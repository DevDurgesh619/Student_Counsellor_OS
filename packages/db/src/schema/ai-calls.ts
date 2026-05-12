import {
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, idColumn } from './_helpers.js';
import { students } from './students.js';
import { counsellors } from './counsellors.js';
import { sessions } from './sessions.js';

/**
 * AI substrate logs — Claude calls only (CLAUDE_CODE.md §10).
 *
 * Note: OpenAI Whisper transcriptions do NOT log here — they have their own
 * `transcriptions` table with different cost-model and retry semantics
 * (clarifications.md Q4).
 */
export const aiCalls = pgTable(
  'ai_calls',
  {
    id: idColumn(),
    workerName: text('worker_name').notNull(),
    promptId: text('prompt_id').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    model: text('model').notNull(),
    studentId: uuid('student_id').references(() => students.id),
    counsellorId: uuid('counsellor_id').references(() => counsellors.id),
    sessionId: uuid('session_id').references(() => sessions.id),
    inputs: jsonb('inputs').$type<Record<string, unknown>>().notNull(),
    rawResponse: text('raw_response'),
    parsedOutput: jsonb('parsed_output').$type<Record<string, unknown>>(),
    schemaValidationPassed: boolean('schema_validation_passed'),
    tokensInput: integer('tokens_input'),
    tokensOutput: integer('tokens_output'),
    costUsd: decimal('cost_usd', { precision: 10, scale: 6 }),
    costInr: decimal('cost_inr', { precision: 10, scale: 2 }),
    latencyMs: integer('latency_ms'),
    status: text('status').notNull(), // success | retry | failed
    createdAt: createdAt(),
  },
  (t) => ({
    workerDateIdx: index('idx_ai_calls_worker_date').on(t.workerName, t.createdAt),
    studentIdx: index('idx_ai_calls_student').on(t.studentId),
  }),
);

export type AiCall = typeof aiCalls.$inferSelect;
export type NewAiCall = typeof aiCalls.$inferInsert;
