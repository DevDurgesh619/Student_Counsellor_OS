import { z } from 'zod';

/**
 * Shared Zod schemas for the closed timetable-operations vocabulary. This
 * is the single source of truth used by both the conversational editor
 * (worker_4b_timetable_editor) and the meeting-extraction pipeline
 * (worker_4_timetable_drafter). Drift between the two prompts was real —
 * Worker 4 used to speak a "drafts" abstraction while the editor spoke
 * ops directly, and the bridge code silently dropped intents the
 * translator didn't know about. Co-locating the schemas here keeps both
 * workers honest.
 *
 * The runtime engine (apps/api/src/lib/timetable-engine.ts) executes
 * these ops; the type definition lives at
 * packages/db/src/schema/timetable-changes.ts as `TimetableOp`.
 */

export const HhmmRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const YmdRegex = /^\d{4}-\d{2}-\d{2}$/;
export const Flexibility = z.enum(['fixed', 'preferred', 'flexible']);
export const RuleJsonSchema = z.object({
  frequency: z.enum(['daily', 'weekly']),
  days_of_week: z.array(z.number().int().min(0).max(6)),
  start_time: z.string().regex(HhmmRegex, 'start_time must be HH:MM (24h)'),
  duration_min: z.number().int().positive().max(24 * 60),
  timezone: z.string().min(3),
});

export const OpCreateTask = z.object({
  op: z.literal('create_task'),
  payload: z.object({
    scheduled_start: z.string().datetime(),
    scheduled_end: z.string().datetime(),
    subject: z.string().min(1),
    task_title: z.string().min(1),
    task_description: z.string().nullable().optional(),
    expected_output: z.string().nullable().optional(),
    flexibility: Flexibility.optional(),
  }),
});

export const OpCreateRecurrence = z.object({
  op: z.literal('create_recurrence'),
  payload: z.object({
    rule_json: RuleJsonSchema,
    starts_on: z.string().regex(YmdRegex),
    ends_on: z.string().regex(YmdRegex),
    subject: z.string().min(1),
    task_title: z.string().min(1),
    task_description: z.string().nullable().optional(),
    flexibility: Flexibility.optional(),
  }),
});

export const OpCancelTask = z.object({
  op: z.literal('cancel_task'),
  payload: z.object({ task_id: z.string().uuid() }),
});

export const OpCancelRecurrence = z.object({
  op: z.literal('cancel_recurrence'),
  payload: z.object({
    recurrence_group_id: z.string().uuid(),
    effective_from: z.string().regex(YmdRegex).optional(),
  }),
});

export const OpMoveTask = z.object({
  op: z.literal('move_task'),
  payload: z.object({
    task_id: z.string().uuid(),
    new_start: z.string().datetime(),
    new_end: z.string().datetime(),
  }),
});

export const OpEditTask = z.object({
  op: z.literal('edit_task'),
  payload: z.object({
    task_id: z.string().uuid(),
    changes: z
      .object({
        subject: z.string().min(1).optional(),
        task_title: z.string().min(1).optional(),
        task_description: z.string().nullable().optional(),
        expected_output: z.string().nullable().optional(),
        flexibility: Flexibility.optional(),
        verification_required: z.boolean().optional(),
      })
      .refine((c) => Object.keys(c).length > 0, 'edit_task.changes cannot be empty'),
  }),
});

export const OpEditRecurrence = z.object({
  op: z.literal('edit_recurrence'),
  payload: z.object({
    recurrence_group_id: z.string().uuid(),
    new_rule_json: RuleJsonSchema,
    effective_from: z.string().regex(YmdRegex),
  }),
});

export const OperationSchema = z.discriminatedUnion('op', [
  OpCreateTask,
  OpCreateRecurrence,
  OpCancelTask,
  OpCancelRecurrence,
  OpMoveTask,
  OpEditTask,
  OpEditRecurrence,
]);

/**
 * Worker 4 (meeting extraction) output shape. Direct ops + optional
 * warnings; matches the editor's proposal shape minus the conversational
 * `needs_clarification` / `message` fields that don't apply to a
 * batch-extraction worker.
 */
export const Worker4OutputSchema = z.object({
  operations: z.array(OperationSchema).default([]),
  rationale: z.string().nullable().optional(),
  warnings: z.array(z.string()).default([]),
});
