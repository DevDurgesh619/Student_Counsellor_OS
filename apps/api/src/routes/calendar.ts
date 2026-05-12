import { Hono } from 'hono';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { google } from 'googleapis';
import {
  calendarWatchChannels,
  db,
  encryptJson,
  errors as errorsTable,
  students,
  syncOutbox,
  tasks,
} from '@wgc/db';
import { Errors } from '@wgc/shared';
import { loadEnv } from '@wgc/config';
import type { AppEnv } from '../app.js';
import { requireRole } from '../middleware/auth.js';
import { enqueueTaskSync } from '../lib/sync-outbox.js';
import { reconcileStudentCalendar } from '../lib/calendar-reconcile.js';
import { logger } from '../logger.js';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

function buildOAuthClient() {
  const env = loadEnv();
  if (
    !env.WGC_GOOGLE_CALENDAR_CLIENT_ID ||
    !env.WGC_GOOGLE_CALENDAR_CLIENT_SECRET ||
    !env.WGC_GOOGLE_CALENDAR_REDIRECT_URI
  ) {
    throw Errors.internal('Google Calendar OAuth env vars not set');
  }
  return new google.auth.OAuth2(
    env.WGC_GOOGLE_CALENDAR_CLIENT_ID,
    env.WGC_GOOGLE_CALENDAR_CLIENT_SECRET,
    env.WGC_GOOGLE_CALENDAR_REDIRECT_URI,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Counsellor-scoped (authenticated) — mounted at /api/counsellor
// ─────────────────────────────────────────────────────────────────────────────

export const calendarCounsellorRoutes = new Hono<AppEnv>();

calendarCounsellorRoutes.get('/students/:id/calendar/setup-url', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.param('id');
  const row = (
    await db
      .select({ counsellorId: students.counsellorId })
      .from(students)
      .where(eq(students.id, studentId))
      .limit(1)
  )[0];
  if (!row) throw Errors.notFound('student', studentId);
  if (row.counsellorId !== auth.subjectId) throw Errors.authForbidden();

  const client = buildOAuthClient();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: studentId,
  });
  return c.json({ url });
});

calendarCounsellorRoutes.get('/students/:id/calendar-health', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.param('id');
  const sRow = (
    await db
      .select({
        counsellorId: students.counsellorId,
        token: students.googleOauthToken,
        calendarId: students.googleCalendarId,
      })
      .from(students)
      .where(eq(students.id, studentId))
      .limit(1)
  )[0];
  if (!sRow) throw Errors.notFound('student', studentId);
  if (sRow.counsellorId !== auth.subjectId) throw Errors.authForbidden();

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentFails = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(syncOutbox)
    .where(and(eq(syncOutbox.status, 'failed'), gte(syncOutbox.createdAt, since)));
  const lastSync = (
    await db
      .select({ completedAt: syncOutbox.completedAt })
      .from(syncOutbox)
      .where(eq(syncOutbox.status, 'synced'))
      .orderBy(desc(syncOutbox.completedAt))
      .limit(1)
  )[0];

  let status: 'healthy' | 'degraded' | 'failing' | 'auth_required' | 'not_setup' = 'healthy';
  if (!sRow.token || !sRow.calendarId) status = 'not_setup';
  else if ((recentFails[0]?.count ?? 0) >= 5) status = 'failing';
  else if ((recentFails[0]?.count ?? 0) > 0) status = 'degraded';

  const tokenExpiry = (sRow.token as { expiry_date?: number } | null)?.expiry_date;
  const tokenExpiringInDays =
    tokenExpiry !== undefined ? Math.round((tokenExpiry - Date.now()) / 86_400_000) : null;

  return c.json({
    status,
    lastSyncAt: lastSync?.completedAt ?? null,
    errorsLast24h: recentFails[0]?.count ?? 0,
    tokenExpiringInDays,
    calendarId: sRow.calendarId,
  });
});

calendarCounsellorRoutes.post('/students/:id/calendar/resync', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.param('id');
  const sRow = (
    await db
      .select({ counsellorId: students.counsellorId })
      .from(students)
      .where(eq(students.id, studentId))
      .limit(1)
  )[0];
  if (!sRow) throw Errors.notFound('student', studentId);
  if (sRow.counsellorId !== auth.subjectId) throw Errors.authForbidden();

  const future = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.studentId, studentId),
        gte(tasks.scheduledStart, new Date()),
        eq(tasks.status, 'scheduled'),
      ),
    );
  for (const t of future) await enqueueTaskSync(t.id, 'create');
  return c.json({ enqueued: future.length });
});

// ─────────────────────────────────────────────────────────────────────────────
// Public (no auth) — mounted at root: /auth/google/callback, /webhooks/google-calendar
// ─────────────────────────────────────────────────────────────────────────────

export const calendarPublicRoutes = new Hono<AppEnv>();

calendarPublicRoutes.get('/auth/google/callback', async (c) => {
  const code = c.req.query('code');
  const studentId = c.req.query('state');
  if (!code || !studentId) throw Errors.validation('Missing code or state');

  const env = loadEnv();
  const client = buildOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw Errors.validation(
      'Google did not return a refresh_token. Revoke prior consent in your Google Account and retry.',
    );
  }
  client.setCredentials(tokens);

  const cal = google.calendar({ version: 'v3', auth: client });

  const studentRow = (
    await db.select().from(students).where(eq(students.id, studentId)).limit(1)
  )[0];
  if (!studentRow) throw Errors.notFound('student', studentId);

  let calendarId = studentRow.googleCalendarId;
  if (!calendarId) {
    const created = await cal.calendars.insert({
      requestBody: {
        summary: 'WGC – Study',
        description: `Study schedule for ${studentRow.fullName}`,
        timeZone: studentRow.timezone || 'Asia/Kolkata',
      },
    });
    calendarId = created.data.id ?? null;
  }

  const encryptedToken = await encryptJson(tokens);
  await db
    .update(students)
    .set({
      googleOauthToken: encryptedToken,
      googleCalendarId: calendarId,
      updatedAt: new Date(),
    })
    .where(eq(students.id, studentId));

  const future = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.studentId, studentId), gte(tasks.scheduledStart, new Date())));
  for (const t of future) await enqueueTaskSync(t.id, 'create');

  if (env.WGC_GOOGLE_CALENDAR_WEBHOOK_URL && calendarId) {
    try {
      const channelId = crypto.randomUUID();
      const watch = await cal.events.watch({
        calendarId,
        requestBody: {
          id: channelId,
          type: 'web_hook',
          address: env.WGC_GOOGLE_CALENDAR_WEBHOOK_URL,
          token: studentId,
        },
      });
      const exp = watch.data.expiration
        ? Number(watch.data.expiration)
        : Date.now() + 30 * 86_400_000;
      await db
        .insert(calendarWatchChannels)
        .values({
          studentId,
          channelId,
          resourceId: watch.data.resourceId ?? '',
          expiresAt: new Date(exp),
        })
        .onConflictDoNothing();
    } catch {
      // Non-fatal — sync still works in DB→Calendar direction.
    }
  }

  return c.html(
    `<html><body style="font-family:system-ui;padding:2rem;text-align:center"><h1>Calendar connected</h1><p>You can close this tab.</p></body></html>`,
  );
});

calendarPublicRoutes.post('/webhooks/google-calendar', async (c) => {
  const channelId = c.req.header('X-Goog-Channel-Id');
  const token = c.req.header('X-Goog-Channel-Token');
  const resourceState = c.req.header('X-Goog-Resource-State');
  if (!channelId || !token) return c.body(null, 400);

  const ch = (
    await db
      .select()
      .from(calendarWatchChannels)
      .where(eq(calendarWatchChannels.channelId, channelId))
      .limit(1)
  )[0];
  if (!ch) return c.body(null, 404);
  if (ch.studentId !== token) return c.body(null, 401);

  // `sync` is the initial handshake — no event changes yet.
  // `exists` / `not_exists` indicate event-level changes; reconcile.
  if (resourceState === 'exists' || resourceState === 'not_exists') {
    // Run reconciliation in the background so we acknowledge the webhook
    // promptly (Google retries on slow 200s and treats >30s as failure).
    reconcileStudentCalendar(ch.studentId).catch((err) => {
      logger.error({ err, studentId: ch.studentId }, 'reconcile failed');
      void db.insert(errorsTable).values({
        severity: 'error',
        source: 'calendar_webhook',
        studentId: ch.studentId,
        errorMessage: `reconcile failed: ${(err as Error).message}`,
        context: { channelId, resourceState },
      });
    });
  }
  return c.body(null, 200);
});
