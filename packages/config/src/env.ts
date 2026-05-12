import { z } from 'zod';

/**
 * Env schema. Vendor-native names stay native; WGC_* prefix only for our own
 * config (per CLAUDE_CODE.md §5 / clarifications.md Q4).
 *
 * Each field is optional or has a sensible local-dev default so packages can
 * boot without all production secrets set. Validate via {@link loadEnv} at
 * service startup; later phases tighten requiredness per service.
 */
const EnvSchema = z.object({
  // --- runtime ---
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  WGC_NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  WGC_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // --- Postgres / Supabase (vendor-native names) ---
  DATABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // --- Anthropic (Phase 5+) ---
  WGC_ANTHROPIC_API_KEY: z.string().optional(),

  // --- OpenAI Whisper (Phase 5+, voice STT — separate substrate per CLAUDE_CODE.md §12) ---
  WGC_OPENAI_API_KEY: z.string().optional(),

  // --- Postmark (Phase 8) ---
  WGC_POSTMARK_API_KEY: z.string().optional(),
  WGC_POSTMARK_FROM_DOMAIN: z.string().default('reports.wgc.in'),

  // --- Google Vision (Phase 7, OCR) ---
  WGC_GOOGLE_VISION_KEY: z.string().optional(),

  // --- Google Calendar (Phase 4) ---
  WGC_GOOGLE_CALENDAR_CLIENT_ID: z.string().optional(),
  WGC_GOOGLE_CALENDAR_CLIENT_SECRET: z.string().optional(),
  WGC_GOOGLE_CALENDAR_REDIRECT_URI: z.string().url().optional(),
  /** Public URL where Google posts watch-channel notifications. Required for two-way sync. */
  WGC_GOOGLE_CALENDAR_WEBHOOK_URL: z.string().url().optional(),
  /** Master switch — if false (or creds missing), the sync worker no-ops outbox entries. */
  WGC_CALENDAR_SYNC_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Symmetric key for at-rest encryption of OAuth refresh tokens
   * (students.google_oauth_token) via pgcrypto's pgp_sym_encrypt.
   * Required whenever Calendar sync is enabled.
   */
  WGC_TOKEN_ENCRYPTION_KEY: z.string().min(16).optional(),

  // --- Google OAuth for Supabase user auth (Phase 6 follow-on) ---
  // Reuse the Calendar OAuth client OR create a separate Web client.
  // The redirect URI to add to the Google client is the Supabase callback:
  //   http://127.0.0.1:54321/auth/v1/callback
  WGC_GOOGLE_AUTH_CLIENT_ID: z.string().optional(),
  WGC_GOOGLE_AUTH_CLIENT_SECRET: z.string().optional(),

  // --- Spinach (Phase 6) ---
  // /webhooks/spinach is the Zapier fallback path. The primary ingestion
  // route is Spinach's MCP server (https://mcp.spinach.ai/mcp) with per-
  // counsellor OAuth — polled every 5 min by workers-cron.
  WGC_SPINACH_WEBHOOK_SECRET: z.string().optional(),
  WGC_SPINACH_CLIENT_ID: z.string().optional(),
  WGC_SPINACH_CLIENT_SECRET: z.string().optional(),
  WGC_SPINACH_REDIRECT_URI: z.string().url().optional(),
  WGC_SPINACH_MCP_URL: z.string().url().default('https://mcp.spinach.ai/mcp'),

  // --- Internal RPC between workers-cron and api (Phase 6+) ---
  WGC_INTERNAL_API_SECRET: z.string().min(16).optional(),

  // --- Sentry (Phase 9) ---
  WGC_SENTRY_DSN: z.string().optional(),

  // --- Public API base URL (consumed by web/admin clients) ---
  NEXT_PUBLIC_API_BASE_URL: z.string().url().default('http://localhost:8787'),
  /** Public origin of the apps/web Next.js app. Used by the API to build the
   * onboarding-form URL it returns to the counsellor and any future emails
   * that link back into the dashboard. Different from API in production
   * (api.wgc.in vs app.wgc.in). */
  NEXT_PUBLIC_WEB_BASE_URL: z.string().url().default('http://localhost:3000'),

  // --- API service ---
  API_PORT: z.coerce.number().int().positive().default(8787),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * Parse env against the schema. Throws on validation failure with a
 * human-readable list of missing/invalid keys.
 *
 * Caches the result of the first call against `process.env` so production
 * reads are O(1). When called with an explicit `source`, no caching happens —
 * use this in tests to exercise different envs without leaking state.
 */
export function loadEnv(source?: NodeJS.ProcessEnv): Env {
  if (!source && cached) return cached;
  const parsed = EnvSchema.safeParse(source ?? process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  if (!source) cached = parsed.data;
  return parsed.data;
}

/** Convenience accessor; calls {@link loadEnv} on first use. */
export function getEnv(): Env {
  return cached ?? loadEnv();
}
