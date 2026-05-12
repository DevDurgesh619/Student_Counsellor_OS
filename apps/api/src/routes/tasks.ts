import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { db, students, tasks } from '@wgc/db';
import { Errors, SubjectSchema, TaskFlexibilitySchema, TaskSourceSchema } from '@wgc/shared';
import type { AppEnv } from '../app.js';
import { requireRole } from '../middleware/auth.js';
import { idempotency } from '../middleware/idempotency.js';
import { enqueueTaskSync } from '../lib/sync-outbox.js';

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

  const inserted = await db
    .insert(tasks)
    .values({
      ...body,
      scheduledStart: new Date(body.scheduledStart),
      scheduledEnd: new Date(body.scheduledEnd),
    })
    .returning();
  if (inserted[0]) await enqueueTaskSync(inserted[0].id, 'create');
  return c.json(inserted[0], 201);
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
  const { scheduledStart, scheduledEnd, ...rest } = patch;
  const updated = await db
    .update(tasks)
    .set({
      ...rest,
      ...(scheduledStart ? { scheduledStart: new Date(scheduledStart) } : {}),
      ...(scheduledEnd ? { scheduledEnd: new Date(scheduledEnd) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id))
    .returning();
  await enqueueTaskSync(id, 'update');
  return c.json(updated[0]);
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

  // Atomic: mark old as 'rescheduled', insert new row pointing back via rescheduledFromId.
  const result = await db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({ status: 'rescheduled', updatedAt: new Date() })
      .where(eq(tasks.id, id));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _oldId, createdAt: _c, updatedAt: _u, ...rest } = existing[0]!;
    const inserted = await tx
      .insert(tasks)
      .values({
        ...rest,
        scheduledStart: new Date(body.newScheduledStart),
        scheduledEnd: new Date(body.newScheduledEnd),
        status: 'scheduled',
        rescheduledFromId: id,
      })
      .returning();
    return inserted[0];
  });
  // Old task → delete event; new task → create event.
  await enqueueTaskSync(id, 'delete');
  if (result) await enqueueTaskSync(result.id, 'create');
  return c.json(result, 201);
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
  const updated = await db
    .update(tasks)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(tasks.id, id))
    .returning();
  await enqueueTaskSync(id, 'delete');
  return c.json(updated[0]);
});
