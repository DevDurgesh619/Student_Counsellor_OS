import { bigint, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, idColumn } from './_helpers.js';
import { students } from './students.js';
import { tasks } from './tasks.js';

export const artifacts = pgTable(
  'artifacts',
  {
    id: idColumn(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    fileUrl: text('file_url').notNull(),
    fileType: text('file_type').notNull(),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }),
    originalFilename: text('original_filename'),
    transcriptionText: text('transcription_text'), // populated by Whisper async (Phase 5+)
    tags: text('tags').array().default(sql`'{}'::text[]`),
    source: text('source').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    studentIdx: index('idx_artifacts_student').on(t.studentId),
    taskIdx: index('idx_artifacts_task').on(t.taskId),
  }),
);

export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;
