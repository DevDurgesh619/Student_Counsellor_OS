import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  counsellors,
  db,
  reviewQueue,
  sessions,
  spinachIngestedMeetings,
  students,
  type SpinachAttendee,
} from '@wgc/db';
import { logger } from '../logger.js';
import { runSessionPipeline } from './session-pipeline.js';
import {
  listMeetings,
  pullFullMeeting,
  SpinachReauthRequired,
  type SpinachMeetingFull,
  type SpinachMeetingSummary,
} from './spinach-mcp.js';

export type PollResult = {
  counsellorsScanned: number;
  meetingsFetched: number;
  sessionsCreated: number;
  unassigned: number;
  reauthRequired: number;
  errors: number;
};

/**
 * Sweep every counsellor with a stored Spinach token. Called by the
 * 5-min cron via /internal/spinach-poll.
 */
export async function sweepAllCounsellors(): Promise<PollResult> {
  const rows = await db
    .select({ id: counsellors.id })
    .from(counsellors)
    .where(and(eq(counsellors.status, 'active'), isNotNull(counsellors.spinachOauthToken)));

  const result: PollResult = {
    counsellorsScanned: 0,
    meetingsFetched: 0,
    sessionsCreated: 0,
    unassigned: 0,
    reauthRequired: 0,
    errors: 0,
  };

  for (const c of rows) {
    result.counsellorsScanned += 1;
    try {
      const partial = await pollOneCounsellor(c.id);
      result.meetingsFetched += partial.meetingsFetched;
      result.sessionsCreated += partial.sessionsCreated;
      result.unassigned += partial.unassigned;
    } catch (err) {
      if (err instanceof SpinachReauthRequired) {
        result.reauthRequired += 1;
        logger.info({ counsellorId: c.id }, 'spinach poll: reauth required');
      } else {
        result.errors += 1;
        logger.warn({ err, counsellorId: c.id }, 'spinach poll: unexpected error');
      }
    }
  }
  return result;
}

type PollOneResult = {
  meetingsFetched: number;
  sessionsCreated: number;
  unassigned: number;
};

export async function pollOneCounsellor(counsellorId: string): Promise<PollOneResult> {
  const counsellor = (
    await db.select().from(counsellors).where(eq(counsellors.id, counsellorId)).limit(1)
  )[0];
  if (!counsellor) throw new Error(`counsellor ${counsellorId} not found`);

  const sinceFromDb = counsellor.spinachLastSyncedAt
    ? new Date(counsellor.spinachLastSyncedAt)
    : null;
  // Always look back at least 24h on first run / after gaps, so we don't miss
  // a meeting that finished after a brief outage.
  const since = sinceFromDb ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  logger.info(
    {
      counsellorId,
      since: since.toISOString(),
      sinceSource: sinceFromDb ? 'watermark' : 'lookback-7d',
    },
    'spinach poll: starting',
  );

  const meetings = await listMeetings(counsellorId, { since });
  if (meetings.length === 0) {
    logger.info({ counsellorId }, 'spinach poll: list returned 0 meetings');
    await touchWatermark(counsellorId);
    return { meetingsFetched: 0, sessionsCreated: 0, unassigned: 0 };
  }

  // Skip the ones we already ingested (idempotency).
  const ids = meetings.map((m) => m.id);
  const seenRows = await db
    .select({ spinachMeetingId: spinachIngestedMeetings.spinachMeetingId })
    .from(spinachIngestedMeetings)
    .where(
      and(
        eq(spinachIngestedMeetings.counsellorId, counsellorId),
        inArray(spinachIngestedMeetings.spinachMeetingId, ids),
      ),
    );
  const seen = new Set(seenRows.map((r) => r.spinachMeetingId));
  const allFresh = meetings.filter((m) => !seen.has(m.id));
  // Dev cap: only ingest a handful per poll so we can validate the pipeline
  // end-to-end without flooding the DB / hitting Spinach rate limits. Remove
  // (or lift) once the pipeline is verified.
  const DEV_INGEST_CAP = 3;
  const fresh = allFresh.slice(0, DEV_INGEST_CAP);
  logger.info(
    {
      counsellorId,
      total: meetings.length,
      alreadyIngested: seen.size,
      freshTotal: allFresh.length,
      freshCapped: fresh.length,
      cap: DEV_INGEST_CAP,
      freshSample: fresh.map((m) => ({ id: m.id, title: m.title, scheduledAt: m.scheduledAt })),
    },
    'spinach poll: meeting list summary',
  );

  let sessionsCreated = 0;
  let unassigned = 0;
  let latest = since;

  for (const meeting of fresh) {
    try {
      const full = await pullFullMeeting(counsellorId, meeting.id);
      if (!full) {
        logger.warn({ counsellorId, meetingId: meeting.id }, 'spinach poll: pull returned null');
        continue;
      }
      const outcome = await ingestOneMeeting(counsellor.id, meeting, full);
      if (outcome === 'linked') sessionsCreated += 1;
      else unassigned += 1;
      if (meeting.scheduledAt) {
        const t = new Date(meeting.scheduledAt);
        if (t > latest) latest = t;
      }
    } catch (err) {
      logger.warn({ err, counsellorId, meetingId: meeting.id }, 'spinach poll: ingest failed');
    }
  }

  // Bump watermark to the most-recent scheduledAt we observed (or now).
  const newWatermark = latest > since ? latest : new Date();
  await db
    .update(counsellors)
    .set({ spinachLastSyncedAt: newWatermark })
    .where(eq(counsellors.id, counsellorId));

  return { meetingsFetched: fresh.length, sessionsCreated, unassigned };
}

async function touchWatermark(counsellorId: string): Promise<void> {
  await db
    .update(counsellors)
    .set({ spinachLastSyncedAt: new Date() })
    .where(eq(counsellors.id, counsellorId));
}

type IngestOutcome = 'linked' | 'unassigned';

async function ingestOneMeeting(
  counsellorId: string,
  meeting: SpinachMeetingSummary,
  full: SpinachMeetingFull,
): Promise<IngestOutcome> {
  const attendees: SpinachAttendee[] = (full.attendees?.length ? full.attendees : meeting.attendees) ?? [];
  const attendeeEmails = attendees
    .map((a) => a.email?.toLowerCase())
    .filter((e): e is string => Boolean(e));

  // Match by attendee email → students.email for THIS counsellor's roster only.
  let matchedStudent: { id: string; fullName: string } | null = null;
  if (attendeeEmails.length > 0) {
    const matches = await db
      .select({ id: students.id, fullName: students.fullName })
      .from(students)
      .where(
        and(
          eq(students.counsellorId, counsellorId),
          eq(students.status, 'active'),
          inArray(sql`LOWER(${students.email})`, attendeeEmails),
        ),
      )
      .limit(1);
    matchedStudent = matches[0] ?? null;
  }
  logger.info(
    {
      counsellorId,
      meetingId: meeting.id,
      attendeeEmails,
      matched: Boolean(matchedStudent),
      matchedStudentId: matchedStudent?.id,
      matchedStudentName: matchedStudent?.fullName,
    },
    'spinach poll: match attempt',
  );

  const scheduledAt = meeting.scheduledAt ? new Date(meeting.scheduledAt) : new Date();

  if (matchedStudent) {
    // Claim the meeting first via ON CONFLICT DO NOTHING so concurrent polls
    // (manual sync + cron tick overlapping) don't both create a session row.
    const claimed = await db
      .insert(spinachIngestedMeetings)
      .values({
        counsellorId,
        spinachMeetingId: meeting.id,
        scheduledAt,
        title: meeting.title ?? null,
        attendees,
        raw: full.raw,
        status: 'linked',
      })
      .onConflictDoNothing({
        target: [
          spinachIngestedMeetings.counsellorId,
          spinachIngestedMeetings.spinachMeetingId,
        ],
      })
      .returning({ id: spinachIngestedMeetings.id });
    if (claimed.length === 0) {
      logger.info(
        { counsellorId, meetingId: meeting.id },
        'spinach poll: lost ingest race (matched); skipping',
      );
      return 'linked';
    }
    const ingestId = claimed[0]!.id;

    const sessionRow = (
      await db
        .insert(sessions)
        .values({
          studentId: matchedStudent.id,
          counsellorId,
          scheduledAt,
          actualStartedAt: scheduledAt,
          transcriptText: full.transcript ?? null,
          spinachSummaryText: full.summary ?? null,
          spinachMetadata: { source: 'mcp', spinachMeetingId: meeting.id, raw: full.raw },
          status: 'completed',
        })
        .returning({ id: sessions.id })
    )[0]!;

    await db
      .update(spinachIngestedMeetings)
      .set({ linkedSessionId: sessionRow.id })
      .where(eq(spinachIngestedMeetings.id, ingestId));

    try {
      await runSessionPipeline(sessionRow.id);
    } catch (err) {
      logger.warn(
        { err, sessionId: sessionRow.id },
        'spinach poll: pipeline failed (session row + ingest kept)',
      );
    }
    return 'linked';
  }

  // Unmatched — drop into the inbox and surface a queue item.
  const ingestedRows = await db
    .insert(spinachIngestedMeetings)
    .values({
      counsellorId,
      spinachMeetingId: meeting.id,
      scheduledAt,
      title: meeting.title ?? null,
      attendees,
      raw: full.raw,
      status: 'unassigned',
    })
    .onConflictDoNothing({
      target: [
        spinachIngestedMeetings.counsellorId,
        spinachIngestedMeetings.spinachMeetingId,
      ],
    })
    .returning({ id: spinachIngestedMeetings.id });
  if (ingestedRows.length === 0) {
    logger.info(
      { counsellorId, meetingId: meeting.id },
      'spinach poll: lost ingest race (unassigned); skipping queue insert',
    );
    return 'unassigned';
  }
  const ingested = ingestedRows[0]!;

  await db.insert(reviewQueue).values({
    counsellorId,
    studentId: null,
    type: 'unassigned_spinach_meeting',
    referenceId: ingested.id,
    priority: 3,
  });
  return 'unassigned';
}

/**
 * Promote an unassigned inbox row into a real session + pipeline run.
 * Used by the manual assign endpoint.
 */
export async function assignInboxMeeting(
  counsellorId: string,
  inboxId: string,
  studentId: string,
): Promise<{ sessionId: string }> {
  const inbox = (
    await db
      .select()
      .from(spinachIngestedMeetings)
      .where(eq(spinachIngestedMeetings.id, inboxId))
      .limit(1)
  )[0];
  if (!inbox) throw new Error(`inbox row ${inboxId} not found`);
  if (inbox.counsellorId !== counsellorId) throw new Error('not your inbox row');
  if (inbox.status === 'linked' && inbox.linkedSessionId) {
    return { sessionId: inbox.linkedSessionId };
  }

  const student = (
    await db
      .select({ id: students.id, counsellorId: students.counsellorId })
      .from(students)
      .where(eq(students.id, studentId))
      .limit(1)
  )[0];
  if (!student) throw new Error('student not found');
  if (student.counsellorId !== counsellorId) throw new Error('student not assigned to you');

  const raw = (inbox.raw ?? {}) as Record<string, unknown>;
  const transcript = pickStringRaw(raw, ['transcript', 'transcript_text', 'full_transcript']);
  const summary = pickStringRaw(raw, ['summary', 'summary_text', 'ai_summary']);
  const scheduledAt = inbox.scheduledAt ?? new Date();

  const sessionRow = (
    await db
      .insert(sessions)
      .values({
        studentId,
        counsellorId,
        scheduledAt,
        actualStartedAt: scheduledAt,
        transcriptText: transcript ?? null,
        spinachSummaryText: summary ?? null,
        spinachMetadata: { source: 'mcp-manual', spinachMeetingId: inbox.spinachMeetingId, raw },
        status: 'completed',
      })
      .returning({ id: sessions.id })
  )[0]!;

  await db
    .update(spinachIngestedMeetings)
    .set({ status: 'linked', linkedSessionId: sessionRow.id })
    .where(eq(spinachIngestedMeetings.id, inboxId));

  await db
    .update(reviewQueue)
    .set({ status: 'resolved', resolvedAt: new Date(), resolvedBy: counsellorId })
    .where(
      and(
        eq(reviewQueue.type, 'unassigned_spinach_meeting'),
        eq(reviewQueue.referenceId, inboxId),
      ),
    );

  try {
    await runSessionPipeline(sessionRow.id);
  } catch (err) {
    logger.warn({ err, sessionId: sessionRow.id }, 'spinach assign: pipeline failed');
  }
  return { sessionId: sessionRow.id };
}

export async function ignoreInboxMeeting(counsellorId: string, inboxId: string): Promise<void> {
  const inbox = (
    await db
      .select({ counsellorId: spinachIngestedMeetings.counsellorId })
      .from(spinachIngestedMeetings)
      .where(eq(spinachIngestedMeetings.id, inboxId))
      .limit(1)
  )[0];
  if (!inbox) throw new Error(`inbox row ${inboxId} not found`);
  if (inbox.counsellorId !== counsellorId) throw new Error('not your inbox row');
  await db
    .update(spinachIngestedMeetings)
    .set({ status: 'ignored' })
    .where(eq(spinachIngestedMeetings.id, inboxId));
  await db
    .update(reviewQueue)
    .set({ status: 'dismissed', resolvedAt: new Date(), resolvedBy: counsellorId })
    .where(
      and(
        eq(reviewQueue.type, 'unassigned_spinach_meeting'),
        eq(reviewQueue.referenceId, inboxId),
      ),
    );
}

function pickStringRaw(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}
