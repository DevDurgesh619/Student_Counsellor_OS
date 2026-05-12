-- Phase 5 (token hardening, pre-Phase-6).
-- Replace plaintext onboarding_token with a sha256 hash + expiry + single-use marker.
-- Existing pre-launch dev data is discarded; the column drop is safe because
-- no real students have onboarded yet.

ALTER TABLE student_profile_drafts
    ADD COLUMN IF NOT EXISTS onboarding_token_hash TEXT,
    ADD COLUMN IF NOT EXISTS onboarding_token_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS onboarding_token_used_at TIMESTAMPTZ;

-- Drop the old plaintext column. (Indexes on it auto-drop with CASCADE.)
DROP INDEX IF EXISTS uq_profile_drafts_onboarding_token;
ALTER TABLE student_profile_drafts DROP COLUMN IF EXISTS onboarding_token;

-- Hash uniqueness is partial — null hashes (drafts without a token, e.g.
-- counsellor manual entries in future flows) coexist.
CREATE UNIQUE INDEX uq_profile_drafts_onboarding_token_hash
    ON student_profile_drafts(onboarding_token_hash)
    WHERE onboarding_token_hash IS NOT NULL;

-- Lookup-by-hash is the hot path for every public onboarding hit.
CREATE INDEX IF NOT EXISTS idx_profile_drafts_token_active
    ON student_profile_drafts(onboarding_token_hash, onboarding_token_expires_at)
    WHERE onboarding_token_hash IS NOT NULL AND onboarding_token_used_at IS NULL;
