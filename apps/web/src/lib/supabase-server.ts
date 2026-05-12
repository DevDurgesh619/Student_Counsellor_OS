import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Server-side Supabase client. Reads/writes cookies via next/headers so the
 * session set by /auth/callback/route.ts is visible to layouts and other
 * server components. Cookie writes from a Server Component will throw in dev
 * — we swallow that path because route handlers handle session writes.
 */
export function getServerSupabase(): SupabaseClient {
  const store = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return store.getAll().map((c) => ({ name: c.name, value: c.value }));
        },
        setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              store.set({ name, value, ...options });
            }
          } catch {
            // Server Components can't mutate cookies. Route handlers (where it
            // matters) can, and they use this same client.
          }
        },
      },
    },
  );
}
