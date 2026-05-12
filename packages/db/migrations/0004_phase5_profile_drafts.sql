-- Phase 5 (Worker 1 — Profile Builder): extend student_profile_drafts to
-- carry the raw onboarding-form responses and the list of uploaded marksheet
-- artifact ids. Also enforce uniqueness on onboarding_token so a misplaced
-- link cannot be replayed.

ALTER TABLE student_profile_drafts
    ADD COLUMN IF NOT EXISTS form_responses JSONB,
    ADD COLUMN IF NOT EXISTS marksheet_artifacts UUID[] NOT NULL DEFAULT '{}'::uuid[];

-- profile is filled by Worker 1 *after* the student submits the form. Pre-submit,
-- a draft row exists in 'awaiting_form' state with profile = NULL.
ALTER TABLE student_profile_drafts ALTER COLUMN profile DROP NOT NULL;

-- Token uniqueness is partial because legacy rows may have NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_drafts_onboarding_token
    ON student_profile_drafts(onboarding_token)
    WHERE onboarding_token IS NOT NULL;

-- Status vocabulary — accept the full Phase 5 set.
ALTER TABLE student_profile_drafts DROP CONSTRAINT IF EXISTS student_profile_drafts_status_check;
ALTER TABLE student_profile_drafts
    ADD CONSTRAINT student_profile_drafts_status_check
    CHECK (status IN ('awaiting_form', 'pending_review', 'approved', 'regenerated', 'rejected'));
