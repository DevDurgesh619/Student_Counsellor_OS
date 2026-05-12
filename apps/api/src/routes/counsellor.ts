import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  artifacts,
  changeRequests,
  completions,
  counsellors,
  db,
  reviewQueue,
  sessions as sessionsTable,
  students,
  tasks,
} from '@wgc/db';
import { Errors, SubjectSchema, TaskFlexibilitySchema, TaskSourceSchema } from '@wgc/shared';
import type { AppEnv } from '../app.js';
import { requireRole } from '../middleware/auth.js';
import { idempotency } from '../middleware/idempotency.js';
import { enqueueTaskSync } from '../lib/sync-outbox.js';

export const counsellorScopedRoutes = new Hono<AppEnv>();

/**
 * GET /api/counsellor/me — current counsellor profile.
 */
counsellorScopedRoutes.get('/me', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const row = (
    await db.select().from(counsellors).where(eq(counsellors.id, auth.subjectId)).limit(1)
  )[0];
  if (!row) throw Errors.notFound('counsellor', auth.subjectId);
  return c.json(row);
});

/**
 * GET /api/counsellor/students-overview
 *
 * One row per assigned student with computed stats per Phase 3 §3:
 *   - today's completion: { scheduled, done, partial, skipped, couldnt_do, missed }
 *   - lastActivity: max(completions.submittedAt, artifacts.uploadedAt)
 *   - pendingReviewItems: count of review_queue rows for this counsellor + student in pending/in_review
 *   - healthIndicator: derived from completion ratio (green ≥0.7, yellow ≥0.3, red <0.3 OR missing)
 */
counsellorScopedRoutes.get('/students-overview', async (c) => {
  const auth = requireRole(c, 'counsellor');

  // Today bounds in counsellor's timezone — for v1, use UTC; counsellor's
  // timezone (default Asia/Kolkata) is mostly a display concern. Phase 9
  // tightens this if needed.
  const now = new Date();
  const startOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  const startOfTomorrow = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);

  const assigned = await db
    .select({
      id: students.id,
      fullName: students.fullName,
      currentGrade: students.currentGrade,
      status: students.status,
    })
    .from(students)
    .where(and(eq(students.counsellorId, auth.subjectId), eq(students.status, 'active')))
    .orderBy(asc(students.fullName));

  if (assigned.length === 0) return c.json({ data: [] });

  const studentIds = assigned.map((s) => s.id);

  // Today's tasks per student grouped by status
  const todayTasks = await db
    .select({
      studentId: tasks.studentId,
      status: tasks.status,
      count: sql<number>`count(*)::int`,
    })
    .from(tasks)
    .where(
      and(
        inArray(tasks.studentId, studentIds),
        gte(tasks.scheduledStart, startOfToday),
        lt(tasks.scheduledStart, startOfTomorrow),
      ),
    )
    .groupBy(tasks.studentId, tasks.status);

  // Latest completion + artifact timestamps per student
  const latestCompletion = await db
    .select({
      studentId: tasks.studentId,
      latest: sql<Date | null>`max(${completions.submittedAt})`,
    })
    .from(completions)
    .innerJoin(tasks, eq(tasks.id, completions.taskId))
    .where(inArray(tasks.studentId, studentIds))
    .groupBy(tasks.studentId);

  const latestArtifact = await db
    .select({
      studentId: artifacts.studentId,
      latest: sql<Date | null>`max(${artifacts.uploadedAt})`,
    })
    .from(artifacts)
    .where(inArray(artifacts.studentId, studentIds))
    .groupBy(artifacts.studentId);

  // Pending review items per student
  const pending = await db
    .select({
      studentId: reviewQueue.studentId,
      count: sql<number>`count(*)::int`,
    })
    .from(reviewQueue)
    .where(
      and(
        eq(reviewQueue.counsellorId, auth.subjectId),
        inArray(reviewQueue.status, ['pending', 'in_review']),
      ),
    )
    .groupBy(reviewQueue.studentId);

  // Stitch it all together
  const lastActMap = new Map<string, Date>();
  for (const row of latestCompletion) {
    if (row.latest) lastActMap.set(row.studentId, row.latest);
  }
  for (const row of latestArtifact) {
    if (row.latest) {
      const existing = lastActMap.get(row.studentId);
      if (!existing || row.latest > existing) lastActMap.set(row.studentId, row.latest);
    }
  }

  const pendingMap = new Map<string, number>();
  for (const row of pending) {
    if (row.studentId) pendingMap.set(row.studentId, row.count);
  }

  type TodayBreakdown = {
    scheduled: number;
    done: number;
    partial: number;
    skipped: number;
    couldntDo: number;
    cancelled: number;
    rescheduled: number;
  };
  const emptyBreakdown = (): TodayBreakdown => ({
    scheduled: 0,
    done: 0,
    partial: 0,
    skipped: 0,
    couldntDo: 0,
    cancelled: 0,
    rescheduled: 0,
  });
  const todayMap = new Map<string, TodayBreakdown>();
  for (const row of todayTasks) {
    const cur = todayMap.get(row.studentId) ?? emptyBreakdown();
    switch (row.status) {
      case 'scheduled':
        cur.scheduled = row.count;
        break;
      case 'completed':
        cur.done = row.count;
        break;
      case 'skipped':
        cur.skipped = row.count;
        break;
      case 'couldnt_do':
        cur.couldntDo = row.count;
        break;
      case 'cancelled':
        cur.cancelled = row.count;
        break;
      case 'rescheduled':
        cur.rescheduled = row.count;
        break;
    }
    todayMap.set(row.studentId, cur);
  }

  const data = assigned.map((s) => {
    const today = todayMap.get(s.id) ?? emptyBreakdown();
    const totalToday =
      today.scheduled + today.done + today.skipped + today.couldntDo + today.partial;
    const ratio = totalToday > 0 ? today.done / totalToday : null;
    const healthIndicator: 'green' | 'yellow' | 'red' | 'unknown' =
      ratio === null ? 'unknown' : ratio >= 0.7 ? 'green' : ratio >= 0.3 ? 'yellow' : 'red';
    return {
      studentId: s.id,
      name: s.fullName,
      grade: s.currentGrade,
      lastActivity: lastActMap.get(s.id) ?? null,
      today,
      pendingReviewItems: pendingMap.get(s.id) ?? 0,
      healthIndicator,
    };
  });

  return c.json({ data });
});

/**
 * Counsellor-scoped student detail — same as /api/students/:id but explicit
 * about the counsellor scoping (cleaner for the web app to consume).
 */
counsellorScopedRoutes.get('/students/:id', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const row = (await db.select().from(students).where(eq(students.id, id)).limit(1))[0];
  if (!row) throw Errors.notFound('student', id);
  if (row.counsellorId !== auth.subjectId) throw Errors.authForbidden();
  return c.json(row);
});

/**
 * GET /api/counsellor/queue — review queue for current counsellor.
 * Filters: ?status=pending|in_review|resolved|dismissed (default: pending,in_review)
 *          ?studentId=...
 */
counsellorScopedRoutes.get('/queue', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const statusParam = c.req.query('status');
  const studentIdParam = c.req.query('studentId');
  const statuses = statusParam ? statusParam.split(',') : ['pending', 'in_review'];
  const conds = [
    eq(reviewQueue.counsellorId, auth.subjectId),
    inArray(reviewQueue.status, statuses),
  ];
  if (studentIdParam) conds.push(eq(reviewQueue.studentId, studentIdParam));
  const rows = await db
    .select()
    .from(reviewQueue)
    .where(and(...conds))
    .orderBy(asc(reviewQueue.priority), desc(reviewQueue.createdAt))
    .limit(200);
  return c.json({ data: rows });
});

/**
 * PATCH /api/counsellor/queue/:id/resolve — mark a queue item resolved or dismissed.
 */
counsellorScopedRoutes.patch('/queue/:id/resolve', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const body = (await c.req.json()) as {
    status?: 'resolved' | 'dismissed';
    resolutionNotes?: string;
  };
  const status = body.status ?? 'resolved';
  if (status !== 'resolved' && status !== 'dismissed') {
    throw Errors.validation('status must be "resolved" or "dismissed"');
  }
  const existing = (
    await db.select().from(reviewQueue).where(eq(reviewQueue.id, id)).limit(1)
  )[0];
  if (!existing) throw Errors.notFound('review_queue_item', id);
  if (existing.counsellorId !== auth.subjectId) throw Errors.authForbidden();
  const updated = await db
    .update(reviewQueue)
    .set({
      status,
      resolvedAt: new Date(),
      resolvedBy: auth.subjectId,
      resolutionNotes: body.resolutionNotes ?? null,
    })
    .where(eq(reviewQueue.id, id))
    .returning();
  return c.json(updated[0]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Sessions — manual entry until Phase 6 / Spinach takes over
// ─────────────────────────────────────────────────────────────────────────────

async function assertCounsellorOwnsStudent(counsellorId: string, studentId: string) {
  const row = (
    await db
      .select({ counsellorId: students.counsellorId })
      .from(students)
      .where(eq(students.id, studentId))
      .limit(1)
  )[0];
  if (!row) throw Errors.notFound('student', studentId);
  if (row.counsellorId !== counsellorId) throw Errors.authForbidden();
}

const SessionCreateSchema = z.object({
  scheduledAt: z.string().datetime(),
  durationMinutes: z.number().int().positive().optional(),
  spinachSummaryText: z.string().optional(),
  status: z.enum(['scheduled', 'in_progress', 'completed', 'cancelled']).default('scheduled'),
});

counsellorScopedRoutes.get('/students/:id/sessions', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.param('id');
  await assertCounsellorOwnsStudent(auth.subjectId, studentId);
  const rows = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.studentId, studentId))
    .orderBy(desc(sessionsTable.scheduledAt));
  return c.json({ data: rows });
});

counsellorScopedRoutes.post('/students/:id/sessions', idempotency, async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.param('id');
  await assertCounsellorOwnsStudent(auth.subjectId, studentId);
  const body = SessionCreateSchema.parse(await c.req.json());
  const inserted = await db
    .insert(sessionsTable)
    .values({
      studentId,
      counsellorId: auth.subjectId,
      scheduledAt: new Date(body.scheduledAt),
      durationMinutes: body.durationMinutes ?? null,
      spinachSummaryText: body.spinachSummaryText ?? null,
      status: body.status,
    })
    .returning();
  return c.json(inserted[0], 201);
});

const SessionPatchSchema = SessionCreateSchema.partial();

counsellorScopedRoutes.patch('/students/:studentId/sessions/:sessionId', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.param('studentId');
  const sessionId = c.req.param('sessionId');
  await assertCounsellorOwnsStudent(auth.subjectId, studentId);
  const existing = (
    await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId)).limit(1)
  )[0];
  if (!existing || existing.studentId !== studentId) {
    throw Errors.notFound('session', sessionId);
  }
  const patch = SessionPatchSchema.parse(await c.req.json());
  const updated = await db
    .update(sessionsTable)
    .set({
      ...(patch.scheduledAt ? { scheduledAt: new Date(patch.scheduledAt) } : {}),
      ...(patch.durationMinutes !== undefined ? { durationMinutes: patch.durationMinutes } : {}),
      ...(patch.spinachSummaryText !== undefined
        ? { spinachSummaryText: patch.spinachSummaryText }
        : {}),
      ...(patch.status ? { status: patch.status } : {}),
    })
    .where(eq(sessionsTable.id, sessionId))
    .returning();
  return c.json(updated[0]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Change requests — student creates, counsellor decides
// ─────────────────────────────────────────────────────────────────────────────

counsellorScopedRoutes.get('/students/:id/change-requests', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.param('id');
  await assertCounsellorOwnsStudent(auth.subjectId, studentId);
  const statusFilter = c.req.query('status');
  const conds = [eq(changeRequests.studentId, studentId)];
  if (statusFilter) {
    conds.push(inArray(changeRequests.status, statusFilter.split(',')));
  }
  const rows = await db
    .select()
    .from(changeRequests)
    .where(and(...conds))
    .orderBy(desc(changeRequests.requestedAt));
  return c.json({ data: rows });
});

const ChangeRequestDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  counsellorNotes: z.string().optional(),
});

/**
 * POST /api/counsellor/change-requests/:id/decision
 *
 * Phase 3: records the decision and updates change_requests.status. The actual
 * task mutation (apply the change) is intentionally NOT done here — the
 * counsellor still has to manually update the task afterward via /api/tasks.
 * Phase 4 (Calendar Sync) will tie approval directly to a task transaction.
 */
counsellorScopedRoutes.post('/change-requests/:id/decision', idempotency, async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const body = ChangeRequestDecisionSchema.parse(await c.req.json());

  const cr = (
    await db.select().from(changeRequests).where(eq(changeRequests.id, id)).limit(1)
  )[0];
  if (!cr) throw Errors.notFound('change_request', id);
  await assertCounsellorOwnsStudent(auth.subjectId, cr.studentId);
  if (cr.status !== 'pending') {
    throw Errors.conflict(
      'CHANGE_REQUEST_ALREADY_DECIDED',
      `change_request is already ${cr.status}`,
    );
  }
  if (body.decision === 'rejected' && !body.counsellorNotes) {
    throw Errors.validation('counsellorNotes is required when rejecting');
  }
  const updated = await db
    .update(changeRequests)
    .set({
      status: body.decision,
      counsellorNotes: body.counsellorNotes ?? null,
      decidedAt: new Date(),
      decidedBy: auth.subjectId,
    })
    .where(eq(changeRequests.id, id))
    .returning();

  // Resolve any review_queue rows tied to this change_request.
  await db
    .update(reviewQueue)
    .set({
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedBy: auth.subjectId,
      resolutionNotes: `change_request ${body.decision}`,
    })
    .where(
      and(eq(reviewQueue.referenceId, id), eq(reviewQueue.type, 'change_request')),
    );

  return c.json(updated[0]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

const SettingsPatchSchema = z.object({
  timezone: z.string().optional(),
  workingHours: z.record(z.tuple([z.string(), z.string()])).optional(),
  notificationPreferences: z.record(z.unknown()).optional(),
});

counsellorScopedRoutes.patch('/settings', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const body = SettingsPatchSchema.parse(await c.req.json());
  const updated = await db
    .update(counsellors)
    .set({
      ...(body.timezone ? { timezone: body.timezone } : {}),
      ...(body.workingHours ? { workingHours: body.workingHours } : {}),
      ...(body.notificationPreferences
        ? { notificationPreferences: body.notificationPreferences }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(counsellors.id, auth.subjectId))
    .returning();
  return c.json(updated[0]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Bulk task operations + recurrence expansion
// ─────────────────────────────────────────────────────────────────────────────

const BulkActionSchema = z.object({
  taskIds: z.array(z.string().uuid()).min(1).max(100),
  action: z.enum(['cancel', 'reschedule_by_minutes']),
  /** Required when action === 'reschedule_by_minutes' */
  minutesDelta: z.number().int().optional(),
  reason: z.string().optional(),
});

counsellorScopedRoutes.post('/tasks/bulk', idempotency, async (c) => {
  const auth = requireRole(c, 'counsellor');
  const body = BulkActionSchema.parse(await c.req.json());

  const rows = await db.select().from(tasks).where(inArray(tasks.id, body.taskIds));
  if (rows.length !== body.taskIds.length) {
    throw Errors.validation('one or more tasks not found');
  }

  const studentIds = [...new Set(rows.map((r) => r.studentId))];
  for (const sid of studentIds) {
    await assertCounsellorOwnsStudent(auth.subjectId, sid);
  }

  if (body.action === 'cancel') {
    await db
      .update(tasks)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(inArray(tasks.id, body.taskIds));
    for (const tid of body.taskIds) await enqueueTaskSync(tid, 'delete');
    return c.json({ updated: body.taskIds.length, action: 'cancelled' });
  }

  // reschedule_by_minutes
  if (body.minutesDelta === undefined) {
    throw Errors.validation('minutesDelta is required for reschedule_by_minutes');
  }
  const ms = body.minutesDelta * 60_000;
  await db.transaction(async (tx) => {
    for (const r of rows) {
      if (r.status !== 'scheduled') continue; // immutability rule
      await tx
        .update(tasks)
        .set({
          scheduledStart: new Date(r.scheduledStart.getTime() + ms),
          scheduledEnd: new Date(r.scheduledEnd.getTime() + ms),
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, r.id));
    }
  });
  for (const r of rows) {
    if (r.status === 'scheduled') await enqueueTaskSync(r.id, 'update');
  }
  return c.json({ updated: rows.length, action: 'rescheduled_by_minutes' });
});

/**
 * POST /api/counsellor/tasks/recurring
 *
 * Create a recurrence series. The "parent" task is the first instance; the
 * system materializes additional instances for the next 4 weeks per
 * phase-1-foundation.md (Edge Cases — Recurring tasks). All instances share a
 * `recurrence_parent_id` pointing at the first row.
 */
const RecurrenceSchema = z.object({
  studentId: z.string().uuid(),
  /** First instance start; subsequent instances derived from this + pattern */
  scheduledStart: z.string().datetime(),
  scheduledEnd: z.string().datetime(),
  subject: SubjectSchema,
  taskTitle: z.string().min(1),
  taskDescription: z.string().optional(),
  expectedOutput: z.string().optional(),
  flexibility: TaskFlexibilitySchema.default('preferred'),
  source: TaskSourceSchema.default('counsellor_manual'),
  /** 'daily' | 'weekdays' | 'weekly' (same weekday) */
  pattern: z.enum(['daily', 'weekdays', 'weekly']),
  weeksAhead: z.number().int().min(1).max(8).default(4),
});

counsellorScopedRoutes.post('/tasks/recurring', idempotency, async (c) => {
  const auth = requireRole(c, 'counsellor');
  const body = RecurrenceSchema.parse(await c.req.json());
  await assertCounsellorOwnsStudent(auth.subjectId, body.studentId);

  const start = new Date(body.scheduledStart);
  const end = new Date(body.scheduledEnd);
  const durationMs = end.getTime() - start.getTime();

  // Generate occurrences
  const occurrences: Date[] = [];
  const horizon = new Date(start);
  horizon.setUTCDate(horizon.getUTCDate() + body.weeksAhead * 7);

  const cursor = new Date(start);
  while (cursor <= horizon) {
    const day = cursor.getUTCDay(); // 0=Sun … 6=Sat
    const isWeekday = day >= 1 && day <= 5;
    if (
      body.pattern === 'daily' ||
      (body.pattern === 'weekdays' && isWeekday) ||
      (body.pattern === 'weekly' && day === start.getUTCDay())
    ) {
      occurrences.push(new Date(cursor));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  if (occurrences.length === 0) {
    throw Errors.validation('recurrence pattern produced 0 occurrences');
  }

  const created = await db.transaction(async (tx) => {
    const [first] = await tx
      .insert(tasks)
      .values({
        studentId: body.studentId,
        scheduledStart: occurrences[0]!,
        scheduledEnd: new Date(occurrences[0]!.getTime() + durationMs),
        subject: body.subject,
        taskTitle: body.taskTitle,
        taskDescription: body.taskDescription ?? null,
        expectedOutput: body.expectedOutput ?? null,
        recurrencePattern: body.pattern,
        flexibility: body.flexibility,
        source: body.source,
      })
      .returning();
    if (!first) throw Errors.internal('failed to create first recurring instance');
    if (occurrences.length > 1) {
      await tx.insert(tasks).values(
        occurrences.slice(1).map((occ) => ({
          studentId: body.studentId,
          scheduledStart: occ,
          scheduledEnd: new Date(occ.getTime() + durationMs),
          subject: body.subject,
          taskTitle: body.taskTitle,
          taskDescription: body.taskDescription ?? null,
          expectedOutput: body.expectedOutput ?? null,
          recurrencePattern: body.pattern,
          recurrenceParentId: first.id,
          flexibility: body.flexibility,
          source: body.source,
        })),
      );
    }
    return { parentId: first.id, count: occurrences.length, allIds: [first.id] as string[] };
  });

  // Enqueue create for the parent. The Sync Worker can fan out to siblings via
  // recurrence_parent_id; for v1 we simply enqueue each row independently.
  // Re-fetch all sibling ids since the transaction returned only the parent.
  const siblings = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.recurrenceParentId, created.parentId));
  await enqueueTaskSync(created.parentId, 'create');
  for (const s of siblings) await enqueueTaskSync(s.id, 'create');

  return c.json({ parentId: created.parentId, count: created.count }, 201);
});
