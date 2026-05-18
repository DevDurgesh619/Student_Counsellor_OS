import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import {
  changeRequests,
  db,
  recurrenceGroups,
  tasks,
  timetableChanges,
  type NewTask,
  type RecurrenceRule,
  type Task,
  type TimetableOp,
} from '@wgc/db';
import { Errors, WgcError } from '@wgc/shared';
import { logger } from '../logger.js';
import { enqueueTaskSync } from './sync-outbox.js';
import { expandRecurrence } from './timetable-rules.js';

export type ApplyChangeResult = {
  appliedNow: boolean;
  alreadyApplied: boolean;
  tasksAffected: number;
  summary: ChangeSummary;
};

/**
 * Apply a draft `timetable_changes` row: execute each op transactionally,
 * mark applied_at, enqueue calendar syncs. Idempotent — re-running on an
 * already-applied change reports `alreadyApplied: true` and returns the
 * existing summary so the caller can still navigate to the affected week.
 */
export async function applyChange(changeId: string): Promise<ApplyChangeResult> {
  const change = (
    await db.select().from(timetableChanges).where(eq(timetableChanges.id, changeId)).limit(1)
  )[0];
  if (!change) throw Errors.notFound('timetable_change', changeId);

  // State machine: draft → active (apply) → reverted (revert). Terminal
  // states are explicit errors rather than silent no-ops so the UI can
  // disable the button + tell the counsellor what's going on. Reverted is
  // checked FIRST because appliedAt stays set on a reverted change (it's
  // the audit timestamp of when the apply originally happened, not the
  // current state) — without this ordering, the appliedAt branch would
  // mask the reverted state and produce the silent-no-op bug.
  if (change.status === 'reverted') {
    throw Errors.conflict(
      'CHANGE_REVERTED',
      'This change was reverted. Send the editor a new message to redo it.',
    );
  }
  if (change.appliedAt) {
    logger.info({ changeId }, 'applyChange: already applied, returning existing summary');
    const summary = await summarizeChange(changeId);
    return {
      appliedNow: false,
      alreadyApplied: true,
      tasksAffected:
        summary.added.length +
        summary.removed.length +
        summary.moved.length * 2 +
        summary.edits.length,
      summary,
    };
  }

  // Safety-net validation. The conversational editor runs validateOperations
  // before persisting its draft; the meeting-extraction pipeline does too
  // (post Phase 4b rewrite). But the schedule can shift between persist and
  // click — a task referenced by the draft might have been completed,
  // superseded by another change, or its recurrence group might have been
  // edited. Re-checking here turns those races into a clean 409 with
  // structured `errors` the UI can render, instead of letting assertMutable
  // throw a mid-transaction TASK_ALREADY_SUPERSEDED that the user can't
  // recover from. Idempotent re-applies short-circuit above this point, so
  // applied changes aren't re-validated.
  const preflightValidation = await validateOperations(change.studentId, change.operations);
  if (!preflightValidation.ok) {
    throw new WgcError({
      code: 'OPERATIONS_INVALID',
      message:
        'This change can no longer be applied cleanly. The schedule shifted since it was drafted — open the editor for a fresh proposal.',
      status: 409,
      details: { errors: preflightValidation.errors },
    });
  }

  const now = new Date();
  const syncQueue: Array<{ taskId: string; operation: 'create' | 'update' | 'delete' }> = [];

  // Atomic claim — if two requests reach this point concurrently (two
  // browser tabs, double-click, retry), exactly one wins. The UPDATE
  // mutates the row only if it's still draft + un-applied; the other
  // request's UPDATE matches zero rows and we surface that as
  // already-applied (re-reading the now-committed state).
  const claimed = await db
    .update(timetableChanges)
    .set({ status: 'active', appliedAt: now })
    .where(
      and(
        eq(timetableChanges.id, change.id),
        eq(timetableChanges.status, 'draft'),
        isNull(timetableChanges.appliedAt),
      ),
    )
    .returning({ id: timetableChanges.id });
  if (claimed.length === 0) {
    logger.info({ changeId }, 'applyChange: claim lost to a concurrent apply');
    const summary = await summarizeChange(changeId);
    return {
      appliedNow: false,
      alreadyApplied: true,
      tasksAffected:
        summary.added.length +
        summary.removed.length +
        summary.moved.length * 2 +
        summary.edits.length,
      summary,
    };
  }

  // We hold the claim. Execute ops in a transaction; on failure, roll back
  // both the ops AND release the claim so a retry can proceed.
  try {
    await db.transaction(async (tx) => {
      for (const op of change.operations) {
        await executeOp(tx, op, change.id, change.studentId, change.source, syncQueue, now);
      }
      // If this change came from a student request, mark the request resolved
      // and link it back. Lives inside the transaction so the request-state
      // mirror stays consistent with the schedule mutation: either both
      // commit or neither does.
      if (change.source === 'change_request' && change.sourceRequestId) {
        await tx
          .update(changeRequests)
          .set({ resolvedAt: now, linkedChangeId: change.id })
          .where(eq(changeRequests.id, change.sourceRequestId));
      }
    });
  } catch (err) {
    // Release the claim so the user can retry / inspect without the change
    // being stuck in 'active' with zero materialized tasks.
    await db
      .update(timetableChanges)
      .set({ status: 'draft', appliedAt: null })
      .where(eq(timetableChanges.id, change.id));
    throw err;
  }

  // Sync queue outside the transaction — outbox failure shouldn't roll back
  // the schedule mutation (enqueueTaskSync already handles its own errors).
  for (const entry of syncQueue) {
    await enqueueTaskSync(entry.taskId, entry.operation);
  }

  const summary = await summarizeChange(changeId);
  return {
    appliedNow: true,
    alreadyApplied: false,
    tasksAffected: summary.added.length + summary.removed.length + summary.moved.length * 2,
    summary,
  };
}

export type RevertChangeResult = {
  revertedNow: boolean;
  alreadyReverted: boolean;
  tasksRestored: number;
  tasksCancelled: number;
};

/**
 * Best-effort reverse of applyChange. State machine:
 *   active → reverted  (do the work)
 *   reverted → reverted  (idempotent, return alreadyReverted)
 *   draft → error  (nothing to undo)
 */
export async function revertChange(changeId: string): Promise<RevertChangeResult> {
  const change = (
    await db.select().from(timetableChanges).where(eq(timetableChanges.id, changeId)).limit(1)
  )[0];
  if (!change) throw Errors.notFound('timetable_change', changeId);
  if (!change.appliedAt) {
    throw Errors.conflict(
      'CHANGE_NOT_APPLIED',
      'This proposal hasn’t been applied yet — there’s nothing to revert.',
    );
  }
  if (change.revertedAt) {
    return { revertedNow: false, alreadyReverted: true, tasksRestored: 0, tasksCancelled: 0 };
  }

  const now = new Date();
  const syncQueue: Array<{ taskId: string; operation: 'create' | 'update' | 'delete' }> = [];

  await db.transaction(async (tx) => {
    // Un-supersede tasks this change marked. Any task carrying
    // supersededByChangeId = change.id was at status='scheduled' immediately
    // before the change applied (assertMutable enforces that on the way in),
    // so unconditionally restoring to 'scheduled' is safe.
    //
    // Sync semantics: the Calendar event was deleted when the change was
    // originally applied (apply enqueued 'delete'). To bring it back we need
    // a fresh 'create' — the event id is deterministic from the task UUID,
    // but the calendar entry no longer exists. 'update' would 404.
    const supersededTasks = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.supersededByChangeId, change.id));
    for (const t of supersededTasks) {
      await tx
        .update(tasks)
        .set({
          supersededAt: null,
          supersededByChangeId: null,
          status: 'scheduled',
          updatedAt: now,
        })
        .where(eq(tasks.id, t.id));
      syncQueue.push({ taskId: t.id, operation: 'create' });
    }

    // Cancel tasks this change created (soft-cancel; immutability still
    // prevents touching ones that progressed past 'scheduled').
    const createdTasks = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.generatedFromChangeId, change.id));
    for (const t of createdTasks) {
      if (t.status === 'scheduled') {
        await tx
          .update(tasks)
          .set({ status: 'cancelled', updatedAt: now })
          .where(eq(tasks.id, t.id));
        syncQueue.push({ taskId: t.id, operation: 'delete' });
      }
    }

    // Same for recurrence groups: un-supersede and/or end ones we created.
    await tx
      .update(recurrenceGroups)
      .set({ supersededAt: null, supersededByChangeId: null })
      .where(eq(recurrenceGroups.supersededByChangeId, change.id));

    await tx
      .update(timetableChanges)
      .set({ status: 'reverted', revertedAt: now })
      .where(eq(timetableChanges.id, change.id));

    // Mirror revert into the originating request: it goes back to
    // "approved, pending re-apply" so the counsellor's queue reflects
    // that the student's ask still needs a working answer.
    if (change.source === 'change_request' && change.sourceRequestId) {
      await tx
        .update(changeRequests)
        .set({ resolvedAt: null, linkedChangeId: null })
        .where(eq(changeRequests.id, change.sourceRequestId));
    }
  });

  // Counts collected for the response. Computed by partitioning the sync
  // queue — 'create' entries here mean restored tasks, 'delete' means
  // newly-cancelled tasks (we use 'delete' for Calendar but the task row is
  // soft-cancelled, not deleted).
  const tasksRestored = syncQueue.filter((q) => q.operation === 'create').length;
  const tasksCancelled = syncQueue.filter((q) => q.operation === 'delete').length;

  for (const entry of syncQueue) {
    await enqueueTaskSync(entry.taskId, entry.operation);
  }

  return { revertedNow: true, alreadyReverted: false, tasksRestored, tasksCancelled };
}

/**
 * Map a `timetable_changes.source` value (audit-level vocabulary) into the
 * constrained `tasks.source` enum that the legacy DB CHECK constraint
 * accepts. The two vocabularies were defined independently — change rows
 * track decision origin, task rows track creation channel — so we translate
 * at the boundary. The audit chain (generated_from_change_id on the task)
 * still recovers the true origin.
 */
function changeSourceToTaskSource(changeSource: string): string {
  switch (changeSource) {
    case 'meeting_extraction':
      return 'ai_drafted_from_session';
    case 'change_request':
      return 'student_request';
    case 'bootstrap':
    case 'counsellor_chat':
    case 'counsellor_direct':
    default:
      return 'counsellor_manual';
  }
}

/**
 * Per-op executor. Runs inside the applyChange transaction. Pushes sync
 * intents into `syncQueue` rather than calling enqueueTaskSync directly,
 * so the outbox write happens after the transaction commits.
 */
async function executeOp(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  op: TimetableOp,
  changeId: string,
  studentId: string,
  source: string,
  syncQueue: Array<{ taskId: string; operation: 'create' | 'update' | 'delete' }>,
  now: Date,
): Promise<void> {
  const taskSource = changeSourceToTaskSource(source);
  switch (op.op) {
    case 'create_task': {
      const inserted = await tx
        .insert(tasks)
        .values({
          studentId,
          scheduledStart: new Date(op.payload.scheduled_start),
          scheduledEnd: new Date(op.payload.scheduled_end),
          subject: op.payload.subject,
          taskTitle: op.payload.task_title,
          taskDescription: op.payload.task_description ?? null,
          expectedOutput: op.payload.expected_output ?? null,
          flexibility: op.payload.flexibility ?? 'preferred',
          source: taskSource,
          generatedFromChangeId: changeId,
          status: 'scheduled',
        } satisfies NewTask)
        .returning({ id: tasks.id });
      if (inserted[0]) syncQueue.push({ taskId: inserted[0].id, operation: 'create' });
      return;
    }

    case 'create_recurrence': {
      const group = (
        await tx
          .insert(recurrenceGroups)
          .values({
            studentId,
            subject: op.payload.subject,
            taskTitle: op.payload.task_title,
            taskDescription: op.payload.task_description ?? null,
            ruleJson: op.payload.rule_json,
            startsOn: op.payload.starts_on,
            endsOn: op.payload.ends_on,
            flexibility: op.payload.flexibility ?? 'preferred',
            source,
            generatedFromChangeId: changeId,
          })
          .returning()
      )[0];
      if (!group) return;
      const occurrences = expandRecurrence(
        op.payload.rule_json,
        op.payload.starts_on,
        op.payload.ends_on,
      );
      if (occurrences.length === 0) return;
      const inserted = await tx
        .insert(tasks)
        .values(
          occurrences.map(
            (o) =>
              ({
                studentId,
                scheduledStart: o.scheduledStart,
                scheduledEnd: o.scheduledEnd,
                subject: op.payload.subject,
                taskTitle: op.payload.task_title,
                taskDescription: op.payload.task_description ?? null,
                flexibility: op.payload.flexibility ?? 'preferred',
                source: taskSource,
                generatedFromChangeId: changeId,
                recurrenceGroupId: group.id,
                recurrencePattern: op.payload.rule_json.frequency,
                status: 'scheduled',
              }) satisfies NewTask,
          ),
        )
        .returning({ id: tasks.id });
      for (const row of inserted) {
        syncQueue.push({ taskId: row.id, operation: 'create' });
      }
      return;
    }

    case 'edit_task': {
      const t = await assertMutable(tx, op.payload.task_id, changeId);
      if (t === 'skip') return;
      const changes: Record<string, unknown> = { updatedAt: now };
      const c = op.payload.changes;
      if (c.subject !== undefined) changes['subject'] = c.subject;
      if (c.task_title !== undefined) changes['taskTitle'] = c.task_title;
      if (c.task_description !== undefined) changes['taskDescription'] = c.task_description;
      if (c.expected_output !== undefined) changes['expectedOutput'] = c.expected_output;
      if (c.flexibility !== undefined) changes['flexibility'] = c.flexibility;
      if (c.verification_required !== undefined)
        changes['verificationRequired'] = c.verification_required;
      await tx.update(tasks).set(changes).where(eq(tasks.id, t.id));
      syncQueue.push({ taskId: t.id, operation: 'update' });
      return;
    }

    case 'cancel_task': {
      const t = await assertMutable(tx, op.payload.task_id, changeId);
      if (t === 'skip') return;
      await tx
        .update(tasks)
        .set({
          status: 'cancelled',
          supersededAt: now,
          supersededByChangeId: changeId,
          updatedAt: now,
        })
        .where(eq(tasks.id, t.id));
      syncQueue.push({ taskId: t.id, operation: 'delete' });
      return;
    }

    case 'move_task': {
      const t = await assertMutable(tx, op.payload.task_id, changeId);
      if (t === 'skip') return;
      // Supersede the old row; insert a fresh "scheduled" row pointing back.
      await tx
        .update(tasks)
        .set({
          status: 'rescheduled',
          supersededAt: now,
          supersededByChangeId: changeId,
          updatedAt: now,
        })
        .where(eq(tasks.id, t.id));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id: _oldId, createdAt: _c, updatedAt: _u, ...rest } = t;
      const inserted = await tx
        .insert(tasks)
        .values({
          ...rest,
          scheduledStart: new Date(op.payload.new_start),
          scheduledEnd: new Date(op.payload.new_end),
          status: 'scheduled',
          rescheduledFromId: t.id,
          generatedFromChangeId: changeId,
          supersededAt: null,
          supersededByChangeId: null,
          // Drop the cloned Google Calendar event id — the new task is a
          // distinct Calendar entry; the old one will be deleted via the
          // 'delete' sync. Without this null, two tasks would point at the
          // same calendar event id and the sync worker would update one
          // entry twice (and never create the new one).
          googleCalendarEventId: null,
        } satisfies NewTask)
        .returning({ id: tasks.id });
      syncQueue.push({ taskId: t.id, operation: 'delete' });
      if (inserted[0]) syncQueue.push({ taskId: inserted[0].id, operation: 'create' });
      return;
    }

    case 'cancel_recurrence': {
      const group = (
        await tx
          .select()
          .from(recurrenceGroups)
          .where(eq(recurrenceGroups.id, op.payload.recurrence_group_id))
          .limit(1)
      )[0];
      if (!group) throw Errors.notFound('recurrence_group', op.payload.recurrence_group_id);
      const effectiveFrom = op.payload.effective_from
        ? new Date(op.payload.effective_from)
        : now;

      await tx
        .update(recurrenceGroups)
        .set({ supersededAt: now, supersededByChangeId: changeId })
        .where(eq(recurrenceGroups.id, group.id));

      const futureTasks = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.recurrenceGroupId, group.id),
            eq(tasks.status, 'scheduled'),
            isNull(tasks.supersededAt),
            gte(tasks.scheduledStart, effectiveFrom),
          ),
        );
      if (futureTasks.length > 0) {
        const ids = futureTasks.map((t) => t.id);
        await tx
          .update(tasks)
          .set({
            status: 'cancelled',
            supersededAt: now,
            supersededByChangeId: changeId,
            updatedAt: now,
          })
          .where(inArray(tasks.id, ids));
        for (const id of ids) syncQueue.push({ taskId: id, operation: 'delete' });
      }
      return;
    }

    case 'edit_recurrence': {
      const group = (
        await tx
          .select()
          .from(recurrenceGroups)
          .where(eq(recurrenceGroups.id, op.payload.recurrence_group_id))
          .limit(1)
      )[0];
      if (!group) throw Errors.notFound('recurrence_group', op.payload.recurrence_group_id);
      const effectiveFrom = new Date(op.payload.effective_from);

      // Supersede the old group + cancel its future tasks.
      await tx
        .update(recurrenceGroups)
        .set({ supersededAt: now, supersededByChangeId: changeId })
        .where(eq(recurrenceGroups.id, group.id));
      const futureTasks = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.recurrenceGroupId, group.id),
            eq(tasks.status, 'scheduled'),
            isNull(tasks.supersededAt),
            gte(tasks.scheduledStart, effectiveFrom),
          ),
        );
      if (futureTasks.length > 0) {
        const ids = futureTasks.map((t) => t.id);
        await tx
          .update(tasks)
          .set({
            status: 'cancelled',
            supersededAt: now,
            supersededByChangeId: changeId,
            updatedAt: now,
          })
          .where(inArray(tasks.id, ids));
        for (const id of ids) syncQueue.push({ taskId: id, operation: 'delete' });
      }

      // Create the new group + materialize from effective_from..old.endsOn.
      const newGroup = (
        await tx
          .insert(recurrenceGroups)
          .values({
            studentId,
            subject: group.subject,
            taskTitle: group.taskTitle,
            taskDescription: group.taskDescription,
            ruleJson: op.payload.new_rule_json,
            startsOn: op.payload.effective_from,
            endsOn: group.endsOn,
            flexibility: group.flexibility,
            source,
            generatedFromChangeId: changeId,
          })
          .returning()
      )[0];
      if (!newGroup) return;
      const occurrences = expandRecurrence(
        op.payload.new_rule_json,
        op.payload.effective_from,
        group.endsOn,
      );
      if (occurrences.length > 0) {
        const inserted = await tx
          .insert(tasks)
          .values(
            occurrences.map(
              (o) =>
                ({
                  studentId,
                  scheduledStart: o.scheduledStart,
                  scheduledEnd: o.scheduledEnd,
                  subject: group.subject,
                  taskTitle: group.taskTitle,
                  taskDescription: group.taskDescription,
                  flexibility: group.flexibility,
                  source: taskSource,
                  generatedFromChangeId: changeId,
                  recurrenceGroupId: newGroup.id,
                  recurrencePattern: op.payload.new_rule_json.frequency,
                  status: 'scheduled',
                }) satisfies NewTask,
            ),
          )
          .returning({ id: tasks.id });
        for (const row of inserted) {
          syncQueue.push({ taskId: row.id, operation: 'create' });
        }
      }
      return;
    }
  }
}

/**
 * Guard for ops that touch a single existing task. Three outcomes:
 *
 *   1. Task is genuinely mutable → return the row.
 *   2. Task was superseded earlier *by this same change* (a redundant op
 *      within the same proposal — e.g. cancel_recurrence followed by
 *      cancel_task on a task that was in that group) → return 'skip'.
 *      Callers no-op. This keeps the engine resilient to LLM-generated
 *      proposals that include overlapping ops.
 *   3. Task was superseded by some *other* change, or has progressed past
 *      'scheduled' (completed/skipped/cancelled-externally) → throw.
 *
 * Completion-bearing statuses are immutable forever (locked decision #1).
 */
type AssertResult = Task | 'skip';

async function assertMutable(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  taskId: string,
  currentChangeId: string,
): Promise<AssertResult> {
  const t = (await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0];
  if (!t) throw Errors.notFound('task', taskId);
  if (t.supersededAt) {
    if (t.supersededByChangeId === currentChangeId) {
      // An earlier op in this same change already handled it. Treat the
      // redundant op as a no-op rather than blowing up the transaction.
      logger.info(
        { taskId, currentChangeId },
        'assertMutable: task already superseded by this change — skipping redundant op',
      );
      return 'skip';
    }
    throw Errors.conflict(
      'TASK_ALREADY_SUPERSEDED',
      `Task ${taskId} was already superseded by another change. The schedule has shifted since this proposal was drafted — start a new chat so the editor sees the current state.`,
    );
  }
  if (t.status !== 'scheduled') {
    throw Errors.conflict(
      'TASK_IMMUTABLE',
      `Task ${taskId} has status='${t.status}' and cannot be modified by a change-event`,
    );
  }
  return t;
}

/**
 * Diff projection for the UI. Walks the operations array (after apply) and
 * resolves added/removed/moved task rows. Cheap enough to call from the
 * change-detail endpoint per request.
 */
export type ChangeSummary = {
  added: Task[];
  removed: Task[];
  moved: Array<{ from: Task; to: Task }>;
  /** edit_task ops surface here so the diff can show "would change title
   *  / subject / flexibility on these tasks" without conflating with
   *  moved (which implies a time change). */
  edits: Array<{ task: Task; changes: Record<string, unknown> }>;
};

export async function summarizeChange(changeId: string): Promise<ChangeSummary> {
  const change = (
    await db.select().from(timetableChanges).where(eq(timetableChanges.id, changeId)).limit(1)
  )[0];
  if (!change) throw Errors.notFound('timetable_change', changeId);

  // Draft → there are no materialized tasks yet. Project the operations
  // into virtual task rows so the counsellor can review *before* apply.
  // Once applied, fall through to the audit-trail-driven summary below.
  if (!change.appliedAt) {
    return previewOperations(change.studentId, change.operations);
  }

  // "Added" = tasks created by this change that are not also marked as the
  // new half of a move (those go into `moved`).
  const created = await db
    .select()
    .from(tasks)
    .where(eq(tasks.generatedFromChangeId, changeId));
  const superseded = await db
    .select()
    .from(tasks)
    .where(eq(tasks.supersededByChangeId, changeId));

  const moved: ChangeSummary['moved'] = [];
  const movedNewIds = new Set<string>();
  for (const t of created) {
    if (t.rescheduledFromId) {
      const from = superseded.find((s) => s.id === t.rescheduledFromId);
      if (from) {
        moved.push({ from, to: t });
        movedNewIds.add(t.id);
      }
    }
  }
  const movedOldIds = new Set(moved.map((m) => m.from.id));

  // edit_task ops don't supersede or create — they mutate in-place. To
  // surface them we walk the ops array directly and look up the affected
  // task rows in DB.
  const editOps = change.operations.filter((op) => op.op === 'edit_task') as Array<
    Extract<TimetableOp, { op: 'edit_task' }>
  >;
  const editTaskIds = editOps.map((op) => op.payload.task_id);
  const editedTaskRows = editTaskIds.length
    ? await db.select().from(tasks).where(inArray(tasks.id, editTaskIds))
    : [];
  const editedById = new Map(editedTaskRows.map((t) => [t.id, t]));
  const edits = editOps
    .map((op) => {
      const task = editedById.get(op.payload.task_id);
      return task ? { task, changes: op.payload.changes as Record<string, unknown> } : null;
    })
    .filter((x): x is { task: Task; changes: Record<string, unknown> } => x !== null);

  return {
    added: created.filter((t) => !movedNewIds.has(t.id)),
    removed: superseded.filter((t) => !movedOldIds.has(t.id)),
    moved,
    edits,
  };
}

/**
 * Read-only validator. The conversational editor calls this on the LLM's
 * proposed operations BEFORE persisting the change, so an invalid proposal
 * surfaces as a chat-message error the model can read on its next turn.
 */
export async function validateOperations(
  studentId: string,
  ops: TimetableOp[],
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  // Collect referenced ids + future-task lookups for groups so we can
  // simulate the effect of each op in sequence (catching same-change
  // redundancy: e.g. cancel_recurrence then cancel_task on a task in
  // that group). Without simulation, redundant ops sneak past validate
  // and blow up the transaction at apply time.
  const taskIds = new Set<string>();
  const groupIds = new Set<string>();
  for (const op of ops) {
    if (op.op === 'cancel_task' || op.op === 'move_task' || op.op === 'edit_task')
      taskIds.add(op.payload.task_id);
    if (op.op === 'cancel_recurrence' || op.op === 'edit_recurrence')
      groupIds.add(op.payload.recurrence_group_id);
  }
  const taskRows = taskIds.size
    ? await db.select().from(tasks).where(inArray(tasks.id, Array.from(taskIds)))
    : [];
  const groupRows = groupIds.size
    ? await db
        .select()
        .from(recurrenceGroups)
        .where(inArray(recurrenceGroups.id, Array.from(groupIds)))
    : [];
  const taskById = new Map(taskRows.map((t) => [t.id, t]));
  const groupById = new Map(groupRows.map((g) => [g.id, g]));

  // Pull all future tasks per touched group so we know which task_ids a
  // recurrence-level op would supersede.
  const groupFutureTaskIds = new Map<string, Set<string>>();
  for (const gid of groupIds) {
    const future = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.recurrenceGroupId, gid),
          eq(tasks.status, 'scheduled'),
          isNull(tasks.supersededAt),
        ),
      );
    groupFutureTaskIds.set(gid, new Set(future.map((r) => r.id)));
  }

  // Simulation state: ids the engine WOULD have superseded by this point.
  const supersededByThisChange = new Set<string>();
  const supersededGroups = new Set<string>();

  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]!;
    const opLabel = `op ${i + 1} (${op.op})`;

    // Value-level sanity checks. The zod schema in the route already
    // enforces shape; here we enforce *meaning* (intervals are non-empty,
    // windows are in the right order, recurrence expands to >= 1).
    if (op.op === 'create_task' || op.op === 'move_task') {
      const startKey =
        op.op === 'create_task' ? op.payload.scheduled_start : op.payload.new_start;
      const endKey = op.op === 'create_task' ? op.payload.scheduled_end : op.payload.new_end;
      if (new Date(startKey).getTime() >= new Date(endKey).getTime()) {
        errors.push(`${opLabel}: end time must be after start time`);
        continue;
      }
    }
    if (op.op === 'create_recurrence') {
      if (op.payload.starts_on > op.payload.ends_on) {
        errors.push(
          `${opLabel}: starts_on (${op.payload.starts_on}) must be <= ends_on (${op.payload.ends_on})`,
        );
        continue;
      }
      let projected;
      try {
        projected = expandRecurrence(
          op.payload.rule_json,
          op.payload.starts_on,
          op.payload.ends_on,
        );
      } catch (err) {
        errors.push(`${opLabel}: ${(err as Error).message}`);
        continue;
      }
      if (projected.length === 0) {
        errors.push(
          `${opLabel}: recurrence rule expands to 0 occurrences over ${op.payload.starts_on}–${op.payload.ends_on} (check days_of_week vs window)`,
        );
        continue;
      }
    }
    if (op.op === 'edit_recurrence') {
      const g = groupById.get(op.payload.recurrence_group_id);
      if (g && op.payload.effective_from > g.endsOn) {
        errors.push(
          `${opLabel}: effective_from (${op.payload.effective_from}) is after the group's ends_on (${g.endsOn}) — nothing left to edit`,
        );
        continue;
      }
      if (g) {
        let projected;
        try {
          projected = expandRecurrence(
            op.payload.new_rule_json,
            op.payload.effective_from,
            g.endsOn,
          );
        } catch (err) {
          errors.push(`${opLabel}: ${(err as Error).message}`);
          continue;
        }
        if (projected.length === 0) {
          errors.push(
            `${opLabel}: new recurrence rule expands to 0 occurrences over ${op.payload.effective_from}–${g.endsOn}`,
          );
          continue;
        }
      }
    }

    if (op.op === 'cancel_task' || op.op === 'move_task' || op.op === 'edit_task') {
      const tid = op.payload.task_id;
      const t = taskById.get(tid);
      if (!t) {
        errors.push(`${opLabel}: task ${tid} not found`);
        continue;
      }
      if (t.studentId !== studentId) {
        errors.push(`${opLabel}: task ${tid} belongs to a different student`);
        continue;
      }
      if (t.status !== 'scheduled') {
        errors.push(`${opLabel}: task ${tid} has status='${t.status}' and cannot be changed`);
        continue;
      }
      if (t.supersededAt) {
        errors.push(
          `${opLabel}: task ${tid} was already superseded — the schedule shifted since this proposal was drafted`,
        );
        continue;
      }
      if (supersededByThisChange.has(tid)) {
        // Same-change redundancy. The engine will skip the op at apply
        // time (graceful), but the proposal is still worth flagging so
        // the LLM can be improved over time.
        warnings.push(
          `${opLabel}: task ${tid} was already touched by an earlier op in this proposal — will be skipped`,
        );
        continue;
      }
      if (op.op === 'cancel_task' || op.op === 'move_task') {
        supersededByThisChange.add(tid);
      }
    }

    if (op.op === 'cancel_recurrence' || op.op === 'edit_recurrence') {
      const gid = op.payload.recurrence_group_id;
      const g = groupById.get(gid);
      if (!g) {
        errors.push(`${opLabel}: recurrence group ${gid} not found`);
        continue;
      }
      if (g.studentId !== studentId) {
        errors.push(`${opLabel}: recurrence group ${gid} belongs to a different student`);
        continue;
      }
      if (g.supersededAt) {
        errors.push(`${opLabel}: recurrence group ${gid} was already superseded`);
        continue;
      }
      if (supersededGroups.has(gid)) {
        warnings.push(
          `${opLabel}: recurrence group ${gid} was already touched by an earlier op in this proposal — will be skipped`,
        );
        continue;
      }
      supersededGroups.add(gid);
      // Mark all future tasks in this group as superseded for downstream sim.
      for (const id of groupFutureTaskIds.get(gid) ?? []) {
        supersededByThisChange.add(id);
      }
    }
  }

  if (warnings.length > 0) {
    logger.info({ warnings }, 'validateOperations: proposal contains redundant ops');
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Project a draft change's operations into a ChangeSummary *before* anything
 * is committed. For create_* ops we synthesize task rows with `preview:`-
 * prefixed ids so the UI can render them on the diff grid without colliding
 * with real ids. For mutate ops (cancel/move/edit) we look up the actual
 * task row that would be affected, so the diff shows the real titles/times.
 */
async function previewOperations(
  studentId: string,
  ops: TimetableOp[],
): Promise<ChangeSummary> {
  const referencedTaskIds = new Set<string>();
  const referencedGroupIds = new Set<string>();
  for (const op of ops) {
    if (op.op === 'cancel_task' || op.op === 'move_task' || op.op === 'edit_task')
      referencedTaskIds.add(op.payload.task_id);
    if (op.op === 'cancel_recurrence' || op.op === 'edit_recurrence')
      referencedGroupIds.add(op.payload.recurrence_group_id);
  }
  const referencedTasks = referencedTaskIds.size
    ? await db.select().from(tasks).where(inArray(tasks.id, Array.from(referencedTaskIds)))
    : [];
  const taskById = new Map(referencedTasks.map((t) => [t.id, t]));

  // For recurrence cancels/edits we also need the group's future tasks so
  // the diff shows the strip of blocks that will disappear.
  const groupFutureTasks = new Map<string, Task[]>();
  if (referencedGroupIds.size > 0) {
    for (const gid of referencedGroupIds) {
      const futures = await db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.recurrenceGroupId, gid),
            eq(tasks.status, 'scheduled'),
            isNull(tasks.supersededAt),
          ),
        );
      groupFutureTasks.set(gid, futures);
    }
  }

  const added: Task[] = [];
  const removed: Task[] = [];
  const moved: Array<{ from: Task; to: Task }> = [];
  const edits: Array<{ task: Task; changes: Record<string, unknown> }> = [];

  let virtualCounter = 0;
  const synth = (overrides: Partial<Task> & Pick<Task, 'scheduledStart' | 'scheduledEnd' | 'subject' | 'taskTitle'>): Task => {
    virtualCounter += 1;
    return {
      id: `preview:${virtualCounter}`,
      studentId,
      scheduledStart: overrides.scheduledStart,
      scheduledEnd: overrides.scheduledEnd,
      subject: overrides.subject,
      taskTitle: overrides.taskTitle,
      taskDescription: overrides.taskDescription ?? null,
      expectedOutput: overrides.expectedOutput ?? null,
      recurrencePattern: overrides.recurrencePattern ?? null,
      recurrenceParentId: null,
      recurrenceGroupId: overrides.recurrenceGroupId ?? null,
      source: overrides.source ?? 'counsellor_chat',
      generatedFromSessionId: null,
      generatedFromChangeId: null,
      supersededByChangeId: null,
      supersededAt: null,
      status: overrides.status ?? 'scheduled',
      rescheduledFromId: overrides.rescheduledFromId ?? null,
      linkedGapId: null,
      verificationRequired: false,
      flexibility: overrides.flexibility ?? 'preferred',
      googleCalendarEventId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Task;
  };

  for (const op of ops) {
    switch (op.op) {
      case 'create_task': {
        added.push(
          synth({
            scheduledStart: new Date(op.payload.scheduled_start),
            scheduledEnd: new Date(op.payload.scheduled_end),
            subject: op.payload.subject,
            taskTitle: op.payload.task_title,
            taskDescription: op.payload.task_description ?? null,
            flexibility: op.payload.flexibility ?? 'preferred',
          }),
        );
        break;
      }
      case 'create_recurrence': {
        const occurrences = expandRecurrence(
          op.payload.rule_json,
          op.payload.starts_on,
          op.payload.ends_on,
        );
        for (const o of occurrences) {
          added.push(
            synth({
              scheduledStart: o.scheduledStart,
              scheduledEnd: o.scheduledEnd,
              subject: op.payload.subject,
              taskTitle: op.payload.task_title,
              taskDescription: op.payload.task_description ?? null,
              flexibility: op.payload.flexibility ?? 'preferred',
              recurrencePattern: op.payload.rule_json.frequency,
            }),
          );
        }
        break;
      }
      case 'cancel_task': {
        const t = taskById.get(op.payload.task_id);
        if (t) removed.push(t);
        break;
      }
      case 'move_task': {
        const from = taskById.get(op.payload.task_id);
        if (from) {
          const to = synth({
            scheduledStart: new Date(op.payload.new_start),
            scheduledEnd: new Date(op.payload.new_end),
            subject: from.subject,
            taskTitle: from.taskTitle,
            taskDescription: from.taskDescription,
            flexibility: from.flexibility,
            rescheduledFromId: from.id,
          });
          moved.push({ from, to });
        }
        break;
      }
      case 'cancel_recurrence': {
        const futures = groupFutureTasks.get(op.payload.recurrence_group_id) ?? [];
        const effectiveFrom = op.payload.effective_from
          ? new Date(op.payload.effective_from)
          : new Date();
        for (const t of futures) {
          if (t.scheduledStart >= effectiveFrom) removed.push(t);
        }
        break;
      }
      case 'edit_recurrence': {
        const futures = groupFutureTasks.get(op.payload.recurrence_group_id) ?? [];
        const effectiveFrom = new Date(op.payload.effective_from);
        for (const t of futures) {
          if (t.scheduledStart >= effectiveFrom) removed.push(t);
        }
        // We can't compute the precise endsOn without the group row; pull it.
        const group = (
          await db
            .select()
            .from(recurrenceGroups)
            .where(eq(recurrenceGroups.id, op.payload.recurrence_group_id))
            .limit(1)
        )[0];
        if (group) {
          const occurrences = expandRecurrence(
            op.payload.new_rule_json,
            op.payload.effective_from,
            group.endsOn,
          );
          for (const o of occurrences) {
            added.push(
              synth({
                scheduledStart: o.scheduledStart,
                scheduledEnd: o.scheduledEnd,
                subject: group.subject,
                taskTitle: group.taskTitle,
                taskDescription: group.taskDescription,
                flexibility: group.flexibility,
                recurrencePattern: op.payload.new_rule_json.frequency,
              }),
            );
          }
        }
        break;
      }
      case 'edit_task': {
        const t = taskById.get(op.payload.task_id);
        if (t) edits.push({ task: t, changes: op.payload.changes as Record<string, unknown> });
        break;
      }
    }
  }

  return { added, removed, moved, edits };
}

// `sql` kept imported for potential future raw expressions; suppress noise.
void sql;

// Type re-export so callers don't need to dig into @wgc/db just for this.
export type { RecurrenceRule, TimetableOp };
