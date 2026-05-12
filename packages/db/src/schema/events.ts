import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { idColumn } from './_helpers.js';

/**
 * Postgres-backed event bus (CLAUDE_CODE.md §11). Active in Phase 5+ when
 * subscribers start polling. v2 prefixes (whatsapp.*, pattern_detector.*,
 * pillar.*) are forbidden — guard at the emitter via assertNoV2Prefix from
 * @wgc/shared/events.
 */
export const events = pgTable(
  'events',
  {
    id: idColumn(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    correlationId: uuid('correlation_id'),
    emittedAt: timestamp('emitted_at', { withTimezone: true }).notNull().defaultNow(),
    status: text('status').notNull().default('pending'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    errorText: text('error_text'),
  },
  (t) => ({
    pendingIdx: index('idx_events_pending').on(t.status, t.emittedAt),
    correlationIdx: index('idx_events_correlation').on(t.correlationId),
  }),
);

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
