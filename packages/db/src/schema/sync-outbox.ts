import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { uuid } from 'drizzle-orm/pg-core';
import { createdAt, idColumn } from './_helpers.js';

/**
 * Outbox pattern (CLAUDE_CODE.md §7 Pattern 1). Active in Phase 4 when the
 * Calendar Sync Service polls for pending entries and dispatches to Google
 * Calendar / other external services.
 */
export const syncOutbox = pgTable(
  'sync_outbox',
  {
    id: idColumn(),
    entityType: text('entity_type').notNull(), // 'task' | 'student' | ...
    entityId: uuid('entity_id').notNull(),
    operation: text('operation').notNull(), // 'create' | 'update' | 'delete'
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    pendingIdx: index('idx_sync_outbox_pending').on(t.status, t.createdAt),
  }),
);

export type SyncOutboxEntry = typeof syncOutbox.$inferSelect;
export type NewSyncOutboxEntry = typeof syncOutbox.$inferInsert;
