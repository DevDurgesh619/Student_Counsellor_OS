-- Phase 7-prereq — versioned timetable: recurrence groups, change-event audit,
-- conversational editor history.
--
-- Today every code path that mutates a task does so directly; there is no
-- record of *which decision* produced *which task*. Worker 4 hand-expands
-- recurrence inside the prompt, so anything past 7 days vanishes. This
-- migration adds the data contract for both: a `recurrence_groups` table
-- holds rule_json + window; `timetable_changes` is an immutable log of every
-- mutation (source, operations, who/when). Tasks gain back-pointers
-- (recurrence_group_id + generated_from_change_id + superseded_by_change_id
-- + superseded_at) so the active schedule is `superseded_at IS NULL AND
-- status NOT IN ('cancelled','rescheduled')`. Conversational editor
-- (`timetable_conversations` + `_messages`) lives in its own pair of tables
-- so it never collides with Ask AI's assistant_conversations.
--
-- Ordering: timetable_changes first (no FKs to the new tables), then
-- recurrence_groups (FK back to changes), then conversations/messages, then
-- ALTER tasks. All new columns nullable so legacy rows (Hetvika's current
-- tasks) keep working — they appear active via the "superseded_at IS NULL"
-- predicate.

CREATE TABLE IF NOT EXISTS timetable_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  operations jsonb NOT NULL,
  rationale text,
  source_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  source_request_id uuid REFERENCES change_requests(id) ON DELETE SET NULL,
  source_conversation_id uuid,
  created_by_subject_id uuid NOT NULL,
  created_by_role text NOT NULL,
  applied_at timestamptz,
  reverted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT timetable_changes_source_check CHECK (source IN
    ('bootstrap','meeting_extraction','change_request','counsellor_chat','counsellor_direct')),
  CONSTRAINT timetable_changes_status_check CHECK (status IN
    ('draft','active','reverted')),
  CONSTRAINT timetable_changes_role_check CHECK (created_by_role IN
    ('counsellor','student','system'))
);
CREATE INDEX IF NOT EXISTS idx_timetable_changes_student
  ON timetable_changes (student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_timetable_changes_status
  ON timetable_changes (status) WHERE status = 'draft';

CREATE TABLE IF NOT EXISTS recurrence_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject text NOT NULL,
  task_title text NOT NULL,
  task_description text,
  rule_json jsonb NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  flexibility text NOT NULL DEFAULT 'preferred',
  source text NOT NULL,
  generated_from_change_id uuid REFERENCES timetable_changes(id) ON DELETE SET NULL,
  superseded_by_change_id uuid REFERENCES timetable_changes(id) ON DELETE SET NULL,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recurrence_groups_student_active
  ON recurrence_groups (student_id) WHERE superseded_at IS NULL;

-- Counsellor's chat with the timetable editor. Distinct from Ask AI's
-- assistant_conversations so neither feature can poison the other's history
-- query.
CREATE TABLE IF NOT EXISTS timetable_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  counsellor_id uuid NOT NULL REFERENCES counsellors(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  is_bootstrap boolean NOT NULL DEFAULT false,
  title text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_timetable_conversations_student
  ON timetable_conversations (student_id, started_at DESC);

CREATE TABLE IF NOT EXISTS timetable_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES timetable_conversations(id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  proposed_change_id uuid REFERENCES timetable_changes(id) ON DELETE SET NULL,
  ai_call_id uuid REFERENCES ai_calls(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT timetable_messages_role_check CHECK (role IN ('user','assistant','system'))
);
CREATE INDEX IF NOT EXISTS idx_timetable_messages_conversation
  ON timetable_messages (conversation_id, created_at);

-- Tasks get four new pointers + an active-set partial index.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS recurrence_group_id uuid REFERENCES recurrence_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS generated_from_change_id uuid REFERENCES timetable_changes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS superseded_by_change_id uuid REFERENCES timetable_changes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks (student_id, scheduled_start)
  WHERE superseded_at IS NULL AND status NOT IN ('cancelled','rescheduled');
