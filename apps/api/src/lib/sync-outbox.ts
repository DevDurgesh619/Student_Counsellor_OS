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
    if (!row) return;
    if (!shouldSyncToCalendar(row.subject as Subject)) return;
    await db.insert(syncOutbox).values({
      entityType: 'task',
      entityId: taskId,
      operation,
      payload: { studentId: row.studentId },
    });
  } catch (err) {
    logger.warn({ err, taskId, operation }, 'Failed to enqueue sync_outbox entry');
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
