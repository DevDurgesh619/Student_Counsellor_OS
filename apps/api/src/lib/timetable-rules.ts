import type { RecurrenceRule } from '@wgc/db';

/**
 * Pure recurrence helpers. No DB calls — keeps the rule logic unit-testable
 * and lets the engine layer focus on transactions / FK wiring.
 */

/**
 * Convert a wall-clock time in a named IANA timezone to a UTC Date.
 * DST-correct: uses Intl.DateTimeFormat to discover the zone's offset at
 * that specific wall time, which avoids the "fixed offset" trap that
 * naive `new Date(...)` constructs fall into.
 *
 * Quirk handled: `Intl.DateTimeFormat('en-US', { hour12: false })` returns
 * `hour: "24"` (instead of "00") for midnight in Node.js / V8 because en-US
 * with hour12=false defaults to the h24 cycle. Building an ISO string
 * `2026-05-19T24:30:00.000Z` produces an Invalid Date and silently corrupts
 * any task at a wall time whose tz-equivalent lands on midnight (for IST,
 * that's wall times 18:30–19:29). We pass `hourCycle: 'h23'` explicitly,
 * and also defensively normalize "24" → "00" + advance the day.
 */
export function wallTimeToUtc(dateStr: string, timeHHmm: string, tz: string): Date {
  const wallAsUtc = new Date(`${dateStr}T${timeHHmm}:00.000Z`);

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(wallAsUtc);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;

  let year = get('year');
  let month = get('month');
  let day = get('day');
  let hour = get('hour');
  // Belt-and-braces: even with hourCycle='h23', some runtimes still report
  // "24". Normalize to "00" and roll the day forward.
  if (hour === '24') {
    hour = '00';
    const rolled = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
    rolled.setUTCDate(rolled.getUTCDate() + 1);
    year = String(rolled.getUTCFullYear()).padStart(4, '0');
    month = String(rolled.getUTCMonth() + 1).padStart(2, '0');
    day = String(rolled.getUTCDate()).padStart(2, '0');
  }
  const tzWallAsUtcParsed = new Date(
    `${year}-${month}-${day}T${hour}:${get('minute')}:${get('second')}.000Z`,
  );

  const offsetMs = tzWallAsUtcParsed.getTime() - wallAsUtc.getTime();
  return new Date(wallAsUtc.getTime() - offsetMs);
}

/** YYYY-MM-DD for a Date treated as UTC. */
function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Day-of-week 0=Sun..6=Sat for a YYYY-MM-DD wall date (no timezone needed
 * because the date itself is the wall-day; we anchor at noon UTC to dodge
 * boundary surprises). */
function dowOfYmd(ymd: string): number {
  return new Date(`${ymd}T12:00:00.000Z`).getUTCDay();
}

/** Add N days to a YYYY-MM-DD wall date, returning YYYY-MM-DD. */
function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return toYmd(d);
}

export type MaterializedOccurrence = {
  scheduledStart: Date;
  scheduledEnd: Date;
};

/**
 * Walk a recurrence rule over a [from, to] inclusive date range (both as
 * YYYY-MM-DD wall dates) and emit a UTC instant pair for each matching day.
 *
 * For weekly/daily-with-days_of_week: only days in `days_of_week` produce
 * occurrences. Pure daily (no days_of_week filter) → every day.
 */
export function expandRecurrence(
  rule: RecurrenceRule,
  fromYmd: string,
  toYmd: string,
): MaterializedOccurrence[] {
  const out: MaterializedOccurrence[] = [];
  const dowFilter = new Set(rule.days_of_week);
  const includeAllDays = rule.frequency === 'daily' && rule.days_of_week.length === 0;

  let cursor = fromYmd;
  // Guardrail — a recurrence over more than ~2 years almost certainly
  // indicates a bug (the plan caps recurrence windows at weeks, not years).
  let safety = 800;
  while (cursor <= toYmd && safety-- > 0) {
    const dow = dowOfYmd(cursor);
    if (includeAllDays || dowFilter.has(dow)) {
      const start = wallTimeToUtc(cursor, rule.start_time, rule.timezone);
      const end = new Date(start.getTime() + rule.duration_min * 60_000);
      // Fail loudly if the wall-time math produced an invalid Date —
      // silently emitting them lets bad data leak all the way to the
      // DB insert, where Drizzle's timestamp serializer throws
      // `RangeError: Invalid time value` and the user gets a generic
      // "Apply failed" with no diagnosis.
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        throw new Error(
          `expandRecurrence: produced an invalid Date for cursor=${cursor} start_time=${rule.start_time} tz=${rule.timezone}. Check the rule's time / timezone format.`,
        );
      }
      out.push({ scheduledStart: start, scheduledEnd: end });
    }
    cursor = addDays(cursor, 1);
  }
  return out;
}

/** Convenience: today's YYYY-MM-DD in the given tz. */
export function todayYmdInTz(tz: string, now: Date = new Date()): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA produces YYYY-MM-DD natively.
  return dtf.format(now);
}
