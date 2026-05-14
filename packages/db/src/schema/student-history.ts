import { sql } from 'drizzle-orm';
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { idColumn } from './_helpers.js';
import { students } from './students.js';
import { aiCalls } from './ai-calls.js';

const uuidArray = customType<{ data: string[]; driverData: string[] }>({
  dataType: () => 'uuid[]',
});

/**
 * Rolling longitudinal narrative for a student. Regenerated after every
 * meeting ingest from (prior summary + new extraction + approved onboarding
 * profile). One row per student — `student_id` is UNIQUE. Older versions
 * are preserved in `studentHistorySummaryVersions`.
 */
export const studentHistorySummaries = pgTable('student_history_summaries', {
  id: idColumn(),
  studentId: uuid('student_id')
    .notNull()
    .unique()
    .references(() => students.id, { onDelete: 'cascade' }),
  currentVersion: integer('current_version').notNull().default(1),
  content: text('content').notNull(),
  openConcerns: jsonb('open_concerns').$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
  lastUpdatedFocus: text('last_updated_focus'),
  basedOnSessionIds: uuidArray('based_on_session_ids').notNull().default(sql`'{}'::uuid[]`),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  aiCallId: uuid('ai_call_id').references(() => aiCalls.id),
});

export type StudentHistorySummary = typeof studentHistorySummaries.$inferSelect;
export type NewStudentHistorySummary = typeof studentHistorySummaries.$inferInsert;

export const studentHistorySummaryVersions = pgTable(
  'student_history_summary_versions',
  {
    id: idColumn(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    openConcerns: jsonb('open_concerns').$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    lastUpdatedFocus: text('last_updated_focus'),
    basedOnSessionIds: uuidArray('based_on_session_ids').notNull().default(sql`'{}'::uuid[]`),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    aiCallId: uuid('ai_call_id').references(() => aiCalls.id),
  },
  (t) => ({
    uniqueVersion: unique().on(t.studentId, t.version),
    studentIdx: index('idx_student_history_summary_versions_student').on(t.studentId, t.version),
  }),
);

export type StudentHistorySummaryVersion = typeof studentHistorySummaryVersions.$inferSelect;
export type NewStudentHistorySummaryVersion = typeof studentHistorySummaryVersions.$inferInsert;
