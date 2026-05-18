import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  artifacts,
  changeRequests,
  completions,
  counsellors,
  db,
  recurrenceGroups,
  reviewQueue,
  sessions as sessionsTable,
  spinachIngestedMeetings,
  studentHistorySummaries,
  students,
  tasks,
  timetableConversations,
} from '@wgc/db';
import { Errors, SubjectSchema, TaskFlexibilitySchema, TaskSourceSchema } from '@wgc/shared';
import type { AppEnv } from '../app.js';
import { requireRole } from '../middleware/auth.js';
import { idempotency } from '../middleware/idempotency.js';
import { enqueueTaskSync } from '../lib/sync-outbox.js';
import { backfillStudentSpinach, pollOneCounsellor } from '../lib/spinach-poll.js';
import { markStudentBriefsForRefresh } from '../lib/meeting-prep.js';
import { logger } from '../logger.js';
import { listSummaryVersions } from '../lib/student-history.js';
import { runEditorTurn } from './timetable-editor.js';

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
      case 'partial':
        cur.partial = row.count;
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
 * GET /api/counsellor/spinach/recent-activity
 *
 * Single endpoint powering the counsellor home page's "Recent Spinach
 * activity" panel. Without this the counsellor only sees results (new
 * sessions on a student) — never the act of syncing, so silent successes
 * read as failures. Returns the last 20 ingested meetings + the next
 * scheduled session + the last-sync watermark.
 */
counsellorScopedRoutes.get('/spinach/recent-activity', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const counsellorRow = (
    await db
      .select({ spinachLastSyncedAt: counsellors.spinachLastSyncedAt })
      .from(counsellors)
      .where(eq(counsellors.id, auth.subjectId))
      .limit(1)
  )[0];

  // LEFT JOIN sessions so matched items carry the student + session id.
  // Unmatched (status='unassigned') rows still surface with student=null
  // so the counsellor can jump to the inbox.
  const ingestedRows = await db
    .select({
      ingestId: spinachIngestedMeetings.id,
      title: spinachIngestedMeetings.title,
      scheduledAt: spinachIngestedMeetings.scheduledAt,
      fetchedAt: spinachIngestedMeetings.fetchedAt,
      status: spinachIngestedMeetings.status,
      sessionId: spinachIngestedMeetings.linkedSessionId,
      studentId: sessionsTable.studentId,
    })
    .from(spinachIngestedMeetings)
    .leftJoin(
      sessionsTable,
      eq(sessionsTable.id, spinachIngestedMeetings.linkedSessionId),
    )
    .where(
      and(
        eq(spinachIngestedMeetings.counsellorId, auth.subjectId),
        gte(spinachIngestedMeetings.fetchedAt, sevenDaysAgo),
      ),
    )
    .orderBy(desc(spinachIngestedMeetings.fetchedAt))
    .limit(20);

  // Resolve student names in one shot.
  const studentIds = [
    ...new Set(ingestedRows.map((r) => r.studentId).filter((x): x is string => Boolean(x))),
  ];
  const studentRows = studentIds.length
    ? await db
        .select({ id: students.id, fullName: students.fullName })
        .from(students)
        .where(inArray(students.id, studentIds))
    : [];
  const studentById = new Map(studentRows.map((s) => [s.id, s.fullName]));

  // Next scheduled session across all assigned students.
  const next = (
    await db
      .select({
        id: sessionsTable.id,
        studentId: sessionsTable.studentId,
        scheduledAt: sessionsTable.scheduledAt,
        studentName: students.fullName,
      })
      .from(sessionsTable)
      .innerJoin(students, eq(students.id, sessionsTable.studentId))
      .where(
        and(
          eq(students.counsellorId, auth.subjectId),
          eq(sessionsTable.status, 'scheduled'),
          gte(sessionsTable.scheduledAt, now),
        ),
      )
      .orderBy(asc(sessionsTable.scheduledAt))
      .limit(1)
  )[0];

  return c.json({
    lastSyncedAt: counsellorRow?.spinachLastSyncedAt ?? null,
    nextScheduledSession: next
      ? {
          sessionId: next.id,
          studentId: next.studentId,
          studentName: next.studentName,
          scheduledAt: next.scheduledAt,
        }
      : null,
    items: ingestedRows.map((r) => ({
      ingestId: r.ingestId,
      title: r.title,
      scheduledAt: r.scheduledAt,
      fetchedAt: r.fetchedAt,
      status: r.status,
      sessionId: r.sessionId,
      student: r.studentId
        ? { id: r.studentId, fullName: studentById.get(r.studentId) ?? null }
        : null,
    })),
  });
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

/**
 * GET /api/counsellor/students/:id/history-summary
 *
 * The rolling longitudinal summary plus its version history. This is the
 * counsellor's window into the system's long-term memory of the student —
 * regenerated after every meeting ingest, fed into every brief.
 */
counsellorScopedRoutes.get('/students/:id/history-summary', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.param('id');
  await assertCounsellorOwnsStudent(auth.subjectId, studentId);

  const current = (
    await db
      .select()
      .from(studentHistorySummaries)
      .where(eq(studentHistorySummaries.studentId, studentId))
      .limit(1)
  )[0];

  const versions = await listSummaryVersions(studentId);
  return c.json({ current: current ?? null, versions });
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
  // Reschedule → bump the brief refresh signal so Pass B regenerates at
  // the new T-24h window with up-to-date context.
  if (patch.scheduledAt) {
    markStudentBriefsForRefresh(studentId).catch((err) =>
      logger.warn({ err, studentId }, 'markStudentBriefsForRefresh failed (non-fatal)'),
    );
  }
  return c.json(updated[0]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Spinach backfill — import a student's historical meetings on demand
// ─────────────────────────────────────────────────────────────────────────────

const SpinachBackfillSchema = z.object({
  lookbackDays: z.number().int().positive().max(730).optional(),
});

/**
 * POST /api/counsellor/students/:id/spinach-backfill
 *
 * Opt-in: walks the counsellor's full Spinach history, finds meetings
 * auto-matched to this student, ingests them chronologically. Active
 * students only — archived/pending shouldn't burn LLM budget.
 *
 * Synchronous; takes 30s–2min for typical 8–10 meetings. The endpoint
 * returns the counts (imported / skipped / failed) so the UI can render
 * a friendly summary.
 */
/**
 * POST /api/counsellor/students/:id/spinach-refresh
 *
 * Counsellor-triggered focused poll. Runs `pollOneCounsellor` (which is
 * counsellor-wide because that's what Spinach's MCP supports) and reports
 * how many of the new sessions landed on THIS student specifically. Used
 * by the "Refresh from Spinach" button on the student Sessions tab.
 *
 * Rate-limited per (counsellor, student) — at most one call per 30s,
 * because the Spinach API itself has per-second limits and counsellors
 * may double-click. Cheap in-memory dedup; if we ever multi-instance
 * this we'd need a shared store, but at our scale this is fine.
 */
const spinachRefreshTimes = new Map<string, number>();
counsellorScopedRoutes.post('/students/:id/spinach-refresh', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.param('id');
  await assertCounsellorOwnsStudent(auth.subjectId, studentId);

  const key = `${auth.subjectId}:${studentId}`;
  const last = spinachRefreshTimes.get(key);
  if (last && Date.now() - last < 30_000) {
    throw Errors.conflict(
      'SPINACH_REFRESH_RATE_LIMITED',
      'Please wait a few seconds between refreshes.',
    );
  }
  spinachRefreshTimes.set(key, Date.now());

  // Count sessions BEFORE the poll, so we can derive how many landed for
  // this student in the call. Cheap — limit to the last 24h.
  const sinceCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const before = await db
    .select({ id: sessionsTable.id })
    .from(sessionsTable)
    .where(
      and(
        eq(sessionsTable.studentId, studentId),
        gte(sessionsTable.scheduledAt, sinceCutoff),
      ),
    );
  const beforeIds = new Set(before.map((r) => r.id));

  const result = await pollOneCounsellor(auth.subjectId);

  const after = await db
    .select({ id: sessionsTable.id })
    .from(sessionsTable)
    .where(
      and(
        eq(sessionsTable.studentId, studentId),
        gte(sessionsTable.scheduledAt, sinceCutoff),
      ),
    );
  const addedForThisStudent = after.filter((r) => !beforeIds.has(r.id)).length;

  return c.json({
    data: { ...result, addedForThisStudent },
  });
});

counsellorScopedRoutes.post('/students/:id/spinach-backfill', idempotency, async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.param('id');
  await assertCounsellorOwnsStudent(auth.subjectId, studentId);

  const studentRow = (
    await db.select({ status: students.status }).from(students).where(eq(students.id, studentId)).limit(1)
  )[0];
  if (!studentRow) throw Errors.notFound('student', studentId);
  if (studentRow.status !== 'active') {
    throw Errors.conflict(
      'STUDENT_NOT_ACTIVE',
      'Backfill is only available for active students',
    );
  }

  const body = SpinachBackfillSchema.parse(await c.req.json().catch(() => ({})));
  const result = await backfillStudentSpinach(auth.subjectId, studentId, {
    lookbackDays: body.lookbackDays,
  });
  return c.json(result);
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

  // Hydrate target task + recurrence group for task_change rows so the
  // counsellor UI can show "Math AI Wed 8am · recurring" without a second
  // roundtrip per request.
  const taskIds = rows
    .filter((r) => r.kind === 'task_change' && r.originalTaskId)
    .map((r) => r.originalTaskId as string);
  const groupIds = rows
    .filter((r) => r.targetRecurrenceGroupId)
    .map((r) => r.targetRecurrenceGroupId as string);
  const taskRows = taskIds.length
    ? await db
        .select({
          id: tasks.id,
          subject: tasks.subject,
          taskTitle: tasks.taskTitle,
          scheduledStart: tasks.scheduledStart,
          scheduledEnd: tasks.scheduledEnd,
          status: tasks.status,
          recurrenceGroupId: tasks.recurrenceGroupId,
        })
        .from(tasks)
        .where(inArray(tasks.id, taskIds))
    : [];
  const groupRows = groupIds.length
    ? await db
        .select({
          id: recurrenceGroups.id,
          ruleJson: recurrenceGroups.ruleJson,
          startsOn: recurrenceGroups.startsOn,
          endsOn: recurrenceGroups.endsOn,
        })
        .from(recurrenceGroups)
        .where(inArray(recurrenceGroups.id, groupIds))
    : [];
  const taskById = new Map(taskRows.map((t) => [t.id, t]));
  const groupById = new Map(groupRows.map((g) => [g.id, g]));
  const data = rows.map((r) => ({
    ...r,
    targetTask: r.originalTaskId ? (taskById.get(r.originalTaskId) ?? null) : null,
    targetRecurrenceGroup: r.targetRecurrenceGroupId
      ? (groupById.get(r.targetRecurrenceGroupId) ?? null)
      : null,
  }));
  return c.json({ data });
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

/**
 * POST /api/counsellor/change-requests/:id/open-in-editor
 *
 * Bridges a structured task_change request into the conversational timetable
 * editor: creates a conversation (stamped with seed_request_id), seeds it
 * with a counsellor-authored prose turn summarising the request, runs
 * Worker 4b to generate a draft proposal, and marks the request approved.
 * Idempotent — re-invocations on a request that already has
 * linked_conversation_id return the existing conversation id instead of
 * spawning a duplicate.
 */
counsellorScopedRoutes.post(
  '/change-requests/:id/open-in-editor',
  idempotency,
  async (c) => {
    const auth = requireRole(c, 'counsellor');
    const id = c.req.param('id');

    const cr = (
      await db.select().from(changeRequests).where(eq(changeRequests.id, id)).limit(1)
    )[0];
    if (!cr) throw Errors.notFound('change_request', id);
    await assertCounsellorOwnsStudent(auth.subjectId, cr.studentId);
    if (cr.kind !== 'task_change') {
      throw Errors.conflict(
        'CHANGE_REQUEST_NOT_TASK_CHANGE',
        'Only task_change requests can be opened in the editor. General requests must be handled manually.',
      );
    }
    // Idempotency: same request opened twice (double-click, retry) returns
    // the existing conversation. The status check below skips because cr
    // is already 'approved' after a successful first call.
    if (cr.linkedConversationId) {
      return c.json({ conversationId: cr.linkedConversationId, reused: true });
    }
    if (cr.status !== 'pending') {
      throw Errors.conflict(
        'CHANGE_REQUEST_ALREADY_DECIDED',
        `change_request is already ${cr.status}`,
      );
    }

    // Build the seed prose. We resolve the target task + recurrence rule
    // here so the LLM doesn't have to infer the time-window from history
    // alone — it gets a self-contained brief.
    const task = cr.originalTaskId
      ? (
          await db
            .select()
            .from(tasks)
            .where(eq(tasks.id, cr.originalTaskId))
            .limit(1)
        )[0]
      : undefined;
    const group = cr.targetRecurrenceGroupId
      ? (
          await db
            .select()
            .from(recurrenceGroups)
            .where(eq(recurrenceGroups.id, cr.targetRecurrenceGroupId))
            .limit(1)
        )[0]
      : task?.recurrenceGroupId
        ? (
            await db
              .select()
              .from(recurrenceGroups)
              .where(eq(recurrenceGroups.id, task.recurrenceGroupId))
              .limit(1)
          )[0]
        : undefined;
    const student = (
      await db.select().from(students).where(eq(students.id, cr.studentId)).limit(1)
    )[0];
    const tz = student?.timezone || 'Asia/Kolkata';

    const taskLine = task
      ? `${task.subject} · ${task.taskTitle} · ${formatTaskTime(task.scheduledStart, task.scheduledEnd, tz)}`
      : '(no task linked)';
    const recurrenceLine = group
      ? `${describeRule(group.ruleJson)} from ${group.startsOn} to ${group.endsOn}`
      : 'one-off';
    const proposedLine =
      cr.proposedStart && cr.proposedEnd
        ? formatTaskTime(cr.proposedStart, cr.proposedEnd, tz)
        : 'unspecified — counsellor to decide';
    const seedBody = [
      `Student request (auto-seeded from request ${id}):`,
      '',
      `Target task: ${taskLine} (timezone ${tz})`,
      `Recurrence: ${recurrenceLine}`,
      `Scope requested: ${cr.scope ?? 'unspecified'}`,
      `Proposed new slot: ${proposedLine}`,
      `Student's words: "${cr.proposedChange}"`,
      `Reason: "${cr.reason}"`,
      '',
      "Please propose the minimal operations to fulfil this. If scope=recurring, edit_recurrence; if scope=single, move_task / cancel_task / create_task as needed.",
    ].join('\n');

    // Create the conversation BEFORE marking the request approved. If the
    // worker fails the conversation persists (counsellor can continue
    // manually) but the request stays pending so the queue still flags it.
    const titleHint = task
      ? `Request: ${task.subject} ${cr.scope ?? ''}`.trim()
      : `Request: ${cr.proposedChange.slice(0, 40)}`;
    const conv = (
      await db
        .insert(timetableConversations)
        .values({
          counsellorId: auth.subjectId,
          studentId: cr.studentId,
          title: titleHint,
          isBootstrap: false,
          seedRequestId: id,
        })
        .returning()
    )[0]!;

    const result = await runEditorTurn({
      conv,
      counsellorId: auth.subjectId,
      content: seedBody,
    });

    if (result.error) {
      // Worker died — keep the conversation + seed message so the counsellor
      // can retry inside the chat, but DO NOT flip the request to approved.
      // We still record the conversation linkage so the next open-in-editor
      // call is idempotent (reuses the same conversation).
      await db
        .update(changeRequests)
        .set({ linkedConversationId: conv.id })
        .where(eq(changeRequests.id, id));
      throw Errors.internal(result.error);
    }

    // Worker succeeded (with or without operations). Mark approved and
    // link the conversation; resolved_at stays NULL until Apply.
    await db
      .update(changeRequests)
      .set({
        status: 'approved',
        decidedAt: new Date(),
        decidedBy: auth.subjectId,
        linkedConversationId: conv.id,
      })
      .where(eq(changeRequests.id, id));

    // Resolve any review_queue rows tied to this request (matches the
    // plain-decision endpoint's behaviour).
    await db
      .update(reviewQueue)
      .set({
        status: 'resolved',
        resolvedAt: new Date(),
        resolvedBy: auth.subjectId,
        resolutionNotes: 'change_request opened in editor',
      })
      .where(and(eq(reviewQueue.referenceId, id), eq(reviewQueue.type, 'change_request')));

    return c.json({
      conversationId: conv.id,
      reused: false,
      proposedChangeId: result.proposedChange?.id,
      assistantMessageId: result.assistantMessage?.id,
    });
  },
);

function describeRule(rule: { frequency: string; days_of_week: number[]; start_time: string; duration_min: number }): string {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = rule.days_of_week.map((d) => dayNames[d] ?? d).join('/');
  return `${rule.frequency} ${days} at ${rule.start_time} (${rule.duration_min}min)`;
}

function formatTaskTime(start: Date, end: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const endFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${fmt.format(start)} – ${endFmt.format(end)}`;
}

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
