import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, idColumn } from './_helpers.js';
import { students } from './students.js';
import { counsellors } from './counsellors.js';
import { aiCalls } from './ai-calls.js';
// Postgres uuid[] column.
import { customType } from 'drizzle-orm/pg-core';
const uuidArray = customType<{ data: string[]; driverData: string[] }>({
  dataType: () => 'uuid[]',
});

/**
 * Layer 2. Written by Worker 1 (Profile Builder) when a student submits the
 * onboarding form. Read by the counsellor review queue.
 *
 * Post-Google-OAuth refactor: `student_id` is NOT NULL — every draft belongs
 * to an authenticated student. The old token-as-auth columns are gone.
 */
export const studentProfileDrafts = pgTable(
  'student_profile_drafts',
  {
    id: idColumn(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    counsellorId: uuid('counsellor_id').references(() => counsellors.id),
    aiCallId: uuid('ai_call_id').references(() => aiCalls.id),
    formResponses: jsonb('form_responses').$type<Record<string, unknown>>(),
    marksheetArtifacts: uuidArray('marksheet_artifacts').notNull().default(sql`'{}'::uuid[]`),
    profile: jsonb('profile').$type<Record<string, unknown>>(),
    flagsForCounsellor: jsonb('flags_for_counsellor')
      .$type<unknown[]>()
      .default(sql`'[]'::jsonb`),
    status: text('status').notNull().default('pending_review'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => counsellors.id),
    createdAt: createdAt(),
  },
  (t) => ({
    statusIdx: index('idx_profile_drafts_status').on(t.status),
    studentIdx: index('idx_profile_drafts_student').on(t.studentId),
  }),
);

export type StudentProfileDraft = typeof studentProfileDrafts.$inferSelect;
export type NewStudentProfileDraft = typeof studentProfileDrafts.$inferInsert;
