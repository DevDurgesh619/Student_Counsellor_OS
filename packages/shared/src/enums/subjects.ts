import { z } from 'zod';

/**
 * Subject enum, enforced in app code (not at DB level for flexibility).
 * Source of truth: docs/phases/phase-1-foundation.md "Subject enum".
 */
export const SUBJECTS = [
  'Math',
  'Physics',
  'Chemistry',
  'Biology',
  'English',
  'Hindi',
  'Economics',
  'Business',
  'Reading',
  'Vocabulary',
  'Revision',
  'Test',
  'Tuition',
  'Counselling Session',
  'Assessment',
  'Sleep',
  'Meal',
  'Free',
  'Family',
  'Other',
] as const;

export const SubjectSchema = z.enum(SUBJECTS);
export type Subject = z.infer<typeof SubjectSchema>;

/**
 * Subjects that do NOT sync to Google Calendar (Phase 4).
 * Per docs/phases/phase-4-calendar-sync.md and CLAUDE_CODE.md §12.
 */
export const NON_SYNCING_SUBJECTS: ReadonlySet<Subject> = new Set<Subject>([
  'Sleep',
  'Meal',
  'Free',
  'Family',
  'Other',
]);

export function shouldSyncToCalendar(subject: Subject): boolean {
  return !NON_SYNCING_SUBJECTS.has(subject);
}

/**
 * Google Calendar colorId mapping per subject (Phase 4).
 * Color IDs reference Calendar API's `events.colorId` palette (1–11).
 */
export const SUBJECT_CALENDAR_COLOR: Record<Subject, string> = {
  Math: '9', // blueberry
  Physics: '3', // grape
  Chemistry: '6', // tangerine
  Biology: '10', // basil
  English: '5', // banana
  Hindi: '11', // tomato
  Economics: '1', // lavender
  Business: '2', // sage
  Reading: '8', // graphite
  Vocabulary: '4', // flamingo
  Revision: '7', // peacock
  Test: '11', // tomato
  Tuition: '7',
  'Counselling Session': '1',
  Assessment: '11',
  Sleep: '8',
  Meal: '8',
  Free: '8',
  Family: '8',
  Other: '8',
};
