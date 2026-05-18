import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { idColumn } from './_helpers.js';
import { students } from './students.js';
import { tasks } from './tasks.js';
import { counsellors } from './counsellors.js';
import { recurrenceGroups } from './recurrence-groups.js';

export const changeRequests = pgTable(
  'change_requests',
  {
    id: idColumn(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    originalTaskId: uuid('original_task_id').references(() => tasks.id),
    patternDescription: text('pattern_description'),
    proposedChange: text('proposed_change').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('pending'),
    counsellorNotes: text('counsellor_notes'),
    decidedBy: uuid('decided_by').references(() => counsellors.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    // Structured task-change fields. kind='general' (default) keeps legacy
    // free-text requests valid; kind='task_change' carries the structured
    // pointer the counsellor needs to route the request into the editor.
    kind: text('kind').notNull().default('general'),
    scope: text('scope'),
    targetRecurrenceGroupId: uuid('target_recurrence_group_id').references(
      () => recurrenceGroups.id,
      { onDelete: 'set null' },
    ),
    proposedStart: timestamp('proposed_start', { withTimezone: true }),
    proposedEnd: timestamp('proposed_end', { withTimezone: true }),
    // Cross-feature pointers (no FK to keep coupling loose with the editor).
    linkedConversationId: uuid('linked_conversation_id'),
    linkedChangeId: uuid('linked_change_id'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => ({
    studentStatusIdx: index('idx_change_requests_student_status').on(t.studentId, t.status),
    kindStatusIdx: index('idx_change_requests_kind_status').on(t.studentId, t.kind, t.status),
  }),
);

export type ChangeRequest = typeof changeRequests.$inferSelect;
export type NewChangeRequest = typeof changeRequests.$inferInsert;
