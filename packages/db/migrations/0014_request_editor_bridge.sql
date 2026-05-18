-- Phase: Close the student-request loop.
--
-- change_requests gains structured fields so the counsellor sees task + scope
-- + proposed-slot, and so the timetable editor can be seeded from a request.
-- timetable_conversations gains seed_request_id so the message handler knows
-- which request a conversation was opened from (and stamps source/source_request_id
-- on resulting timetable_changes drafts).
--
-- All additions are nullable except `kind` (default 'general' keeps legacy
-- rows valid without backfill). No FKs across change_requests <-> editor
-- tables to keep cross-feature coupling loose.

ALTER TABLE change_requests
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS scope text,
  ADD COLUMN IF NOT EXISTS target_recurrence_group_id uuid REFERENCES recurrence_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proposed_start timestamptz,
  ADD COLUMN IF NOT EXISTS proposed_end timestamptz,
  ADD COLUMN IF NOT EXISTS linked_conversation_id uuid,
  ADD COLUMN IF NOT EXISTS linked_change_id uuid,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

DO $$ BEGIN
  ALTER TABLE change_requests
    ADD CONSTRAINT change_requests_kind_check CHECK (kind IN ('general','task_change'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE change_requests
    ADD CONSTRAINT change_requests_scope_check CHECK (scope IS NULL OR scope IN ('single','recurring'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_change_requests_kind_status
  ON change_requests(student_id, kind, status);

ALTER TABLE timetable_conversations
  ADD COLUMN IF NOT EXISTS seed_request_id uuid;
