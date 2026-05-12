import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { counsellors, db, students } from '@wgc/db';
import type { AppEnv } from '../app.js';
import { Errors } from '@wgc/shared';
import { getAuth } from '../middleware/auth.js';

/** GET /api/me — returns the authenticated user's profile (counsellor or student). */
export const meRoutes = new Hono<AppEnv>();

meRoutes.get('/', async (c) => {
  const auth = getAuth(c);
  if (auth.role === 'counsellor') {
    const row = await db
      .select()
      .from(counsellors)
      .where(eq(counsellors.id, auth.subjectId))
      .limit(1);
    if (!row[0]) throw Errors.notFound('counsellor', auth.subjectId);
    return c.json({ role: 'counsellor', state: 'active', profile: row[0] });
  }
  if (auth.role === 'student') {
    const row = await db.select().from(students).where(eq(students.id, auth.subjectId)).limit(1);
    if (!row[0]) throw Errors.notFound('student', auth.subjectId);
    // `state` drives the post-login redirect on the client:
    //   pending_onboarding  → /student/onboarding (form)
    //   pending_review      → /student/onboarding (read-only "awaiting review")
    //   active              → /student/today
    //   archived            → /student/archived (informational)
    return c.json({ role: 'student', state: row[0].status, profile: row[0] });
  }
  throw Errors.authForbidden();
});
