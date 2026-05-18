// Layer 1 — core entities (CLAUDE_CODE.md §8)
export * from './counsellors.js';
export * from './students.js';
// recurrence-groups + timetable-changes ordered before tasks because tasks.ts
// imports them for FK column refs.
export * from './timetable-changes.js';
export * from './recurrence-groups.js';
export * from './timetable-conversations.js';
export * from './tasks.js';
export * from './completions.js';
export * from './artifacts.js';
export * from './conversations.js';
export * from './sessions.js';
export * from './assessments.js';
export * from './submissions.js';
export * from './reports.js';
export * from './plans.js';
export * from './change-requests.js';
export * from './review-queue.js';

// Layer 2 — interpretive (Phase 5+)
export * from './student-profile-drafts.js';
export * from './assistant.js';
export * from './session-pipeline.js';
export * from './spinach-inbox.js';
export * from './student-history.js';

// Operational tables (CLAUDE_CODE.md §8)
export * from './sync-outbox.js';
export * from './calendar-watch-channels.js';
export * from './events.js';
export * from './ai-calls.js';
export * from './transcriptions.js';
export * from './idempotency-records.js';
export * from './errors.js';
