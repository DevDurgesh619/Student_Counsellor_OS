import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { artifacts, db, students } from '@wgc/db';
import { Errors } from '@wgc/shared';
import { loadEnv } from '@wgc/config';
import type { AppEnv } from '../app.js';
import { requireRole } from '../middleware/auth.js';
import { idempotency } from '../middleware/idempotency.js';

const ARTIFACT_BUCKET = 'artifacts';
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB per CLAUDE_CODE.md §12 / phase-1

const SignUrlRequestSchema = z.object({
  studentId: z.string().uuid(),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive().max(MAX_BYTES),
});

const ConfirmUploadSchema = z.object({
  studentId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  fileUrl: z.string().min(1),
  fileType: z.string().min(1),
  fileSizeBytes: z.number().int().positive().max(MAX_BYTES),
  originalFilename: z.string().optional(),
  source: z
    .enum(['dashboard_upload', 'whatsapp_forward', 'counsellor_manual_entry'])
    .default('counsellor_manual_entry'),
});

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

export const artifactRoutes = new Hono<AppEnv>();

/**
 * POST /api/artifacts/upload-url — return a Supabase Storage signed upload URL
 * scoped to `students/{studentId}/artifacts/{uuid}/{filename}`. Client uploads
 * directly; then calls POST /api/artifacts to record metadata.
 */
artifactRoutes.post('/upload-url', idempotency, async (c) => {
  const auth = requireRole(c, 'counsellor');
  const body = SignUrlRequestSchema.parse(await c.req.json());

  const studentRow = await db
    .select({ counsellorId: students.counsellorId })
    .from(students)
    .where(eq(students.id, body.studentId))
    .limit(1);
  if (!studentRow[0]) throw Errors.notFound('student', body.studentId);
  if (studentRow[0].counsellorId !== auth.subjectId) throw Errors.authForbidden();

  const objectId = crypto.randomUUID();
  const safeName = body.filename.replace(/[^A-Za-z0-9._-]/g, '_');
  const path = `students/${body.studentId}/artifacts/${objectId}/${safeName}`;

  const supa = getStorage();
  const { data, error } = await supa.storage
    .from(ARTIFACT_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) {
    throw Errors.internal(`Failed to create signed URL: ${error?.message}`);
  }
  return c.json({
    uploadUrl: data.signedUrl,
    storagePath: path,
    token: data.token,
    bucket: ARTIFACT_BUCKET,
  });
});

artifactRoutes.post('/', idempotency, async (c) => {
  const auth = requireRole(c, 'counsellor');
  const body = ConfirmUploadSchema.parse(await c.req.json());
  const studentRow = await db
    .select({ counsellorId: students.counsellorId })
    .from(students)
    .where(eq(students.id, body.studentId))
    .limit(1);
  if (!studentRow[0]) throw Errors.notFound('student', body.studentId);
  if (studentRow[0].counsellorId !== auth.subjectId) throw Errors.authForbidden();

  const inserted = await db.insert(artifacts).values(body).returning();
  return c.json(inserted[0], 201);
});

/** GET /api/artifacts/:id — metadata + a signed download URL (60s TTL). */
artifactRoutes.get('/:id', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const row = await db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1);
  if (!row[0]) throw Errors.notFound('artifact', id);

  const studentRow = await db
    .select({ counsellorId: students.counsellorId })
    .from(students)
    .where(eq(students.id, row[0].studentId))
    .limit(1);
  if (studentRow[0]?.counsellorId !== auth.subjectId) throw Errors.authForbidden();

  const supa = getStorage();
  const { data, error } = await supa.storage
    .from(ARTIFACT_BUCKET)
    .createSignedUrl(row[0].fileUrl, 60);
  if (error) throw Errors.internal(`Failed to sign download URL: ${error.message}`);

  return c.json({ ...row[0], downloadUrl: data?.signedUrl });
});
