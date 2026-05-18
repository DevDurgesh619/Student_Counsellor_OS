import { eq } from 'drizzle-orm';
import { db, syncOutbox, tasks } from '@wgc/db';
import { shouldSyncToCalendar, type Subject } from '@wgc/shared';
import { logger } from '../logger.js';

/**
 * Queue a Calendar sync for a task mutation. Honours the non-syncing subject
 * filter — Sleep/Meal/Free/Family/Other are stored in DB but never sent to
 * Calendar. Caller need not check.
 *
 * Best-effort: failures here log but don't fail the parent request. The Sync
 * Worker also has a self-heal "resync from tasks table" admin path for any
 * outbox entry that goes missing.
 */
export async function enqueueTaskSync(
  taskId: string,
  operation: 'create' | 'update' | 'delete',
): Promise<void> {
  try {
    const row = (
      await db
        .select({ subject: tasks.subject, studentId: tasks.studentId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
    )[0];
    if (!row) {
      logger.warn(
        { taskId, operation },
        'enqueueTaskSync: task row not found — calendar event will not be synced',
      );
      return;
    }
    if (!shouldSyncToCalendar(row.subject as Subject)) {
      // Non-syncing subjects (Sleep / Meal / Free / Family / Other) — log
      // at trace level rather than silently dropping so the noise is
      // available when debugging "why didn't this hit Google Calendar?"
      logger.trace(
        { taskId, operation, subject: row.subject },
        'enqueueTaskSync: subject opted out of calendar sync',
      );
      return;
    }
    await db.insert(syncOutbox).values({
      entityType: 'task',
      entityId: taskId,
      operation,
      payload: { studentId: row.studentId },
    });
    logger.debug({ taskId, operation, subject: row.subject }, 'enqueued task sync');
  } catch (err) {
    // We can't fail the parent transaction over a missed sync — Calendar
    // is best-effort. But we DO want this loud in logs so an ops dashboard
    // / alerting on warns picks it up. Previously this was logged at warn
    // but without enough context to debug; now includes the studentId
    // when we have it.
    logger.warn(
      { err, taskId, operation, errMsg: (err as Error)?.message },
      'enqueueTaskSync: failed to enqueue sync_outbox entry — calendar will be out of sync until next backfill',
    );
  }
}

/** Bulk variant — accepts (taskId, operation) pairs. */
export async function enqueueTaskSyncBulk(
  entries: Array<{ taskId: string; operation: 'create' | 'update' | 'delete' }>,
): Promise<void> {
  for (const e of entries) {
    await enqueueTaskSync(e.taskId, e.operation);
  }
}
