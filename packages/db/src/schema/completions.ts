import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idColumn } from './_helpers.js';
import { tasks } from './tasks.js';

export const completions = pgTable(
  'completions',
  {
    id: idColumn(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    statusClaimed: text('status_claimed').notNull(), // done | partial | skipped | couldnt_do
    statusVerified: text('status_verified').notNull().default('claimed_only'),
    verificationMethod: text('verification_method'),
    notesText: text('notes_text'),
    timeTakenMinutes: integer('time_taken_minutes'),
    source: text('source').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    taskIdx: index('idx_completions_task').on(t.taskId),
    submittedIdx: index('idx_completions_submitted').on(t.submittedAt),
  }),
);

export type Completion = typeof completions.$inferSelect;
export type NewCompletion = typeof completions.$inferInsert;
