import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { idColumn } from './_helpers.js';
import { students } from './students.js';
import { counsellors } from './counsellors.js';

/**
 * Conversation log. Schema in place from Phase 1; written to starting Phase 10
 * (WhatsApp Receiver). Per the schema-built-once binding rule
 * (clarifications.md Q3): inert table is cheaper than later migration.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: idColumn(),
    channel: text('channel').notNull(), // student | counsellor | system
    studentId: uuid('student_id').references(() => students.id),
    counsellorId: uuid('counsellor_id').references(() => counsellors.id),
    direction: text('direction').notNull(), // inbound | outbound
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    contentText: text('content_text'),
    contentVoiceUrl: text('content_voice_url'),
    contentImageUrl: text('content_image_url'),
    classifiedIntent: text('classified_intent'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    processingOutcome: text('processing_outcome'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    studentIdx: index('idx_conversations_student').on(t.studentId, t.sentAt),
  }),
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
