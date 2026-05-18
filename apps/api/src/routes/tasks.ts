import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import {
  db,
  students,
  tasks,
  timetableChanges,
  type TimetableOp,
} from '@wgc/db';
import { Errors, SubjectSchema, TaskFlexibilitySchema, TaskSourceSchema } from '@wgc/shared';
import type { AppEnv } from '../app.js';
import { requireRole } from '../middleware/auth.js';
import { idempotency } from '../middleware/idempotency.js';
import { applyChange } from '../lib/timetable-engine.js';

const CreateTaskSchema = z.object({
  studentId: z.string().uuid(),
  scheduledStart: z.string().datetime(),
  scheduledEnd: z.string().datetime(),
  subject: SubjectSchema,
  taskTitle: z.string().min(1),
  taskDescription: z.string().optional(),
  expectedOutput: z.string().optional(),
  recurrencePattern: z.string().optional(),
  source: TaskSourceSchema.default('counsellor_manual'),
  flexibility: TaskFlexibilitySchema.default('preferred'),
  verificationRequired: z.boolean().default(false),
});

const UpdateTaskSchema = CreateTaskSchema.partial().omit({ studentId: true });

export const taskRoutes = new Hono<AppEnv>();

/** GET /api/tasks?studentId&start&end — list tasks within date range. */
taskRoutes.get('/', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.query('studentId');
  if (!studentId) throw Errors.validation('studentId query param is required');

  const studentRow = await db
    .select({ counsellorId: students.counsellorId })
    .from(students)
    .where(eq(students.id, studentId))
    .limit(1);
  if (!studentRow[0]) throw Errors.notFound('student', studentId);
  if (studentRow[0].counsellorId !== auth.subjectId) throw Errors.authForbidden();

  const start = c.req.query('start');
  const end = c.req.query('end');
  const conds = [eq(tasks.studentId, studentId)];
  if (start) conds.push(gte(tasks.scheduledStart, new Date(start)));
  if (end) conds.push(lte(tasks.scheduledEnd, new Date(end)));

  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conds))
    .orderBy(asc(tasks.scheduledStart));

  return c.json({ data: rows });
});

/**
 * Helper: create a draft timetable_changes row + apply it. Wraps the audit
 * boilerplate so each route stays a one-liner. Returns the change id so
 * callers can fetch the resulting task(s).
 */
async function createAndApplyChange(
  studentId: string,
  subjectId: string,
  ops: TimetableOp[],
  rationale?: string,
): Promise<string> {
  const inserted = (
    await db
      .insert(timetableChanges)
      .values({
        studentId,
        source: 'counsellor_direct',
        operations: ops,
        rationale: rationale ?? null,
        createdBySubjectId: subjectId,
        createdByRole: 'counsellor',
      })
      .returning({ id: timetableChanges.id })
  )[0];
  if (!inserted) throw Errors.internal('failed to create timetable_change row');
  await applyChange(inserted.id);
  return inserted.id;
}

taskRoutes.post('/', idempotency, async (c) => {
  const auth = requireRole(c, 'counsellor');
  const body = CreateTaskSchema.parse(await c.req.json());
  const studentRow = await db
    .select({ counsellorId: students.counsellorId })
    .from(students)
    .where(eq(students.id, body.studentId))
    .limit(1);
  if (!studentRow[0]) throw Errors.notFound('student', body.studentId);
  if (studentRow[0].counsellorId !== auth.subjectId) throw Errors.authForbidden();

  const changeId = await createAndApplyChange(body.studentId, auth.subjectId, [
    {
      op: 'create_task',
      payload: {
        scheduled_start: body.scheduledStart,
        scheduled_end: body.scheduledEnd,
        subject: body.subject,
        task_title: body.taskTitle,
        task_description: body.taskDescription ?? null,
        expected_output: body.expectedOutput ?? null,
        flexibility: body.flexibility,
      },
    },
  ]);

  // Return the freshly-created task for backwards compat with the existing client.
  const created = (
    await db
      .select()
      .from(tasks)
      .where(eq(tasks.generatedFromChangeId, changeId))
      .limit(1)
  )[0];
  return c.json(created, 201);
});

/**
 * PATCH /api/tasks/:id — only allowed when status='scheduled' (immutability rule
 * from phase-1-foundation.md). Reschedules go through POST /:id/reschedule.
 */
taskRoutes.patch('/:id', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const existing = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!existing[0]) throw Errors.notFound('task', id);

  // Authorize via the parent student's counsellor.
  const studentRow = await db
    .select({ counsellorId: students.counsellorId })
    .from(students)
    .where(eq(students.id, existing[0].studentId))
    .limit(1);
  if (studentRow[0]?.counsellorId !== auth.subjectId) throw Errors.authForbidden();

  if (existing[0].status !== 'scheduled') {
    throw Errors.conflict(
      'TASK_IMMUTABLE',
      'Tasks are immutable once status changes from scheduled. Use POST /api/tasks/:id/reschedule.',
    );
  }

  const patch = UpdateTaskSchema.parse(await c.req.json());
  const ops: TimetableOp[] = [];
  // Time changes route through move_task (supersedes); everything else
  // through edit_task (in-place, with audit).
  const wantsMove =
    patch.scheduledStart !== undefined || patch.scheduledEnd !== undefined;
  if (wantsMove) {
    ops.push({
      op: 'move_task',
      payload: {
        task_id: id,
        new_start: patch.scheduledStart ?? existing[0].scheduledStart.toISOString(),
        new_end: patch.scheduledEnd ?? existing[0].scheduledEnd.toISOString(),
      },
    });
  }
  const nonTime = {
    subject: patch.subject,
    task_title: patch.taskTitle,
    task_description: patch.taskDescription,
    expected_output: patch.expectedOutput,
    flexibility: patch.flexibility,
    verification_required: patch.verificationRequired,
  };
  const hasNonTime = Object.values(nonTime).some((v) => v !== undefined);
  if (hasNonTime && !wantsMove) {
    ops.push({ op: 'edit_task', payload: { task_id: id, changes: nonTime } });
  } else if (hasNonTime && wantsMove) {
    // After a move, the *new* task id is unknown until applyChange resolves.
    // For now we apply move first and let edit_task fold into the next change
    // on the resurfaced row — keeps the engine simple. The caller almost
    // never combines time + field edits in one PATCH.
    // Apply move; then run a second change for the field edits against the
    // new task row.
  }

  if (ops.length === 0) {
    return c.json(existing[0]);
  }

  const changeId = await createAndApplyChange(existing[0].studentId, auth.subjectId, ops);

  if (hasNonTime && wantsMove) {
    // Find the resurfaced new task and apply the field edits to it.
    const moved = (
      await db
        .select()
        .from(tasks)
        .where(eq(tasks.generatedFromChangeId, changeId))
        .limit(1)
    )[0];
    if (moved) {
      await createAndApplyChange(existing[0].studentId, auth.subjectId, [
        { op: 'edit_task', payload: { task_id: moved.id, changes: nonTime } },
      ]);
    }
  }

  // Return the now-current task — either the resurfaced new row (if move
  // happened) or the in-place updated row.
  const current = wantsMove
    ? (
        await db
          .select()
          .from(tasks)
          .where(eq(tasks.generatedFromChangeId, changeId))
          .limit(1)
      )[0]
    : (await db.select().from(tasks).where(eq(tasks.id, id)).limit(1))[0];
  return c.json(current);
});

const RescheduleSchema = z.object({
  newScheduledStart: z.string().datetime(),
  newScheduledEnd: z.string().datetime(),
});

taskRoutes.post('/:id/reschedule', idempotency, async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const existing = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!existing[0]) throw Errors.notFound('task', id);

  const studentRow = await db
    .select({ counsellorId: students.counsellorId })
    .from(students)
    .where(eq(students.id, existing[0].studentId))
    .limit(1);
  if (studentRow[0]?.counsellorId !== auth.subjectId) throw Errors.authForbidden();

  const body = RescheduleSchema.parse(await c.req.json());
  const changeId = await createAndApplyChange(existing[0].studentId, auth.subjectId, [
    {
      op: 'move_task',
      payload: { task_id: id, new_start: body.newScheduledStart, new_end: body.newScheduledEnd },
    },
  ]);
  const created = (
    await db
      .select()
      .from(tasks)
      .where(eq(tasks.generatedFromChangeId, changeId))
      .limit(1)
  )[0];
  return c.json(created, 201);
});

/** DELETE /api/tasks/:id — soft-cancel (status='cancelled'). */
taskRoutes.delete('/:id', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const existing = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!existing[0]) throw Errors.notFound('task', id);
  const studentRow = await db
    .select({ counsellorId: students.counsellorId })
    .from(students)
    .where(eq(students.id, existing[0].studentId))
    .limit(1);
  if (studentRow[0]?.counsellorId !== auth.subjectId) throw Errors.authForbidden();

  await createAndApplyChange(existing[0].studentId, auth.subjectId, [
    { op: 'cancel_task', payload: { task_id: id } },
  ]);
  const updated = (await db.select().from(tasks).where(eq(tasks.id, id)).limit(1))[0];
  return c.json(updated);
});
