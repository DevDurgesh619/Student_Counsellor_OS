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
import { recurrenceGroups } from './recurrence-groups.js';
import { timetableChanges } from './timetable-changes.js';

/**
 * Tasks. UUID primary key (clarifications.md Q1 — deterministic format killed).
 * Calendar event ID derived deterministically from task UUID at the Calendar
 * boundary (CLAUDE_CODE.md §12) — not stored as the PK.
 *
 * Immutability rule: tasks are immutable once status changes from `scheduled`.
 * Reschedules create a new row with `rescheduledFromId` pointing back; old row
 * gets `status = 'rescheduled'`. Enforced in app code, not at DB level.
 *
 * `recurrenceParentId` / `recurrencePattern` are legacy. New code uses
 * `recurrenceGroupId` (FK to recurrence_groups) — the rule itself lives on
 * the group, not on each materialized occurrence. `generatedFromChangeId`
 * + `supersededByChangeId` + `supersededAt` are the audit chain: every
 * mutation pins the responsible decision and marks the prior state.
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
    recurrenceGroupId: uuid('recurrence_group_id').references(() => recurrenceGroups.id, {
      onDelete: 'set null',
    }),
    source: text('source').notNull().default('counsellor_manual'),
    generatedFromSessionId: uuid('generated_from_session_id'),
    generatedFromChangeId: uuid('generated_from_change_id').references(() => timetableChanges.id, {
      onDelete: 'set null',
    }),
    supersededByChangeId: uuid('superseded_by_change_id').references(() => timetableChanges.id, {
      onDelete: 'set null',
    }),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
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
    recurrenceGroupIdx: index('idx_tasks_recurrence_group').on(t.recurrenceGroupId),
  }),
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
