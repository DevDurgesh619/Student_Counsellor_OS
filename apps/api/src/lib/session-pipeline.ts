import { and, desc, eq, gte, lte, ne } from 'drizzle-orm';
import { z } from 'zod';
import {
  counsellorTodos,
  counsellors,
  db,
  gaps,
  meetingPrepBriefs,
  reviewQueue,
  sessions,
  sessionExtractions,
  students,
  tasks,
  type ExtractedActionItem,
  type ExtractedScheduleChange,
  type SessionExtraction,
} from '@wgc/db';
import { AIClient } from '@wgc/ai';
import { SUBJECTS } from '@wgc/shared';
import { logger } from '../logger.js';

// ---------- Zod schemas for AI outputs ----------

const ActionItemSchema = z.object({
  owner: z.enum(['student', 'counsellor', 'unclear']),
  description: z.string(),
  due: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
});

const ScheduleChangeSchema = z.object({
  type: z.enum(['add', 'remove', 'edit', 'move']),
  what: z.string(),
  when: z.string().nullable().optional(),
  duration: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const ExtractionSchema = z.object({
  topics_discussed: z.array(z.string()).default([]),
  action_items: z.array(ActionItemSchema).default([]),
  schedule_changes_discussed: z.boolean().default(false),
  schedule_changes: z.array(ScheduleChangeSchema).default([]),
  concerns_raised: z
    .array(
      z.object({
        raised_by: z.enum(['student', 'counsellor']),
        concern: z.string(),
        context: z.string().nullable().optional(),
      }),
    )
    .default([]),
  decisions_made: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
  confidence: z.enum(['low', 'normal', 'high']).default('normal'),
});

const TimetableDraftSchema = z.object({
  drafts: z
    .array(
      z.object({
        action: z.enum(['create', 'cancel', 'edit']),
        source_change_index: z.number().int().nonnegative(),
        task_id: z.string().nullable().optional(),
        scheduled_start: z.string().optional(),
        scheduled_end: z.string().optional(),
        subject: z.string().optional(),
        task_title: z.string().optional(),
        task_description: z.string().nullable().optional(),
        expected_output: z.string().nullable().optional(),
        recurrence_pattern: z.string().nullable().optional(),
        flexibility: z.enum(['fixed', 'preferred', 'flexible']).optional(),
        conflicts_with: z.array(z.string()).default([]),
        rationale: z.string().optional(),
      }),
    )
    .default([]),
  warnings: z.array(z.string()).default([]),
});

// ---------- Public entry point ----------

/**
 * Run the post-session pipeline against a session that has a transcript.
 * Idempotent: re-running atomically replaces extraction + downstream drafts.
 */
export async function runSessionPipeline(sessionId: string): Promise<{
  extractionId: string;
  passABriefId: string | null;
  draftTaskCount: number;
  worker4Ran: boolean;
}> {
  const session = (
    await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
  )[0];
  if (!session) throw new Error(`session ${sessionId} not found`);
  if (!session.transcriptText && !session.spinachSummaryText) {
    throw new Error(`session ${sessionId} has no transcript or summary; cannot extract`);
  }

  const student = (
    await db.select().from(students).where(eq(students.id, session.studentId)).limit(1)
  )[0];
  if (!student) throw new Error(`student ${session.studentId} not found`);
  const counsellor = (
    await db.select().from(counsellors).where(eq(counsellors.id, session.counsellorId)).limit(1)
  )[0];
  if (!counsellor) throw new Error(`counsellor ${session.counsellorId} not found`);

  // Step 1: structured extraction (replaces any existing extraction).
  const extraction = await runStructuredExtraction({
    sessionId,
    studentName: student.fullName,
    studentGrade: student.currentGrade,
    counsellorName: counsellor.fullName,
    sessionDate: (session.actualStartedAt ?? session.scheduledAt).toISOString(),
    transcript: session.transcriptText ?? '',
    spinachSummary: session.spinachSummaryText ?? '',
  });

  // Step 2: Worker 7 Pass A — runs always.
  let passABriefId: string | null = null;
  try {
    passABriefId = await runWorker7PassA({
      session,
      student,
      extraction,
    });
  } catch (err) {
    logger.warn({ err, sessionId }, 'worker7 pass A failed; continuing pipeline');
  }

  // Step 3: action item processing — runs always.
  const draftTaskCount = await processActionItems({
    extraction,
    counsellorId: counsellor.id,
    studentId: student.id,
    sessionId,
  });

  // Step 4: Worker 4 — gated on extraction.scheduleChangesDiscussed.
  let worker4Ran = false;
  if (extraction.scheduleChangesDiscussed && extraction.confidence !== 'low') {
    try {
      await runWorker4({
        session,
        student,
        extraction,
        counsellorId: counsellor.id,
      });
      worker4Ran = true;
    } catch (err) {
      logger.warn({ err, sessionId }, 'worker4 failed; counsellor will see warning');
    }
  }

  // Surface an extraction-summary review queue item so the counsellor lands on
  // it after a session. Idempotent on (type, reference_id).
  await ensureReviewQueueItem({
    counsellorId: counsellor.id,
    studentId: student.id,
    type: 'session_extraction',
    referenceId: extraction.id,
    priority: extraction.confidence === 'low' ? 2 : 4,
  });

  return {
    extractionId: extraction.id,
    passABriefId,
    draftTaskCount,
    worker4Ran,
  };
}

// ---------- Step 1: structured extraction ----------

async function runStructuredExtraction(input: {
  sessionId: string;
  studentName: string;
  studentGrade: string;
  counsellorName: string;
  sessionDate: string;
  transcript: string;
  spinachSummary: string;
}): Promise<SessionExtraction> {
  const ai = new AIClient();
  const result = await ai.call({
    workerName: 'worker_4_extract_session',
    promptId: 'worker4_extract_session',
    sessionId: input.sessionId,
    outputSchema: ExtractionSchema,
    inputs: {
      student_name: input.studentName,
      student_grade: input.studentGrade,
      counsellor_name: input.counsellorName,
      session_date: input.sessionDate,
      spinach_summary: input.spinachSummary || '(none)',
      transcript: input.transcript || '(none — only summary available)',
    },
  });
  const out = result.output;

  // Replace atomically: delete then insert (UNIQUE on session_id).
  await db.delete(sessionExtractions).where(eq(sessionExtractions.sessionId, input.sessionId));
  const inserted = await db
    .insert(sessionExtractions)
    .values({
      sessionId: input.sessionId,
      topicsDiscussed: out.topics_discussed,
      actionItems: out.action_items as ExtractedActionItem[],
      scheduleChangesDiscussed: out.schedule_changes_discussed,
      scheduleChanges: out.schedule_changes as ExtractedScheduleChange[],
      concernsRaised: out.concerns_raised,
      decisionsMade: out.decisions_made,
      openQuestions: out.open_questions,
      confidence: out.confidence,
      rawExtraction: out as unknown as Record<string, unknown>,
      aiCallId: result.aiCallId,
    })
    .returning();
  const row = inserted[0]!;
  await db
    .update(sessions)
    .set({ structuredExtractionId: row.id })
    .where(eq(sessions.id, input.sessionId));
  return row;
}

// ---------- Step 2: Worker 7 Pass A ----------

async function runWorker7PassA(args: {
  session: typeof sessions.$inferSelect;
  student: typeof students.$inferSelect;
  extraction: SessionExtraction;
}): Promise<string> {
  // Pass A is anchored to the *upcoming* session for this student; if none
  // exists yet, anchor to this session itself so the brief isn't lost.
  const upcoming = (
    await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.studentId, args.student.id),
          gte(sessions.scheduledAt, new Date()),
          ne(sessions.id, args.session.id),
        ),
      )
      .orderBy(sessions.scheduledAt)
      .limit(1)
  )[0];
  const targetSessionId = upcoming?.id ?? args.session.id;

  // Last 4 sessions' Spinach summaries for context.
  const recent = await db
    .select({ summary: sessions.spinachSummaryText, scheduledAt: sessions.scheduledAt })
    .from(sessions)
    .where(
      and(
        eq(sessions.studentId, args.student.id),
        ne(sessions.id, args.session.id),
      ),
    )
    .orderBy(desc(sessions.scheduledAt))
    .limit(4);
  const recentSummaries = recent
    .reverse()
    .map((r, i) => `[Session ${i + 1}] ${r.summary ?? '(no summary)'}`)
    .join('\n\n');

  const ai = new AIClient();
  const result = await ai.call({
    workerName: 'worker_7_meeting_prep',
    promptId: 'worker7_pass_a',
    studentId: args.student.id,
    sessionId: args.session.id,
    inputs: {
      student_name: args.student.fullName,
      session_date: (args.session.actualStartedAt ?? args.session.scheduledAt).toISOString(),
      extraction_json: args.extraction.rawExtraction ?? {},
      recent_summaries: recentSummaries || '(no prior sessions)',
    },
  });

  // Upsert (one brief per upcoming session).
  const existing = (
    await db
      .select()
      .from(meetingPrepBriefs)
      .where(eq(meetingPrepBriefs.targetSessionId, targetSessionId))
      .limit(1)
  )[0];
  const now = new Date();
  if (existing) {
    await db
      .update(meetingPrepBriefs)
      .set({
        passAContent: result.rawResponse,
        passAGeneratedAt: now,
        updatedAt: now,
      })
      .where(eq(meetingPrepBriefs.id, existing.id));
    return existing.id;
  }
  const inserted = await db
    .insert(meetingPrepBriefs)
    .values({
      targetSessionId,
      passAContent: result.rawResponse,
      passAGeneratedAt: now,
      status: 'pass_a_only',
    })
    .returning({ id: meetingPrepBriefs.id });
  return inserted[0]!.id;
}

// ---------- Step 3: action item processing ----------

async function processActionItems(args: {
  extraction: SessionExtraction;
  counsellorId: string;
  studentId: string;
  sessionId: string;
}): Promise<number> {
  let draftTasks = 0;
  for (const item of args.extraction.actionItems) {
    if (item.owner === 'counsellor') {
      // Idempotency: skip if a todo with the exact description already exists
      // for this session.
      const existing = (
        await db
          .select()
          .from(counsellorTodos)
          .where(
            and(
              eq(counsellorTodos.counsellorId, args.counsellorId),
              eq(counsellorTodos.sourceSessionId, args.sessionId),
              eq(counsellorTodos.description, item.description),
            ),
          )
          .limit(1)
      )[0];
      if (existing) continue;
      await db.insert(counsellorTodos).values({
        counsellorId: args.counsellorId,
        studentId: args.studentId,
        description: item.description,
        sourceSessionId: args.sessionId,
        dueDate: parseRelativeDue(item.due ?? null),
      });
      continue;
    }
    if (item.owner === 'unclear') {
      // Surface for counsellor to assign.
      await ensureReviewQueueItem({
        counsellorId: args.counsellorId,
        studentId: args.studentId,
        type: 'action_item_unassigned',
        referenceId: args.extraction.id,
        priority: 3,
      });
      continue;
    }
    // owner === 'student' — only the timetable drafter creates concrete tasks
    // (Worker 4). For action items that don't map to recurring schedule
    // changes, surface as a note for counsellor to translate manually.
    draftTasks += 0;
  }
  return draftTasks;
}

function parseRelativeDue(due: string | null): string | null {
  if (!due) return null;
  const lower = due.toLowerCase();
  const today = new Date();
  if (lower.includes('today')) return today.toISOString().slice(0, 10);
  if (lower.includes('tomorrow')) {
    const t = new Date(today);
    t.setDate(t.getDate() + 1);
    return t.toISOString().slice(0, 10);
  }
  if (lower.includes('this week') || lower.includes('next session') || lower.includes('before next')) {
    const t = new Date(today);
    t.setDate(t.getDate() + 7);
    return t.toISOString().slice(0, 10);
  }
  // Otherwise leave as null; counsellor sees the raw `description`/`due` text
  // in the review queue instead.
  return null;
}

// ---------- Step 4: Worker 4 (Mode 1) ----------

async function runWorker4(args: {
  session: typeof sessions.$inferSelect;
  student: typeof students.$inferSelect;
  extraction: SessionExtraction;
  counsellorId: string;
}): Promise<void> {
  // Idempotency: drop any existing drafts from a prior run for this session.
  await db
    .delete(tasks)
    .where(
      and(
        eq(tasks.generatedFromSessionId, args.session.id),
        eq(tasks.status, 'draft'),
      ),
    );

  // Compute next ISO Monday for week_start.
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sun
  const daysToMonday = ((1 - day) + 7) % 7 || 7;
  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() + daysToMonday);
  weekStart.setUTCHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 14);

  const existing = await db
    .select({
      id: tasks.id,
      start: tasks.scheduledStart,
      end: tasks.scheduledEnd,
      subject: tasks.subject,
      title: tasks.taskTitle,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.studentId, args.student.id),
        gte(tasks.scheduledStart, new Date()),
        lte(tasks.scheduledStart, weekEnd),
      ),
    );
  const existingTasksRendered = existing
    .map(
      (t) =>
        `${t.id} | ${t.start.toISOString()} → ${t.end.toISOString()} | ${t.subject} | ${t.title}`,
    )
    .join('\n');

  const studentGaps = await db
    .select({ category: gaps.category, description: gaps.description, subject: gaps.subject })
    .from(gaps)
    .where(and(eq(gaps.studentId, args.student.id), eq(gaps.status, 'active')))
    .limit(20);
  const gapsSummary = studentGaps
    .map((g) => `[${g.category}${g.subject ? `:${g.subject}` : ''}] ${g.description}`)
    .join('\n');

  const ai = new AIClient();
  const result = await ai.call({
    workerName: 'worker_4_timetable_drafter',
    promptId: 'worker4_timetable_draft',
    studentId: args.student.id,
    sessionId: args.session.id,
    outputSchema: TimetableDraftSchema,
    inputs: {
      student_name: args.student.fullName,
      student_grade: args.student.currentGrade,
      timezone: args.student.timezone,
      session_date: (args.session.actualStartedAt ?? args.session.scheduledAt).toISOString(),
      week_start: weekStart.toISOString().slice(0, 10),
      allowed_subjects: SUBJECTS.join(', '),
      schedule_changes_json: args.extraction.scheduleChanges,
      existing_tasks: existingTasksRendered || '(none)',
      plan_summary: '(not available; plan engine ships in Phase 8)',
      gaps_summary: gapsSummary || '(no active gaps)',
    },
  });

  const allowedSubjects: ReadonlySet<string> = new Set(SUBJECTS as readonly string[]);
  let createdCount = 0;
  const drafts = result.output.drafts ?? [];
  const warnings = result.output.warnings ?? [];
  for (const draft of drafts) {
    if (draft.action !== 'create') continue;
    if (!draft.scheduled_start || !draft.scheduled_end || !draft.subject || !draft.task_title) continue;
    const subject = allowedSubjects.has(draft.subject) ? draft.subject : 'Other';
    await db.insert(tasks).values({
      studentId: args.student.id,
      scheduledStart: new Date(draft.scheduled_start),
      scheduledEnd: new Date(draft.scheduled_end),
      subject,
      taskTitle: draft.task_title,
      taskDescription: draft.task_description ?? null,
      expectedOutput: draft.expected_output ?? null,
      recurrencePattern: draft.recurrence_pattern ?? null,
      flexibility: draft.flexibility ?? 'preferred',
      source: 'ai_drafted_from_session',
      generatedFromSessionId: args.session.id,
      status: 'draft',
    });
    createdCount += 1;
  }

  if (createdCount > 0 || warnings.length > 0) {
    await ensureReviewQueueItem({
      counsellorId: args.counsellorId,
      studentId: args.student.id,
      type: 'draft_timetable_changes',
      referenceId: args.session.id,
      priority: 2,
    });
  }
}

// ---------- Helpers ----------

async function ensureReviewQueueItem(item: {
  counsellorId: string;
  studentId: string | null;
  type: string;
  referenceId: string;
  priority: number;
}): Promise<void> {
  const existing = (
    await db
      .select({ id: reviewQueue.id, status: reviewQueue.status })
      .from(reviewQueue)
      .where(and(eq(reviewQueue.type, item.type), eq(reviewQueue.referenceId, item.referenceId)))
      .limit(1)
  )[0];
  if (existing) {
    // Reopen if it had been resolved/dismissed and we regenerated.
    if (existing.status !== 'pending' && existing.status !== 'in_review') {
      await db
        .update(reviewQueue)
        .set({ status: 'pending', priority: item.priority })
        .where(eq(reviewQueue.id, existing.id));
    }
    return;
  }
  await db.insert(reviewQueue).values({
    counsellorId: item.counsellorId,
    studentId: item.studentId,
    type: item.type,
    referenceId: item.referenceId,
    priority: item.priority,
  });
}
