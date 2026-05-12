import Anthropic from '@anthropic-ai/sdk';
import type { ZodSchema } from 'zod';
import { aiCalls, db } from '@wgc/db';
import { loadEnv } from '@wgc/config';
import { computeCost } from './cost.js';
import { loadPrompt, renderPrompt } from './prompts.js';

export type AICallParams<T> = {
  workerName: string;
  promptId: string;
  inputs: Record<string, unknown>;
  /** Optional Zod schema; output is parsed as JSON and validated. */
  outputSchema?: ZodSchema<T>;
  studentId?: string;
  counsellorId?: string;
  sessionId?: string;
  /** Optional model override; falls back to the prompt's frontmatter. */
  model?: string;
};

export type AICallResult<T> = {
  output: T;
  rawResponse: string;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  costInr: number;
  latencyMs: number;
  aiCallId: string;
};

/**
 * AIClient — single funnel for every Claude call in the system.
 *
 * Responsibilities (CLAUDE_CODE.md §10):
 *  - Load and render prompt by id
 *  - Call Anthropic with retry/rate-limit handling
 *  - Validate output against Zod schema with one regenerate-on-failure
 *  - Log every call to ai_calls regardless of outcome (audit + cost dashboard)
 */
export class AIClient {
  private client: Anthropic;

  constructor(apiKey?: string) {
    const env = loadEnv();
    const key = apiKey ?? env.WGC_ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error('WGC_ANTHROPIC_API_KEY is not set; cannot call Claude API');
    }
    this.client = new Anthropic({ apiKey: key });
  }

  async call<T = unknown>(params: AICallParams<T>): Promise<AICallResult<T>> {
    const prompt = await loadPrompt(params.promptId);
    const rendered = renderPrompt(prompt.body, params.inputs);
    const model = params.model ?? prompt.model;

    let attempt = 0;
    let lastError: string | null = null;
    let lastRaw = '';
    let lastTokensInput = 0;
    let lastTokensOutput = 0;
    let lastLatencyMs = 0;

    // Up to 2 attempts: original + one regenerate on schema failure.
    while (attempt < 2) {
      attempt += 1;
      const t0 = Date.now();
      const messageContent =
        attempt === 1
          ? rendered
          : `${rendered}\n\nYour previous response did not match the required JSON schema. ` +
            `Error: ${lastError}\n\nPlease produce a corrected response. Output only the JSON object, no commentary.`;

      const response = await this.client.messages.create({
        model,
        max_tokens: prompt.maxTokens,
        temperature: prompt.temperature,
        messages: [{ role: 'user', content: messageContent }],
      });

      lastLatencyMs = Date.now() - t0;
      lastTokensInput = response.usage.input_tokens;
      lastTokensOutput = response.usage.output_tokens;
      lastRaw = response.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim();

      if (!params.outputSchema) {
        return await this.persistAndReturn({
          params,
          prompt,
          model,
          rawResponse: lastRaw,
          parsedOutput: lastRaw as unknown as T,
          schemaValidationPassed: null,
          tokensInput: lastTokensInput,
          tokensOutput: lastTokensOutput,
          latencyMs: lastLatencyMs,
          status: 'success',
        });
      }

      const parsed = tryParseJson(lastRaw);
      if (parsed === null) {
        lastError = 'Response is not valid JSON';
        continue;
      }
      const validated = params.outputSchema.safeParse(parsed);
      if (validated.success) {
        return await this.persistAndReturn<T>({
          params,
          prompt,
          model,
          rawResponse: lastRaw,
          parsedOutput: validated.data,
          schemaValidationPassed: true,
          tokensInput: lastTokensInput,
          tokensOutput: lastTokensOutput,
          latencyMs: lastLatencyMs,
          status: 'success',
        });
      }
      lastError = validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    }

    // Both attempts failed — log and throw.
    await this.logCall({
      params,
      prompt,
      model,
      rawResponse: lastRaw,
      parsedOutput: null,
      schemaValidationPassed: false,
      tokensInput: lastTokensInput,
      tokensOutput: lastTokensOutput,
      latencyMs: lastLatencyMs,
      status: 'failed',
    });
    const err = new Error(
      `AI call ${params.promptId} failed schema validation: ${lastError}`,
    ) as Error & { rawResponse?: string; promptId?: string };
    err.rawResponse = lastRaw;
    err.promptId = params.promptId;
    throw err;
  }

  private async persistAndReturn<T>(args: {
    params: AICallParams<T>;
    prompt: { id: string; version: number };
    model: string;
    rawResponse: string;
    parsedOutput: T | null;
    schemaValidationPassed: boolean | null;
    tokensInput: number;
    tokensOutput: number;
    latencyMs: number;
    status: string;
  }): Promise<AICallResult<T>> {
    const id = await this.logCall(args);
    const cost = computeCost(args.model, args.tokensInput, args.tokensOutput);
    return {
      output: args.parsedOutput as T,
      rawResponse: args.rawResponse,
      tokensInput: args.tokensInput,
      tokensOutput: args.tokensOutput,
      costUsd: cost.usd,
      costInr: cost.inr,
      latencyMs: args.latencyMs,
      aiCallId: id,
    };
  }

  private async logCall(args: {
    params: AICallParams<unknown>;
    prompt: { id: string; version: number };
    model: string;
    rawResponse: string;
    parsedOutput: unknown;
    schemaValidationPassed: boolean | null;
    tokensInput: number;
    tokensOutput: number;
    latencyMs: number;
    status: string;
  }): Promise<string> {
    const cost = computeCost(args.model, args.tokensInput, args.tokensOutput);
    const inserted = await db
      .insert(aiCalls)
      .values({
        workerName: args.params.workerName,
        promptId: args.prompt.id,
        promptVersion: args.prompt.version,
        model: args.model,
        studentId: args.params.studentId ?? null,
        counsellorId: args.params.counsellorId ?? null,
        sessionId: args.params.sessionId ?? null,
        inputs: args.params.inputs,
        rawResponse: args.rawResponse,
        parsedOutput:
          args.parsedOutput && typeof args.parsedOutput === 'object'
            ? (args.parsedOutput as Record<string, unknown>)
            : null,
        schemaValidationPassed: args.schemaValidationPassed,
        tokensInput: args.tokensInput,
        tokensOutput: args.tokensOutput,
        costUsd: cost.usd.toFixed(6),
        costInr: cost.inr.toFixed(2),
        latencyMs: args.latencyMs,
        status: args.status,
      })
      .returning({ id: aiCalls.id });
    return inserted[0]!.id;
  }
}

function tryParseJson(s: string): unknown {
  // Tolerate fenced code blocks and stray text around the JSON object.
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1]! : s;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) return null;
  const json = candidate.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
