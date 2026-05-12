import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { counsellors, db } from '@wgc/db';
import { Errors } from '@wgc/shared';
import type { AppEnv } from '../app.js';
import { requireRole } from '../middleware/auth.js';
import { idempotency } from '../middleware/idempotency.js';

const CreateCounsellorSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  timezone: z.string().default('Asia/Kolkata'),
});

export const counsellorRoutes = new Hono<AppEnv>();

counsellorRoutes.get('/', async (c) => {
  requireRole(c, 'counsellor');
  const rows = await db.select().from(counsellors);
  return c.json({ data: rows });
});

counsellorRoutes.get('/:id', async (c) => {
  requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const row = await db.select().from(counsellors).where(eq(counsellors.id, id)).limit(1);
  if (!row[0]) throw Errors.notFound('counsellor', id);
  return c.json(row[0]);
});

/**
 * Counsellor creation is admin-only in v1; gated to a special bootstrap email
 * for the first row. After Phase 9 rolls in proper admin role, swap to
 * `requireRole(c, 'admin')`.
 */
counsellorRoutes.post('/', idempotency, async (c) => {
  requireRole(c, 'counsellor');
  const body = CreateCounsellorSchema.parse(await c.req.json());
  const inserted = await db.insert(counsellors).values(body).returning();
  return c.json(inserted[0], 201);
});
