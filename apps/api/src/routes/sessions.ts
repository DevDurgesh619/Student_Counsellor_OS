import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
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
  tasks,
} from '@wgc/db';
import { Errors } from '@wgc/shared';
import { loadEnv } from '@wgc/config';
import type { AppEnv } from '../app.js';
import { requireRole } from '../middleware/auth.js';
import { enqueueTaskSync } from '../lib/sync-outbox.js';
import { runSessionPipeline } from '../lib/session-pipeline.js';
import { runPassBSweep, runWorker7PassB } from '../lib/meeting-prep.js';
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

sessionsCounsellorRoutes.get('/sessions/:id/draft-tasks', async (c) => {
  const id = c.req.param('id');
  await assertSessionAccess(c, id);
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.generatedFromSessionId, id), eq(tasks.status, 'draft')));
  return c.json({ data: rows });
});

sessionsCounsellorRoutes.post('/sessions/:id/run-pipeline', async (c) => {
  const id = c.req.param('id');
  await assertSessionAccess(c, id);
  const result = await runSessionPipeline(id);
  return c.json({ data: result });
});

const BulkDecisionSchema = z.object({
  decisions: z
    .array(
      z.object({
        taskId: z.string().uuid(),
        action: z.enum(['approve', 'reject', 'edit']),
        edits: z
          .object({
            scheduledStart: z.string().optional(),
            scheduledEnd: z.string().optional(),
            taskTitle: z.string().optional(),
            taskDescription: z.string().nullable().optional(),
            subject: z.string().optional(),
            flexibility: z.enum(['fixed', 'preferred', 'flexible']).optional(),
          })
          .optional(),
        notes: z.string().optional(),
      }),
    )
    .min(1),
});

sessionsCounsellorRoutes.post('/draft-tasks/bulk-decision', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const body = BulkDecisionSchema.parse(await c.req.json());
  const ids = body.decisions.map((d) => d.taskId);
  const drafts = await db.select().from(tasks).where(inArray(tasks.id, ids));
  const draftById = new Map(drafts.map((t) => [t.id, t]));

  let approved = 0;
  let rejected = 0;
  for (const d of body.decisions) {
    const t = draftById.get(d.taskId);
    if (!t) continue;
    if (t.status !== 'draft') continue;
    // Authorise against the assigned student↔counsellor relationship.
    const stu = (
      await db.select({ counsellorId: students.counsellorId }).from(students).where(eq(students.id, t.studentId)).limit(1)
    )[0];
    if (!stu || stu.counsellorId !== auth.subjectId) continue;

    if (d.action === 'reject') {
      await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, t.id));
      rejected += 1;
      continue;
    }
    const next: Record<string, unknown> = { status: 'scheduled' };
    if (d.action === 'edit' && d.edits) {
      if (d.edits.scheduledStart) next['scheduledStart'] = new Date(d.edits.scheduledStart);
      if (d.edits.scheduledEnd) next['scheduledEnd'] = new Date(d.edits.scheduledEnd);
      if (d.edits.taskTitle) next['taskTitle'] = d.edits.taskTitle;
      if (d.edits.taskDescription !== undefined) next['taskDescription'] = d.edits.taskDescription;
      if (d.edits.subject) next['subject'] = d.edits.subject;
      if (d.edits.flexibility) next['flexibility'] = d.edits.flexibility;
    }
    await db.update(tasks).set(next).where(eq(tasks.id, t.id));
    await enqueueTaskSync(t.id, 'create');
    approved += 1;
  }

  // If all drafts for a session resolved, close the review queue item.
  const sessionId = drafts[0]?.generatedFromSessionId;
  if (sessionId) {
    const remaining = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.generatedFromSessionId, sessionId), eq(tasks.status, 'draft')))
      .limit(1);
    if (remaining.length === 0) {
      await db
        .update(reviewQueue)
        .set({ status: 'resolved', resolvedAt: new Date(), resolvedBy: auth.subjectId })
        .where(
          and(
            eq(reviewQueue.type, 'draft_timetable_changes'),
            eq(reviewQueue.referenceId, sessionId),
          ),
        );
    }
  }

  return c.json({ data: { approved, rejected } });
});

// ── Meeting prep briefs ─────────────────────────────────────────────────────

sessionsCounsellorRoutes.get('/students/:id/upcoming-session-brief', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.param('id');
  const stu = (
    await db.select({ counsellorId: students.counsellorId }).from(students).where(eq(students.id, studentId)).limit(1)
  )[0];
  if (!stu) throw Errors.notFound('student', studentId);
  if (stu.counsellorId !== auth.subjectId) throw Errors.authForbidden('not_assigned');

  const upcoming = (
    await db
      .select()
      .from(sessions)
      .where(eq(sessions.studentId, studentId))
      .orderBy(sessions.scheduledAt)
      .limit(20)
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
  const rows = await db
    .select()
    .from(counsellorTodos)
    .where(eq(counsellorTodos.counsellorId, auth.subjectId))
    .orderBy(desc(counsellorTodos.createdAt))
    .limit(100);
  return c.json({ data: rows });
});

sessionsCounsellorRoutes.patch('/todos/:id', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const body = z
    .object({ status: z.enum(['pending', 'completed', 'cancelled']) })
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
      completedAt: body.status === 'completed' ? new Date() : null,
    })
    .where(eq(counsellorTodos.id, id));
  return c.json({ ok: true });
});
