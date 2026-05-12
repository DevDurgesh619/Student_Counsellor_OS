import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { db, reviewQueue, studentProfileDrafts } from '@wgc/db';
import { AIClient } from '@wgc/ai';
import { loadEnv } from '@wgc/config';
import { logger } from '../logger.js';
import { ocrMarksheet } from './marksheet-ocr.js';

let storageClient: SupabaseClient | null = null;
function getStorage(): SupabaseClient {
  if (storageClient) return storageClient;
  const env = loadEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase storage not configured');
  }
  storageClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return storageClient;
}

const ProfileSchema = z.object({
  name: z.string(),
  current_grade: z.string(),
  school: z.string().nullable().optional(),
  date_of_birth: z.string().nullable().optional(),
  subjects: z
    .array(
      z.object({
        subject: z.string(),
        year: z.string().nullable().optional(),
        term: z.string().nullable().optional(),
        marks_obtained: z.number().nullable().optional(),
        marks_total: z.number().nullable().optional(),
      }),
    )
    .default([]),
  named_strengths: z.array(z.string()).default([]),
  named_weaknesses: z.array(z.string()).default([]),
  goals: z.array(z.string()).default([]),
  working_sample_analysis: z.string().nullable().optional(),
  parent_context: z.string().nullable().optional(),
  language_preference: z.string().default('en'),
  logistics: z
    .object({
      timezone: z.string().default('Asia/Kolkata'),
      devices: z.array(z.string()).default([]),
      schedule_constraints: z.string().nullable().optional(),
    })
    .default({ timezone: 'Asia/Kolkata', devices: [] }),
  initial_focus_areas: z
    .array(z.object({ area: z.string(), rationale: z.string() }))
    .default([]),
  flags_for_counsellor: z
    .array(
      z.object({
        field: z.string(),
        code: z.string(),
        note: z.string(),
      }),
    )
    .default([]),
});
export type ExtractedProfile = z.infer<typeof ProfileSchema>;

/**
 * Run Worker 1 against a draft row whose form_responses + marksheet_artifacts
 * have already been written. Marks the row's status as `pending_review` on
 * success so it lights up in the counsellor's review queue.
 */
export async function runProfileBuilder(draftId: string): Promise<void> {
  const draft = (
    await db.select().from(studentProfileDrafts).where(eq(studentProfileDrafts.id, draftId)).limit(1)
  )[0];
  if (!draft) throw new Error(`profile draft ${draftId} not found`);
  if (!draft.formResponses) throw new Error(`profile draft ${draftId} has no form_responses`);

  // 1. Marksheet storage paths live on form_responses.marksheet_paths
  //    (set by the public onboarding form). Pull each from Supabase Storage
  //    and OCR.
  let marksheetText = '';
  const formResponses = draft.formResponses as Record<string, unknown>;
  const paths = (formResponses['marksheet_paths'] as string[] | undefined) ?? [];
  if (paths.length > 0) {
    const supa = getStorage();
    for (const path of paths) {
      try {
        const dl = await supa.storage.from('artifacts').download(path);
        if (dl.error || !dl.data) continue;
        const buf = Buffer.from(await dl.data.arrayBuffer());
        const text = await ocrMarksheet(buf);
        if (text) marksheetText += `\n\n--- ${path} ---\n${text}`;
      } catch (err) {
        logger.warn({ err, path }, 'marksheet OCR failed for one file');
      }
    }
  }

  // 2. Call Worker 1 LLM.
  const ai = new AIClient();
  const result = await ai.call({
    workerName: 'worker_1_profile_builder',
    promptId: 'worker1_extract_profile',
    counsellorId: draft.counsellorId ?? undefined,
    outputSchema: ProfileSchema,
    inputs: {
      form_responses: draft.formResponses,
      marksheet_text: marksheetText.trim() || '(no marksheet text available)',
    },
  });

  // 3. Persist + insert review queue entry (if a counsellor is bound).
  await db
    .update(studentProfileDrafts)
    .set({
      profile: result.output,
      flagsForCounsellor: result.output.flags_for_counsellor,
      aiCallId: result.aiCallId,
      status: 'pending_review',
    })
    .where(eq(studentProfileDrafts.id, draftId));

  if (draft.counsellorId) {
    await db
      .insert(reviewQueue)
      .values({
        counsellorId: draft.counsellorId,
        studentId: null,
        type: 'profile_draft',
        referenceId: draftId,
        priority: 3,
      })
      .onConflictDoNothing();
  }
}
