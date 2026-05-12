import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, idColumn } from './_helpers.js';
import { counsellors } from './counsellors.js';
import { students } from './students.js';
import { aiCalls } from './ai-calls.js';

/**
 * Counsellor-assistant chat threads (Worker 6, Phase 5). Distinct from the
 * `conversations` table, which logs WhatsApp / onboarding-consent records.
 */
export const assistantConversations = pgTable(
  'assistant_conversations',
  {
    id: idColumn(),
    counsellorId: uuid('counsellor_id')
      .notNull()
      .references(() => counsellors.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id').references(() => students.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    title: text('title'),
  },
  (t) => ({
    counsellorIdx: index('idx_assistant_conversations_counsellor').on(
      t.counsellorId,
      t.startedAt,
    ),
  }),
);

export type AssistantConversation = typeof assistantConversations.$inferSelect;
export type NewAssistantConversation = typeof assistantConversations.$inferInsert;

export type Citation = {
  /** Entity table name, e.g. 'tasks', 'completions', 'artifacts'. */
  entity: string;
  /** Primary key UUID of the cited row. */
  id: string;
  /** Optional human label rendered next to the link. */
  label?: string;
};

export const assistantMessages = pgTable(
  'assistant_messages',
  {
    id: idColumn(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => assistantConversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    citations: jsonb('citations').$type<Citation[]>().notNull().default(sql`'[]'::jsonb`),
    aiCallId: uuid('ai_call_id').references(() => aiCalls.id),
    createdAt: createdAt(),
  },
  (t) => ({
    convIdx: index('idx_assistant_messages_conversation').on(t.conversationId, t.createdAt),
  }),
);

export type AssistantMessage = typeof assistantMessages.$inferSelect;
export type NewAssistantMessage = typeof assistantMessages.$inferInsert;
