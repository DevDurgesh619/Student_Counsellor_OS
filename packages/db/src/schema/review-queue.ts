import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idColumn } from './_helpers.js';
import { counsellors } from './counsellors.js';
import { students } from './students.js';

/**
 * Review queue. **Layer 1**, kept indefinitely (clarifications.md Q5):
 * the rows are factual records of counsellor decisions, not transient drafts.
 * Status transitions: pending → in_review → resolved | dismissed.
 * No hard delete in v1.
 */
export const reviewQueue = pgTable(
  'review_queue',
  {
    id: idColumn(),
    counsellorId: uuid('counsellor_id')
      .notNull()
      .references(() => counsellors.id),
    studentId: uuid('student_id').references(() => students.id),
    type: text('type').notNull(),
    referenceId: uuid('reference_id').notNull(),
    priority: integer('priority').notNull().default(5),
    status: text('status').notNull().default('pending'),
    createdAt: createdAt(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => counsellors.id),
    resolutionNotes: text('resolution_notes'),
  },
  (t) => ({
    counsellorStatusIdx: index('idx_review_queue_counsellor_status').on(
      t.counsellorId,
      t.status,
      t.priority,
    ),
  }),
);

export type ReviewQueueItem = typeof reviewQueue.$inferSelect;
export type NewReviewQueueItem = typeof reviewQueue.$inferInsert;
