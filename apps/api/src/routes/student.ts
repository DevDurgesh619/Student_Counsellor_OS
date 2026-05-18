import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, gte, isNull, lte, ne } from 'drizzle-orm';
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

  // Active-schedule predicate (mirrors the engine + counsellor view):
  // `superseded_at IS NULL AND status NOT IN ('cancelled','rescheduled')`.
  // Without this, a counsellor who deletes a task would leave the row
  // visible on the student's today/week view until the page is closed —
  // the student would then "complete" a task that no longer exists.
  const conds = [
    eq(tasks.studentId, auth.subjectId),
    isNull(tasks.supersededAt),
    ne(tasks.status, 'cancelled'),
    ne(tasks.status, 'rescheduled'),
  ];
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

// Allowed MIME types for student-uploaded artifacts. Mirrors the storage
// bucket's allowed_mime_types in supabase/config.toml, but enforced earlier
// (the storage-side check happens after the signed URL is issued, which is
// too late to give the student a clean error).
const ALLOWED_MIME_PREFIXES = ['image/', 'audio/', 'video/'];
const ALLOWED_MIME_EXACT = new Set(['application/pdf']);

function isAllowedMime(t: string): boolean {
  const lower = t.toLowerCase();
  if (ALLOWED_MIME_EXACT.has(lower)) return true;
  return ALLOWED_MIME_PREFIXES.some((p) => lower.startsWith(p));
}

const SignSchema = z.object({
  filename: z.string().min(1),
  contentType: z
    .string()
    .min(1)
    .refine(isAllowedMime, { message: 'Unsupported file type' }),
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
  fileType: z
    .string()
    .min(1)
    .refine(isAllowedMime, { message: 'Unsupported file type' }),
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

const ChangeRequestSchema = z
  .object({
    kind: z.enum(['general', 'task_change']).default('general'),
    // task_change fields (cross-validated below):
    originalTaskId: z.string().uuid().optional(),
    scope: z.enum(['single', 'recurring']).optional(),
    targetRecurrenceGroupId: z.string().uuid().optional(),
    proposedStart: z.string().datetime().optional(),
    proposedEnd: z.string().datetime().optional(),
    // shared:
    patternDescription: z.string().optional(),
    proposedChange: z.string().min(1),
    reason: z.string().min(1),
  })
  .refine((d) => d.kind === 'general' || (d.originalTaskId && d.scope), {
    message: 'task_change requires originalTaskId + scope',
  })
  .refine(
    (d) =>
      !d.proposedStart ||
      (d.proposedEnd && new Date(d.proposedEnd) > new Date(d.proposedStart)),
    { message: 'proposedEnd must be after proposedStart' },
  );

studentScopedRoutes.post('/change-requests', idempotency, async (c) => {
  const auth = requireRole(c, 'student');
  const body = ChangeRequestSchema.parse(await c.req.json());

  // Duplicate guard. One pending task_change per (student, task) — without
  // this a student could drag-drop the same block five times and create five
  // pending requests, all of which surface in the counsellor's queue as
  // duplicates. Cleared automatically when the existing request flips off
  // 'pending' (approve, reject, expire, open-in-editor).
  if (body.kind === 'task_change' && body.originalTaskId) {
    const existing = await db
      .select({ id: changeRequests.id })
      .from(changeRequests)
      .where(
        and(
          eq(changeRequests.studentId, auth.subjectId),
          eq(changeRequests.originalTaskId, body.originalTaskId),
          eq(changeRequests.status, 'pending'),
        ),
      )
      .limit(1);
    if (existing[0]) {
      throw Errors.conflict(
        'CHANGE_REQUEST_EXISTS',
        'You already have a pending request to change this task. Wait for your counsellor to decide on the existing one.',
        { existingRequestId: existing[0].id },
      );
    }
  }

  const inserted = await db
    .insert(changeRequests)
    .values({
      studentId: auth.subjectId,
      kind: body.kind,
      originalTaskId: body.originalTaskId ?? null,
      scope: body.scope ?? null,
      targetRecurrenceGroupId: body.targetRecurrenceGroupId ?? null,
      proposedStart: body.proposedStart ? new Date(body.proposedStart) : null,
      proposedEnd: body.proposedEnd ? new Date(body.proposedEnd) : null,
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

