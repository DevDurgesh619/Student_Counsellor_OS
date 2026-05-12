import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db, students } from '@wgc/db';
import { Errors } from '@wgc/shared';
import type { AppEnv } from '../app.js';
import { requireRole } from '../middleware/auth.js';
import { idempotency } from '../middleware/idempotency.js';

const CreateStudentSchema = z.object({
  fullName: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().email().optional(),
  parentContacts: z
    .array(
      z.object({
        name: z.string().min(1),
        phone: z.string().optional(),
        email: z.string().email().optional(),
        relationship: z.enum(['father', 'mother', 'guardian', 'other']),
      }),
    )
    .default([]),
  counsellorId: z.string().uuid(),
  currentGrade: z.string().min(1),
  school: z.string().optional(),
  currentContextTag: z
    .enum(['school_term', 'summer', 'exam_prep', 'holiday'])
    .default('school_term'),
  timezone: z.string().default('Asia/Kolkata'),
});

const UpdateStudentSchema = CreateStudentSchema.partial();

export const studentRoutes = new Hono<AppEnv>();

studentRoutes.get('/', async (c) => {
  requireRole(c, 'counsellor');
  const auth = c.get('auth')!;
  const status = c.req.query('status');
  const where = status
    ? and(eq(students.counsellorId, auth.subjectId), eq(students.status, status))
    : eq(students.counsellorId, auth.subjectId);
  const rows = await db.select().from(students).where(where).orderBy(desc(students.createdAt));
  return c.json({ data: rows });
});

studentRoutes.get('/:id', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const row = await db.select().from(students).where(eq(students.id, id)).limit(1);
  if (!row[0]) throw Errors.notFound('student', id);
  if (row[0].counsellorId !== auth.subjectId) throw Errors.authForbidden();
  return c.json(row[0]);
});

studentRoutes.post('/', idempotency, async (c) => {
  requireRole(c, 'counsellor');
  const body = CreateStudentSchema.parse(await c.req.json());
  const inserted = await db.insert(students).values(body).returning();
  return c.json(inserted[0], 201);
});

studentRoutes.patch('/:id', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const existing = await db.select().from(students).where(eq(students.id, id)).limit(1);
  if (!existing[0]) throw Errors.notFound('student', id);
  if (existing[0].counsellorId !== auth.subjectId) throw Errors.authForbidden();
  const patch = UpdateStudentSchema.parse(await c.req.json());
  const updated = await db
    .update(students)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(students.id, id))
    .returning();
  return c.json(updated[0]);
});

/** Soft delete (sets status='archived'). Hard delete is a Phase 9 flow. */
studentRoutes.delete('/:id', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const existing = await db.select().from(students).where(eq(students.id, id)).limit(1);
  if (!existing[0]) throw Errors.notFound('student', id);
  if (existing[0].counsellorId !== auth.subjectId) throw Errors.authForbidden();
  const updated = await db
    .update(students)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(eq(students.id, id))
    .returning();
  return c.json(updated[0]);
});
