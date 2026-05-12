import { decimal, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idColumn } from './_helpers.js';
import { artifacts } from './artifacts.js';

/**
 * OpenAI Whisper call logs — metadata ONLY (clarifications.md Q4).
 *
 * **PII rule:** NEVER store the audio URL or the transcript text in this
 * table. Transcript text lives in `artifacts.transcription_text` and the
 * audio URL is on `artifacts.file_url`. This table records only the call's
 * cost, latency, and status.
 *
 * Whisper is not a Claude call → goes through apps/api/src/sync/transcription.ts,
 * not the AI substrate. Different cost model, different retry semantics.
 */
export const transcriptions = pgTable(
  'transcriptions',
  {
    id: idColumn(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    modelVersion: text('model_version').notNull(), // 'whisper-1'
    durationSeconds: decimal('duration_seconds', { precision: 10, scale: 2 }),
    costUsd: decimal('cost_usd', { precision: 10, scale: 6 }),
    costInr: decimal('cost_inr', { precision: 10, scale: 2 }),
    latencyMs: integer('latency_ms'),
    status: text('status').notNull(), // success | retry | failed
    errorText: text('error_text'),
    createdAt: createdAt(),
  },
  (t) => ({
    artifactIdx: index('idx_transcriptions_artifact').on(t.artifactId),
  }),
);

export type Transcription = typeof transcriptions.$inferSelect;
export type NewTranscription = typeof transcriptions.$inferInsert;
