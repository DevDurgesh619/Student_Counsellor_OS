import { type AnyPgColumn, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idColumn } from './_helpers.js';
import { students } from './students.js';
// NOTE: source_session_id and source_request_id are typed as plain uuid here
// (not .references()) on purpose — typed FKs would create an import cycle
// (timetable_changes → change_requests → tasks → timetable_changes). The DB
// constraints exist; they're declared in the SQL migration.

/**
 * Append-only log of every mutation to the active schedule. Each row is the
 * audit record for one "decision" — bootstrap, meeting extraction, student
 * change request, conversational editor, direct counsellor edit. Tasks
 * point back via `generated_from_change_id` and `superseded_by_change_id`,
 * so we can answer "which decision put this Thursday block on the grid?"
 *
 * Operations is an array of closed-vocabulary ops; see timetable-engine.ts
 * for the executor that compiles them into task/recurrence-group writes.
 */
export type TimetableOp =
  | {
      op: 'create_task';
      payload: {
        scheduled_start: string;
        scheduled_end: string;
        subject: string;
        task_title: string;
        task_description?: string | null;
        expected_output?: string | null;
        flexibility?: 'fixed' | 'preferred' | 'flexible';
      };
    }
  | {
      op: 'create_recurrence';
      payload: {
        rule_json: RecurrenceRule;
        starts_on: string;
        ends_on: string;
        subject: string;
        task_title: string;
        task_description?: string | null;
        flexibility?: 'fixed' | 'preferred' | 'flexible';
      };
    }
  | { op: 'cancel_task'; payload: { task_id: string } }
  | { op: 'cancel_recurrence'; payload: { recurrence_group_id: string; effective_from?: string } }
  | { op: 'move_task'; payload: { task_id: string; new_start: string; new_end: string } }
  | {
      // In-place edit of non-time fields. Time changes should use move_task,
      // which supersedes. edit_task is for label/description/flexibility
      // tweaks where superseding would be noise.
      op: 'edit_task';
      payload: {
        task_id: string;
        changes: {
          subject?: string;
          task_title?: string;
          task_description?: string | null;
          expected_output?: string | null;
          flexibility?: 'fixed' | 'preferred' | 'flexible';
          verification_required?: boolean;
        };
      };
    }
  | {
      op: 'edit_recurrence';
      payload: {
        recurrence_group_id: string;
        new_rule_json: RecurrenceRule;
        effective_from: string;
      };
    };

export type RecurrenceRule = {
  frequency: 'daily' | 'weekly';
  days_of_week: number[]; // 0=Sun..6=Sat (ISO sloppy but ubiquitous in JS)
  start_time: string; // 'HH:MM' 24h
  duration_min: number;
  timezone: string; // IANA, e.g. 'Asia/Kolkata'
};

export const timetableChanges = pgTable(
  'timetable_changes',
  {
    id: idColumn(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    status: text('status').notNull().default('draft'),
    operations: jsonb('operations').$type<TimetableOp[]>().notNull(),
    rationale: text('rationale'),
    sourceSessionId: uuid('source_session_id'),
    sourceRequestId: uuid('source_request_id'),
    // Forward-ref to timetable_conversations; no FK to avoid a circular schema
    // import. The SQL migration also leaves this unconstrained for the same
    // reason.
    sourceConversationId: uuid('source_conversation_id'),
    createdBySubjectId: uuid('created_by_subject_id').notNull(),
    createdByRole: text('created_by_role').notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    studentIdx: index('idx_timetable_changes_student').on(t.studentId, t.createdAt),
  }),
);

export type TimetableChange = typeof timetableChanges.$inferSelect;
export type NewTimetableChange = typeof timetableChanges.$inferInsert;

// Self-ref helper for downstream FKs (recurrence-groups, tasks). Kept here
// so other schema files can import a typed column reference.
export const timetableChangesIdRef = (): AnyPgColumn => timetableChanges.id;
