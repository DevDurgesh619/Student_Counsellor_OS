import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  assistantConversations,
  assistantMessages,
  db,
  studentProfileDrafts,
  students,
  type Citation,
} from '@wgc/db';
import { Errors } from '@wgc/shared';
import { AIClient } from '@wgc/ai';
import type { AppEnv } from '../app.js';
import { requireRole } from '../middleware/auth.js';
import { executePlan, type QueryPlan } from '../lib/assistant-retrieval.js';
import { logger } from '../logger.js';

export const assistantRoutes = new Hono<AppEnv>();

// ─── Conversations CRUD ─────────────────────────────────────────────────────

assistantRoutes.post('/conversations', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const body = (await c.req.json().catch(() => ({}))) as { studentId?: string; title?: string };
  if (body.studentId) {
    const ok = (
      await db
        .select({ counsellorId: students.counsellorId })
        .from(students)
        .where(eq(students.id, body.studentId))
        .limit(1)
    )[0];
    if (!ok) throw Errors.notFound('student', body.studentId);
    if (ok.counsellorId !== auth.subjectId) throw Errors.authForbidden();
  }
  const inserted = await db
    .insert(assistantConversations)
    .values({
      counsellorId: auth.subjectId,
      studentId: body.studentId ?? null,
      title: body.title ?? null,
    })
    .returning();
  return c.json(inserted[0], 201);
});

assistantRoutes.get('/conversations', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const studentId = c.req.query('studentId');
  const conds = [eq(assistantConversations.counsellorId, auth.subjectId)];
  if (studentId) conds.push(eq(assistantConversations.studentId, studentId));
  const rows = await db
    .select()
    .from(assistantConversations)
    .where(and(...conds))
    .orderBy(desc(assistantConversations.startedAt))
    .limit(50);
  return c.json({ data: rows });
});

assistantRoutes.get('/conversations/:id', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const conv = await loadOwnedConversation(auth.subjectId, id);
  const messages = await db
    .select()
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, id))
    .orderBy(asc(assistantMessages.createdAt));
  return c.json({ conversation: conv, messages });
});

assistantRoutes.delete('/conversations/:id', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  await loadOwnedConversation(auth.subjectId, id);
  await db.delete(assistantConversations).where(eq(assistantConversations.id, id));
  return c.json({ ok: true });
});

// ─── Chat turn ──────────────────────────────────────────────────────────────

const PostMessageSchema = z.object({
  content: z.string().min(1).max(2000),
});

const QueryPlanSchema = z.object({
  queries: z
    .array(
      z.object({
        entity: z.enum([
          'tasks',
          'completions',
          'artifacts',
          'sessions',
          'reports',
          'change_requests',
        ]),
        timeRange: z
          .object({ from: z.string().optional(), to: z.string().optional() })
          .optional(),
        subjects: z.array(z.string()).optional(),
        statuses: z.array(z.string()).optional(),
        limit: z.number().int().positive().max(200).optional(),
      }),
    )
    .max(6),
  needsClarification: z.string().optional(),
});

const ResponseSchema = z.object({
  answer: z.string().min(1),
  citations: z.array(
    z.object({
      entity: z.string().min(1),
      id: z.string().min(1),
      label: z.string().optional(),
    }),
  ),
});

assistantRoutes.post('/conversations/:id/messages', async (c) => {
  const auth = requireRole(c, 'counsellor');
  const id = c.req.param('id');
  const conv = await loadOwnedConversation(auth.subjectId, id);
  const body = PostMessageSchema.parse(await c.req.json());

  // Persist the user message immediately so we have it logged even if the
  // downstream LLM call fails.
  const userMsg = (
    await db
      .insert(assistantMessages)
      .values({
        conversationId: id,
        role: 'user',
        content: body.content,
        citations: [],
      })
      .returning()
  )[0]!;

  const history = await db
    .select({ role: assistantMessages.role, content: assistantMessages.content })
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, id))
    .orderBy(asc(assistantMessages.createdAt))
    .limit(20);
  const conversationText = history
    .map((m) => `${m.role === 'user' ? 'COUNSELLOR' : 'ASSISTANT'}: ${m.content}`)
    .join('\n\n');

  const ai = new AIClient();
  const today = new Date().toISOString().slice(0, 10);

  // Always-available ambient context — basic student row + latest approved
  // Worker 1 profile draft. Questions about onboarding data ("what are their
  // interests?", "what are the stated goals?") can be answered from this even
  // when the planner has no relevant DB entity to retrieve from.
  const studentContext = await loadStudentContext(conv.studentId);

  // Step 1 — query planning
  let plan: QueryPlan;
  let plannerCallId: string | null = null;
  try {
    const planResult = await ai.call({
      workerName: 'worker_6_counsellor_assistant',
      promptId: 'worker6_query_planner',
      counsellorId: auth.subjectId,
      studentId: conv.studentId ?? undefined,
      outputSchema: QueryPlanSchema,
      inputs: {
        conversation: conversationText,
        studentId: conv.studentId ?? '(no student selected)',
        question: body.content,
        today,
      },
    });
    plan = planResult.output;
    plannerCallId = planResult.aiCallId;
  } catch (err) {
    const e = err as Error & { rawResponse?: string };
    logger.error(
      {
        err: e.message,
        rawResponse: e.rawResponse?.slice(0, 1000) ?? null,
        conversationId: id,
      },
      'query planner failed; falling back to empty plan',
    );
    // Fall back: empty plan — generator can still answer from student_profile context.
    plan = { queries: [] };
  }

  if (plan.needsClarification) {
    const assistantMsg = (
      await db
        .insert(assistantMessages)
        .values({
          conversationId: id,
          role: 'assistant',
          content: plan.needsClarification,
          citations: [],
          aiCallId: plannerCallId,
        })
        .returning()
    )[0]!;
    return c.json({ userMessageId: userMsg.id, assistantMessage: assistantMsg });
  }

  // Step 2 — retrieval (only when a student is bound to the conversation)
  let retrieved: Record<string, unknown[]> = {};
  if (conv.studentId) {
    retrieved = await executePlan(conv.studentId, plan);
  }

  // Step 3 — response generation
  let answer = '';
  let citations: Citation[] = [];
  let responseCallId: string | null = null;
  try {
    const respResult = await ai.call({
      workerName: 'worker_6_counsellor_assistant',
      promptId: 'worker6_response_generator',
      counsellorId: auth.subjectId,
      studentId: conv.studentId ?? undefined,
      outputSchema: ResponseSchema,
      inputs: {
        conversation: conversationText,
        question: body.content,
        student_profile: studentContext,
        data: retrieved,
      },
    });
    answer = respResult.output.answer;
    citations = respResult.output.citations as Citation[];
    responseCallId = respResult.aiCallId;
  } catch (err) {
    const e = err as Error & { rawResponse?: string };
    logger.error(
      {
        err: e.message,
        rawResponse: e.rawResponse?.slice(0, 2000) ?? null,
        conversationId: id,
        studentId: conv.studentId,
      },
      'response generator failed',
    );
    // 200 with an error field instead of 502 so the chat UI surfaces the
    // specific reason rather than a generic "Bad Gateway". The user message
    // is already persisted; this turn just doesn't get an assistant reply.
    return c.json({
      userMessageId: userMsg.id,
      error: `AI response failed: ${e.message}`,
      rawResponse: e.rawResponse?.slice(0, 500) ?? null,
    });
  }

  const assistantMsg = (
    await db
      .insert(assistantMessages)
      .values({
        conversationId: id,
        role: 'assistant',
        content: answer,
        citations,
        aiCallId: responseCallId,
      })
      .returning()
  )[0]!;

  return c.json({ userMessageId: userMsg.id, assistantMessage: assistantMsg });
});

/**
 * Build the always-available student context block that gets passed to the
 * response generator regardless of what the query planner produces. Includes:
 *   - the `students` row (basic info)
 *   - the latest approved `student_profile_drafts.profile` (Worker 1 output —
 *     goals, strengths, working sample analysis, parent context, etc.)
 *
 * Returns null when the conversation isn't bound to a student.
 */
async function loadStudentContext(studentId: string | null) {
  if (!studentId) return null;
  const studentRow = (
    await db.select().from(students).where(eq(students.id, studentId)).limit(1)
  )[0];
  const draftRow = (
    await db
      .select({ profile: studentProfileDrafts.profile })
      .from(studentProfileDrafts)
      .where(
        and(
          eq(studentProfileDrafts.studentId, studentId),
          eq(studentProfileDrafts.status, 'approved'),
        ),
      )
      .orderBy(desc(studentProfileDrafts.acceptedAt))
      .limit(1)
  )[0];
  return {
    student: studentRow
      ? {
          id: studentRow.id,
          full_name: studentRow.fullName,
          current_grade: studentRow.currentGrade,
          school: studentRow.school,
          email: studentRow.email,
          timezone: studentRow.timezone,
          language_preferences: studentRow.languagePreferences,
        }
      : null,
    onboarding_profile: draftRow?.profile ?? null,
  };
}

async function loadOwnedConversation(counsellorId: string, id: string) {
  const conv = (
    await db
      .select()
      .from(assistantConversations)
      .where(eq(assistantConversations.id, id))
      .limit(1)
  )[0];
  if (!conv) throw Errors.notFound('assistant_conversation', id);
  if (conv.counsellorId !== counsellorId) throw Errors.authForbidden();
  return conv;
}
