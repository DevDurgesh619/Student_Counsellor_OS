import { date, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idColumn } from './_helpers.js';
import { students } from './students.js';
import { timetableChanges, type RecurrenceRule } from './timetable-changes.js';

/**
 * A recurring schedule rule (e.g. Math AI MWF 8–9am for 3 weeks). One row
 * per active rule. Materialized tasks point back via tasks.recurrence_group_id.
 * Edits to the rule supersede the group (mark superseded_at) and create a
 * fresh group from the new effective_from date — old completions stay
 * attached to the old group's tasks.
 */
export const recurrenceGroups = pgTable(
  'recurrence_groups',
  {
    id: idColumn(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    taskTitle: text('task_title').notNull(),
    taskDescription: text('task_description'),
    ruleJson: jsonb('rule_json').$type<RecurrenceRule>().notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    flexibility: text('flexibility').notNull().default('preferred'),
    source: text('source').notNull(),
    generatedFromChangeId: uuid('generated_from_change_id').references(() => timetableChanges.id, {
      onDelete: 'set null',
    }),
    supersededByChangeId: uuid('superseded_by_change_id').references(() => timetableChanges.id, {
      onDelete: 'set null',
    }),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    studentActiveIdx: index('idx_recurrence_groups_student_active').on(t.studentId),
  }),
);

export type RecurrenceGroup = typeof recurrenceGroups.$inferSelect;
export type NewRecurrenceGroup = typeof recurrenceGroups.$inferInsert;
