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
} from '../lib/spinach-mcp.js';
import {
  assignInboxMeeting,
  ignoreInboxMeeting,
  pollOneCounsellor,
  sweepAllCounsellors,
} from '../lib/spinach-poll.js';
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
  return c.json({ data: rows });
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
  return c.json({ data: row });
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
  const result = await sweepAllCounsellors();
  return c.json({ data: result });
});
