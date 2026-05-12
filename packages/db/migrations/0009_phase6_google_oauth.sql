-- Phase 6 follow-on — replace magic-link / token-onboarding with Google OAuth.
-- 1. Wipe seed data (per user decision: start fresh with real Gmails).
-- 2. Drop the token-as-auth columns from student_profile_drafts.
-- 3. Add a pending_onboarding status to students and a CHECK that documents
--    the allowed set so future drift is caught at DB level.

-- ── 1. Wipe seed accounts ──────────────────────────────────────────────────
-- CASCADE on FKs cleans up tasks/completions/artifacts/etc. tied to test rows.
TRUNCATE students CASCADE;
TRUNCATE counsellors CASCADE;
-- Also clear auth.users so re-signing-in with the same email starts fresh.
-- Avoid wiping the supabase_admin / service users (they have aud='').
DELETE FROM auth.users WHERE email IS NOT NULL;

-- ── 2. Drop token-based onboarding columns ────────────────────────────────
ALTER TABLE student_profile_drafts
    DROP COLUMN IF EXISTS onboarding_token_hash,
    DROP COLUMN IF EXISTS onboarding_token_expires_at,
    DROP COLUMN IF EXISTS onboarding_token_used_at;

-- After wipe, every remaining draft will be tied to an authenticated student.
ALTER TABLE student_profile_drafts
    ALTER COLUMN student_id SET NOT NULL;

-- ── 3. Student status — document the allowed set ──────────────────────────
-- Allowed values now include 'pending_onboarding' (just-signed-up, hasn't
-- filled the form yet) and 'pending_review' (form submitted, awaiting
-- counsellor approval). 'active' = approved; 'archived' = ignored or removed.
ALTER TABLE students
    DROP CONSTRAINT IF EXISTS students_status_check;
ALTER TABLE students
    ADD CONSTRAINT students_status_check
    CHECK (status IN ('pending_onboarding', 'pending_review', 'active', 'archived'));
