import { Hono } from 'hono';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { completions, db, tasks } from '@wgc/db';
import { CompletionStatusClaimedSchema, Errors } from '@wgc/shared';
import type { AppEnv } from '../app.js';
import { requireRole } from '../middleware/auth.js';
import { idempotency } from '../middleware/idempotency.js';

const CreateCompletionSchema = z.object({
  taskId: z.string().uuid(),
  statusClaimed: CompletionStatusClaimedSchema,
  notesText: z.string().optional(),
  timeTakenMinutes: z.number().int().nonnegative().optional(),
  source: z
    .enum(['dashboard_form', 'whatsapp_text', 'whatsapp_voice', 'counsellor_manual_entry'])
    .default('counsellor_manual_entry'),
});

export const completionRoutes = new Hono<AppEnv>();

completionRoutes.get('/:taskId', async (c) => {
  requireRole(c, 'counsellor');
  const taskId = c.req.param('taskId');
  const rows = await db
    .select()
    .from(completions)
    .where(eq(completions.taskId, taskId))
    .orderBy(desc(completions.submittedAt));
  return c.json({ data: rows });
});

completionRoutes.post('/', idempotency, async (c) => {
  requireRole(c, 'counsellor');
  const body = CreateCompletionSchema.parse(await c.req.json());
  const taskRow = await db.select().from(tasks).where(eq(tasks.id, body.taskId)).limit(1);
  if (!taskRow[0]) throw Errors.notFound('task', body.taskId);
  const inserted = await db.insert(completions).values(body).returning();
  return c.json(inserted[0], 201);
});
