import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { idColumn } from './_helpers.js';
import { counsellors } from './counsellors.js';
import { sessions } from './sessions.js';

export type SpinachAttendee = {
  name?: string;
  email?: string;
  internal?: boolean;
};

export const spinachIngestedMeetings = pgTable(
  'spinach_ingested_meetings',
  {
    id: idColumn(),
    counsellorId: uuid('counsellor_id')
      .notNull()
      .references(() => counsellors.id, { onDelete: 'cascade' }),
    spinachMeetingId: text('spinach_meeting_id').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    title: text('title'),
    attendees: jsonb('attendees')
      .$type<SpinachAttendee[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    raw: jsonb('raw').$type<Record<string, unknown>>(),
    status: text('status').notNull().default('unassigned'),
    linkedSessionId: uuid('linked_session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
  },
  (t) => ({
    counsellorMeetingUq: uniqueIndex('uq_spinach_ingested_counsellor_meeting').on(
      t.counsellorId,
      t.spinachMeetingId,
    ),
    statusIdx: index('idx_spinach_ingested_status').on(t.counsellorId, t.status),
  }),
);

export type SpinachIngestedMeeting = typeof spinachIngestedMeetings.$inferSelect;
export type NewSpinachIngestedMeeting = typeof spinachIngestedMeetings.$inferInsert;
