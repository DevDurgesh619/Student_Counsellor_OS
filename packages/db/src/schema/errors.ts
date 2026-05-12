import { boolean, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idColumn } from './_helpers.js';
import { students } from './students.js';

export const errors = pgTable(
  'errors',
  {
    id: idColumn(),
    occurredAt: createdAt(),
    severity: text('severity').notNull(), // info | warn | error | critical
    source: text('source').notNull(), // 'api' | 'sync_service' | 'worker_1' | ...
    studentId: uuid('student_id').references(() => students.id),
    errorMessage: text('error_message').notNull(),
    errorStack: text('error_stack'),
    context: jsonb('context').$type<Record<string, unknown>>().default({}),
    resolved: boolean('resolved').default(false),
  },
  (t) => ({
    severityUnresolvedIdx: index('idx_errors_severity_unresolved').on(t.severity, t.resolved),
  }),
);

export type ErrorRow = typeof errors.$inferSelect;
export type NewErrorRow = typeof errors.$inferInsert;
