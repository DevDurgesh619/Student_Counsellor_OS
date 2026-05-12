import { date, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, idColumn, updatedAt } from './_helpers.js';
import { students } from './students.js';

export const reports = pgTable(
  'reports',
  {
    id: idColumn(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // weekly | monthly_parent | quarterly_deep | counsellor_working | student_facing
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    draftContent: text('draft_content'),
    reviewedContent: text('reviewed_content'),
    status: text('status').notNull().default('ai_drafted'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    sentTo: jsonb('sent_to').$type<string[]>().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    studentPeriodIdx: index('idx_reports_student_period').on(
      t.studentId,
      t.periodStart,
      t.periodEnd,
    ),
  }),
);

export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;
