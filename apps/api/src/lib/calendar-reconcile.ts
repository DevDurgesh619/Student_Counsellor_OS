import { eq } from 'drizzle-orm';
import { google } from 'googleapis';
import {
  conversations,
  db,
  decryptJson,
  reviewQueue,
  students,
  tasks,
} from '@wgc/db';
import { SUBJECT_CALENDAR_COLOR, type Subject } from '@wgc/shared';
import { loadEnv } from '@wgc/config';
import { logger } from '../logger.js';

const EVENT_ID_PREFIX = 'task';

/**
 * Reconcile externally-edited events on a student's WGC – Study calendar.
 *
 * ACL model (per Phase 4 §2): the dedicated calendar lives in the student's
 * Google account. Counsellor / team members are added as readers only. The
 * only writer with write access is WGC itself (via the stored OAuth refresh
 * token). Therefore any non-WGC mutation observed via webhook is necessarily
 * a student edit — we revert it to the DB-canonical state and notify.
 *
 * Detection strategy: pull events updated in the last 10 minutes; for each
 * event whose id matches our deterministic `wgc{taskId}` prefix, compare the
 * key fields against the expected resource derived from the DB task. On
 * divergence, push the expected resource back via events.update (idempotent),
 * insert a `review_queue` row, and append a `conversations` audit row.
 */
export async function reconcileStudentCalendar(studentId: string): Promise<void> {
  const env = loadEnv();
  if (
    !env.WGC_GOOGLE_CALENDAR_CLIENT_ID ||
    !env.WGC_GOOGLE_CALENDAR_CLIENT_SECRET ||
    !env.WGC_GOOGLE_CALENDAR_REDIRECT_URI
  ) {
    return;
  }

  const studentRow = (
    await db
      .select({
        id: students.id,
        counsellorId: students.counsellorId,
        token: students.googleOauthToken,
        calendarId: students.googleCalendarId,
      })
      .from(students)
      .where(eq(students.id, studentId))
      .limit(1)
  )[0];
  if (!studentRow?.token || !studentRow.calendarId || !studentRow.counsellorId) return;

  const tokens = await decryptJson<Record<string, unknown>>(studentRow.token);
  const oauth = new google.auth.OAuth2(
    env.WGC_GOOGLE_CALENDAR_CLIENT_ID,
    env.WGC_GOOGLE_CALENDAR_CLIENT_SECRET,
    env.WGC_GOOGLE_CALENDAR_REDIRECT_URI,
  );
  oauth.setCredentials(tokens);
  const cal = google.calendar({ version: 'v3', auth: oauth });

  const updatedMin = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const list = await cal.events.list({
    calendarId: studentRow.calendarId,
    updatedMin,
    showDeleted: true,
    singleEvents: true,
    maxResults: 250,
  });
  const items = list.data.items ?? [];

  for (const evt of items) {
    if (!evt.id?.startsWith(EVENT_ID_PREFIX)) continue;
    const taskId = restoreTaskUuid(evt.id);
    if (!taskId) continue;

    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0];
    if (!task) continue; // event exists but task gone — sync worker will clean up.

    const expected = buildExpected(task);
    const divergence = diffEvent(evt, expected);
    if (!divergence) continue;

    // Student deleted the event entirely → recreate.
    if (evt.status === 'cancelled') {
      try {
        await cal.events.insert({
          calendarId: studentRow.calendarId,
          requestBody: { id: evt.id, ...expected },
        });
      } catch (err) {
        // 409 means it already exists (race) — fall back to update.
        if ((err as { code?: number }).code !== 409) throw err;
        await cal.events.update({
          calendarId: studentRow.calendarId,
          eventId: evt.id,
          requestBody: { id: evt.id, ...expected },
        });
      }
    } else {
      await cal.events.update({
        calendarId: studentRow.calendarId,
        eventId: evt.id,
        requestBody: { id: evt.id, ...expected },
      });
    }

    logger.info(
      { studentId, taskId, fields: divergence },
      'reverted external calendar edit',
    );

    await db
      .insert(reviewQueue)
      .values({
        counsellorId: studentRow.counsellorId,
        studentId,
        type: 'calendar_external_edit',
        referenceId: taskId,
        priority: 4,
        status: 'pending',
      })
      .onConflictDoNothing();

    await db.insert(conversations).values({
      channel: 'system',
      studentId,
      direction: 'outbound',
      contentText:
        'A change you made in Google Calendar was reverted. To request a schedule change, ' +
        'use the Request Change feature in the dashboard.',
      classifiedIntent: 'calendar_revert_notice',
      processedAt: new Date(),
      processingOutcome: 'reverted',
      metadata: { taskId, divergedFields: divergence },
    });
  }
}

function buildExpected(task: {
  id: string;
  taskTitle: string;
  taskDescription: string | null;
  expectedOutput: string | null;
  subject: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  status: string;
}): {
  summary: string;
  description: string;
  start: { dateTime: string };
  end: { dateTime: string };
  colorId: string;
} {
  const description = [
    task.taskDescription ?? '',
    task.expectedOutput ? `Expected output: ${task.expectedOutput}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    summary: `${task.subject}: ${task.taskTitle}`.slice(0, 1024),
    description,
    start: { dateTime: task.scheduledStart.toISOString() },
    end: { dateTime: task.scheduledEnd.toISOString() },
    colorId: SUBJECT_CALENDAR_COLOR[task.subject as Subject] ?? '8',
  };
}

function diffEvent(
  actual: {
    summary?: string | null;
    start?: { dateTime?: string | null } | null;
    end?: { dateTime?: string | null } | null;
    colorId?: string | null;
    status?: string | null;
  },
  expected: ReturnType<typeof buildExpected>,
): string[] | null {
  const out: string[] = [];
  if (actual.status === 'cancelled') return ['status:deleted'];
  if (actual.summary !== expected.summary) out.push('summary');
  const aStart = actual.start?.dateTime ? new Date(actual.start.dateTime).toISOString() : null;
  const aEnd = actual.end?.dateTime ? new Date(actual.end.dateTime).toISOString() : null;
  if (aStart !== expected.start.dateTime) out.push('start');
  if (aEnd !== expected.end.dateTime) out.push('end');
  if (actual.colorId !== expected.colorId) out.push('colorId');
  return out.length ? out : null;
}

function restoreTaskUuid(eventId: string): string | null {
  // Inverse of `wgc{taskIdNoDashes}.toLowerCase()`. UUID is 32 hex chars.
  const tail = eventId.slice(EVENT_ID_PREFIX.length);
  if (tail.length !== 32 || !/^[0-9a-f]{32}$/.test(tail)) return null;
  return `${tail.slice(0, 8)}-${tail.slice(8, 12)}-${tail.slice(12, 16)}-${tail.slice(16, 20)}-${tail.slice(20)}`;
}
