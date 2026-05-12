import { boolean, decimal, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { idColumn } from './_helpers.js';
import { assessments } from './assessments.js';
import { artifacts } from './artifacts.js';

/**
 * Submissions. `final_grade` is the canonical authoritative score
 * (clarifications.md Q2(b)). Population rules — applied by Worker 3 in Phase 7,
 * per CLAUDE_CODE.md §3 deterministic carve-out:
 *
 *   - Objective question with ai_grade_confidence ≥ 95
 *     → auto-commit at grading time: final_grade = ai_proposed_grade.
 *       NO review_queue row created.
 *   - Objective with ai_grade_confidence < 95
 *     → final_grade = NULL until counsellor resolves the queue item;
 *       on resolution, final_grade = counsellor's decision.
 *   - Subjective (rubric-based, photo-of-working, OCR'd)
 *     → final_grade = NULL until counsellor resolves;
 *       on resolution, final_grade = counsellor's decision (may equal
 *       ai_proposed_grade).
 *   - Counsellor override (any type): final_grade = override value,
 *     counsellor_override = true, counsellor_override_reason populated.
 */
export const submissions = pgTable('submissions', {
  id: idColumn(),
  assessmentId: uuid('assessment_id')
    .notNull()
    .references(() => assessments.id, { onDelete: 'cascade' }),
  questionId: text('question_id').notNull(), // matches the id within assessments.questions
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  answerText: text('answer_text'),
  answerArtifactId: uuid('answer_artifact_id').references(() => artifacts.id),
  aiProposedGrade: decimal('ai_proposed_grade', { precision: 5, scale: 2 }),
  gradeCorrectness: decimal('grade_correctness', { precision: 5, scale: 2 }),
  gradeType: text('grade_type'), // memory | application | both
  gradeQualityOfWorking: decimal('grade_quality_of_working', { precision: 5, scale: 2 }),
  aiGradeConfidence: decimal('ai_grade_confidence', { precision: 5, scale: 2 }),
  counsellorOverride: boolean('counsellor_override').default(false),
  counsellorOverrideReason: text('counsellor_override_reason'),
  finalGrade: decimal('final_grade', { precision: 5, scale: 2 }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
});

export type Submission = typeof submissions.$inferSelect;
export type NewSubmission = typeof submissions.$inferInsert;
