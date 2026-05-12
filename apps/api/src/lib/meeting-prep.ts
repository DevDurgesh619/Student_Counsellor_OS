import { and, desc, eq, gte, isNull, lt, or } from 'drizzle-orm';
import {
  changeRequests,
  db,
  gaps,
  meetingPrepBriefs,
  reports,
  reviewQueue,
  sessions,
  students,
  tasks,
} from '@wgc/db';
import { AIClient } from '@wgc/ai';
import { logger } from '../logger.js';

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
      .select()
      .from(meetingPrepBriefs)
      .where(eq(meetingPrepBriefs.targetSessionId, targetSessionId))
      .limit(1)
  )[0];
  const passAContent = brief?.passAContent ?? '(no Pass A draft was generated)';

  // Last 6 prior session summaries.
  const priorSessions = await db
    .select({ summary: sessions.spinachSummaryText, scheduledAt: sessions.scheduledAt })
    .from(sessions)
    .where(
      and(
        eq(sessions.studentId, student.id),
        lt(sessions.scheduledAt, session.scheduledAt),
      ),
    )
    .orderBy(desc(sessions.scheduledAt))
    .limit(6);
  const recentSummaries = priorSessions
    .reverse()
    .map((s) => `[${s.scheduledAt.toISOString().slice(0, 10)}] ${s.summary ?? '(no summary)'}`)
    .join('\n\n');

  // Determine "since last session" window.
  const lastSessionAt = priorSessions[priorSessions.length - 1]?.scheduledAt
    ?? new Date(session.scheduledAt.getTime() - 7 * 24 * 60 * 60 * 1000);

  const periodTasks = await db
    .select({
      title: tasks.taskTitle,
      subject: tasks.subject,
      status: tasks.status,
      start: tasks.scheduledStart,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.studentId, student.id),
        gte(tasks.scheduledStart, lastSessionAt),
        lt(tasks.scheduledStart, session.scheduledAt),
      ),
    )
    .limit(50);
  const tasksSummary = periodTasks
    .map((t) => `${t.start.toISOString().slice(0, 10)} ${t.subject} "${t.title}" → ${t.status}`)
    .join('\n');

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
        gte(changeRequests.requestedAt, lastSessionAt),
      ),
    )
    .limit(20);
  const recentSignalsRendered = recentSignals
    .map((s) => `${s.proposed} — reason: ${s.reason}`)
    .join('\n');

  const recentReports = await db
    .select({
      type: reports.type,
      content: reports.reviewedContent,
      draft: reports.draftContent,
      createdAt: reports.createdAt,
    })
    .from(reports)
    .where(eq(reports.studentId, student.id))
    .orderBy(desc(reports.createdAt))
    .limit(2);
  const recentReportsRendered = recentReports
    .map((r) => `[${r.type}] ${r.content ?? r.draft ?? '(no content)'}`)
    .join('\n\n');

  const studentGaps = await db
    .select({ category: gaps.category, description: gaps.description, subject: gaps.subject })
    .from(gaps)
    .where(and(eq(gaps.studentId, student.id), eq(gaps.status, 'active')))
    .limit(20);
  const gapsSummary = studentGaps
    .map((g) => `[${g.category}${g.subject ? `:${g.subject}` : ''}] ${g.description}`)
    .join('\n');

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
      pass_a_content: passAContent,
      recent_summaries: recentSummaries || '(no prior sessions)',
      tasks_summary: tasksSummary || '(no tasks in period)',
      recent_signals: recentSignalsRendered || '(none)',
      recent_reports: recentReportsRendered || '(none)',
      gaps_summary: gapsSummary || '(no active gaps)',
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
 * Find sessions scheduled 24h–25h from now whose Pass B brief hasn't been
 * generated yet. Returns IDs in chronological order.
 */
export async function findSessionsNeedingPassB(now: Date = new Date()): Promise<string[]> {
  const lower = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const upper = new Date(now.getTime() + 25 * 60 * 60 * 1000);

  // LEFT JOIN-ish via two queries: pull sessions in window, then exclude
  // those that already have pass_b_content.
  const inWindow = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        gte(sessions.scheduledAt, lower),
        lt(sessions.scheduledAt, upper),
        or(eq(sessions.status, 'scheduled'), isNull(sessions.status)),
      ),
    );
  const ids = inWindow.map((s) => s.id);
  if (ids.length === 0) return [];

  const briefs = await db
    .select({ targetSessionId: meetingPrepBriefs.targetSessionId, passB: meetingPrepBriefs.passBContent })
    .from(meetingPrepBriefs);
  const haveB = new Set(briefs.filter((b) => b.passB).map((b) => b.targetSessionId));
  return ids.filter((id) => !haveB.has(id));
}

export async function runPassBSweep(): Promise<{ generated: number; failed: number }> {
  const ids = await findSessionsNeedingPassB();
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
