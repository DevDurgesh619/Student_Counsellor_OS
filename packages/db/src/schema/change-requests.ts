import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { idColumn } from './_helpers.js';
import { students } from './students.js';
import { tasks } from './tasks.js';
import { counsellors } from './counsellors.js';

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
  },
  (t) => ({
    studentStatusIdx: index('idx_change_requests_student_status').on(t.studentId, t.status),
  }),
);

export type ChangeRequest = typeof changeRequests.$inferSelect;
export type NewChangeRequest = typeof changeRequests.$inferInsert;
