import { z } from 'zod';

export const TASK_STATUSES = [
  'scheduled',
  'active',
  'completed',
  'skipped',
  'couldnt_do',
  'cancelled',
  'rescheduled',
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const COMPLETION_STATUSES_CLAIMED = ['done', 'partial', 'skipped', 'couldnt_do'] as const;
export const CompletionStatusClaimedSchema = z.enum(COMPLETION_STATUSES_CLAIMED);
export type CompletionStatusClaimed = z.infer<typeof CompletionStatusClaimedSchema>;

export const COMPLETION_STATUSES_VERIFIED = [
  'claimed_only',
  'evidence_submitted',
  'counsellor_verified',
] as const;
export const CompletionStatusVerifiedSchema = z.enum(COMPLETION_STATUSES_VERIFIED);
export type CompletionStatusVerified = z.infer<typeof CompletionStatusVerifiedSchema>;

export const TASK_FLEXIBILITY = ['fixed', 'preferred', 'flexible'] as const;
export const TaskFlexibilitySchema = z.enum(TASK_FLEXIBILITY);
export type TaskFlexibility = z.infer<typeof TaskFlexibilitySchema>;

export const TASK_SOURCES = [
  'counsellor_manual',
  'ai_drafted_from_session',
  'ai_drafted_from_weekly_review',
  'student_request',
] as const;
export const TaskSourceSchema = z.enum(TASK_SOURCES);
export type TaskSource = z.infer<typeof TaskSourceSchema>;
