import { and, eq } from 'drizzle-orm';
import { db, students, type Student } from '@wgc/db';
import { logger } from '../logger.js';
import type { SpinachMeetingFull, SpinachMeetingSummary } from './spinach-mcp.js';

export type MatchSignal = 'student_email' | 'parent_email' | 'title_name' | 'manual';
export type MatchMode = 'name-only' | 'email-first';

export type MatchResult = {
  studentId: string;
  matchedVia: MatchSignal;
};

/**
 * Pick the match mode from env. Default is `name-only` for dev — Hetvika's
 * dummy email won't appear in real Spinach meetings, so name-match is the
 * only signal that fires. Flip to `email-first` for prod once real students
 * are onboarded with calendars they actually attend under their own email.
 */
export function currentMatchMode(): MatchMode {
  const v = process.env['SPINACH_MATCH_MODE'];
  return v === 'email-first' ? 'email-first' : 'name-only';
}

type RosterStudent = Pick<Student, 'id' | 'fullName' | 'email' | 'parentContacts'>;

async function loadActiveRoster(counsellorId: string): Promise<RosterStudent[]> {
  return await db
    .select({
      id: students.id,
      fullName: students.fullName,
      email: students.email,
      parentContacts: students.parentContacts,
    })
    .from(students)
    .where(and(eq(students.counsellorId, counsellorId), eq(students.status, 'active')));
}

function meetingEmails(meeting: SpinachMeetingSummary, full: SpinachMeetingFull | null): string[] {
  const attendees = (full?.attendees?.length ? full.attendees : meeting.attendees) ?? [];
  return attendees
    .map((a) => a.email?.toLowerCase().trim())
    .filter((e): e is string => Boolean(e));
}

function meetingNameHaystack(meeting: SpinachMeetingSummary, full: SpinachMeetingFull | null): string {
  const title = meeting.title ?? full?.title ?? '';
  const attendees = (full?.attendees?.length ? full.attendees : meeting.attendees) ?? [];
  const names = attendees.map((a) => a.name ?? '').join(' ');
  return `${title} ${names}`.toLowerCase();
}

/**
 * Length-3+ name tokens from the student's full name, so "Dr", "Jr", and
 * single initials don't accidentally trigger matches.
 */
function nameTokens(fullName: string): string[] {
  return fullName
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-z]/g, ''))
    .filter((t) => t.length >= 3)
    .map((t) => t.toLowerCase());
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function studentMatchesByName(student: RosterStudent, haystack: string): boolean {
  const tokens = nameTokens(student.fullName);
  if (tokens.length === 0) return false;
  const pattern = new RegExp(`\\b(${tokens.map(escapeRegex).join('|')})\\b`, 'i');
  return pattern.test(haystack);
}

function matchByStudentEmail(roster: RosterStudent[], emails: string[]): RosterStudent[] {
  if (emails.length === 0) return [];
  const set = new Set(emails);
  return roster.filter((s) => s.email && set.has(s.email.toLowerCase()));
}

function matchByParentEmail(roster: RosterStudent[], emails: string[]): RosterStudent[] {
  if (emails.length === 0) return [];
  const set = new Set(emails);
  return roster.filter((s) =>
    (s.parentContacts ?? []).some((p) => p.email && set.has(p.email.toLowerCase())),
  );
}

function matchByName(roster: RosterStudent[], haystack: string): RosterStudent[] {
  if (!haystack.trim()) return [];
  return roster.filter((s) => studentMatchesByName(s, haystack));
}

/**
 * Try to assign a Spinach meeting to one of the counsellor's active students.
 *
 * Returns the matched student id + signal that fired, or `null` if zero or
 * >1 students match (caller should drop into the unassigned queue with the
 * candidate list logged).
 */
export async function matchMeeting(
  counsellorId: string,
  meeting: SpinachMeetingSummary,
  full: SpinachMeetingFull | null,
  mode: MatchMode = currentMatchMode(),
): Promise<MatchResult | null> {
  const roster = await loadActiveRoster(counsellorId);
  if (roster.length === 0) {
    logger.info({ counsellorId, meetingId: meeting.id, mode }, '[match] empty roster');
    return null;
  }

  const emails = meetingEmails(meeting, full);
  const haystack = meetingNameHaystack(meeting, full);

  let nameHits: RosterStudent[] = [];
  if (mode === 'email-first') {
    const studentEmailHits = matchByStudentEmail(roster, emails);
    if (studentEmailHits.length === 1) {
      const hit = studentEmailHits[0]!;
      const nameCheck = matchByName(roster, haystack);
      if (nameCheck.length === 1 && nameCheck[0]!.id !== hit.id) {
        logger.warn(
          {
            counsellorId,
            meetingId: meeting.id,
            byEmail: hit.id,
            byName: nameCheck[0]!.id,
          },
          '[match] conflict: email and title point to different students; email wins',
        );
      }
      logResult(counsellorId, meeting.id, mode, hit.id, 'student_email');
      return { studentId: hit.id, matchedVia: 'student_email' };
    }
    if (studentEmailHits.length > 1) {
      logger.warn(
        { counsellorId, meetingId: meeting.id, candidates: studentEmailHits.map((s) => s.id) },
        '[match] ambiguous student-email match; falling through',
      );
    }

    const parentEmailHits = matchByParentEmail(roster, emails);
    if (parentEmailHits.length === 1) {
      const hit = parentEmailHits[0]!;
      logResult(counsellorId, meeting.id, mode, hit.id, 'parent_email');
      return { studentId: hit.id, matchedVia: 'parent_email' };
    }
    if (parentEmailHits.length > 1) {
      logger.warn(
        { counsellorId, meetingId: meeting.id, candidates: parentEmailHits.map((s) => s.id) },
        '[match] ambiguous parent-email match; falling through',
      );
    }

    nameHits = matchByName(roster, haystack);
  } else {
    nameHits = matchByName(roster, haystack);
  }

  if (nameHits.length === 1) {
    const hit = nameHits[0]!;
    logResult(counsellorId, meeting.id, mode, hit.id, 'title_name');
    return { studentId: hit.id, matchedVia: 'title_name' };
  }
  if (nameHits.length > 1) {
    logger.warn(
      { counsellorId, meetingId: meeting.id, candidates: nameHits.map((s) => s.id) },
      '[match] ambiguous title-name match; leaving unassigned',
    );
  }
  logResult(counsellorId, meeting.id, mode, null, null);
  return null;
}

/**
 * Ranked-candidates view for the inbox UI. Where `matchMeeting` decides
 * "exactly one student or nothing", this returns the top 3 plausible
 * matches with a confidence label and a short human-readable reason — so
 * the counsellor's inbox shows "Suggested: Hetvika · high · email match
 * [Assign]" and triage drops from "read 46 meetings + pick a student
 * from a dropdown of 30+" to one click per match.
 */
export type MatchCandidate = {
  studentId: string;
  fullName: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
};

export async function rankCandidates(
  counsellorId: string,
  meeting: SpinachMeetingSummary,
  full: SpinachMeetingFull | null,
): Promise<MatchCandidate[]> {
  const roster = await loadActiveRoster(counsellorId);
  if (roster.length === 0) return [];

  const emails = meetingEmails(meeting, full);
  const haystack = meetingNameHaystack(meeting, full);
  const title = (meeting.title ?? full?.title ?? '').toLowerCase();

  // Aggregate score + best-reason per student.
  type Scored = { score: number; reason: string };
  const byId = new Map<string, Scored>();
  const bump = (sid: string, score: number, reason: string) => {
    const prev = byId.get(sid);
    if (!prev || score > prev.score) byId.set(sid, { score, reason });
  };

  for (const s of roster) {
    // High-confidence signals (score 1.0) — exact identifiers.
    if (s.email && emails.includes(s.email.toLowerCase())) {
      bump(s.id, 1.0, 'student email in attendees');
      continue;
    }
    const parentMatch = (s.parentContacts ?? []).find(
      (p) => p.email && emails.includes(p.email.toLowerCase()),
    );
    if (parentMatch) {
      bump(s.id, 1.0, 'parent email in attendees');
      continue;
    }
    // Full-name in title is high-confidence too.
    const tokens = nameTokens(s.fullName);
    const fullNameLower = s.fullName.toLowerCase();
    if (title.includes(fullNameLower)) {
      bump(s.id, 1.0, 'full name in meeting title');
      continue;
    }

    // Medium-confidence (0.7) — first-name in title or attendee names.
    const firstName = tokens[0];
    if (firstName && title.includes(firstName)) {
      bump(s.id, 0.7, `first name "${firstName}" in title`);
      continue;
    }
    if (firstName && haystack.includes(firstName)) {
      bump(s.id, 0.7, `first name "${firstName}" in attendees`);
      continue;
    }

    // Low-confidence (0.4) — any 3+ char name token anywhere in metadata.
    const tokenHit = tokens.find((t) => haystack.includes(t));
    if (tokenHit) {
      bump(s.id, 0.4, `name token "${tokenHit}" in metadata`);
    }
  }

  const studentById = new Map(roster.map((s) => [s.id, s]));
  return [...byId.entries()]
    .map(([studentId, { score, reason }]) => ({
      studentId,
      fullName: studentById.get(studentId)?.fullName ?? '(unknown)',
      confidence: (score >= 1.0 ? 'high' : score >= 0.7 ? 'medium' : 'low') as
        | 'high'
        | 'medium'
        | 'low',
      reason,
    }))
    .sort((a, b) => {
      const order = { high: 3, medium: 2, low: 1 } as const;
      return order[b.confidence] - order[a.confidence];
    })
    .slice(0, 3);
}

/**
 * Targeted single-student match — used by the backfill flow when we already
 * know which student we're importing for. Returns true if any signal
 * (in the active mode) points to this specific student.
 */
export async function meetingMatchesStudent(
  counsellorId: string,
  studentId: string,
  meeting: SpinachMeetingSummary,
  full: SpinachMeetingFull | null,
  mode: MatchMode = currentMatchMode(),
): Promise<MatchResult | null> {
  const result = await matchMeeting(counsellorId, meeting, full, mode);
  return result && result.studentId === studentId ? result : null;
}

function logResult(
  counsellorId: string,
  meetingId: string,
  mode: MatchMode,
  resultId: string | null,
  signal: MatchSignal | null,
): void {
  logger.info(
    { counsellorId, meetingId, mode, result: resultId, signal },
    '[match] decision',
  );
}
