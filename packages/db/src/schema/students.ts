import { date, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, idColumn, updatedAt } from './_helpers.js';
import { counsellors } from './counsellors.js';

export const students = pgTable(
  'students',
  {
    id: idColumn(),
    fullName: text('full_name').notNull(),
    phone: text('phone').notNull(),
    email: text('email'),
    parentContacts: jsonb('parent_contacts')
      .$type<
        Array<{
          name: string;
          phone?: string;
          email?: string;
          relationship: 'father' | 'mother' | 'guardian' | 'other';
        }>
      >()
      .notNull()
      .default(sql`'[]'::jsonb`),
    counsellorId: uuid('counsellor_id').references(() => counsellors.id),
    currentGrade: text('current_grade').notNull(),
    school: text('school'),
    currentContextTag: text('current_context_tag').notNull().default('school_term'),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    languagePreferences: jsonb('language_preferences')
      .$type<{ primary: string; secondary?: string[] }>()
      .default({ primary: 'en' }),
    optOuts: jsonb('opt_outs').$type<Record<string, boolean>>().default({}),
    programStartDate: date('program_start_date').notNull().default(sql`CURRENT_DATE`),
    googleCalendarId: text('google_calendar_id'),
    googleOauthToken: jsonb('google_oauth_token'),
    status: text('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    counsellorIdx: index('idx_students_counsellor').on(t.counsellorId),
    statusIdx: index('idx_students_status').on(t.status),
  }),
);

export type Student = typeof students.$inferSelect;
export type NewStudent = typeof students.$inferInsert;
