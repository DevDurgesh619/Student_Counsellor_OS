import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { db, studentProfileDrafts, students } from '@wgc/db';
import { Errors } from '@wgc/shared';
import { loadEnv } from '@wgc/config';
import type { AppEnv } from '../app.js';
import { requireRole } from '../middleware/auth.js';
import { idempotency } from '../middleware/idempotency.js';
import { runProfileBuilder } from '../lib/worker1.js';
import { logger } from '../logger.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// Counsellor-scoped — review, approve, ignore (mounted under /api/counsellor)
// ─────────────────────────────────────────────────────────────────────────────

export const onboardingCounsellorRoutes = new Hono<AppEnv>();

onboardingCounsellorRoutes.get('/profile-drafts', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const status = c.req.query('status');
  // Counsellor sees: their own assigned drafts + unassigned drafts (no
  // counsellor_id yet — new students who just signed up with Google).
  const conds = status ? [eq(studentProfileDrafts.status, status)] : [];
  const rows = await db
    .select()
    .from(studentProfileDrafts)
    .where(and(...conds))
    .orderBy(desc(studentProfileDrafts.createdAt));
  // Filter to drafts whose student belongs to this counsellor OR is unassigned.
  const filtered: typeof rows = [];
  for (const r of rows) {
    if (r.counsellorId && r.counsellorId !== auth.subjectId) continue;
    filtered.push(r);
  }
  return c.json({ data: filtered });
});

onboardingCounsellorRoutes.get('/profile-drafts/:id', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const draft = await loadDraftForCounsellor(auth.subjectId, id);
  return c.json(draft);
});

const EditSchema = z.object({ profile: z.record(z.unknown()) });
onboardingCounsellorRoutes.post('/profile-drafts/:id/edit', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  await loadDraftForCounsellor(auth.subjectId, id);
  const body = EditSchema.parse(await c.req.json());
  const updated = await db
    .update(studentProfileDrafts)
    .set({ profile: body.profile })
    .where(eq(studentProfileDrafts.id, id))
    .returning();
  return c.json(updated[0]);
});

onboardingCounsellorRoutes.post('/profile-drafts/:id/approve', idempotency, async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const draft = await loadDraftForCounsellor(auth.subjectId, id);
  if (!draft.profile) {
    throw Errors.conflict('PROFILE_NOT_BUILT', 'Worker 1 has not produced a profile yet');
  }
  if (draft.status === 'approved') {
    throw Errors.conflict('ALREADY_APPROVED', 'Profile draft is already approved');
  }

  // Post-Google-OAuth: student row always exists (auto-created on first
  // sign-in). Approve = update existing row, flip status to active, claim
  // them under this counsellor.
  const profile = draft.profile as Record<string, unknown>;
  const formResponses = (draft.formResponses ?? {}) as Record<string, unknown>;
  await db
    .update(students)
    .set({
      ...profileToStudentUpdate(profile, formResponses),
      counsellorId: auth.subjectId,
      status: 'active',
    })
    .where(eq(students.id, draft.studentId));

  await db
    .update(studentProfileDrafts)
    .set({
      status: 'approved',
      acceptedAt: new Date(),
      acceptedBy: auth.subjectId,
      counsellorId: auth.subjectId,
    })
    .where(eq(studentProfileDrafts.id, id));

  return c.json({ ok: true, studentId: draft.studentId });
});

const RegenerateSchema = z.object({ notes: z.string().optional() });
onboardingCounsellorRoutes.post('/profile-drafts/:id/regenerate', idempotency, async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const draft = await loadDraftForCounsellor(auth.subjectId, id);
  const body = RegenerateSchema.parse(await c.req.json().catch(() => ({})));
  await db
    .update(studentProfileDrafts)
    .set({
      status: 'regenerated',
      flagsForCounsellor: [
        { field: '_meta', code: 'regenerate_request', note: body.notes ?? '' },
      ],
    })
    .where(eq(studentProfileDrafts.id, draft.id));
  await runProfileBuilder(id).catch((err) =>
    logger.error({ err, draftId: id }, 'Worker 1 regenerate failed'),
  );
  const fresh = (
    await db.select().from(studentProfileDrafts).where(eq(studentProfileDrafts.id, id)).limit(1)
  )[0];
  return c.json(fresh);
});

onboardingCounsellorRoutes.post('/profile-drafts/:id/reject', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  await loadDraftForCounsellor(auth.subjectId, id);
  const updated = await db
    .update(studentProfileDrafts)
    .set({ status: 'rejected' })
    .where(eq(studentProfileDrafts.id, id))
    .returning();
  return c.json(updated[0]);
});

/**
 * Ignore a pending student that signed up with Google but the counsellor
 * doesn't recognise. Marks both the draft (if any) and the student row as
 * archived. The student loses dashboard access on next sign-in.
 *
 * "Light" mode of the public-signup allow-list (per the auth-refactor plan):
 * counsellor controls the gate by ignoring strangers rather than by
 * pre-whitelisting emails.
 */
onboardingCounsellorRoutes.post('/students/:id/ignore', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.param('id');
  const stu = (
    await db.select().from(students).where(eq(students.id, studentId)).limit(1)
  )[0];
  if (!stu) throw Errors.notFound('student', studentId);
  if (stu.counsellorId && stu.counsellorId !== auth.subjectId) {
    throw Errors.authForbidden('not_assigned');
  }
  await db.update(students).set({ status: 'archived' }).where(eq(students.id, studentId));
  await db
    .update(studentProfileDrafts)
    .set({ status: 'rejected' })
    .where(
      and(
        eq(studentProfileDrafts.studentId, studentId),
        eq(studentProfileDrafts.status, 'pending_review'),
      ),
    );
  return c.json({ ok: true });
});

async function loadDraftForCounsellor(counsellorId: string, id: string) {
  const row = (
    await db.select().from(studentProfileDrafts).where(eq(studentProfileDrafts.id, id)).limit(1)
  )[0];
  if (!row) throw Errors.notFound('profile_draft', id);
  // Allow access to drafts that are either assigned to this counsellor OR
  // unassigned (newly-signed-up student that the counsellor is now claiming).
  if (row.counsellorId && row.counsellorId !== counsellorId) throw Errors.authForbidden();
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// Student-scoped — authenticated form submission (mounted under /api/me)
// ─────────────────────────────────────────────────────────────────────────────

export const onboardingStudentRoutes = new Hono<AppEnv>();

const FormSubmitSchema = z.object({
  basic_info: z.object({
    full_name: z.string().min(1),
    grade: z.string().min(1),
    school: z.string().optional(),
    date_of_birth: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
  }),
  parent_info: z
    .array(
      z.object({
        name: z.string(),
        relationship: z.enum(['father', 'mother', 'guardian', 'other']),
        phone: z.string().optional(),
        email: z.string().email().optional(),
      }),
    )
    .default([]),
  academic_background: z.string().optional(),
  manual_marks: z
    .array(
      z.object({
        subject: z.string(),
        marks_obtained: z.number().optional(),
        marks_total: z.number().optional(),
        year: z.string().optional(),
        term: z.string().optional(),
      }),
    )
    .default([]),
  goals: z.string().optional(),
  self_reflection: z.string().optional(),
  working_sample: z.object({ prompt: z.string(), response: z.string() }).optional(),
  logistics: z.object({
    timezone: z.string().default('Asia/Kolkata'),
    language: z.string().default('en'),
    devices: z.array(z.string()).default([]),
    schedule_constraints: z.string().optional(),
  }),
  marksheet_paths: z.array(z.string()).default([]),
});

/** GET /api/me/onboarding — current draft (or null) for the signed-in student. */
onboardingStudentRoutes.get('/onboarding', async (c) => {
  const auth = requireRole(c, 'student');
  const draft = (
    await db
      .select()
      .from(studentProfileDrafts)
      .where(eq(studentProfileDrafts.studentId, auth.subjectId))
      .orderBy(desc(studentProfileDrafts.createdAt))
      .limit(1)
  )[0];
  return c.json({ data: draft ?? null });
});

/** POST /api/me/onboarding/autosave — partial save while filling. */
onboardingStudentRoutes.post('/onboarding/autosave', async (c) => {
  const auth = requireRole(c, 'student');
  const body = (await c.req.json()) as Record<string, unknown>;
  await upsertDraftForStudent(auth.subjectId, body, { submit: false });
  return c.json({ ok: true });
});

/** POST /api/me/onboarding/submit — final submit, kicks Worker 1. */
onboardingStudentRoutes.post('/onboarding/submit', async (c) => {
  const auth = requireRole(c, 'student');
  const body = FormSubmitSchema.parse(await c.req.json());
  const draftId = await upsertDraftForStudent(
    auth.subjectId,
    body as unknown as Record<string, unknown>,
    { submit: true },
  );
  // Flip the student status to pending_review so the counsellor sees them.
  await db
    .update(students)
    .set({ status: 'pending_review' })
    .where(eq(students.id, auth.subjectId));
  try {
    await runProfileBuilder(draftId);
  } catch (err) {
    logger.error({ err, draftId }, 'Worker 1 inline run failed');
  }
  return c.json({ ok: true, draftId });
});

/** POST /api/me/onboarding/upload-marksheet — signed upload URL. */
onboardingStudentRoutes.post('/onboarding/upload-marksheet', async (c) => {
  const auth = requireRole(c, 'student');
  const body = (await c.req.json()) as {
    filename: string;
    contentType: string;
    sizeBytes: number;
  };
  if (!body.filename || !body.contentType || !body.sizeBytes) {
    throw Errors.validation('filename, contentType, sizeBytes required');
  }
  if (body.sizeBytes > MAX_BYTES) throw Errors.validation('file too large');
  const objectId = crypto.randomUUID();
  const safe = body.filename.replace(/[^A-Za-z0-9._-]/g, '_');
  const path = `onboarding/${auth.subjectId}/${objectId}/${safe}`;
  const supa = getStorage();
  const { data, error } = await supa.storage
    .from(ARTIFACT_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) throw Errors.internal(`signed url failed: ${error?.message}`);
  return c.json({
    uploadUrl: data.signedUrl,
    storagePath: path,
    bucket: ARTIFACT_BUCKET,
    token: data.token,
  });
});

async function upsertDraftForStudent(
  studentId: string,
  formResponses: Record<string, unknown>,
  opts: { submit: boolean },
): Promise<string> {
  const existing = (
    await db
      .select()
      .from(studentProfileDrafts)
      .where(eq(studentProfileDrafts.studentId, studentId))
      .orderBy(desc(studentProfileDrafts.createdAt))
      .limit(1)
  )[0];
  if (existing) {
    // Refuse to mutate a closed draft.
    if (existing.status === 'approved' || existing.status === 'rejected') {
      throw Errors.conflict('DRAFT_CLOSED', 'profile draft is closed');
    }
    await db
      .update(studentProfileDrafts)
      .set({
        formResponses,
        status: opts.submit ? 'pending_review' : 'awaiting_form',
      })
      .where(eq(studentProfileDrafts.id, existing.id));
    return existing.id;
  }
  const inserted = await db
    .insert(studentProfileDrafts)
    .values({
      studentId,
      formResponses,
      status: opts.submit ? 'pending_review' : 'awaiting_form',
    })
    .returning({ id: studentProfileDrafts.id });
  return inserted[0]!.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers — student row update on approve
// ─────────────────────────────────────────────────────────────────────────────

type ParentContact = {
  name: string;
  phone?: string;
  email?: string;
  relationship: 'father' | 'mother' | 'guardian' | 'other';
};

function profileToStudentUpdate(
  profile: Record<string, unknown>,
  formResponses: Record<string, unknown>,
) {
  const basic = (formResponses['basic_info'] as Record<string, unknown> | undefined) ?? {};
  const logisticsForm =
    (formResponses['logistics'] as Record<string, unknown> | undefined) ?? {};
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (basic['full_name'] || profile['name']) {
    update['fullName'] = (basic['full_name'] as string) ?? (profile['name'] as string);
  }
  if (basic['phone']) update['phone'] = basic['phone'];
  // Don't overwrite email — it's the Google sign-in identifier and must
  // stay stable so future logins still resolve to the same student row.
  if (basic['grade'] || profile['current_grade']) {
    update['currentGrade'] = (basic['grade'] as string) ?? (profile['current_grade'] as string);
  }
  if (basic['school'] !== undefined || profile['school'] !== undefined) {
    update['school'] = (basic['school'] as string | null) ?? (profile['school'] as string | null);
  }
  const parents = extractParentContacts(formResponses);
  if (parents.length) update['parentContacts'] = parents;
  if (logisticsForm['timezone']) update['timezone'] = logisticsForm['timezone'];
  if (logisticsForm['language'] || profile['language_preference']) {
    update['languagePreferences'] = {
      primary:
        (logisticsForm['language'] as string) ??
        (profile['language_preference'] as string) ??
        'en',
    };
  }
  return update;
}

function extractParentContacts(formResponses: Record<string, unknown>): ParentContact[] {
  const raw = (formResponses['parent_info'] as Array<Record<string, unknown>> | undefined) ?? [];
  return raw
    .filter((p) => typeof p?.['name'] === 'string' && (p['name'] as string).trim())
    .map((p) => {
      const rel = (p['relationship'] as string) ?? 'other';
      const relationship: ParentContact['relationship'] =
        rel === 'father' || rel === 'mother' || rel === 'guardian' ? rel : 'other';
      const out: ParentContact = { name: (p['name'] as string).trim(), relationship };
      if (typeof p['phone'] === 'string' && p['phone']) out.phone = p['phone'];
      if (typeof p['email'] === 'string' && p['email']) out.email = p['email'];
      return out;
    });
}
