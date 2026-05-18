import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, gte, isNull, lt } from 'drizzle-orm';
import {
  db,
  recurrenceGroups,
  students,
  tasks,
  timetableChanges,
  timetableConversations,
  timetableMessages,
  type TimetableConversation,
  type TimetableOp,
} from '@wgc/db';
import { Errors } from '@wgc/shared';
import { AIClient } from '@wgc/ai';
import type { AppEnv } from '../app.js';
import { requireRole } from '../middleware/auth.js';
import {
  applyChange,
  revertChange,
  summarizeChange,
  validateOperations,
} from '../lib/timetable-engine.js';
import { OperationSchema } from '../lib/timetable-op-schemas.js';
import { loadOnboardingProfile } from '../lib/onboarding-profile.js';
import { getCurrentRollingSummary } from '../lib/student-history.js';
import { logger } from '../logger.js';

export const timetableEditorRoutes = new Hono<AppEnv>();

// ─── Conversations ──────────────────────────────────────────────────────────

timetableEditorRoutes.post('/students/:id/timetable/conversations', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.param('id');
  await assertOwns(auth.subjectId, studentId);
  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    isBootstrap?: boolean;
  };
  const inserted = await db
    .insert(timetableConversations)
    .values({
      counsellorId: auth.subjectId,
      studentId,
      title: body.title ?? null,
      isBootstrap: body.isBootstrap ?? false,
    })
    .returning();
  return c.json(inserted[0], 201);
});

timetableEditorRoutes.get('/students/:id/timetable/conversations', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.param('id');
  await assertOwns(auth.subjectId, studentId);
  const rows = await db
    .select()
    .from(timetableConversations)
    .where(
      and(
        eq(timetableConversations.counsellorId, auth.subjectId),
        eq(timetableConversations.studentId, studentId),
      ),
    )
    .orderBy(desc(timetableConversations.startedAt))
    .limit(50);
  return c.json({ data: rows });
});

timetableEditorRoutes.get('/timetable/conversations/:cid/messages', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const cid = c.req.param('cid');
  const conv = await loadOwnedConversation(auth.subjectId, cid);
  const messages = await db
    .select()
    .from(timetableMessages)
    .where(eq(timetableMessages.conversationId, cid))
    .orderBy(asc(timetableMessages.createdAt));
  return c.json({ conversation: conv, messages });
});

// ─── Chat turn ──────────────────────────────────────────────────────────────

const PostSchema = z.object({
  content: z.string().min(1).max(8000),
  // Optional image attachments — base64-encoded, no data: URL prefix.
  // Sent to Claude as vision content blocks alongside the prompt text.
  // Cap at 4 images per turn and ~5MB each to stay under Anthropic's
  // request-size limit; enforced as a string-length budget below.
  images: z
    .array(
      z.object({
        mediaType: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
        data: z.string().min(1),
      }),
    )
    .max(4)
    .optional(),
});

export type EditorImage = z.infer<typeof PostSchema>['images'];

// Per-op payload schemas live in ../lib/timetable-op-schemas.ts so the
// meeting-extraction pipeline (worker_4_timetable_drafter) uses the exact
// same shape this editor expects. Validation happens here BEFORE the
// change row is persisted, so a malformed payload from the LLM surfaces
// as a clarification prompt rather than producing zero occurrences on
// apply.

const EditorResponseSchema = z.object({
  message: z.string(),
  rationale: z.string().nullable().optional(),
  proposed_operations: z.array(OperationSchema).nullable().optional(),
  needs_clarification: z.string().nullable().optional(),
});

/**
 * Persist a counsellor turn, call Worker 4b, persist the assistant reply,
 * and (when the worker proposes operations) write a draft timetable_changes
 * row. Returns the persisted records so callers can echo them to the
 * client. Shared between the interactive chat endpoint and the
 * "open-in-editor" request-handoff path.
 *
 * If the conversation carries `seedRequestId`, every draft generated in
 * the conversation is stamped `source='change_request' +
 * sourceRequestId=seedRequestId`. That keeps the audit chain intact even
 * if the counsellor asks the editor for several revisions before applying.
 */
export async function runEditorTurn(opts: {
  conv: TimetableConversation;
  counsellorId: string;
  content: string;
  images?: EditorImage;
}): Promise<{
  userMessageId: string;
  assistantMessage?: typeof timetableMessages.$inferSelect;
  proposedChange?: typeof timetableChanges.$inferSelect;
  error?: string;
}> {
  const { conv, counsellorId, content, images } = opts;

  // Persist user message first so it survives an LLM failure. Image bytes
  // themselves aren't stored (the conversation can get huge otherwise) —
  // we just note "(N images attached)" so future history reads show context.
  const visibleContent = images?.length
    ? `${content}\n\n_[attached ${images.length} image${images.length === 1 ? '' : 's'}]_`
    : content;
  const userMsg = (
    await db
      .insert(timetableMessages)
      .values({ conversationId: conv.id, role: 'user', content: visibleContent })
      .returning()
  )[0]!;

  const studentRow = (
    await db.select().from(students).where(eq(students.id, conv.studentId)).limit(1)
  )[0];
  if (!studentRow) throw Errors.notFound('student', conv.studentId);

  const now = new Date();
  const horizon = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000);
  const activeTasks = await db
    .select({
      id: tasks.id,
      scheduled_start: tasks.scheduledStart,
      scheduled_end: tasks.scheduledEnd,
      subject: tasks.subject,
      task_title: tasks.taskTitle,
      status: tasks.status,
      recurrence_group_id: tasks.recurrenceGroupId,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.studentId, conv.studentId),
        isNull(tasks.supersededAt),
        gte(tasks.scheduledStart, now),
        lt(tasks.scheduledStart, horizon),
      ),
    )
    .orderBy(asc(tasks.scheduledStart))
    .limit(200);

  const activeGroups = await db
    .select()
    .from(recurrenceGroups)
    .where(and(eq(recurrenceGroups.studentId, conv.studentId), isNull(recurrenceGroups.supersededAt)))
    .limit(50);

  const history = await db
    .select({ role: timetableMessages.role, content: timetableMessages.content })
    .from(timetableMessages)
    .where(eq(timetableMessages.conversationId, conv.id))
    .orderBy(asc(timetableMessages.createdAt))
    .limit(40);
  const conversationText = history
    .map((m) => `${m.role === 'user' ? 'COUNSELLOR' : 'EDITOR'}: ${m.content}`)
    .join('\n\n');

  const [onboarding, rollingHistory] = await Promise.all([
    loadOnboardingProfile(conv.studentId),
    getCurrentRollingSummary(conv.studentId),
  ]);

  const ai = new AIClient();
  let parsed: z.infer<typeof EditorResponseSchema>;
  let aiCallId: string | null = null;
  try {
    const result = await ai.call({
      workerName: 'worker_4b_timetable_editor',
      promptId: 'worker4b_timetable_editor',
      counsellorId,
      studentId: conv.studentId,
      outputSchema: EditorResponseSchema,
      images,
      inputs: {
        student_name: studentRow.fullName,
        student_grade: studentRow.currentGrade,
        student_timezone: studentRow.timezone || 'Asia/Kolkata',
        today: now.toISOString().slice(0, 10),
        conversation_turn: String(history.length),
        is_bootstrap: String(conv.isBootstrap),
        conversation_history: conversationText,
        user_message: content,
        active_tasks_json: activeTasks,
        active_recurrence_groups_json: activeGroups,
        onboarding_profile: onboarding?.aiProfile ?? '(no approved profile)',
        rolling_history: rollingHistory || '(no rolling history yet)',
      },
    });
    parsed = result.output;
    aiCallId = result.aiCallId;
  } catch (err) {
    const e = err as Error & { rawResponse?: string };
    logger.error(
      { err: e.message, rawResponse: e.rawResponse?.slice(0, 1000), conversationId: conv.id },
      'timetable editor worker failed',
    );
    return { userMessageId: userMsg.id, error: `Editor failed: ${e.message}` };
  }

  // Clarification path — assistant message, no change row.
  if (parsed.needs_clarification) {
    const msg = (
      await db
        .insert(timetableMessages)
        .values({
          conversationId: conv.id,
          role: 'assistant',
          content: parsed.needs_clarification,
          aiCallId,
        })
        .returning()
    )[0]!;
    return { userMessageId: userMsg.id, assistantMessage: msg };
  }

  const ops = (parsed.proposed_operations ?? []) as TimetableOp[];
  if (ops.length === 0) {
    const msg = (
      await db
        .insert(timetableMessages)
        .values({
          conversationId: conv.id,
          role: 'assistant',
          content: parsed.message || '(no proposal)',
          aiCallId,
        })
        .returning()
    )[0]!;
    return { userMessageId: userMsg.id, assistantMessage: msg };
  }

  const validation = await validateOperations(conv.studentId, ops);
  if (!validation.ok) {
    const errText =
      `I drafted a proposal but it failed validation:\n` +
      validation.errors.map((e) => `- ${e}`).join('\n') +
      `\n\nLet me know how you'd like to adjust.`;
    const msg = (
      await db
        .insert(timetableMessages)
        .values({
          conversationId: conv.id,
          role: 'assistant',
          content: errText,
          aiCallId,
        })
        .returning()
    )[0]!;
    return { userMessageId: userMsg.id, assistantMessage: msg };
  }

  // seedRequestId wins over isBootstrap: a request-seeded conversation
  // produces request-sourced changes (even on revision turns), keeping the
  // audit chain back to change_requests intact.
  const source = conv.seedRequestId
    ? 'change_request'
    : conv.isBootstrap
      ? 'bootstrap'
      : 'counsellor_chat';

  const change = (
    await db
      .insert(timetableChanges)
      .values({
        studentId: conv.studentId,
        source,
        operations: ops,
        rationale: parsed.rationale ?? null,
        sourceConversationId: conv.id,
        sourceRequestId: conv.seedRequestId ?? null,
        createdBySubjectId: counsellorId,
        createdByRole: 'counsellor',
      })
      .returning()
  )[0]!;

  const msg = (
    await db
      .insert(timetableMessages)
      .values({
        conversationId: conv.id,
        role: 'assistant',
        content: parsed.message || 'Proposal ready — review the diff below.',
        proposedChangeId: change.id,
        aiCallId,
      })
      .returning()
  )[0]!;

  return { userMessageId: userMsg.id, assistantMessage: msg, proposedChange: change };
}

timetableEditorRoutes.post('/timetable/conversations/:cid/messages', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const cid = c.req.param('cid');
  const conv = await loadOwnedConversation(auth.subjectId, cid);
  const body = PostSchema.parse(await c.req.json());

  // Enforce a per-turn payload cap on attached images (~5MB raw / image
  // and ~15MB aggregate). Base64 inflates by ~33%, so we budget on the
  // base64 string length directly.
  if (body.images) {
    const totalBase64 = body.images.reduce((a, img) => a + img.data.length, 0);
    if (totalBase64 > 20_000_000) {
      throw Errors.validation('image attachments too large — total under 15MB please');
    }
  }

  const result = await runEditorTurn({
    conv,
    counsellorId: auth.subjectId,
    content: body.content,
    images: body.images,
  });
  return c.json(result);
});

// ─── Change apply / revert / summary ────────────────────────────────────────

timetableEditorRoutes.post(
  '/students/:id/timetable/changes/:changeId/apply',
  async (c) => {
    const auth = requireRole(c, 'counsellor');
    const studentId = c.req.param('id');
    const changeId = c.req.param('changeId');
    await assertOwns(auth.subjectId, studentId);
    await assertChangeBelongs(changeId, studentId);
    const result = await applyChange(changeId);
    const change = (
      await db.select().from(timetableChanges).where(eq(timetableChanges.id, changeId)).limit(1)
    )[0];
    return c.json({ ok: true, changeId, ...result, change });
  },
);

timetableEditorRoutes.post(
  '/students/:id/timetable/changes/:changeId/revert',
  async (c) => {
    const auth = requireRole(c, 'counsellor');
    const studentId = c.req.param('id');
    const changeId = c.req.param('changeId');
    await assertOwns(auth.subjectId, studentId);
    await assertChangeBelongs(changeId, studentId);
    const result = await revertChange(changeId);
    const change = (
      await db.select().from(timetableChanges).where(eq(timetableChanges.id, changeId)).limit(1)
    )[0];
    return c.json({ ok: true, changeId, ...result, change });
  },
);

/**
 * Summary endpoint now returns both the change row AND the diff so the
 * chat UI can render state-aware buttons (Apply only for draft; Revert
 * only for active; reverted shown as a label with no buttons) without a
 * second roundtrip per message bubble.
 */
timetableEditorRoutes.get(
  '/students/:id/timetable/changes/:changeId/summary',
  async (c) => {
    const auth = requireRole(c, 'counsellor');
    const studentId = c.req.param('id');
    const changeId = c.req.param('changeId');
    await assertOwns(auth.subjectId, studentId);
    await assertChangeBelongs(changeId, studentId);
    const [summary, change] = await Promise.all([
      summarizeChange(changeId),
      db.select().from(timetableChanges).where(eq(timetableChanges.id, changeId)).limit(1),
    ]);
    return c.json({ change: change[0], ...summary });
  },
);

timetableEditorRoutes.delete('/timetable/conversations/:cid', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const cid = c.req.param('cid');
  await loadOwnedConversation(auth.subjectId, cid);
  await db.delete(timetableConversations).where(eq(timetableConversations.id, cid));
  return c.json({ ok: true });
});

timetableEditorRoutes.get('/students/:id/timetable/changes', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.param('id');
  await assertOwns(auth.subjectId, studentId);
  const rows = await db
    .select()
    .from(timetableChanges)
    .where(eq(timetableChanges.studentId, studentId))
    .orderBy(desc(timetableChanges.createdAt))
    .limit(50);
  return c.json({ data: rows });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

async function assertOwns(counsellorId: string, studentId: string): Promise<void> {
  const row = (
    await db
      .select({ counsellorId: students.counsellorId })
      .from(students)
      .where(eq(students.id, studentId))
      .limit(1)
  )[0];
  if (!row) throw Errors.notFound('student', studentId);
  if (row.counsellorId !== counsellorId) throw Errors.authForbidden();
}

async function loadOwnedConversation(counsellorId: string, cid: string) {
  const conv = (
    await db.select().from(timetableConversations).where(eq(timetableConversations.id, cid)).limit(1)
  )[0];
  if (!conv) throw Errors.notFound('timetable_conversation', cid);
  if (conv.counsellorId !== counsellorId) throw Errors.authForbidden();
  return conv;
}

async function assertChangeBelongs(changeId: string, studentId: string): Promise<void> {
  const row = (
    await db
      .select({ studentId: timetableChanges.studentId })
      .from(timetableChanges)
      .where(eq(timetableChanges.id, changeId))
      .limit(1)
  )[0];
  if (!row) throw Errors.notFound('timetable_change', changeId);
  if (row.studentId !== studentId) throw Errors.authForbidden();
}
