import { and, eq, inArray, isNotNull } from 'drizzle-orm';
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
import { matchMeeting, meetingMatchesStudent } from './spinach-match.js';
import { regenerateStudentHistorySummary } from './student-history.js';
import {
  listMeetingsPage,
  pullFullMeeting,
  SpinachRateLimited,
  SpinachReauthRequired,
  type SpinachMeetingFull,
  type SpinachMeetingSummary,
} from './spinach-mcp.js';

/** Hard cap on pages walked per poll. Spinach returns 50/page, so 5 pages = 250 meetings. */
const MAX_PAGES_PER_POLL = 5;
/** Delay between per-meeting `get` calls so we don't blow through Spinach's per-second rate limit. */
const PULL_DELAY_MS = 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  // Paginate the meetings list. Spinach ignores our `since` arg in practice,
  // so we walk pages until we've seen meetings we already ingested (= reached
  // known territory) or until MAX_PAGES_PER_POLL.
  const fresh: SpinachMeetingSummary[] = [];
  let cursor: string | null = null;
  let totalListed = 0;
  let alreadyIngested = 0;
  let rateLimited = false;
  for (let page = 0; page < MAX_PAGES_PER_POLL; page++) {
    let listPage;
    try {
      listPage = await listMeetingsPage(counsellorId, { since, cursor });
    } catch (err) {
      if (err instanceof SpinachRateLimited) {
        logger.warn(
          { counsellorId, page, limits: err.limits },
          'spinach poll: rate-limited on list; stopping pagination',
        );
        rateLimited = true;
        break;
      }
      throw err;
    }
    if (listPage.meetings.length === 0) break;
    totalListed += listPage.meetings.length;

    const ids = listPage.meetings.map((m) => m.id);
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
    alreadyIngested += seen.size;
    for (const m of listPage.meetings) {
      if (!seen.has(m.id)) fresh.push(m);
    }
    // Once a page contains any already-ingested meeting, the pages after it
    // are even older — we've reached known territory, stop here.
    if (seen.size > 0) break;
    if (!listPage.nextCursor) break;
    cursor = listPage.nextCursor;
  }

  logger.info(
    {
      counsellorId,
      totalListed,
      alreadyIngested,
      fresh: fresh.length,
      rateLimited,
    },
    'spinach poll: meeting list summary',
  );

  if (fresh.length === 0) {
    await touchWatermark(counsellorId);
    return { meetingsFetched: 0, sessionsCreated: 0, unassigned: 0 };
  }

  let sessionsCreated = 0;
  let unassigned = 0;
  let latest = since;

  for (let i = 0; i < fresh.length; i++) {
    const meeting = fresh[i]!;
    if (i > 0) await sleep(PULL_DELAY_MS); // throttle to stay under Spinach's per-second limit
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
      if (err instanceof SpinachRateLimited) {
        logger.warn(
          { counsellorId, meetingId: meeting.id, limits: err.limits, remaining: fresh.length - i - 1 },
          'spinach poll: rate-limited on pull; aborting, cron retries next tick',
        );
        break;
      }
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

type IngestOptions = {
  /** Forward to runSessionPipeline — backfill sets this to skip Worker 4. */
  skipTimetableDraft?: boolean;
};

async function ingestOneMeeting(
  counsellorId: string,
  meeting: SpinachMeetingSummary,
  full: SpinachMeetingFull,
  ingestOpts: IngestOptions = {},
): Promise<IngestOutcome> {
  const attendees: SpinachAttendee[] = (full.attendees?.length ? full.attendees : meeting.attendees) ?? [];

  const match = await matchMeeting(counsellorId, meeting, full);

  const scheduledAt = meeting.scheduledAt ? new Date(meeting.scheduledAt) : new Date();

  if (match) {
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
          studentId: match.studentId,
          counsellorId,
          scheduledAt,
          actualStartedAt: scheduledAt,
          transcriptText: full.transcript ?? null,
          spinachSummaryText: full.summary ?? null,
          spinachMetadata: { source: 'mcp', spinachMeetingId: meeting.id, raw: full.raw },
          status: 'completed',
          matchedVia: match.matchedVia,
        })
        .returning({ id: sessions.id })
    )[0]!;

    await db
      .update(spinachIngestedMeetings)
      .set({ linkedSessionId: sessionRow.id })
      .where(eq(spinachIngestedMeetings.id, ingestId));

    try {
      await runSessionPipeline(sessionRow.id, {
        skipTimetableDraft: ingestOpts.skipTimetableDraft,
      });
    } catch (err) {
      logger.warn(
        { err, sessionId: sessionRow.id },
        'spinach poll: pipeline failed (session row + ingest kept)',
      );
    }
    // Fire-and-forget: rolling history summary is the long-term memory but
    // never the critical path. The next brief reads the *prior* summary
    // plus this new extraction directly, so a slow/failed regen here
    // doesn't block anything counsellor-facing.
    void regenerateStudentHistorySummary(match.studentId, sessionRow.id).catch((err) => {
      logger.warn(
        { err, sessionId: sessionRow.id, studentId: match.studentId },
        'spinach poll: rolling-history regen failed (non-fatal)',
      );
    });
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
        matchedVia: 'manual',
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
  void regenerateStudentHistorySummary(studentId, sessionRow.id).catch((err) => {
    logger.warn(
      { err, sessionId: sessionRow.id, studentId },
      'spinach assign: rolling-history regen failed (non-fatal)',
    );
  });
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

export type BackfillResult = {
  scanned: number;
  imported: number;
  skipped: number;
  failed: number;
  durationMs: number;
  rateLimited: boolean;
};

const BACKFILL_MAX_PAGES = 30; // ~1500 meetings — enough for years of history
const BACKFILL_LOOKBACK_MAX_DAYS = 730;

/**
 * Backfill historical Spinach meetings for a specific student. Walks the
 * counsellor's full Spinach history (up to `lookbackDays`, capped at 730),
 * picks meetings that auto-match this student, sorts chronologically, and
 * ingests them in order — running the full pipeline (extraction + rolling
 * summary regen) for each so the longitudinal story is built correctly.
 *
 * Synchronous — caller waits for the response. Expected runtime 30s–2min
 * for typical 8-10 meetings. Promote to a background job later if needed.
 */
export async function backfillStudentSpinach(
  counsellorId: string,
  studentId: string,
  opts: { lookbackDays?: number } = {},
): Promise<BackfillResult> {
  const t0 = Date.now();
  const lookbackDays = Math.min(
    Math.max(opts.lookbackDays ?? 365, 1),
    BACKFILL_LOOKBACK_MAX_DAYS,
  );
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const result: BackfillResult = {
    scanned: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    durationMs: 0,
    rateLimited: false,
  };

  // Step 1 — page through history collecting meetings that match this student.
  const matched: SpinachMeetingSummary[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
    let listPage;
    try {
      listPage = await listMeetingsPage(counsellorId, { since, cursor });
    } catch (err) {
      if (err instanceof SpinachRateLimited) {
        logger.warn({ counsellorId, page, limits: err.limits }, 'backfill: rate-limited on list');
        result.rateLimited = true;
        break;
      }
      throw err;
    }
    if (listPage.meetings.length === 0) break;
    result.scanned += listPage.meetings.length;

    for (const meeting of listPage.meetings) {
      const matches = await meetingMatchesStudent(counsellorId, studentId, meeting, null);
      if (matches) matched.push(meeting);
    }
    if (!listPage.nextCursor) break;
    cursor = listPage.nextCursor;
  }

  if (matched.length === 0) {
    result.durationMs = Date.now() - t0;
    return result;
  }

  // Skip meetings already ingested.
  const ids = matched.map((m) => m.id);
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
  const fresh = matched.filter((m) => !seen.has(m.id));
  result.skipped = matched.length - fresh.length;

  // Step 2 — chronological order, oldest first.
  fresh.sort((a, b) => {
    const ta = a.scheduledAt ? new Date(a.scheduledAt).getTime() : 0;
    const tb = b.scheduledAt ? new Date(b.scheduledAt).getTime() : 0;
    return ta - tb;
  });

  // Step 3 — fetch full + ingest each. The existing `ingestOneMeeting`
  // already runs the pipeline AND fires the rolling summary regen.
  for (let i = 0; i < fresh.length; i++) {
    const meeting = fresh[i]!;
    if (i > 0) await sleep(PULL_DELAY_MS);
    try {
      const full = await pullFullMeeting(counsellorId, meeting.id);
      if (!full) {
        result.failed += 1;
        continue;
      }
      const outcome = await ingestOneMeeting(counsellorId, meeting, full, {
        skipTimetableDraft: true,
      });
      if (outcome === 'linked') result.imported += 1;
      else result.failed += 1; // shouldn't happen — we pre-matched
    } catch (err) {
      if (err instanceof SpinachRateLimited) {
        logger.warn(
          { counsellorId, studentId, meetingId: meeting.id, limits: err.limits },
          'backfill: rate-limited on pull; stopping',
        );
        result.rateLimited = true;
        break;
      }
      logger.warn(
        { err, counsellorId, studentId, meetingId: meeting.id },
        'backfill: ingest failed',
      );
      result.failed += 1;
    }
  }

  result.durationMs = Date.now() - t0;
  logger.info({ counsellorId, studentId, ...result }, 'backfill: done');
  return result;
}
