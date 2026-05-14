import { and, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import {
  db,
  sessions,
  sessionExtractions,
  students,
  studentHistorySummaries,
  studentHistorySummaryVersions,
} from '@wgc/db';
import { AIClient } from '@wgc/ai';
import { logger } from '../logger.js';
import { loadOnboardingProfile } from './onboarding-profile.js';

const KEEP_VERSIONS = 10;

const RollingSummarySchema = z.object({
  summary: z.string().min(20),
  openConcerns: z.array(z.string()).default([]),
  lastUpdatedFocus: z.string().optional().default(''),
});

/**
 * Regenerate a student's rolling longitudinal summary after a new meeting
 * has been ingested and extracted. Fire-and-forget — caller should not
 * await for the critical path.
 *
 * Skips when:
 *  - the session has no extraction yet (pipeline failed earlier)
 *  - the extraction's confidence is 'none' (meeting added nothing worth
 *    summarising; keep the prior summary unchanged)
 *  - the session is not linked to a student (defensive)
 *
 * On success: writes a new row to `student_history_summary_versions`,
 * upserts `student_history_summaries` to the new content, trims old
 * versions beyond KEEP_VERSIONS.
 */
export async function regenerateStudentHistorySummary(
  studentId: string,
  sessionId: string,
): Promise<{ skipped: true; reason: string } | { skipped: false; version: number }> {
  const extraction = (
    await db
      .select()
      .from(sessionExtractions)
      .where(eq(sessionExtractions.sessionId, sessionId))
      .limit(1)
  )[0];
  if (!extraction) {
    logger.info({ studentId, sessionId }, '[history] skip: no extraction for session');
    return { skipped: true, reason: 'no_extraction' };
  }
  if (extraction.confidence === 'none') {
    logger.info({ studentId, sessionId }, '[history] skip: extraction confidence=none');
    return { skipped: true, reason: 'confidence_none' };
  }

  const prior = (
    await db
      .select()
      .from(studentHistorySummaries)
      .where(eq(studentHistorySummaries.studentId, studentId))
      .limit(1)
  )[0];

  const onboarding = await loadOnboardingProfile(studentId);
  const studentRow = (
    await db
      .select({
        fullName: students.fullName,
        currentGrade: students.currentGrade,
        school: students.school,
        timezone: students.timezone,
        languagePreferences: students.languagePreferences,
      })
      .from(students)
      .where(eq(students.id, studentId))
      .limit(1)
  )[0];

  const session = (
    await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
  )[0];

  const inputs = {
    onboarding_profile: onboarding?.aiProfile ?? {},
    onboarding_form_responses: onboarding?.formResponses ?? {},
    student_basics: studentRow ?? {},
    prior_summary: prior?.content ?? '',
    new_extraction_json: {
      topics: extraction.topicsDiscussed,
      actionItems: extraction.actionItems,
      scheduleChanges: extraction.scheduleChanges,
      concernsRaised: extraction.concernsRaised,
      decisionsMade: extraction.decisionsMade,
      openQuestions: extraction.openQuestions,
      confidence: extraction.confidence,
      sessionDate: session?.scheduledAt ?? null,
    },
  };

  let result;
  try {
    result = await new AIClient().call({
      workerName: 'worker_rolling_summary',
      promptId: 'worker_rolling_summary',
      inputs,
      outputSchema: RollingSummarySchema,
      studentId,
      sessionId,
    });
  } catch (err) {
    logger.warn({ err, studentId, sessionId }, '[history] LLM call failed');
    throw err;
  }

  const nextVersion = (prior?.currentVersion ?? 0) + 1;
  const priorSessionIds = prior?.basedOnSessionIds ?? [];
  const nextSessionIds = priorSessionIds.includes(sessionId)
    ? priorSessionIds
    : [...priorSessionIds, sessionId];

  await db.insert(studentHistorySummaryVersions).values({
    studentId,
    version: nextVersion,
    content: result.output.summary,
    openConcerns: result.output.openConcerns,
    lastUpdatedFocus: result.output.lastUpdatedFocus,
    basedOnSessionIds: nextSessionIds,
    aiCallId: result.aiCallId,
  });

  if (prior) {
    await db
      .update(studentHistorySummaries)
      .set({
        currentVersion: nextVersion,
        content: result.output.summary,
        openConcerns: result.output.openConcerns,
        lastUpdatedFocus: result.output.lastUpdatedFocus,
        basedOnSessionIds: nextSessionIds,
        generatedAt: new Date(),
        aiCallId: result.aiCallId,
      })
      .where(eq(studentHistorySummaries.studentId, studentId));
  } else {
    await db.insert(studentHistorySummaries).values({
      studentId,
      currentVersion: nextVersion,
      content: result.output.summary,
      openConcerns: result.output.openConcerns,
      lastUpdatedFocus: result.output.lastUpdatedFocus,
      basedOnSessionIds: nextSessionIds,
      aiCallId: result.aiCallId,
    });
  }

  // Trim old versions beyond KEEP_VERSIONS — find the cutoff version, delete
  // everything strictly below it.
  if (nextVersion > KEEP_VERSIONS) {
    const cutoff = nextVersion - KEEP_VERSIONS + 1;
    await db
      .delete(studentHistorySummaryVersions)
      .where(
        and(
          eq(studentHistorySummaryVersions.studentId, studentId),
          lt(studentHistorySummaryVersions.version, cutoff),
        ),
      );
  }

  logger.info(
    { studentId, sessionId, version: nextVersion, tokensIn: result.tokensInput, tokensOut: result.tokensOutput },
    '[history] regenerated',
  );

  return { skipped: false, version: nextVersion };
}

/**
 * Fetch the current rolling summary content for a student. Returns empty
 * string if none yet (e.g. brand-new student, no meetings ingested).
 * Used by brief workers as the `rolling_history` template var.
 */
export async function getCurrentRollingSummary(studentId: string): Promise<string> {
  const row = (
    await db
      .select({ content: studentHistorySummaries.content })
      .from(studentHistorySummaries)
      .where(eq(studentHistorySummaries.studentId, studentId))
      .limit(1)
  )[0];
  return row?.content ?? '';
}

/**
 * Latest N versions for the audit/rollback UI.
 */
export async function listSummaryVersions(studentId: string, limit = KEEP_VERSIONS) {
  return await db
    .select()
    .from(studentHistorySummaryVersions)
    .where(eq(studentHistorySummaryVersions.studentId, studentId))
    .orderBy(desc(studentHistorySummaryVersions.version))
    .limit(limit);
}
