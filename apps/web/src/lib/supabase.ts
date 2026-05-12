'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

/**
 * Browser-side Supabase client. Cookie-backed via @supabase/ssr so the same
 * session is readable from server components / route handlers in this app.
 * The OAuth code exchange itself happens server-side (see
 * /auth/callback/route.ts); this client only writes its session via the SDK's
 * cookie helpers, not via localStorage.
 */
export function getBrowserSupabase(): SupabaseClient {
  if (cached) return cached;
  cached = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  return cached;
}
