import { date, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, idColumn } from './_helpers.js';
import { students } from './students.js';
import { sessions } from './sessions.js';

export const plans = pgTable(
  'plans',
  {
    id: idColumn(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to').notNull(),
    focusAreas: jsonb('focus_areas').$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    milestones: jsonb('milestones').$type<unknown[]>().default(sql`'[]'::jsonb`),
    generatedFromSessionId: uuid('generated_from_session_id').references(() => sessions.id),
    status: text('status').notNull().default('active'),
    createdAt: createdAt(),
  },
  (t) => ({
    studentValidIdx: index('idx_plans_student_valid').on(t.studentId, t.validFrom, t.validTo),
  }),
);

export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;
