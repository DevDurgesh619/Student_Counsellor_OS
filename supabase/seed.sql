-- Supabase CLI runs this after migrations on `supabase start` / `supabase db reset`.
-- The application-level Gahan reference seed is in `packages/db/src/seed.ts`
-- (run via `pnpm db:seed`); this file is intentionally empty so the two seed
-- paths don't fight each other. Add Storage bucket bootstraps here if needed.
SELECT 'noop seed — application seed lives in @wgc/db' AS info;
