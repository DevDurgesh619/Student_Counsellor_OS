import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';
import {
  changeRequests,
  counsellorTodos,
  db,
  meetingPrepBriefs,
  reviewQueue,
  sessions,
  students,
} from '@wgc/db';
import { AIClient } from '@wgc/ai';
import { logger } from '../logger.js';
import { getCurrentRollingSummary } from './student-history.js';

/**
 * Generate the Pass B brief for an upcoming session. Idempotent —
 * regenerating overwrites pass_b_content. Designed to be called by the
 * hourly cron when a session is 24-25h away.
 */
export async function runWorker7PassB(targetSessionId: string): Promise<string> {
  const session = (
    await db.select().from(sessions).where(eq(sessions.id, targetSessionId)).limit(1)
  )[0];
  if (!session) throw new Error(`session ${targetSessionId} not found`);
  const student = (
    await db.select().from(students).where(eq(students.id, session.studentId)).limit(1)
  )[0];
  if (!student) throw new Error(`student ${session.studentId} not found`);

  const brief = (
    await db
      .select({ id: meetingPrepBriefs.id, passAContent: meetingPrepBriefs.passAContent })
      .from(meetingPrepBriefs)
      .where(eq(meetingPrepBriefs.targetSessionId, targetSessionId))
      .limit(1)
  )[0];
  const passAContent = brief?.passAContent ?? '(no Pass A draft was generated)';

  // Single most-recent prior session — its Spinach summary is the freshest
  // raw detail (the rolling summary runs one meeting behind by design).
  const priorSessions = await db
    .select({
      id: sessions.id,
      summary: sessions.spinachSummaryText,
      scheduledAt: sessions.scheduledAt,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.studentId, student.id),
        lt(sessions.scheduledAt, session.scheduledAt),
      ),
    )
    .orderBy(desc(sessions.scheduledAt))
    .limit(1);
  const lastSession = priorSessions[0] ?? null;
  const lastSessionSummary = lastSession
    ? `[${lastSession.scheduledAt.toISOString().slice(0, 10)}] ${lastSession.summary ?? '(no summary)'}`
    : '';

  // Open counsellor todos tied to the last session — what the counsellor
  // committed to in that meeting and still owes the student. Scoped to
  // lastSession.id deliberately (the brief is "what to close before the
  // next meet", not the lifetime backlog).
  const lastSessionTodos = lastSession
    ? await db
        .select({
          description: counsellorTodos.description,
          dueDate: counsellorTodos.dueDate,
          createdAt: counsellorTodos.createdAt,
        })
        .from(counsellorTodos)
        .where(
          and(
            eq(counsellorTodos.sourceSessionId, lastSession.id),
            eq(counsellorTodos.status, 'pending'),
          ),
        )
        .orderBy(asc(counsellorTodos.dueDate), asc(counsellorTodos.createdAt))
        .limit(30)
    : [];
  const lastSessionTodosRendered = lastSessionTodos
    .map((t) => `- ${t.description}${t.dueDate ? ` (due ${t.dueDate})` : ''}`)
    .join('\n');

  // Change requests opened since the last session — the student's signals
  // about scope/timing/recent friction. Window starts at last session
  // (or 7 days back if no prior session yet) and ends now.
  const sinceWindow =
    lastSession?.scheduledAt
    ?? new Date(session.scheduledAt.getTime() - 7 * 24 * 60 * 60 * 1000);
  const recentSignals = await db
    .select({
      proposed: changeRequests.proposedChange,
      reason: changeRequests.reason,
      requestedAt: changeRequests.requestedAt,
    })
    .from(changeRequests)
    .where(
      and(
        eq(changeRequests.studentId, student.id),
        gte(changeRequests.requestedAt, sinceWindow),
      ),
    )
    .orderBy(desc(changeRequests.requestedAt))
    .limit(20);
  const recentSignalsRendered = recentSignals
    .map((s) => `- ${s.proposed} — reason: ${s.reason}`)
    .join('\n');

  const rollingHistory = await getCurrentRollingSummary(student.id);

  const ai = new AIClient();
  const result = await ai.call({
    workerName: 'worker_7_meeting_prep',
    promptId: 'worker7_pass_b',
    studentId: student.id,
    sessionId: targetSessionId,
    inputs: {
      student_name: student.fullName,
      student_grade: student.currentGrade,
      upcoming_session_at: session.scheduledAt.toISOString(),
      rolling_history: rollingHistory || '(no rolling history yet)',
      last_session_summary: lastSessionSummary || '(no prior sessions)',
      last_session_todos:
        lastSessionTodosRendered || '(no open counsellor todos from the last session)',
      recent_signals: recentSignalsRendered || '(no new change requests since last session)',
      pass_a_content: passAContent,
    },
  });

  const now = new Date();
  if (brief) {
    await db
      .update(meetingPrepBriefs)
      .set({
        passBContent: result.rawResponse,
        passBGeneratedAt: now,
        status: 'pass_b_ready',
        // Clear the refresh signal — the next reschedule or significant
        // student activity will set it again.
        refreshAt: null,
        updatedAt: now,
      })
      .where(eq(meetingPrepBriefs.id, brief.id));
  } else {
    await db.insert(meetingPrepBriefs).values({
      targetSessionId,
      passBContent: result.rawResponse,
      passBGeneratedAt: now,
      status: 'pass_b_ready',
    });
  }

  // Surface to review queue.
  const briefId = brief?.id ?? (
    await db
      .select({ id: meetingPrepBriefs.id })
      .from(meetingPrepBriefs)
      .where(eq(meetingPrepBriefs.targetSessionId, targetSessionId))
      .limit(1)
  )[0]!.id;
  const existingQ = (
    await db
      .select({ id: reviewQueue.id })
      .from(reviewQueue)
      .where(and(eq(reviewQueue.type, 'meeting_prep_brief'), eq(reviewQueue.referenceId, briefId)))
      .limit(1)
  )[0];
  if (!existingQ) {
    await db.insert(reviewQueue).values({
      counsellorId: session.counsellorId,
      studentId: student.id,
      type: 'meeting_prep_brief',
      referenceId: briefId,
      priority: 3,
    });
  }
  return briefId;
}

/**
 * Pick briefs that are due for (re)generation. Rules:
 *   - `refresh_at` is set AND <= now (the explicit "regenerate me now" signal)
 *   - target session is still in the future (no point regenerating for a
 *     meeting that already happened)
 *   - haven't been regenerated since the refresh_at signal landed
 *
 * This replaces the old "exactly 24-25h before" window logic which silently
 * missed sessions created less than 24h before they happened, sessions
 * rescheduled inside the window, and sessions where new artifacts/
 * completions changed the context.
 */
export async function findBriefsNeedingPassB(
  now: Date = new Date(),
  limit = 20,
): Promise<string[]> {
  const rows = await db
    .select({
      sessionId: meetingPrepBriefs.targetSessionId,
    })
    .from(meetingPrepBriefs)
    .innerJoin(sessions, eq(sessions.id, meetingPrepBriefs.targetSessionId))
    .where(
      and(
        isNotNull(meetingPrepBriefs.refreshAt),
        lte(meetingPrepBriefs.refreshAt, now),
        gt(sessions.scheduledAt, now),
        or(
          isNull(meetingPrepBriefs.passBGeneratedAt),
          lt(meetingPrepBriefs.passBGeneratedAt, meetingPrepBriefs.refreshAt),
        ),
      ),
    )
    .orderBy(asc(sessions.scheduledAt))
    .limit(limit);
  return rows.map((r) => r.sessionId);
}

/** Backward-compatible alias — older callers grep for this name. */
export const findSessionsNeedingPassB = findBriefsNeedingPassB;

export async function runPassBSweep(): Promise<{ generated: number; failed: number }> {
  const ids = await findBriefsNeedingPassB();
  let generated = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await runWorker7PassB(id);
      generated += 1;
    } catch (err) {
      logger.warn({ err, sessionId: id }, 'pass B generation failed');
      failed += 1;
    }
  }
  return { generated, failed };
}

/**
 * Bump `refresh_at` on every brief for an upcoming session of this
 * student. Called when something changed that the brief should know about
 * — new artifact, new completion, new change request, new counsellor todo,
 * session reschedule. The cron picks it up within ~15 min.
 *
 * `withinHours` caps how far in the future to bother bumping (default 48h
 * — beyond that, the next 24h-before refresh will still capture the change
 * naturally).
 */
export async function markStudentBriefsForRefresh(
  studentId: string,
  withinHours = 48,
): Promise<number> {
  const now = new Date();
  const horizon = new Date(now.getTime() + withinHours * 60 * 60 * 1000);
  const upcoming = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.studentId, studentId),
        gt(sessions.scheduledAt, now),
        lte(sessions.scheduledAt, horizon),
      ),
    );
  if (upcoming.length === 0) return 0;
  const sessionIds = upcoming.map((r) => r.id);
  const result = await db
    .update(meetingPrepBriefs)
    .set({ refreshAt: new Date(now.getTime() + 5 * 60 * 1000), updatedAt: now })
    .where(inArray(meetingPrepBriefs.targetSessionId, sessionIds))
    .returning({ id: meetingPrepBriefs.id });
  return result.length;
}
