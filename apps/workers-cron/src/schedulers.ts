/**
 * Canonical scheduler registry per CLAUDE_CODE.md §11. All entries pin an IANA
 * timezone (Asia/Kolkata is the business-time zone — never UTC). Each entry
 * carries a `description` so the schedule's intent is co-located with its cron
 * string. This is the "explicit and testable" property the spec asks for.
 *
 * Phase 1: handlers are placeholders that just log. Real handlers are wired by
 * the relevant phase (Phase 6 cron, Phase 7 cron, Phase 8 cron).
 */
import type { Logger } from 'pino';
import { renewExpiringWatchChannels } from './handlers/calendar-watch-renewal.js';
import { runPassBScheduler } from './handlers/pass-b-scheduler.js';
import { runSpinachPoll } from './handlers/spinach-poll.js';

export type SchedulerEntry = {
  name: string;
  schedule: string; // cron string
  timezone: string; // IANA, e.g. 'Asia/Kolkata'
  description: string;
  handler: (log: Logger) => Promise<void>;
};

const noopHandler = (label: string) => async (log: Logger) => {
  log.info({ scheduler: label }, 'scheduler tick (Phase 1 placeholder, no-op)');
};

export const SCHEDULERS: SchedulerEntry[] = [
  {
    name: 'reporter_weekly',
    schedule: '0 18 * * 0', // Sunday 6 PM IST
    timezone: 'Asia/Kolkata',
    description: 'Weekly report generation for all active students (Phase 8)',
    handler: noopHandler('reporter_weekly'),
  },
  {
    name: 'assessment_generator_friday',
    schedule: '0 18 * * 5', // Friday 6 PM IST
    timezone: 'Asia/Kolkata',
    description: 'Friday assessment generation for next week (Phase 7)',
    handler: noopHandler('assessment_generator_friday'),
  },
  {
    name: 'pass_b_24h_check',
    schedule: '0 * * * *', // hourly
    timezone: 'Asia/Kolkata',
    description: 'Check upcoming sessions and emit Pass B events ~24h before (Phase 6)',
    handler: runPassBScheduler,
  },
  {
    name: 'spinach_poll',
    schedule: '*/5 * * * *',
    timezone: 'Asia/Kolkata',
    description: 'Pull new Spinach meetings every 5 min (Phase 6 — MCP ingestion)',
    handler: runSpinachPoll,
  },
  {
    name: 'calendar_watch_renewal',
    schedule: '0 2 * * *', // daily 2 AM IST
    timezone: 'Asia/Kolkata',
    description: 'Renew Google Calendar push channels before 30-day expiry (Phase 4)',
    handler: renewExpiringWatchChannels,
  },
  {
    name: 'idempotency_records_gc',
    schedule: '*/30 * * * *', // every 30 min
    timezone: 'Asia/Kolkata',
    description: 'Garbage-collect expired idempotency_records rows (Phase 1+)',
    handler: noopHandler('idempotency_records_gc'),
  },
];
