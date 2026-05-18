import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idColumn } from './_helpers.js';
import { counsellors } from './counsellors.js';
import { students } from './students.js';
import { aiCalls } from './ai-calls.js';
import { timetableChanges } from './timetable-changes.js';

/**
 * Counsellor's multi-turn chat with the timetable editor (Worker 4b).
 * Separate from assistant_conversations so the Ask AI feature can never
 * leak into the editor history (and vice versa) — different prompts,
 * different downstream effects.
 */
export const timetableConversations = pgTable(
  'timetable_conversations',
  {
    id: idColumn(),
    counsellorId: uuid('counsellor_id')
      .notNull()
      .references(() => counsellors.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    isBootstrap: boolean('is_bootstrap').notNull().default(false),
    title: text('title'),
    // Set when a counsellor opened a change_request via "Approve & open in
    // editor"; the message handler reads this to stamp source='change_request'
    // + sourceRequestId on resulting timetable_changes drafts. No FK to keep
    // change_requests <-> editor coupling loose.
    seedRequestId: uuid('seed_request_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => ({
    studentIdx: index('idx_timetable_conversations_student').on(t.studentId, t.startedAt),
  }),
);

export type TimetableConversation = typeof timetableConversations.$inferSelect;
export type NewTimetableConversation = typeof timetableConversations.$inferInsert;

export const timetableMessages = pgTable(
  'timetable_messages',
  {
    id: idColumn(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => timetableConversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    proposedChangeId: uuid('proposed_change_id').references(() => timetableChanges.id, {
      onDelete: 'set null',
    }),
    aiCallId: uuid('ai_call_id').references(() => aiCalls.id),
    createdAt: createdAt(),
  },
  (t) => ({
    convIdx: index('idx_timetable_messages_conversation').on(t.conversationId, t.createdAt),
  }),
);

export type TimetableMessage = typeof timetableMessages.$inferSelect;
export type NewTimetableMessage = typeof timetableMessages.$inferInsert;
