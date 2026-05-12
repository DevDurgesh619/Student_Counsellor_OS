import {
  boolean,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, idColumn, updatedAt } from './_helpers.js';
import { sessions } from './sessions.js';
import { students } from './students.js';
import { counsellors } from './counsellors.js';
import { aiCalls } from './ai-calls.js';

export type ExtractedActionItem = {
  owner: 'student' | 'counsellor' | 'unclear';
  description: string;
  due?: string | null;
  subject?: string | null;
};

export type ExtractedScheduleChange = {
  type: 'add' | 'remove' | 'edit' | 'move';
  what: string;
  when?: string | null;
  duration?: string | null;
  notes?: string | null;
};

export type ExtractedConcern = {
  raised_by: 'student' | 'counsellor';
  concern: string;
  context?: string | null;
};

export const sessionExtractions = pgTable('session_extractions', {
  id: idColumn(),
  sessionId: uuid('session_id')
    .notNull()
    .unique()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  topicsDiscussed: text('topics_discussed')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  actionItems: jsonb('action_items')
    .$type<ExtractedActionItem[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  scheduleChangesDiscussed: boolean('schedule_changes_discussed').notNull().default(false),
  scheduleChanges: jsonb('schedule_changes')
    .$type<ExtractedScheduleChange[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  concernsRaised: jsonb('concerns_raised')
    .$type<ExtractedConcern[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  decisionsMade: jsonb('decisions_made')
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  openQuestions: jsonb('open_questions')
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  confidence: text('confidence').notNull().default('normal'),
  rawExtraction: jsonb('raw_extraction').$type<Record<string, unknown>>(),
  aiCallId: uuid('ai_call_id').references(() => aiCalls.id),
  createdAt: createdAt(),
});

export type SessionExtraction = typeof sessionExtractions.$inferSelect;
export type NewSessionExtraction = typeof sessionExtractions.$inferInsert;

export const meetingPrepBriefs = pgTable('meeting_prep_briefs', {
  id: idColumn(),
  targetSessionId: uuid('target_session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  passAContent: text('pass_a_content'),
  passAGeneratedAt: timestamp('pass_a_generated_at', { withTimezone: true }),
  passBContent: text('pass_b_content'),
  passBGeneratedAt: timestamp('pass_b_generated_at', { withTimezone: true }),
  finalContent: text('final_content'),
  counsellorEditedAt: timestamp('counsellor_edited_at', { withTimezone: true }),
  status: text('status').notNull().default('pass_a_only'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type MeetingPrepBrief = typeof meetingPrepBriefs.$inferSelect;
export type NewMeetingPrepBrief = typeof meetingPrepBriefs.$inferInsert;

export const gaps = pgTable(
  'gaps',
  {
    id: idColumn(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    subject: text('subject'),
    description: text('description').notNull(),
    identifiedInSessionId: uuid('identified_in_session_id').references(() => sessions.id),
    identifiedVia: text('identified_via').notNull(),
    priority: text('priority').notNull().default('medium'),
    status: text('status').notNull().default('active'),
    targetResolutionDate: date('target_resolution_date'),
    addressedInSessionId: uuid('addressed_in_session_id').references(() => sessions.id),
    addressedAt: timestamp('addressed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    studentStatusIdx: index('idx_gaps_student_status').on(t.studentId, t.status),
  }),
);

export type Gap = typeof gaps.$inferSelect;
export type NewGap = typeof gaps.$inferInsert;

export const counsellorTodos = pgTable(
  'counsellor_todos',
  {
    id: idColumn(),
    counsellorId: uuid('counsellor_id')
      .notNull()
      .references(() => counsellors.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id').references(() => students.id, { onDelete: 'set null' }),
    description: text('description').notNull(),
    sourceSessionId: uuid('source_session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    dueDate: date('due_date'),
    status: text('status').notNull().default('pending'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    counsellorStatusIdx: index('idx_counsellor_todos_status').on(t.counsellorId, t.status),
  }),
);

export type CounsellorTodo = typeof counsellorTodos.$inferSelect;
export type NewCounsellorTodo = typeof counsellorTodos.$inferInsert;
