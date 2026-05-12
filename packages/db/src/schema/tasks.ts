import {
  type AnyPgColumn,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, idColumn, updatedAt } from './_helpers.js';
import { students } from './students.js';

/**
 * Tasks. UUID primary key (clarifications.md Q1 — deterministic format killed).
 * Calendar event ID derived deterministically from task UUID at the Calendar
 * boundary (CLAUDE_CODE.md §12) — not stored as the PK.
 *
 * Immutability rule: tasks are immutable once status changes from `scheduled`.
 * Reschedules create a new row with `rescheduledFromId` pointing back; old row
 * gets `status = 'rescheduled'`. Enforced in app code, not at DB level.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: idColumn(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    scheduledStart: timestamp('scheduled_start', { withTimezone: true }).notNull(),
    scheduledEnd: timestamp('scheduled_end', { withTimezone: true }).notNull(),
    subject: text('subject').notNull(), // enum enforced in app code (@wgc/shared SUBJECTS)
    taskTitle: text('task_title').notNull(),
    taskDescription: text('task_description'),
    expectedOutput: text('expected_output'),
    recurrencePattern: text('recurrence_pattern'),
    recurrenceParentId: uuid('recurrence_parent_id').references(
      (): AnyPgColumn => tasks.id,
    ),
    source: text('source').notNull().default('counsellor_manual'),
    generatedFromSessionId: uuid('generated_from_session_id'),
    status: text('status').notNull().default('scheduled'),
    rescheduledFromId: uuid('rescheduled_from_id').references((): AnyPgColumn => tasks.id),
    linkedGapId: uuid('linked_gap_id'),
    verificationRequired: boolean('verification_required').notNull().default(false),
    flexibility: text('flexibility').notNull().default('preferred'),
    googleCalendarEventId: text('google_calendar_event_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    studentDateIdx: index('idx_tasks_student_date').on(t.studentId, t.scheduledStart),
    statusIdx: index('idx_tasks_status').on(t.status),
    recurrenceParentIdx: index('idx_tasks_recurrence_parent').on(t.recurrenceParentId),
  }),
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
