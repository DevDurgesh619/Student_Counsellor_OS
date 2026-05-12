import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  artifacts,
  changeRequests,
  completions,
  conversations,
  db,
  reports,
  students,
  tasks,
} from '@wgc/db';
import { CompletionStatusClaimedSchema, Errors } from '@wgc/shared';
import { loadEnv } from '@wgc/config';
import type { AppEnv } from '../app.js';
import { requireRole } from '../middleware/auth.js';
import { idempotency } from '../middleware/idempotency.js';

export const studentScopedRoutes = new Hono<AppEnv>();

const ARTIFACT_BUCKET = 'artifacts';
const MAX_BYTES = 50 * 1024 * 1024;

let storageClient: SupabaseClient | null = null;
function getStorage(): SupabaseClient {
  if (storageClient) return storageClient;
  const env = loadEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw Errors.internal('Supabase storage not configured');
  }
  storageClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return storageClient;
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

studentScopedRoutes.get('/tasks', async (c) => {
  const auth = requireRole(c, 'student');
  const date = c.req.query('date');
  const startDate = c.req.query('startDate');
  const endDate = c.req.query('endDate');

  const conds = [eq(tasks.studentId, auth.subjectId)];
  if (date) {
    const day = new Date(`${date}T00:00:00.000Z`);
    const next = new Date(day.getTime() + 86_400_000);
    conds.push(gte(tasks.scheduledStart, day));
    conds.push(lte(tasks.scheduledStart, next));
  } else if (startDate && endDate) {
    conds.push(gte(tasks.scheduledStart, new Date(`${startDate}T00:00:00.000Z`)));
    conds.push(lte(tasks.scheduledStart, new Date(`${endDate}T23:59:59.999Z`)));
  }

  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conds))
    .orderBy(asc(tasks.scheduledStart));
  return c.json({ data: rows });
});

studentScopedRoutes.get('/tasks/:id', async (c) => {
  const auth = requireRole(c, 'student');
  const id = c.req.param('id');
  const row = (await db.select().from(tasks).where(eq(tasks.id, id)).limit(1))[0];
  if (!row) throw Errors.notFound('task', id);
  if (row.studentId !== auth.subjectId) throw Errors.authForbidden();

  const completionsRows = await db
    .select()
    .from(completions)
    .where(eq(completions.taskId, id))
    .orderBy(desc(completions.submittedAt));

  const artifactRows = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, id))
    .orderBy(desc(artifacts.uploadedAt));

  return c.json({ task: row, completions: completionsRows, artifacts: artifactRows });
});

const CompletionSchema = z.object({
  statusClaimed: CompletionStatusClaimedSchema,
  notesText: z.string().optional(),
  timeTakenMinutes: z.number().int().nonnegative().optional(),
});

studentScopedRoutes.post('/tasks/:id/completions', idempotency, async (c) => {
  const auth = requireRole(c, 'student');
  const id = c.req.param('id');
  const row = (await db.select().from(tasks).where(eq(tasks.id, id)).limit(1))[0];
  if (!row) throw Errors.notFound('task', id);
  if (row.studentId !== auth.subjectId) throw Errors.authForbidden();

  const body = CompletionSchema.parse(await c.req.json());
  const inserted = await db
    .insert(completions)
    .values({
      taskId: id,
      statusClaimed: body.statusClaimed,
      notesText: body.notesText ?? null,
      timeTakenMinutes: body.timeTakenMinutes ?? null,
      source: 'dashboard_form',
    })
    .returning();

  // Mirror the task.status to the latest claim so the schedule view reflects it.
  const taskStatus =
    body.statusClaimed === 'done'
      ? 'completed'
      : body.statusClaimed === 'partial'
        ? 'completed'
        : body.statusClaimed === 'skipped'
          ? 'skipped'
          : 'couldnt_do';
  await db
    .update(tasks)
    .set({ status: taskStatus, updatedAt: new Date() })
    .where(eq(tasks.id, id));

  return c.json(inserted[0], 201);
});

// ─── Artifacts ───────────────────────────────────────────────────────────────

const SignSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive().max(MAX_BYTES),
});

studentScopedRoutes.post('/artifacts/upload-url', idempotency, async (c) => {
  const auth = requireRole(c, 'student');
  const body = SignSchema.parse(await c.req.json());
  const objectId = crypto.randomUUID();
  const safe = body.filename.replace(/[^A-Za-z0-9._-]/g, '_');
  const path = `students/${auth.subjectId}/artifacts/${objectId}/${safe}`;

  const { data, error } = await getStorage()
    .storage.from(ARTIFACT_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) throw Errors.internal(`Failed to create signed URL: ${error?.message}`);
  return c.json({
    uploadUrl: data.signedUrl,
    storagePath: path,
    token: data.token,
    bucket: ARTIFACT_BUCKET,
  });
});

const ConfirmSchema = z.object({
  taskId: z.string().uuid().optional(),
  fileUrl: z.string().min(1),
  fileType: z.string().min(1),
  fileSizeBytes: z.number().int().positive().max(MAX_BYTES),
  originalFilename: z.string().optional(),
});

studentScopedRoutes.post('/artifacts', idempotency, async (c) => {
  const auth = requireRole(c, 'student');
  const body = ConfirmSchema.parse(await c.req.json());
  const inserted = await db
    .insert(artifacts)
    .values({
      studentId: auth.subjectId,
      taskId: body.taskId ?? null,
      fileUrl: body.fileUrl,
      fileType: body.fileType,
      fileSizeBytes: body.fileSizeBytes,
      originalFilename: body.originalFilename ?? null,
      source: 'dashboard_upload',
    })
    .returning();
  return c.json(inserted[0], 201);
});

studentScopedRoutes.get('/artifacts', async (c) => {
  const auth = requireRole(c, 'student');
  const rows = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.studentId, auth.subjectId))
    .orderBy(desc(artifacts.uploadedAt))
    .limit(100);
  return c.json({ data: rows });
});

// ─── Change requests ─────────────────────────────────────────────────────────

const ChangeRequestSchema = z.object({
  originalTaskId: z.string().uuid().optional(),
  patternDescription: z.string().optional(),
  proposedChange: z.string().min(1),
  reason: z.string().min(1),
});

studentScopedRoutes.post('/change-requests', idempotency, async (c) => {
  const auth = requireRole(c, 'student');
  const body = ChangeRequestSchema.parse(await c.req.json());
  const inserted = await db
    .insert(changeRequests)
    .values({
      studentId: auth.subjectId,
      originalTaskId: body.originalTaskId ?? null,
      patternDescription: body.patternDescription ?? null,
      proposedChange: body.proposedChange,
      reason: body.reason,
    })
    .returning();
  return c.json(inserted[0], 201);
});

studentScopedRoutes.get('/change-requests', async (c) => {
  const auth = requireRole(c, 'student');
  const rows = await db
    .select()
    .from(changeRequests)
    .where(eq(changeRequests.studentId, auth.subjectId))
    .orderBy(desc(changeRequests.requestedAt));
  return c.json({ data: rows });
});

// ─── Reports ─────────────────────────────────────────────────────────────────

studentScopedRoutes.get('/reports', async (c) => {
  const auth = requireRole(c, 'student');
  const rows = await db
    .select()
    .from(reports)
    .where(
      and(eq(reports.studentId, auth.subjectId), eq(reports.status, 'sent')),
    )
    .orderBy(desc(reports.publishedAt));
  return c.json({ data: rows });
});

studentScopedRoutes.get('/reports/:id', async (c) => {
  const auth = requireRole(c, 'student');
  const id = c.req.param('id');
  const row = (await db.select().from(reports).where(eq(reports.id, id)).limit(1))[0];
  if (!row) throw Errors.notFound('report', id);
  if (row.studentId !== auth.subjectId) throw Errors.authForbidden();
  return c.json(row);
});

// ─── Settings ────────────────────────────────────────────────────────────────

const SettingsSchema = z.object({
  languagePreferences: z
    .object({ primary: z.string().min(2), secondary: z.array(z.string()).optional() })
    .optional(),
  optOuts: z.record(z.boolean()).optional(),
  timezone: z.string().optional(),
});

studentScopedRoutes.patch('/settings', async (c) => {
  const auth = requireRole(c, 'student');
  const body = SettingsSchema.parse(await c.req.json());
  const updated = await db
    .update(students)
    .set({
      ...(body.languagePreferences ? { languagePreferences: body.languagePreferences } : {}),
      ...(body.optOuts ? { optOuts: body.optOuts } : {}),
      ...(body.timezone ? { timezone: body.timezone } : {}),
      updatedAt: new Date(),
    })
    .where(eq(students.id, auth.subjectId))
    .returning();
  return c.json(updated[0]);
});

