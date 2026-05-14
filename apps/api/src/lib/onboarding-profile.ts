import { and, desc, eq } from 'drizzle-orm';
import { db, studentProfileDrafts } from '@wgc/db';

export type OnboardingProfileSeed = {
  aiProfile: Record<string, unknown>;
  formResponses: Record<string, unknown>;
};

/**
 * Load the approved onboarding profile for a student. Returns `null` if
 * the student has no approved draft (e.g. they're still in onboarding).
 *
 * This is the immutable "who is this student" seed context: grade, marks,
 * goals, family situation, self-reflection from the AI-extracted profile
 * (Worker 1 output) plus the raw form responses. Fed into the rolling
 * summary worker and both brief workers so the model always knows the
 * student's baseline before reading meeting content.
 *
 * After onboarding approval (`apps/api/src/routes/onboarding.ts:77-113`),
 * the draft row is preserved with `status='approved'` — only flat columns
 * are copied to `students`. The rich profile stays here.
 */
export async function loadOnboardingProfile(
  studentId: string,
): Promise<OnboardingProfileSeed | null> {
  const row = (
    await db
      .select({
        profile: studentProfileDrafts.profile,
        formResponses: studentProfileDrafts.formResponses,
      })
      .from(studentProfileDrafts)
      .where(
        and(
          eq(studentProfileDrafts.studentId, studentId),
          eq(studentProfileDrafts.status, 'approved'),
        ),
      )
      .orderBy(desc(studentProfileDrafts.acceptedAt))
      .limit(1)
  )[0];
  if (!row || !row.profile) return null;
  return {
    aiProfile: row.profile,
    formResponses: row.formResponses ?? {},
  };
}
