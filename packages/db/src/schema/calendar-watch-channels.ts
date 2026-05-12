import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idColumn } from './_helpers.js';
import { students } from './students.js';

/**
 * Google Calendar watch channels for push notifications (Phase 4).
 * Channels expire every 30 days; the daily renewal cron reads `expiresAt`.
 */
export const calendarWatchChannels = pgTable(
  'calendar_watch_channels',
  {
    id: idColumn(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull().unique(),
    resourceId: text('resource_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    expiryIdx: index('idx_calendar_watch_expiry').on(t.expiresAt),
  }),
);

export type CalendarWatchChannel = typeof calendarWatchChannels.$inferSelect;
export type NewCalendarWatchChannel = typeof calendarWatchChannels.$inferInsert;
