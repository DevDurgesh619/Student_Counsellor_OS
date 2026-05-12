'use client';

import { getBrowserSupabase } from './supabase';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8787';

export class ApiError extends Error {
  public readonly status: number;
  public readonly code?: string;
  public readonly details?: Record<string, unknown>;
  constructor(params: { status: number; code?: string; message: string; details?: Record<string, unknown> }) {
    super(params.message);
    this.name = 'ApiError';
    this.status = params.status;
    this.code = params.code;
    this.details = params.details;
  }
}

async function authHeader(): Promise<string | undefined> {
  const supabase = getBrowserSupabase();
  let { data } = await supabase.auth.getSession();
  if (!data.session) {
    // Defensive single retry. Cookie-backed sessions are normally instant,
    // but immediately after navigation the SDK may still be hydrating.
    await new Promise((r) => setTimeout(r, 50));
    ({ data } = await supabase.auth.getSession());
    if (!data.session) return undefined;
  }
  return `Bearer ${data.session.access_token}`;
}

type RequestOpts = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  idempotencyKey?: string;
};

export async function api<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const url = new URL(path, API_BASE);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = await authHeader();
  if (auth) headers['Authorization'] = auth;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  const res = await fetch(url.toString(), {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'include',
  });

  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const envelope = json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null;
    throw new ApiError({
      status: res.status,
      code: envelope?.error?.code,
      message: envelope?.error?.message ?? res.statusText,
      details: envelope?.error?.details,
    });
  }
  return json as T;
}

// Domain helpers — thin typed wrappers so call sites read cleanly.

export type StudentOverview = {
  studentId: string;
  name: string;
  grade: string;
  lastActivity: string | null;
  today: {
    scheduled: number;
    done: number;
    partial: number;
    skipped: number;
    couldntDo: number;
    cancelled: number;
    rescheduled: number;
  };
  pendingReviewItems: number;
  healthIndicator: 'green' | 'yellow' | 'red' | 'unknown';
};

export const counsellorApi = {
  me: () => api<unknown>('/api/counsellor/me'),
  studentsOverview: () =>
    api<{ data: StudentOverview[] }>('/api/counsellor/students-overview'),
  student: (id: string) => api<unknown>(`/api/counsellor/students/${id}`),
  studentTasks: (id: string, q: { start?: string; end?: string } = {}) =>
    api<{ data: unknown[] }>(`/api/tasks`, { query: { studentId: id, ...q } }),
  studentArtifacts: (id: string) =>
    api<{ data: unknown[] }>(`/api/students/${id}/artifacts`),
  studentSessions: (id: string) =>
    api<{ data: unknown[] }>(`/api/counsellor/students/${id}/sessions`),
  studentChangeRequests: (id: string, status?: string) =>
    api<{ data: unknown[] }>(`/api/counsellor/students/${id}/change-requests`, {
      query: { status },
    }),
  queue: (status?: string) =>
    api<{ data: unknown[] }>('/api/counsellor/queue', { query: { status } }),
  resolveQueueItem: (id: string, body: { status?: 'resolved' | 'dismissed'; resolutionNotes?: string }) =>
    api<unknown>(`/api/counsellor/queue/${id}/resolve`, { method: 'PATCH', body }),
  decideChangeRequest: (id: string, body: { decision: 'approved' | 'rejected'; counsellorNotes?: string }) =>
    api<unknown>(`/api/counsellor/change-requests/${id}/decision`, {
      method: 'POST',
      body,
      idempotencyKey: crypto.randomUUID(),
    }),
  createSession: (studentId: string, body: unknown) =>
    api<unknown>(`/api/counsellor/students/${studentId}/sessions`, {
      method: 'POST',
      body,
      idempotencyKey: crypto.randomUUID(),
    }),
  patchSettings: (body: unknown) =>
    api<unknown>('/api/counsellor/settings', { method: 'PATCH', body }),
  bulkTasks: (body: unknown) =>
    api<unknown>('/api/counsellor/tasks/bulk', {
      method: 'POST',
      body,
      idempotencyKey: crypto.randomUUID(),
    }),
  createRecurringTasks: (body: unknown) =>
    api<unknown>('/api/counsellor/tasks/recurring', {
      method: 'POST',
      body,
      idempotencyKey: crypto.randomUUID(),
    }),

  // ── Phase 6 — sessions, briefs, gaps, todos
  session: (sessionId: string) =>
    api<{ data: SessionRow }>(`/api/counsellor/sessions/${sessionId}`),
  sessionExtraction: (sessionId: string) =>
    api<{ data: SessionExtractionRow | null }>(
      `/api/counsellor/sessions/${sessionId}/extraction`,
    ),
  sessionDraftTasks: (sessionId: string) =>
    api<{ data: DraftTaskRow[] }>(`/api/counsellor/sessions/${sessionId}/draft-tasks`),
  runSessionPipeline: (sessionId: string) =>
    api<{ data: { extractionId: string; passABriefId: string | null; draftTaskCount: number; worker4Ran: boolean } }>(
      `/api/counsellor/sessions/${sessionId}/run-pipeline`,
      { method: 'POST', idempotencyKey: crypto.randomUUID() },
    ),
  bulkDecideDraftTasks: (
    body: {
      decisions: Array<{
        taskId: string;
        action: 'approve' | 'reject' | 'edit';
        edits?: Partial<{
          scheduledStart: string;
          scheduledEnd: string;
          taskTitle: string;
          taskDescription: string | null;
          subject: string;
          flexibility: 'fixed' | 'preferred' | 'flexible';
        }>;
        notes?: string;
      }>;
    },
  ) =>
    api<{ data: { approved: number; rejected: number } }>(
      '/api/counsellor/draft-tasks/bulk-decision',
      { method: 'POST', body, idempotencyKey: crypto.randomUUID() },
    ),
  upcomingBrief: (studentId: string) =>
    api<{ data: MeetingPrepBriefRow | null; session?: SessionRow }>(
      `/api/counsellor/students/${studentId}/upcoming-session-brief`,
    ),
  patchBrief: (briefId: string, body: { finalContent: string; markReviewed?: boolean }) =>
    api<unknown>(`/api/counsellor/upcoming-session-brief/${briefId}`, {
      method: 'PATCH',
      body,
    }),
  studentGaps: (studentId: string) =>
    api<{ data: GapRow[] }>(`/api/counsellor/students/${studentId}/gaps`),
  createGap: (
    studentId: string,
    body: {
      category: 'content' | 'skill' | 'habit';
      subject?: string | null;
      description: string;
      priority?: 'low' | 'medium' | 'high';
      targetResolutionDate?: string | null;
    },
  ) =>
    api<{ data: GapRow }>(`/api/counsellor/students/${studentId}/gaps`, {
      method: 'POST',
      body,
    }),
  patchGap: (
    gapId: string,
    body: Partial<{
      status: 'active' | 'addressed' | 'archived';
      priority: 'low' | 'medium' | 'high';
      description: string;
      subject: string | null;
      targetResolutionDate: string | null;
    }>,
  ) => api<unknown>(`/api/counsellor/gaps/${gapId}`, { method: 'PATCH', body }),
  todos: () => api<{ data: CounsellorTodoRow[] }>('/api/counsellor/todos'),
  patchTodo: (id: string, body: { status: 'pending' | 'completed' | 'cancelled' }) =>
    api<unknown>(`/api/counsellor/todos/${id}`, { method: 'PATCH', body }),

  // ── Spinach MCP integration
  spinachStatus: () =>
    api<{ data: { state: 'disconnected' | 'pending' | 'connected'; lastSyncedAt: string | null } }>(
      '/api/counsellor/spinach/status',
    ),
  spinachSetupUrl: () => api<{ url: string }>('/api/counsellor/spinach/setup-url'),
  disconnectSpinach: () => api<unknown>('/api/counsellor/spinach', { method: 'DELETE' }),
  pollSpinachNow: () =>
    api<{
      data: {
        meetingsFetched: number;
        sessionsCreated: number;
        unassigned: number;
      };
    }>('/api/counsellor/spinach/poll-now', { method: 'POST' }),
  spinachInboxList: (status: 'unassigned' | 'linked' | 'ignored' = 'unassigned') =>
    api<{ data: SpinachInboxRow[] }>('/api/counsellor/spinach/inbox', { query: { status } }),
  spinachInboxOne: (id: string) =>
    api<{ data: SpinachInboxRow }>(`/api/counsellor/spinach/inbox/${id}`),
  assignSpinachMeeting: (id: string, studentId: string) =>
    api<{ data: { sessionId: string } }>(`/api/counsellor/spinach/inbox/${id}/assign`, {
      method: 'POST',
      body: { studentId },
    }),
  ignoreSpinachMeeting: (id: string) =>
    api<unknown>(`/api/counsellor/spinach/inbox/${id}/ignore`, { method: 'POST' }),
};

export type SpinachInboxRow = {
  id: string;
  counsellorId: string;
  spinachMeetingId: string;
  fetchedAt: string;
  scheduledAt: string | null;
  title: string | null;
  attendees: Array<{ name?: string; email?: string; internal?: boolean }>;
  raw: Record<string, unknown> | null;
  status: 'unassigned' | 'linked' | 'ignored';
  linkedSessionId: string | null;
};

export type SessionRow = {
  id: string;
  studentId: string;
  counsellorId: string;
  scheduledAt: string;
  actualStartedAt: string | null;
  durationMinutes: number | null;
  transcriptText: string | null;
  spinachSummaryText: string | null;
  status: string;
  structuredExtractionId: string | null;
  agendaUsedId: string | null;
};

export type SessionExtractionRow = {
  id: string;
  sessionId: string;
  topicsDiscussed: string[];
  actionItems: Array<{
    owner: 'student' | 'counsellor' | 'unclear';
    description: string;
    due?: string | null;
    subject?: string | null;
  }>;
  scheduleChangesDiscussed: boolean;
  scheduleChanges: Array<{
    type: 'add' | 'remove' | 'edit' | 'move';
    what: string;
    when?: string | null;
    duration?: string | null;
    notes?: string | null;
  }>;
  concernsRaised: Array<{ raised_by: string; concern: string; context?: string | null }>;
  decisionsMade: string[];
  openQuestions: string[];
  confidence: 'low' | 'normal' | 'high';
  createdAt: string;
};

export type DraftTaskRow = {
  id: string;
  studentId: string;
  scheduledStart: string;
  scheduledEnd: string;
  subject: string;
  taskTitle: string;
  taskDescription: string | null;
  status: string;
  source: string;
  generatedFromSessionId: string | null;
  flexibility: string;
};

export type MeetingPrepBriefRow = {
  id: string;
  targetSessionId: string;
  passAContent: string | null;
  passAGeneratedAt: string | null;
  passBContent: string | null;
  passBGeneratedAt: string | null;
  finalContent: string | null;
  counsellorEditedAt: string | null;
  status: 'pass_a_only' | 'pass_b_ready' | 'reviewed' | 'archived';
  createdAt: string;
  updatedAt: string;
};

export type GapRow = {
  id: string;
  studentId: string;
  category: 'content' | 'skill' | 'habit';
  subject: string | null;
  description: string;
  priority: 'low' | 'medium' | 'high';
  status: 'active' | 'addressed' | 'archived';
  identifiedVia: string;
  identifiedInSessionId: string | null;
  targetResolutionDate: string | null;
  addressedAt: string | null;
  createdAt: string;
};

export type CounsellorTodoRow = {
  id: string;
  counsellorId: string;
  studentId: string | null;
  description: string;
  sourceSessionId: string | null;
  dueDate: string | null;
  status: 'pending' | 'completed' | 'cancelled';
  completedAt: string | null;
  createdAt: string;
};

export type ProfileDraft = {
  id: string;
  counsellorId: string | null;
  studentId: string | null;
  /** Plaintext token never leaves the API. Counsellor sees URL once at generation. */
  onboardingTokenExpiresAt: string | null;
  onboardingTokenUsedAt: string | null;
  formResponses: Record<string, unknown> | null;
  marksheetArtifacts: string[];
  profile: Record<string, unknown> | null;
  flagsForCounsellor: unknown[];
  status: 'awaiting_form' | 'pending_review' | 'approved' | 'regenerated' | 'rejected';
  createdAt: string;
};

export type ApproveResult = {
  ok: true;
  studentId: string;
  invite:
    | { sent: true; via: 'postmark'; messageId?: string }
    | { sent: false; reason: 'postmark_not_configured'; manualUrl: string }
    | { sent: false; reason: string; error?: string };
};

export const onboardingApi = {
  drafts: (status?: string) =>
    api<{ data: ProfileDraft[] }>('/api/counsellor/profile-drafts', { query: { status } }),
  draft: (id: string) => api<ProfileDraft>(`/api/counsellor/profile-drafts/${id}`),
  edit: (id: string, profile: Record<string, unknown>) =>
    api<ProfileDraft>(`/api/counsellor/profile-drafts/${id}/edit`, {
      method: 'POST',
      body: { profile },
    }),
  approve: (id: string) =>
    api<{ ok: true; studentId: string }>(`/api/counsellor/profile-drafts/${id}/approve`, {
      method: 'POST',
      body: {},
      idempotencyKey: crypto.randomUUID(),
    }),
  regenerate: (id: string, notes?: string) =>
    api<ProfileDraft>(`/api/counsellor/profile-drafts/${id}/regenerate`, {
      method: 'POST',
      body: { notes },
      idempotencyKey: crypto.randomUUID(),
    }),
  reject: (id: string) =>
    api<ProfileDraft>(`/api/counsellor/profile-drafts/${id}/reject`, { method: 'POST' }),
  /**
   * Light approval-list mode: archives a student that signed up with Google
   * but the counsellor doesn't recognise. They lose dashboard access on next
   * sign-in.
   */
  ignoreStudent: (studentId: string) =>
    api<{ ok: true }>(`/api/counsellor/students/${studentId}/ignore`, {
      method: 'POST',
      body: {},
    }),
};

export type AssistantConversation = {
  id: string;
  counsellorId: string;
  studentId: string | null;
  startedAt: string;
  title: string | null;
};
export type AssistantMessage = {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Array<{ entity: string; id: string; label?: string }>;
  createdAt: string;
};

export const assistantApi = {
  start: (studentId?: string) =>
    api<AssistantConversation>('/api/counsellor/assistant/conversations', {
      method: 'POST',
      body: { studentId },
    }),
  list: (studentId?: string) =>
    api<{ data: AssistantConversation[] }>('/api/counsellor/assistant/conversations', {
      query: { studentId },
    }),
  history: (id: string) =>
    api<{ conversation: AssistantConversation; messages: AssistantMessage[] }>(
      `/api/counsellor/assistant/conversations/${id}`,
    ),
  send: (id: string, content: string) =>
    api<{
      userMessageId: string;
      assistantMessage?: AssistantMessage;
      error?: string;
      rawResponse?: string | null;
    }>(`/api/counsellor/assistant/conversations/${id}/messages`, {
      method: 'POST',
      body: { content },
    }),
  delete: (id: string) =>
    api<{ ok: true }>(`/api/counsellor/assistant/conversations/${id}`, { method: 'DELETE' }),
};

export type CalendarHealth = {
  status: 'healthy' | 'degraded' | 'failing' | 'auth_required' | 'not_setup';
  lastSyncAt: string | null;
  errorsLast24h: number;
  tokenExpiringInDays: number | null;
  calendarId: string | null;
};

export const calendarApi = {
  setupUrl: (studentId: string) =>
    api<{ url: string }>(`/api/counsellor/students/${studentId}/calendar/setup-url`),
  health: (studentId: string) =>
    api<CalendarHealth>(`/api/counsellor/students/${studentId}/calendar-health`),
  resync: (studentId: string) =>
    api<{ enqueued: number }>(`/api/counsellor/students/${studentId}/calendar/resync`, {
      method: 'POST',
    }),
};

export type Role = 'counsellor' | 'student';
export type StudentState = 'pending_onboarding' | 'pending_review' | 'active' | 'archived';
export type MeResponse = {
  role: Role;
  /** Counsellors are always 'active'. For students this drives post-login routing. */
  state?: StudentState | 'active';
  profile: Record<string, unknown> & { id: string; fullName?: string; email?: string };
};

export const meApi = {
  me: () => api<MeResponse>('/api/me'),
};

/** Student-side onboarding API (authenticated). */
export const myOnboardingApi = {
  current: () =>
    api<{ data: { id: string; formResponses: Record<string, unknown> | null; status: string } | null }>(
      '/api/me/onboarding',
    ),
  autosave: (formResponses: Record<string, unknown>) =>
    api<unknown>('/api/me/onboarding/autosave', {
      method: 'POST',
      body: formResponses,
    }),
  submit: (formResponses: Record<string, unknown>) =>
    api<{ ok: true; draftId: string }>('/api/me/onboarding/submit', {
      method: 'POST',
      body: formResponses,
    }),
  signedUploadUrl: (body: { filename: string; contentType: string; sizeBytes: number }) =>
    api<{ uploadUrl: string; storagePath: string; bucket: string; token: string }>(
      '/api/me/onboarding/upload-marksheet',
      { method: 'POST', body },
    ),
};

export type StudentTask = {
  id: string;
  studentId: string;
  scheduledStart: string;
  scheduledEnd: string;
  subject: string;
  taskTitle: string;
  taskDescription: string | null;
  expectedOutput: string | null;
  status: string;
  flexibility: string;
};

export const studentApi = {
  tasks: (q: { date?: string; startDate?: string; endDate?: string }) =>
    api<{ data: StudentTask[] }>('/api/me/tasks', { query: q }),
  task: (id: string) =>
    api<{
      task: StudentTask;
      completions: Array<Record<string, unknown> & { id: string; submittedAt: string; statusClaimed: string; notesText: string | null; timeTakenMinutes: number | null }>;
      artifacts: Array<Record<string, unknown> & { id: string; fileType: string; originalFilename: string | null; uploadedAt: string }>;
    }>(`/api/me/tasks/${id}`),
  submitCompletion: (
    taskId: string,
    body: { statusClaimed: 'done' | 'partial' | 'skipped' | 'couldnt_do'; notesText?: string; timeTakenMinutes?: number },
  ) =>
    api<unknown>(`/api/me/tasks/${taskId}/completions`, {
      method: 'POST',
      body,
      idempotencyKey: crypto.randomUUID(),
    }),
  getUploadUrl: (body: { filename: string; contentType: string; sizeBytes: number }) =>
    api<{ uploadUrl: string; storagePath: string; bucket: string; token: string }>(
      '/api/me/artifacts/upload-url',
      { method: 'POST', body, idempotencyKey: crypto.randomUUID() },
    ),
  confirmArtifact: (body: {
    taskId?: string;
    fileUrl: string;
    fileType: string;
    fileSizeBytes: number;
    originalFilename?: string;
  }) =>
    api<unknown>('/api/me/artifacts', {
      method: 'POST',
      body,
      idempotencyKey: crypto.randomUUID(),
    }),
  artifacts: () => api<{ data: Array<Record<string, unknown> & { id: string; fileType: string; originalFilename: string | null; uploadedAt: string; taskId: string | null }> }>('/api/me/artifacts'),
  changeRequests: () => api<{ data: Array<Record<string, unknown> & { id: string; proposedChange: string; reason: string; status: string; counsellorNotes: string | null; requestedAt: string; decidedAt: string | null }> }>('/api/me/change-requests'),
  submitChangeRequest: (body: { originalTaskId?: string; patternDescription?: string; proposedChange: string; reason: string }) =>
    api<unknown>('/api/me/change-requests', {
      method: 'POST',
      body,
      idempotencyKey: crypto.randomUUID(),
    }),
  reports: () => api<{ data: Array<Record<string, unknown> & { id: string; type: string; periodStart: string; periodEnd: string; reviewedContent: string | null; publishedAt: string | null }> }>('/api/me/reports'),
  report: (id: string) => api<Record<string, unknown> & { id: string; reviewedContent: string | null }>(`/api/me/reports/${id}`),
  patchSettings: (body: { languagePreferences?: { primary: string; secondary?: string[] }; optOuts?: Record<string, boolean>; timezone?: string }) =>
    api<unknown>('/api/me/settings', { method: 'PATCH', body }),
};

export const taskApi = {
  create: (body: unknown) =>
    api<unknown>('/api/tasks', { method: 'POST', body, idempotencyKey: crypto.randomUUID() }),
  patch: (id: string, body: unknown) =>
    api<unknown>(`/api/tasks/${id}`, { method: 'PATCH', body }),
  reschedule: (id: string, body: unknown) =>
    api<unknown>(`/api/tasks/${id}/reschedule`, {
      method: 'POST',
      body,
      idempotencyKey: crypto.randomUUID(),
    }),
  cancel: (id: string) => api<unknown>(`/api/tasks/${id}`, { method: 'DELETE' }),
};
