import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import {
  artifacts,
  changeRequests,
  completions,
  counsellorTodos,
  db,
  gaps,
  reports,
  sessions,
  tasks,
} from '@wgc/db';

export type QueryPlan = {
  queries: PlannedQuery[];
  needsClarification?: string;
};

export type PlannedEntity =
  | 'tasks'
  | 'completions'
  | 'artifacts'
  | 'sessions'
  | 'reports'
  | 'change_requests'
  | 'counsellor_todos'
  | 'gaps';

export type PlannedQuery = {
  entity: PlannedEntity;
  timeRange?: { from?: string; to?: string };
  subjects?: string[];
  statuses?: string[];
  limit?: number;
};

const MAX_ROWS_PER_ENTITY = 100;

/**
 * Execute a planned-retrieval batch against Postgres. The plan is whatever
 * the query-planner LLM produced; we treat it as untrusted hints (whitelist
 * entities, cap row counts) so a malformed plan can never escalate.
 *
 * `counsellorId`, when provided, scopes `counsellor_todos` to that counsellor
 * as well as the student — defense-in-depth so the assistant can never read
 * another counsellor's todos.
 */
export async function executePlan(
  studentId: string,
  plan: QueryPlan,
  counsellorId?: string,
): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const q of plan.queries.slice(0, 8)) {
    const limit = Math.min(q.limit ?? 50, MAX_ROWS_PER_ENTITY);
    const fromDate = q.timeRange?.from ? parseRelative(q.timeRange.from) : null;
    const toDate = q.timeRange?.to && q.timeRange.to !== 'now' ? parseRelative(q.timeRange.to) : null;

    if (q.entity === 'tasks') {
      const conds = [eq(tasks.studentId, studentId)];
      if (fromDate) conds.push(gte(tasks.scheduledStart, fromDate));
      if (toDate) conds.push(lte(tasks.scheduledStart, toDate));
      if (q.subjects?.length) conds.push(inArray(tasks.subject, q.subjects));
      if (q.statuses?.length) conds.push(inArray(tasks.status, q.statuses));
      out['tasks'] = await db
        .select({
          id: tasks.id,
          scheduled_start: tasks.scheduledStart,
          scheduled_end: tasks.scheduledEnd,
          subject: tasks.subject,
          task_title: tasks.taskTitle,
          status: tasks.status,
        })
        .from(tasks)
        .where(and(...conds))
        .orderBy(desc(tasks.scheduledStart))
        .limit(limit);
    } else if (q.entity === 'completions') {
      const conds = [eq(tasks.studentId, studentId)];
      if (fromDate) conds.push(gte(completions.submittedAt, fromDate));
      if (toDate) conds.push(lte(completions.submittedAt, toDate));
      if (q.subjects?.length) conds.push(inArray(tasks.subject, q.subjects));
      if (q.statuses?.length) conds.push(inArray(completions.statusClaimed, q.statuses));
      out['completions'] = await db
        .select({
          id: completions.id,
          task_id: completions.taskId,
          submitted_at: completions.submittedAt,
          status_claimed: completions.statusClaimed,
          notes_text: completions.notesText,
          time_taken_minutes: completions.timeTakenMinutes,
          subject: tasks.subject,
          task_title: tasks.taskTitle,
        })
        .from(completions)
        .innerJoin(tasks, eq(tasks.id, completions.taskId))
        .where(and(...conds))
        .orderBy(desc(completions.submittedAt))
        .limit(limit);
    } else if (q.entity === 'artifacts') {
      const conds = [eq(artifacts.studentId, studentId)];
      if (fromDate) conds.push(gte(artifacts.uploadedAt, fromDate));
      if (toDate) conds.push(lte(artifacts.uploadedAt, toDate));
      out['artifacts'] = await db
        .select({
          id: artifacts.id,
          task_id: artifacts.taskId,
          file_type: artifacts.fileType,
          original_filename: artifacts.originalFilename,
          uploaded_at: artifacts.uploadedAt,
        })
        .from(artifacts)
        .where(and(...conds))
        .orderBy(desc(artifacts.uploadedAt))
        .limit(limit);
    } else if (q.entity === 'sessions') {
      const conds = [eq(sessions.studentId, studentId)];
      if (fromDate) conds.push(gte(sessions.scheduledAt, fromDate));
      if (toDate) conds.push(lte(sessions.scheduledAt, toDate));
      if (q.statuses?.length) conds.push(inArray(sessions.status, q.statuses));
      out['sessions'] = await db
        .select({
          id: sessions.id,
          scheduled_at: sessions.scheduledAt,
          status: sessions.status,
          duration_minutes: sessions.durationMinutes,
          spinach_summary_text: sessions.spinachSummaryText,
        })
        .from(sessions)
        .where(and(...conds))
        .orderBy(desc(sessions.scheduledAt))
        .limit(limit);
    } else if (q.entity === 'reports') {
      const conds = [eq(reports.studentId, studentId)];
      out['reports'] = await db
        .select({
          id: reports.id,
          type: reports.type,
          period_start: reports.periodStart,
          period_end: reports.periodEnd,
          status: reports.status,
        })
        .from(reports)
        .where(and(...conds))
        .orderBy(desc(reports.periodStart))
        .limit(limit);
    } else if (q.entity === 'change_requests') {
      const conds = [eq(changeRequests.studentId, studentId)];
      if (fromDate) conds.push(gte(changeRequests.requestedAt, fromDate));
      if (q.statuses?.length) conds.push(inArray(changeRequests.status, q.statuses));
      out['change_requests'] = await db
        .select({
          id: changeRequests.id,
          original_task_id: changeRequests.originalTaskId,
          proposed_change: changeRequests.proposedChange,
          reason: changeRequests.reason,
          status: changeRequests.status,
          requested_at: changeRequests.requestedAt,
        })
        .from(changeRequests)
        .where(and(...conds))
        .orderBy(desc(changeRequests.requestedAt))
        .limit(limit);
    } else if (q.entity === 'counsellor_todos') {
      // The counsellor's own follow-up items for this student. Scoped to
      // both student AND counsellor when counsellorId is supplied.
      const conds = [eq(counsellorTodos.studentId, studentId)];
      if (counsellorId) conds.push(eq(counsellorTodos.counsellorId, counsellorId));
      if (fromDate) conds.push(gte(counsellorTodos.createdAt, fromDate));
      if (toDate) conds.push(lte(counsellorTodos.createdAt, toDate));
      if (q.statuses?.length) conds.push(inArray(counsellorTodos.status, q.statuses));
      out['counsellor_todos'] = await db
        .select({
          id: counsellorTodos.id,
          description: counsellorTodos.description,
          status: counsellorTodos.status,
          due_date: counsellorTodos.dueDate,
          source_session_id: counsellorTodos.sourceSessionId,
          completed_at: counsellorTodos.completedAt,
          created_at: counsellorTodos.createdAt,
        })
        .from(counsellorTodos)
        .where(and(...conds))
        .orderBy(desc(counsellorTodos.createdAt))
        .limit(limit);
    } else if (q.entity === 'gaps') {
      // Learning gaps flagged for this student (by category/subject/priority).
      const conds = [eq(gaps.studentId, studentId)];
      if (q.subjects?.length) conds.push(inArray(gaps.subject, q.subjects));
      if (q.statuses?.length) conds.push(inArray(gaps.status, q.statuses));
      out['gaps'] = await db
        .select({
          id: gaps.id,
          category: gaps.category,
          subject: gaps.subject,
          description: gaps.description,
          priority: gaps.priority,
          status: gaps.status,
          identified_via: gaps.identifiedVia,
          target_resolution_date: gaps.targetResolutionDate,
          addressed_at: gaps.addressedAt,
          created_at: gaps.createdAt,
        })
        .from(gaps)
        .where(and(...conds))
        .orderBy(desc(gaps.createdAt))
        .limit(limit);
    }
  }
  return out;
}

function parseRelative(input: string): Date | null {
  // Accept ISO dates and a few relative forms like "7 days ago", "now",
  // "start of today". Anything else returns null and the caller skips it.
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed === 'now') return new Date();
  const iso = new Date(trimmed);
  if (!Number.isNaN(iso.getTime())) return iso;
  const m = trimmed.match(/^(\d+)\s*(hour|hours|day|days|week|weeks)\s*ago$/i);
  if (m) {
    const n = parseInt(m[1]!, 10);
    const unit = m[2]!.toLowerCase();
    const ms =
      unit.startsWith('hour') ? n * 3_600_000 : unit.startsWith('day') ? n * 86_400_000 : n * 7 * 86_400_000;
    return new Date(Date.now() - ms);
  }
  if (/^start of today$/i.test(trimmed)) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  return null;
}
