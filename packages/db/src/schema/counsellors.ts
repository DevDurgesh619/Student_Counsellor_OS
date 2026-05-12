import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idColumn, updatedAt } from './_helpers.js';

export const counsellors = pgTable('counsellors', {
  id: idColumn(),
  fullName: text('full_name').notNull(),
  email: text('email').notNull().unique(),
  phone: text('phone'),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  workingHours: jsonb('working_hours').$type<Record<string, [string, string]>>().default({
    monday: ['09:00', '18:00'],
  }),
  notificationPreferences: jsonb('notification_preferences')
    .$type<Record<string, unknown>>()
    .default({}),
  authUserId: uuid('auth_user_id'),
  spinachOauthToken: jsonb('spinach_oauth_token'),
  spinachLastSyncedAt: timestamp('spinach_last_synced_at', { withTimezone: true }),
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Counsellor = typeof counsellors.$inferSelect;
export type NewCounsellor = typeof counsellors.$inferInsert;
