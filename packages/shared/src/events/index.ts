import { z } from 'zod';

/**
 * Canonical v1 event taxonomy. Source of truth: CLAUDE_CODE.md §11.
 *
 * Cadence-bearing events (e.g. `report.cron.triggered`) carry the cadence in
 * the payload, NOT in the event name (resolved in clarifications.md Q3).
 *
 * v2 prefixes (`whatsapp.*`, `pattern_detector.*`, `pillar.*`) are FORBIDDEN
 * in v1 code — see {@link assertNoV2Prefix}.
 */
export const EVENT_TYPES_V1 = [
  'student.onboarding.submitted',
  'session.spinach.processed',
  'session.extraction.completed',
  'schedule.task.created',
  'schedule.task.cancelled',
  'assessment.submitted',
  'assessment.graded',
  'report.cron.triggered',
  'schedule.cron.session_24h_before',
  'schedule.cron.assessment_friday',
  'calendar.webhook.received',
  'counsellor.queue.item_resolved',
  'counsellor.review.approved',
] as const;

export const EventTypeSchema = z.enum(EVENT_TYPES_V1);
export type EventType = z.infer<typeof EventTypeSchema>;

const FORBIDDEN_V2_PREFIXES = ['whatsapp.', 'pattern_detector.', 'pillar.'] as const;

/**
 * Throws if the given event type starts with a v2-reserved prefix. Call this
 * inside any code path that emits or subscribes to events to catch accidental
 * scope creep at runtime, complementing the {@link EventTypeSchema} compile-time
 * check.
 */
export function assertNoV2Prefix(eventType: string): void {
  for (const prefix of FORBIDDEN_V2_PREFIXES) {
    if (eventType.startsWith(prefix)) {
      throw new Error(
        `Event prefix "${prefix}" is reserved for a deferred v2 phase ` +
          `and is forbidden in v1 code. See CLAUDE_CODE.md §11.`,
      );
    }
  }
}

// Cadence enum used in `report.cron.triggered` payloads.
export const REPORT_CADENCES = ['weekly', 'monthly', 'quarterly'] as const;
export const ReportCadenceSchema = z.enum(REPORT_CADENCES);
export type ReportCadence = z.infer<typeof ReportCadenceSchema>;
