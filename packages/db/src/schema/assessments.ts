import { date, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { idColumn } from './_helpers.js';
import { students } from './students.js';

export const assessments = pgTable('assessments', {
  id: idColumn(),
  studentId: uuid('student_id')
    .notNull()
    .references(() => students.id, { onDelete: 'cascade' }),
  subject: text('subject').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  questions: jsonb('questions').$type<unknown[]>().notNull(),
  answerKey: jsonb('answer_key').$type<Record<string, unknown>>(),
  rubric: jsonb('rubric').$type<Record<string, unknown>>(),
  status: text('status').notNull().default('draft'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdByWorker: text('created_by_worker'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
});

export type Assessment = typeof assessments.$inferSelect;
export type NewAssessment = typeof assessments.$inferInsert;
