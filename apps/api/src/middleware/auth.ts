import type { MiddlewareHandler } from 'hono';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Errors, type UserRole } from '@wgc/shared';
import { loadEnv } from '@wgc/config';
import { db, counsellors, students } from '@wgc/db';
import { eq, sql } from 'drizzle-orm';
import type { AppEnv } from '../app.js';
import { logger } from '../logger.js';

export type AuthContext = {
  authUserId: string;
  email: string;
  role: UserRole;
  /** Domain ID — counsellors.id when role='counsellor', students.id when role='student'. */
  subjectId: string;
  /** Student lifecycle: 'pending_onboarding' | 'pending_review' | 'active' | 'archived'.
   *  Undefined for counsellors. */
  studentStatus?: string;
};

let supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient {
  if (supabase) return supabase;
  const env = loadEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw Errors.internal('Supabase env vars not set; cannot verify auth tokens.');
  }
  supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabase;
}

/**
 * Auth middleware. Verifies the Bearer token via Supabase Auth, then resolves
 * the calling user to a `counsellors` or `students` row to derive their role
 * and domain id. Per CLAUDE_CODE.md §9: never trust client-supplied user IDs.
 *
 * Phase 1 note: only counsellor and admin roles are exercised here (the admin
 * panel is the only consumer). Student role plumbing exists for Phase 2.
 */
export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw Errors.authInvalidToken('Missing Bearer token');
  }
  const token = authHeader.slice('Bearer '.length);
  const supa = getSupabase();
  const { data, error } = await supa.auth.getUser(token);
  if (error || !data.user?.email) {
    throw Errors.authInvalidToken();
  }

  const email = data.user.email.toLowerCase();
  const authUserId = data.user.id;

  // Counsellor takes precedence. Match case-insensitively because Google
  // returns emails in their canonical form which may differ from how the
  // counsellor was seeded.
  const counsellorRow = await db
    .select()
    .from(counsellors)
    .where(sql`LOWER(${counsellors.email}) = ${email}`)
    .limit(1);
  if (counsellorRow[0]) {
    c.set('auth', {
      authUserId,
      email,
      role: 'counsellor',
      subjectId: counsellorRow[0].id,
    });
    return next();
  }

  const studentRow = await db
    .select()
    .from(students)
    .where(sql`LOWER(${students.email}) = ${email}`)
    .limit(1);
  if (studentRow[0]) {
    c.set('auth', {
      authUserId,
      email,
      role: 'student',
      subjectId: studentRow[0].id,
      studentStatus: studentRow[0].status,
    });
    return next();
  }

  // First sign-in for this Gmail. Auto-create a pending student row so the
  // user can land on the onboarding form. Counsellor will see them in the
  // queue and either approve or ignore. Display name comes from the Google
  // JWT's `user_metadata.full_name` / `name` claim; falls back to the email
  // local-part if absent.
  const meta = (data.user.user_metadata ?? {}) as Record<string, unknown>;
  const fullName =
    (typeof meta['full_name'] === 'string' && meta['full_name']) ||
    (typeof meta['name'] === 'string' && meta['name']) ||
    email.split('@')[0]!;
  // Two concurrent first-time sign-ins from the same Gmail could both reach
  // here. `uq_students_email` (migration 0006) is a partial UNIQUE index on
  // LOWER(email), so the second INSERT would otherwise 500. Catch 23505
  // (unique_violation) and re-select so the loser of the race silently picks
  // up the winner's row.
  let row: { id: string; status: string } | undefined;
  try {
    const inserted = await db
      .insert(students)
      .values({
        fullName: fullName as string,
        email,
        phone: '',
        currentGrade: 'unknown',
        status: 'pending_onboarding',
      })
      .returning({ id: students.id, status: students.status });
    row = inserted[0];
    if (row) {
      logger.info({ email, studentId: row.id }, 'auto-created pending_onboarding student');
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== '23505') throw e;
    const existing = await db
      .select({ id: students.id, status: students.status })
      .from(students)
      .where(sql`LOWER(${students.email}) = ${email}`)
      .limit(1);
    if (!existing[0]) {
      throw Errors.internal('auto-create race: insert conflicted but no existing row');
    }
    row = existing[0];
  }
  if (!row) {
    throw Errors.internal('auto-create: insert returned no row');
  }
  c.set('auth', {
    authUserId,
    email,
    role: 'student',
    subjectId: row.id,
    studentStatus: row.status,
  });
  return next();
};

/** Guard helper used inside route handlers. */
export function requireRole(c: { get: (k: 'auth') => AuthContext | undefined }, role: UserRole): AuthContext {
  const auth = c.get('auth');
  if (!auth) throw Errors.authInvalidToken();
  if (auth.role !== role) throw Errors.authForbidden(`Requires ${role} role`);
  return auth;
}

export function getAuth(c: { get: (k: 'auth') => AuthContext | undefined }): AuthContext {
  const auth = c.get('auth');
  if (!auth) throw Errors.authInvalidToken();
  return auth;
}
