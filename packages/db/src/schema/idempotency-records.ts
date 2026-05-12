import { integer, jsonb, pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt } from './_helpers.js';

/**
 * Idempotency records (CLAUDE_CODE.md §7 Pattern 7). 24-hour TTL. Active in
 * Phase 1 — POST endpoints store the response under the supplied
 * `Idempotency-Key` header so repeated calls return the same response.
 */
export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    key: text('key').primaryKey(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').$type<unknown>(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`(NOW() + INTERVAL '24 hours')`),
  },
  (t) => ({
    expiresIdx: index('idx_idempotency_expires').on(t.expiresAt),
  }),
);

export type IdempotencyRecord = typeof idempotencyRecords.$inferSelect;
export type NewIdempotencyRecord = typeof idempotencyRecords.$inferInsert;
