-- Phase 6 — Spinach + Worker 7 + Worker 4 (Mode 1).
-- Adds the four tables that gate the post-session pipeline:
--   session_extractions   — structured JSON output that drives downstream workers
--   meeting_prep_briefs   — Worker 7 Pass A / Pass B output for upcoming sessions
--   gaps                  — Layer 2 entity tracked over time, read by Worker 4
--   counsellor_todos      — action items owned by counsellor (not student tasks)
-- Plus FK wiring on existing sessions/tasks columns that Phase 1 declared but
-- left dangling pending these tables.

CREATE TABLE IF NOT EXISTS session_extractions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    topics_discussed TEXT[] NOT NULL DEFAULT '{}',
    action_items JSONB NOT NULL DEFAULT '[]',
    schedule_changes_discussed BOOLEAN NOT NULL DEFAULT false,
    schedule_changes JSONB NOT NULL DEFAULT '[]',
    concerns_raised JSONB NOT NULL DEFAULT '[]',
    decisions_made JSONB NOT NULL DEFAULT '[]',
    open_questions JSONB NOT NULL DEFAULT '[]',
    confidence TEXT NOT NULL DEFAULT 'normal'
        CHECK (confidence IN ('low', 'normal', 'high')),
    raw_extraction JSONB,
    ai_call_id UUID REFERENCES ai_calls(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS meeting_prep_briefs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    pass_a_content TEXT,
    pass_a_generated_at TIMESTAMPTZ,
    pass_b_content TEXT,
    pass_b_generated_at TIMESTAMPTZ,
    final_content TEXT,
    counsellor_edited_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'pass_a_only'
        CHECK (status IN ('pass_a_only', 'pass_b_ready', 'reviewed', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One brief per upcoming session — re-running Pass A/B updates in place.
CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_prep_briefs_session
    ON meeting_prep_briefs(target_session_id);

CREATE TABLE IF NOT EXISTS gaps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK (category IN ('content', 'skill', 'habit')),
    subject TEXT,
    description TEXT NOT NULL,
    identified_in_session_id UUID REFERENCES sessions(id),
    identified_via TEXT NOT NULL CHECK (identified_via IN (
        'session_extraction', 'counsellor_manual', 'assessment_failure', 'pattern_detection'
    )),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'addressed', 'archived')),
    target_resolution_date DATE,
    addressed_in_session_id UUID REFERENCES sessions(id),
    addressed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gaps_student_status ON gaps(student_id, status);

CREATE TABLE IF NOT EXISTS counsellor_todos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    counsellor_id UUID NOT NULL REFERENCES counsellors(id) ON DELETE CASCADE,
    student_id UUID REFERENCES students(id) ON DELETE SET NULL,
    description TEXT NOT NULL,
    source_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
    due_date DATE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'completed', 'cancelled')),
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_counsellor_todos_status
    ON counsellor_todos(counsellor_id, status);

-- Wire dangling FKs that Phase 1 declared in code but couldn't constrain
-- because the target tables didn't exist yet.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_tasks_linked_gap'
    ) THEN
        ALTER TABLE tasks
            ADD CONSTRAINT fk_tasks_linked_gap
            FOREIGN KEY (linked_gap_id) REFERENCES gaps(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_sessions_extraction'
    ) THEN
        ALTER TABLE sessions
            ADD CONSTRAINT fk_sessions_extraction
            FOREIGN KEY (structured_extraction_id) REFERENCES session_extractions(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_sessions_agenda'
    ) THEN
        ALTER TABLE sessions
            ADD CONSTRAINT fk_sessions_agenda
            FOREIGN KEY (agenda_used_id) REFERENCES meeting_prep_briefs(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_tasks_session'
    ) THEN
        ALTER TABLE tasks
            ADD CONSTRAINT fk_tasks_session
            FOREIGN KEY (generated_from_session_id) REFERENCES sessions(id) ON DELETE SET NULL;
    END IF;
END$$;
