'use client';

import { dataProvider as supabaseDataProvider } from '@refinedev/supabase';
import { getBrowserSupabase } from './supabase';

/**
 * Refine data provider backed by Supabase REST (PostgREST). The admin app
 * reads/writes Layer 1 directly — no API hop. This is intentional for
 * internal-only tooling; counsellor and student apps go through apps/api.
 */
export function getDataProvider() {
  return supabaseDataProvider(getBrowserSupabase());
}
