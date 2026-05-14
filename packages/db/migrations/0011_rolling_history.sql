-- Phase 6.5 — rolling student history summary + Spinach match-signal column.
--
-- The rolling summary is the longitudinal memory layer for each student.
-- After every meeting ingest, a worker regenerates it from
-- (prior summary + new extraction + approved onboarding profile). It is fed
-- into every downstream LLM call (briefs, reports) as the student's "story
-- so far," so the model isn't reconstructing context from raw transcripts
-- on each call.
--
-- `sessions.matched_via` records how the Spinach meeting was paired to
-- the student row, so we can audit auto-match quality later.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS matched_via text;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_matched_via_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_matched_via_check
  CHECK (matched_via IS NULL OR matched_via IN
    ('student_email', 'parent_email', 'title_name', 'manual'));

CREATE TABLE IF NOT EXISTS student_history_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid UNIQUE NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  current_version integer NOT NULL DEFAULT 1,
  content text NOT NULL,
  open_concerns jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_updated_focus text,
  based_on_session_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  generated_at timestamptz NOT NULL DEFAULT now(),
  ai_call_id uuid REFERENCES ai_calls(id)
);

CREATE TABLE IF NOT EXISTS student_history_summary_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  version integer NOT NULL,
  content text NOT NULL,
  open_concerns jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_updated_focus text,
  based_on_session_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  generated_at timestamptz NOT NULL DEFAULT now(),
  ai_call_id uuid REFERENCES ai_calls(id),
  UNIQUE (student_id, version)
);

CREATE INDEX IF NOT EXISTS idx_student_history_summary_versions_student
  ON student_history_summary_versions (student_id, version DESC);
