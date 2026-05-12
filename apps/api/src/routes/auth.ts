import { Hono } from 'hono';
import type { AppEnv } from '../app.js';

/**
 * Auth routes are essentially passthroughs to Supabase Auth, which the
 * frontend speaks to directly via @supabase/ssr or supabase-js. The endpoint
 * below exists for health/visibility; real session lifecycle lives client-side.
 */
export const authRoutes = new Hono<AppEnv>();

authRoutes.get('/health', (c) =>
  c.json({ provider: 'supabase-auth', mode: 'client-driven' }),
);
