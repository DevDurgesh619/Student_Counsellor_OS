import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { counsellors, db, spinachIngestedMeetings } from '@wgc/db';
import { Errors } from '@wgc/shared';
import { loadEnv } from '@wgc/config';
import type { AppEnv } from '../app.js';
import { requireRole } from '../middleware/auth.js';
import {
  completeSpinachAuth,
  disconnectSpinach,
  SpinachReauthRequired,
  startSpinachAuth,
  type SpinachMeetingSummary,
} from '../lib/spinach-mcp.js';
import {
  assignInboxMeeting,
  ignoreInboxMeeting,
  pollOneCounsellor,
  sweepAllCounsellors,
} from '../lib/spinach-poll.js';
import { rankCandidates, type MatchCandidate } from '../lib/spinach-match.js';
import { logger } from '../logger.js';

// ─── Public OAuth callback (no Bearer auth — Spinach redirects here) ──────

export const spinachAuthPublicRoutes = new Hono<AppEnv>();

spinachAuthPublicRoutes.get('/auth/spinach/callback', async (c) => {
  const env = loadEnv();
  const code = c.req.query('code');
  const state = c.req.query('state');
  const errorParam = c.req.query('error');
  const webBase = env.NEXT_PUBLIC_WEB_BASE_URL.replace(/\/$/, '');
  if (errorParam) {
    logger.warn({ errorParam }, 'spinach callback received error');
    return c.redirect(`${webBase}/settings?spinach=error&reason=${encodeURIComponent(errorParam)}`);
  }
  if (!code || !state) {
    return c.redirect(`${webBase}/settings?spinach=error&reason=missing_params`);
  }
  try {
    await completeSpinachAuth(state, code);
    return c.redirect(`${webBase}/settings?spinach=connected`);
  } catch (err) {
    logger.warn({ err }, 'spinach callback exchange failed');
    return c.redirect(
      `${webBase}/settings?spinach=error&reason=${encodeURIComponent((err as Error).message)}`,
    );
  }
});

// ─── Counsellor-scoped (authenticated) ───────────────────────────────────

export const spinachCounsellorRoutes = new Hono<AppEnv>();

spinachCounsellorRoutes.get('/spinach/setup-url', async (c) => {
  const auth = requireRole(c, 'counsellor');
  try {
    const url = await startSpinachAuth(auth.subjectId);
    return c.json({ url });
  } catch (err) {
    logger.warn({ err, counsellorId: auth.subjectId }, 'spinach setup-url failed');
    throw Errors.internal((err as Error).message);
  }
});

spinachCounsellorRoutes.get('/spinach/status', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const row = (
    await db
      .select({
        token: counsellors.spinachOauthToken,
        lastSyncedAt: counsellors.spinachLastSyncedAt,
      })
      .from(counsellors)
      .where(eq(counsellors.id, auth.subjectId))
      .limit(1)
  )[0];
  if (!row) throw Errors.notFound('counsellor', auth.subjectId);
  const t = row.token as Record<string, unknown> | null;
  let state: 'disconnected' | 'pending' | 'connected' = 'disconnected';
  if (t) {
    if ('pending' in t) state = 'pending';
    else if ('ciphertext' in t) state = 'connected';
  }
  return c.json({ data: { state, lastSyncedAt: row.lastSyncedAt } });
});

spinachCounsellorRoutes.delete('/spinach', async (c) => {
  const auth = requireRole(c, 'counsellor');
  await disconnectSpinach(auth.subjectId);
  return c.json({ ok: true });
});

spinachCounsellorRoutes.post('/spinach/poll-now', async (c) => {
  const auth = requireRole(c, 'counsellor');
  try {
    const result = await pollOneCounsellor(auth.subjectId);
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof SpinachReauthRequired) {
      throw Errors.conflict('SPINACH_REAUTH_REQUIRED', err.message);
    }
    throw err;
  }
});

spinachCounsellorRoutes.get('/spinach/inbox', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const status = c.req.query('status') ?? 'unassigned';
  const rows = await db
    .select()
    .from(spinachIngestedMeetings)
    .where(
      and(
        eq(spinachIngestedMeetings.counsellorId, auth.subjectId),
        eq(spinachIngestedMeetings.status, status),
      ),
    )
    .orderBy(desc(spinachIngestedMeetings.fetchedAt))
    .limit(100);

  // For unassigned rows, attach ranked candidate students so the inbox UI
  // can render "Suggested: Hetvika · high · email match [Assign]" per item.
  // Skipped for already-linked rows (they have a student already).
  const withSuggestions =
    status === 'unassigned'
      ? await Promise.all(
          rows.map(async (r) => {
            const summary: SpinachMeetingSummary = {
              id: r.spinachMeetingId,
              title: r.title ?? undefined,
              scheduledAt: r.scheduledAt ? r.scheduledAt.toISOString() : undefined,
              attendees: r.attendees,
            };
            const suggestions = await rankCandidates(auth.subjectId, summary, null);
            return { ...r, suggestions };
          }),
        )
      : rows.map((r) => ({ ...r, suggestions: [] as MatchCandidate[] }));

  return c.json({ data: withSuggestions });
});

/**
 * POST /spinach/inbox/bulk-auto-assign
 *
 * Drain the inbox in one click — assigns every unassigned meeting whose
 * top candidate is high-confidence. Counsellor manually triages the rest.
 * Returns counts so the UI can show "Assigned 12, left 8 for manual review."
 */
spinachCounsellorRoutes.post('/spinach/inbox/bulk-auto-assign', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const rows = await db
    .select()
    .from(spinachIngestedMeetings)
    .where(
      and(
        eq(spinachIngestedMeetings.counsellorId, auth.subjectId),
        eq(spinachIngestedMeetings.status, 'unassigned'),
      ),
    )
    .limit(100);

  let assigned = 0;
  let skipped = 0;
  const errors: Array<{ id: string; message: string }> = [];
  for (const r of rows) {
    const summary: SpinachMeetingSummary = {
      id: r.spinachMeetingId,
      title: r.title ?? undefined,
      scheduledAt: r.scheduledAt ? r.scheduledAt.toISOString() : undefined,
      attendees: r.attendees,
    };
    const candidates = await rankCandidates(auth.subjectId, summary, null);
    const top = candidates[0];
    if (!top || top.confidence !== 'high') {
      skipped += 1;
      continue;
    }
    try {
      await assignInboxMeeting(auth.subjectId, r.id, top.studentId);
      assigned += 1;
    } catch (err) {
      errors.push({ id: r.id, message: (err as Error).message });
    }
  }

  return c.json({ data: { assigned, skipped, errors } });
});

spinachCounsellorRoutes.get('/spinach/inbox/:id', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const row = (
    await db
      .select()
      .from(spinachIngestedMeetings)
      .where(eq(spinachIngestedMeetings.id, id))
      .limit(1)
  )[0];
  if (!row) throw Errors.notFound('spinach_inbox_meeting', id);
  if (row.counsellorId !== auth.subjectId) throw Errors.authForbidden('not_yours');

  // Compute suggestions only for unassigned rows — once linked there's no
  // triage value left.
  let suggestions: MatchCandidate[] = [];
  if (row.status === 'unassigned') {
    const summary: SpinachMeetingSummary = {
      id: row.spinachMeetingId,
      title: row.title ?? undefined,
      scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : undefined,
      attendees: row.attendees,
    };
    suggestions = await rankCandidates(auth.subjectId, summary, null);
  }
  return c.json({ data: { ...row, suggestions } });
});

spinachCounsellorRoutes.post('/spinach/inbox/:id/assign', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const body = z.object({ studentId: z.string().uuid() }).parse(await c.req.json());
  const result = await assignInboxMeeting(auth.subjectId, id, body.studentId);
  return c.json({ data: result });
});

spinachCounsellorRoutes.post('/spinach/inbox/:id/ignore', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  await ignoreInboxMeeting(auth.subjectId, id);
  return c.json({ ok: true });
});

// ─── Internal (shared-secret) — called by workers-cron ─────────────────────

export const spinachInternalRoutes = new Hono<AppEnv>();

function assertInternalSecret(c: Context<AppEnv>): void {
  const env = loadEnv();
  const expected = env.WGC_INTERNAL_API_SECRET;
  if (!expected) throw Errors.internal('WGC_INTERNAL_API_SECRET not configured');
  const provided = c.req.header('x-internal-secret');
  if (!provided || provided !== expected) throw Errors.authInvalidToken('invalid internal secret');
}

spinachInternalRoutes.post('/spinach-poll', async (c) => {
  assertInternalSecret(c);
  // Default sweep applies the activity gate (skip counsellors with no
  // recent or upcoming meeting). `?safety=1` bypasses the gate — used by
  // the 6-hourly safety-net cron to catch ad-hoc meetings that didn't
  // have a pre-scheduled `sessions` row.
  const safety = c.req.query('safety') === '1';
  const result = await sweepAllCounsellors({ skipActivityGate: safety });
  return c.json({ data: result });
});
