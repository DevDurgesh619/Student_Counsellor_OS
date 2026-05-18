import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import {
  counsellorTodos,
  counsellors,
  db,
  gaps,
  meetingPrepBriefs,
  reviewQueue,
  sessions,
  sessionExtractions,
  students,
  timetableChanges,
} from '@wgc/db';
import { Errors } from '@wgc/shared';
import { loadEnv } from '@wgc/config';
import type { AppEnv } from '../app.js';
import { requireRole } from '../middleware/auth.js';
import { idempotency } from '../middleware/idempotency.js';
import { runSessionPipeline } from '../lib/session-pipeline.js';
import { runPassBSweep, runWorker7PassB } from '../lib/meeting-prep.js';
import { applyChange, summarizeChange } from '../lib/timetable-engine.js';
import { logger } from '../logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public Spinach webhook — verifies HMAC signature, ingests transcript,
// triggers full pipeline (extraction → Pass A → action items → Worker 4).
// ─────────────────────────────────────────────────────────────────────────────

export const spinachPublicRoutes = new Hono<AppEnv>();

const SpinachPayloadSchema = z.object({
  // Spinach's payload shape varies by integration. We accept these and let
  // the rest pass through into spinach_metadata.
  session_external_id: z.string().optional(),
  meeting_id: z.string().optional(),
  // We require either one of session_id (our UUID, set when scheduling) or
  // a (counsellor_email, student_email, meeting_started_at) triple.
  wgc_session_id: z.string().uuid().optional(),
  counsellor_email: z.string().email().optional(),
  student_email: z.string().email().optional(),
  meeting_started_at: z.string().optional(),
  duration_minutes: z.number().optional(),
  transcript_text: z.string().optional(),
  transcript_url: z.string().url().optional(),
  recording_url: z.string().url().optional(),
  summary_text: z.string().optional(),
});

spinachPublicRoutes.post('/webhooks/spinach', async (c) => {
  const env = loadEnv();
  const secret = env.WGC_SPINACH_WEBHOOK_SECRET;
  const rawBody = await c.req.text();

  if (secret) {
    const sigHeader = c.req.header('x-spinach-signature') ?? c.req.header('x-signature');
    if (!sigHeader) throw Errors.authInvalidToken('missing webhook signature');
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const provided = sigHeader.replace(/^sha256=/, '').trim();
    const expBuf = Buffer.from(expected, 'hex');
    const provBuf = Buffer.from(provided, 'hex');
    if (expBuf.length !== provBuf.length || !crypto.timingSafeEqual(expBuf, provBuf)) {
      throw Errors.authInvalidToken('invalid webhook signature');
    }
  } else if (env.WGC_NODE_ENV === 'production') {
    throw Errors.internal('WGC_SPINACH_WEBHOOK_SECRET is required in production');
  }

  let payload: z.infer<typeof SpinachPayloadSchema>;
  try {
    payload = SpinachPayloadSchema.parse(JSON.parse(rawBody));
  } catch (err) {
    logger.warn({ err }, 'spinach webhook payload parse failed');
    throw Errors.validation('invalid_payload');
  }

  // Resolve our session row.
  let sessionRow = null;
  if (payload.wgc_session_id) {
    sessionRow = (
      await db.select().from(sessions).where(eq(sessions.id, payload.wgc_session_id)).limit(1)
    )[0];
  } else if (payload.counsellor_email && payload.student_email) {
    const counsellor = (
      await db.select().from(counsellors).where(eq(counsellors.email, payload.counsellor_email)).limit(1)
    )[0];
    const student = (
      await db.select().from(students).where(eq(students.email, payload.student_email)).limit(1)
    )[0];
    if (counsellor && student) {
      sessionRow = (
        await db
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.counsellorId, counsellor.id),
              eq(sessions.studentId, student.id),
            ),
          )
          .orderBy(desc(sessions.scheduledAt))
          .limit(1)
      )[0];
    }
  }
  if (!sessionRow) {
    logger.warn({ payload }, 'spinach webhook could not resolve session');
    return c.json({ ok: false, reason: 'session_not_resolved' }, 202);
  }

  // Persist transcript + summary; merge raw payload into spinach_metadata.
  await db
    .update(sessions)
    .set({
      transcriptText: payload.transcript_text ?? sessionRow.transcriptText,
      transcriptUrl: payload.transcript_url ?? sessionRow.transcriptUrl,
      recordingUrl: payload.recording_url ?? sessionRow.recordingUrl,
      spinachSummaryText: payload.summary_text ?? sessionRow.spinachSummaryText,
      spinachMetadata: { ...(sessionRow.spinachMetadata ?? {}), lastWebhookPayload: payload },
      durationMinutes: payload.duration_minutes ?? sessionRow.durationMinutes,
      status: 'completed',
    })
    .where(eq(sessions.id, sessionRow.id));

  // Run pipeline (best-effort; webhook responds 202 either way).
  try {
    const result = await runSessionPipeline(sessionRow.id);
    return c.json({ ok: true, sessionId: sessionRow.id, ...result }, 202);
  } catch (err) {
    logger.error({ err, sessionId: sessionRow.id }, 'session pipeline failed');
    return c.json({ ok: false, sessionId: sessionRow.id, error: (err as Error).message }, 202);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal endpoints (shared-secret) — called by workers-cron
// ─────────────────────────────────────────────────────────────────────────────

export const sessionsInternalRoutes = new Hono<AppEnv>();

function assertInternalSecret(c: Context<AppEnv>): void {
  const env = loadEnv();
  const expected = env.WGC_INTERNAL_API_SECRET;
  if (!expected) throw Errors.internal('WGC_INTERNAL_API_SECRET not configured');
  const provided = c.req.header('x-internal-secret');
  if (!provided || provided !== expected) throw Errors.authInvalidToken('invalid internal secret');
}

sessionsInternalRoutes.post('/run-pass-b-scheduler', async (c) => {
  assertInternalSecret(c);
  const result = await runPassBSweep();
  return c.json({ data: result });
});

sessionsInternalRoutes.post('/regenerate-extraction/:sessionId', async (c) => {
  assertInternalSecret(c);
  const sessionId = c.req.param('sessionId');
  const result = await runSessionPipeline(sessionId);
  return c.json({ data: result });
});

sessionsInternalRoutes.post('/run-pass-b/:sessionId', async (c) => {
  assertInternalSecret(c);
  const sessionId = c.req.param('sessionId');
  const briefId = await runWorker7PassB(sessionId);
  return c.json({ data: { briefId } });
});

// ─────────────────────────────────────────────────────────────────────────────
// Counsellor-scoped (authenticated) — mounted at /api/counsellor
// ─────────────────────────────────────────────────────────────────────────────

export const sessionsCounsellorRoutes = new Hono<AppEnv>();

async function assertSessionAccess(c: Context<AppEnv>, sessionId: string) {
  const auth = requireRole(c, 'counsellor');
  const row = (
    await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
  )[0];
  if (!row) throw Errors.notFound('session', sessionId);
  if (row.counsellorId !== auth.subjectId) throw Errors.authForbidden('not_assigned');
  return { auth, session: row };
}

sessionsCounsellorRoutes.get('/sessions/:id', async (c) => {
  const id = c.req.param('id');
  const { session } = await assertSessionAccess(c, id);
  return c.json({ data: session });
});

sessionsCounsellorRoutes.get('/sessions/:id/extraction', async (c) => {
  const id = c.req.param('id');
  await assertSessionAccess(c, id);
  const row = (
    await db.select().from(sessionExtractions).where(eq(sessionExtractions.sessionId, id)).limit(1)
  )[0];
  if (!row) return c.json({ data: null });
  return c.json({ data: row });
});

/**
 * GET /sessions/:id/pending-change
 *
 * Returns the draft `timetable_changes` row Worker 4 produced for this
 * session (if any), together with a summary the UI renders as a list of
 * "would create/cancel" tasks. The draft is atomic — the counsellor
 * approves or rejects the whole bundle from the session-detail page.
 * Replaces the legacy per-task draft list (Phase 4b).
 */
sessionsCounsellorRoutes.get('/sessions/:id/pending-change', async (c) => {
  const id = c.req.param('id');
  await assertSessionAccess(c, id);
  const change = (
    await db
      .select()
      .from(timetableChanges)
      .where(
        and(
          eq(timetableChanges.sourceSessionId, id),
          eq(timetableChanges.status, 'draft'),
        ),
      )
      .orderBy(desc(timetableChanges.createdAt))
      .limit(1)
  )[0];
  if (!change) return c.json({ data: null });
  const summary = await summarizeChange(change.id);
  return c.json({ data: { change, summary } });
});

sessionsCounsellorRoutes.post('/sessions/:id/run-pipeline', async (c) => {
  const id = c.req.param('id');
  await assertSessionAccess(c, id);
  const result = await runSessionPipeline(id);
  return c.json({ data: result });
});

const PendingChangeDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
});

/**
 * POST /sessions/:id/pending-change/decision
 *
 * Approve → applyChange (materialises tasks + recurrence groups, enqueues
 * calendar sync, marks the change active). Reject → flips status to
 * 'reverted' without ever applying. Either way the matching review-queue
 * row is closed. V1: counsellor doesn't edit individual ops here — for
 * partial accept they open the conversational editor and ask for a
 * revision (the original Phase 4 design).
 */
sessionsCounsellorRoutes.post(
  '/sessions/:id/pending-change/decision',
  idempotency,
  async (c) => {
    const auth = requireRole(c, 'counsellor');
    const id = c.req.param('id');
    await assertSessionAccess(c, id);
    const body = PendingChangeDecisionSchema.parse(await c.req.json());

    const change = (
      await db
        .select()
        .from(timetableChanges)
        .where(
          and(
            eq(timetableChanges.sourceSessionId, id),
            eq(timetableChanges.status, 'draft'),
          ),
        )
        .orderBy(desc(timetableChanges.createdAt))
        .limit(1)
    )[0];
    if (!change) throw Errors.notFound('pending_change', id);

    if (body.decision === 'approve') {
      const result = await applyChange(change.id);
      await db
        .update(reviewQueue)
        .set({
          status: 'resolved',
          resolvedAt: new Date(),
          resolvedBy: auth.subjectId,
          resolutionNotes: 'meeting-extracted change approved',
        })
        .where(
          and(
            eq(reviewQueue.type, 'draft_timetable_changes'),
            eq(reviewQueue.referenceId, id),
          ),
        );
      return c.json({ data: { decision: 'approve', ...result } });
    }

    // reject: never applied, just close it out. Don't go through
    // revertChange (that's for active changes only).
    await db
      .update(timetableChanges)
      .set({ status: 'reverted', revertedAt: new Date() })
      .where(eq(timetableChanges.id, change.id));
    await db
      .update(reviewQueue)
      .set({
        status: 'resolved',
        resolvedAt: new Date(),
        resolvedBy: auth.subjectId,
        resolutionNotes: 'meeting-extracted change rejected',
      })
      .where(
        and(
          eq(reviewQueue.type, 'draft_timetable_changes'),
          eq(reviewQueue.referenceId, id),
        ),
      );
    return c.json({ data: { decision: 'reject', changeId: change.id } });
  },
);

// ── Meeting prep briefs ─────────────────────────────────────────────────────

sessionsCounsellorRoutes.get('/students/:id/upcoming-session-brief', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.param('id');
  const stu = (
    await db.select({ counsellorId: students.counsellorId }).from(students).where(eq(students.id, studentId)).limit(1)
  )[0];
  if (!stu) throw Errors.notFound('student', studentId);
  if (stu.counsellorId !== auth.subjectId) throw Errors.authForbidden('not_assigned');

  // Next session whose scheduled time is in the future. Without the
  // `gt(scheduledAt, now)` filter this would return the earliest session
  // ever — typically a months-old historical row with a stale brief
  // attached — which is the opposite of what the counsellor's "upcoming
  // brief" view should surface.
  const upcoming = (
    await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.studentId, studentId), gt(sessions.scheduledAt, new Date())))
      .orderBy(sessions.scheduledAt)
      .limit(1)
  )[0];
  if (!upcoming) return c.json({ data: null });

  const brief = (
    await db
      .select()
      .from(meetingPrepBriefs)
      .where(eq(meetingPrepBriefs.targetSessionId, upcoming.id))
      .limit(1)
  )[0];
  return c.json({ data: brief ?? null, session: upcoming });
});

sessionsCounsellorRoutes.patch('/upcoming-session-brief/:id', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const briefId = c.req.param('id');
  const body = z
    .object({ finalContent: z.string(), markReviewed: z.boolean().optional() })
    .parse(await c.req.json());

  const brief = (
    await db.select().from(meetingPrepBriefs).where(eq(meetingPrepBriefs.id, briefId)).limit(1)
  )[0];
  if (!brief) throw Errors.notFound('meeting_prep_brief', briefId);
  const session = (
    await db.select().from(sessions).where(eq(sessions.id, brief.targetSessionId)).limit(1)
  )[0];
  if (!session || session.counsellorId !== auth.subjectId) throw Errors.authForbidden('not_assigned');

  const now = new Date();
  await db
    .update(meetingPrepBriefs)
    .set({
      finalContent: body.finalContent,
      counsellorEditedAt: now,
      status: body.markReviewed ? 'reviewed' : brief.status,
      updatedAt: now,
    })
    .where(eq(meetingPrepBriefs.id, briefId));
  if (body.markReviewed) {
    await db
      .update(reviewQueue)
      .set({ status: 'resolved', resolvedAt: now, resolvedBy: auth.subjectId })
      .where(
        and(eq(reviewQueue.type, 'meeting_prep_brief'), eq(reviewQueue.referenceId, briefId)),
      );
  }
  return c.json({ ok: true });
});

// ── Gaps ────────────────────────────────────────────────────────────────────

sessionsCounsellorRoutes.get('/students/:id/gaps', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.param('id');
  const stu = (
    await db.select({ counsellorId: students.counsellorId }).from(students).where(eq(students.id, studentId)).limit(1)
  )[0];
  if (!stu) throw Errors.notFound('student', studentId);
  if (stu.counsellorId !== auth.subjectId) throw Errors.authForbidden('not_assigned');
  const rows = await db
    .select()
    .from(gaps)
    .where(eq(gaps.studentId, studentId))
    .orderBy(desc(gaps.createdAt));
  return c.json({ data: rows });
});

const GapCreateSchema = z.object({
  category: z.enum(['content', 'skill', 'habit']),
  subject: z.string().nullable().optional(),
  description: z.string().min(1),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  targetResolutionDate: z.string().nullable().optional(),
});

sessionsCounsellorRoutes.post('/students/:id/gaps', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.param('id');
  const stu = (
    await db.select({ counsellorId: students.counsellorId }).from(students).where(eq(students.id, studentId)).limit(1)
  )[0];
  if (!stu) throw Errors.notFound('student', studentId);
  if (stu.counsellorId !== auth.subjectId) throw Errors.authForbidden('not_assigned');
  const body = GapCreateSchema.parse(await c.req.json());
  const inserted = await db
    .insert(gaps)
    .values({
      studentId,
      category: body.category,
      subject: body.subject ?? null,
      description: body.description,
      priority: body.priority,
      targetResolutionDate: body.targetResolutionDate ?? null,
      identifiedVia: 'counsellor_manual',
    })
    .returning();
  return c.json({ data: inserted[0] }, 201);
});

const GapPatchSchema = z.object({
  status: z.enum(['active', 'addressed', 'archived']).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  description: z.string().optional(),
  subject: z.string().nullable().optional(),
  targetResolutionDate: z.string().nullable().optional(),
});

sessionsCounsellorRoutes.patch('/gaps/:id', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const gap = (await db.select().from(gaps).where(eq(gaps.id, id)).limit(1))[0];
  if (!gap) throw Errors.notFound('gap', id);
  const stu = (
    await db.select({ counsellorId: students.counsellorId }).from(students).where(eq(students.id, gap.studentId)).limit(1)
  )[0];
  if (!stu || stu.counsellorId !== auth.subjectId) throw Errors.authForbidden('not_assigned');
  const body = GapPatchSchema.parse(await c.req.json());
  const next: Record<string, unknown> = { ...body };
  if (body.status === 'addressed' && !gap.addressedAt) {
    next['addressedAt'] = new Date();
  }
  await db.update(gaps).set(next).where(eq(gaps.id, id));
  return c.json({ ok: true });
});

// ── Counsellor todos ────────────────────────────────────────────────────────

sessionsCounsellorRoutes.get('/todos', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.query('studentId');
  // status: comma-separated. Default to the active tiers — archived is
  // excluded unless explicitly requested (the "Show archived" toggle).
  const statusParam = c.req.query('status');
  const statuses = statusParam
    ? statusParam.split(',').map((s) => s.trim()).filter(Boolean)
    : ['pending', 'completed'];
  // lastSessions: restrict todos to those generated from the student's N
  // most-recent sessions. Only meaningful in student scope (a meeting count
  // doesn't translate across students), so it's ignored without studentId.
  const lastSessionsRaw = c.req.query('lastSessions');
  const lastSessions = lastSessionsRaw ? parseInt(lastSessionsRaw, 10) : null;

  const conds = [
    eq(counsellorTodos.counsellorId, auth.subjectId),
    inArray(counsellorTodos.status, statuses),
  ];
  if (studentId) conds.push(eq(counsellorTodos.studentId, studentId));

  if (studentId && lastSessions && lastSessions > 0) {
    const recentSessions = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.studentId, studentId))
      .orderBy(desc(sessions.scheduledAt))
      .limit(Math.min(lastSessions, 50));
    const ids = recentSessions.map((s) => s.id);
    // No sessions for this student yet → nothing meeting-sourced to show.
    if (ids.length === 0) return c.json({ data: [] });
    conds.push(inArray(counsellorTodos.sourceSessionId, ids));
  }

  const rows = await db
    .select()
    .from(counsellorTodos)
    .where(and(...conds))
    .orderBy(desc(counsellorTodos.createdAt))
    .limit(200);
  return c.json({ data: rows });
});

sessionsCounsellorRoutes.patch('/todos/:id', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const body = z
    .object({ status: z.enum(['pending', 'completed', 'archived']) })
    .parse(await c.req.json());
  const todo = (
    await db.select().from(counsellorTodos).where(eq(counsellorTodos.id, id)).limit(1)
  )[0];
  if (!todo) throw Errors.notFound('counsellor_todo', id);
  if (todo.counsellorId !== auth.subjectId) throw Errors.authForbidden('not_assigned');
  await db
    .update(counsellorTodos)
    .set({
      status: body.status,
      // completedAt tracks the moment it was checked off; clear it if the
      // todo is moved back to pending, keep it through archive.
      completedAt:
        body.status === 'completed'
          ? new Date()
          : body.status === 'pending'
            ? null
            : todo.completedAt,
    })
    .where(eq(counsellorTodos.id, id));
  return c.json({ ok: true });
});

/**
 * POST /todos/bulk-archive — flip every 'completed' todo for this counsellor
 * (optionally scoped to one student) to 'archived'. Powers the
 * "Clear all completed" button.
 */
sessionsCounsellorRoutes.post('/todos/bulk-archive', idempotency, async (c) => {
  const auth = requireRole(c, 'counsellor');
  const body = z
    .object({ studentId: z.string().uuid().optional() })
    .parse(await c.req.json().catch(() => ({})));
  const conds = [
    eq(counsellorTodos.counsellorId, auth.subjectId),
    eq(counsellorTodos.status, 'completed'),
  ];
  if (body.studentId) conds.push(eq(counsellorTodos.studentId, body.studentId));
  const archived = await db
    .update(counsellorTodos)
    .set({ status: 'archived' })
    .where(and(...conds))
    .returning({ id: counsellorTodos.id });
  return c.json({ archived: archived.length });
});

/**
 * DELETE /todos/:id — hard delete. Counsellor todos are operational items,
 * not audit records, so removal is permanent.
 */
sessionsCounsellorRoutes.delete('/todos/:id', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const todo = (
    await db.select().from(counsellorTodos).where(eq(counsellorTodos.id, id)).limit(1)
  )[0];
  if (!todo) throw Errors.notFound('counsellor_todo', id);
  if (todo.counsellorId !== auth.subjectId) throw Errors.authForbidden('not_assigned');
  await db.delete(counsellorTodos).where(eq(counsellorTodos.id, id));
  return c.json({ ok: true });
});
