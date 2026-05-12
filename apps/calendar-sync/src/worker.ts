import { eq, sql } from 'drizzle-orm';
import { db, decryptJson, students, tasks } from '@wgc/db';
import type { Subject } from '@wgc/shared';
import { logger } from './logger.js';
import {
  buildEventResource,
  calendarFromToken,
  eventIdForTask,
  type StoredOAuthToken,
} from './google.js';

const MAX_ATTEMPTS = 3;

/**
 * Pull and process one pending outbox entry. Uses FOR UPDATE SKIP LOCKED so
 * multiple worker instances can run safely.
 */
export async function processOne(): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      SELECT id, entity_type, entity_id, operation, payload, attempts
      FROM sync_outbox
      WHERE status = 'pending'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);
    const row = (rows as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
    if (!row) return false;

    const id = row.id as string;
    const entityType = row.entity_type as string;
    const entityId = row.entity_id as string;
    const operation = row.operation as 'create' | 'update' | 'delete';
    const attempts = (row.attempts as number) ?? 0;

    await tx.execute(sql`
      UPDATE sync_outbox SET status = 'in_progress' WHERE id = ${id}
    `);

    try {
      if (entityType === 'task') {
        await handleTaskSync(entityId, operation);
      } else {
        logger.warn({ entityType, id }, 'Unsupported sync_outbox entity_type — marking skipped');
        await tx.execute(sql`
          UPDATE sync_outbox SET status = 'skipped', completed_at = NOW() WHERE id = ${id}
        `);
        return true;
      }
      await tx.execute(sql`
        UPDATE sync_outbox SET status = 'synced', completed_at = NOW() WHERE id = ${id}
      `);
    } catch (err) {
      const next = attempts + 1;
      const finalStatus = next >= MAX_ATTEMPTS ? 'failed' : 'pending';
      const message = (err as Error).message ?? 'unknown';
      logger.error({ err, id, entityId, operation, attempts: next }, 'sync attempt failed');
      await tx.execute(sql`
        UPDATE sync_outbox
        SET status = ${finalStatus}, attempts = ${next}, last_error = ${message}
        WHERE id = ${id}
      `);
    }
    return true;
  });
}

async function handleTaskSync(taskId: string, op: 'create' | 'update' | 'delete'): Promise<void> {
  if (op === 'delete') {
    // We need the student/calendar to issue the delete. The task row may still
    // exist (cancelled status); look it up.
    const t = (
      await db
        .select({ studentId: tasks.studentId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
    )[0];
    if (!t) return;
    const cal = await loadCalendarForStudent(t.studentId);
    if (!cal) return;
    try {
      await cal.client.events.delete({
        calendarId: cal.calendarId,
        eventId: eventIdForTask(taskId),
      });
    } catch (err) {
      // 404/410 are fine — already gone.
      const status = (err as { code?: number }).code;
      if (status === 404 || status === 410) return;
      throw err;
    }
    return;
  }

  // create / update
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0];
  if (!t) return;
  const cal = await loadCalendarForStudent(t.studentId);
  if (!cal) return;

  const resource = buildEventResource({
    id: t.id,
    taskTitle: t.taskTitle,
    taskDescription: t.taskDescription,
    expectedOutput: t.expectedOutput,
    subject: t.subject as Subject,
    scheduledStart: t.scheduledStart,
    scheduledEnd: t.scheduledEnd,
  });

  if (op === 'create') {
    try {
      await cal.client.events.insert({
        calendarId: cal.calendarId,
        requestBody: resource,
      });
    } catch (err) {
      // 409: event already exists (re-queue / re-run scenario) — fall through to update.
      if ((err as { code?: number }).code !== 409) throw err;
      await cal.client.events.update({
        calendarId: cal.calendarId,
        eventId: resource.id!,
        requestBody: resource,
      });
    }
  } else {
    await cal.client.events.update({
      calendarId: cal.calendarId,
      eventId: resource.id!,
      requestBody: resource,
    });
  }
}

async function loadCalendarForStudent(studentId: string): Promise<
  | {
      client: ReturnType<typeof calendarFromToken>;
      calendarId: string;
    }
  | null
> {
  const s = (
    await db
      .select({
        calendarId: students.googleCalendarId,
        token: students.googleOauthToken,
      })
      .from(students)
      .where(eq(students.id, studentId))
      .limit(1)
  )[0];
  if (!s?.calendarId || !s.token) {
    logger.info({ studentId }, 'student has no calendar or token; skipping');
    return null;
  }
  const token = await decryptJson<StoredOAuthToken>(s.token);
  return {
    client: calendarFromToken(token),
    calendarId: s.calendarId,
  };
}
