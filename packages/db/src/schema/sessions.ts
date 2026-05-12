import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idColumn } from './_helpers.js';
import { students } from './students.js';
import { counsellors } from './counsellors.js';

export const sessions = pgTable(
  'sessions',
  {
    id: idColumn(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id),
    counsellorId: uuid('counsellor_id')
      .notNull()
      .references(() => counsellors.id),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    actualStartedAt: timestamp('actual_started_at', { withTimezone: true }),
    durationMinutes: integer('duration_minutes'),
    transcriptText: text('transcript_text'),
    transcriptUrl: text('transcript_url'),
    recordingUrl: text('recording_url'),
    spinachSummaryText: text('spinach_summary_text'),
    spinachMetadata: jsonb('spinach_metadata').$type<Record<string, unknown>>(),
    structuredExtractionId: uuid('structured_extraction_id'), // Phase 6 — references session_extractions
    agendaUsedId: uuid('agenda_used_id'), // Phase 6 — references meeting_prep_briefs
    status: text('status').notNull().default('scheduled'),
    createdAt: createdAt(),
  },
  (t) => ({
    studentIdx: index('idx_sessions_student').on(t.studentId, t.scheduledAt),
  }),
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
