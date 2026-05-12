-- 0001_initial_schema.sql
-- Phase 1 initial schema. Per the schema-built-once binding rule
-- (clarifications.md Q3), all v1 tables are created here even though some
-- are not written to until later phases.
--
-- Source of truth: docs/phases/phase-1-foundation.md.
-- IDs: UUID gen_random_uuid() everywhere (CLAUDE_CODE.md §8 #1).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at trigger (CLAUDE_CODE.md §8 #3)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────────
-- counsellors
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE counsellors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT,
    timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    working_hours JSONB DEFAULT '{"monday": ["09:00", "18:00"]}',
    notification_preferences JSONB DEFAULT '{}',
    auth_user_id UUID,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER counsellors_set_updated_at BEFORE UPDATE ON counsellors
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- students
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    parent_contacts JSONB NOT NULL DEFAULT '[]',
    counsellor_id UUID REFERENCES counsellors(id),
    current_grade TEXT NOT NULL,
    school TEXT,
    current_context_tag TEXT NOT NULL DEFAULT 'school_term'
        CHECK (current_context_tag IN ('school_term', 'summer', 'exam_prep', 'holiday')),
    timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    language_preferences JSONB DEFAULT '{"primary": "en"}',
    opt_outs JSONB DEFAULT '{}',
    program_start_date DATE NOT NULL DEFAULT CURRENT_DATE,
    google_calendar_id TEXT,
    google_oauth_token JSONB,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_students_counsellor ON students(counsellor_id);
CREATE INDEX idx_students_status ON students(status);
CREATE TRIGGER students_set_updated_at BEFORE UPDATE ON students
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- tasks
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    scheduled_start TIMESTAMPTZ NOT NULL,
    scheduled_end TIMESTAMPTZ NOT NULL,
    subject TEXT NOT NULL,
    task_title TEXT NOT NULL,
    task_description TEXT,
    expected_output TEXT,
    recurrence_pattern TEXT,
    recurrence_parent_id UUID REFERENCES tasks(id),
    source TEXT NOT NULL DEFAULT 'counsellor_manual'
        CHECK (source IN ('counsellor_manual', 'ai_drafted_from_session', 'ai_drafted_from_weekly_review', 'student_request')),
    generated_from_session_id UUID,
    status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'active', 'completed', 'skipped', 'couldnt_do', 'cancelled', 'rescheduled')),
    rescheduled_from_id UUID REFERENCES tasks(id),
    linked_gap_id UUID,
    verification_required BOOLEAN NOT NULL DEFAULT false,
    flexibility TEXT NOT NULL DEFAULT 'preferred'
        CHECK (flexibility IN ('fixed', 'preferred', 'flexible')),
    google_calendar_event_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tasks_student_date ON tasks(student_id, scheduled_start);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_recurrence_parent ON tasks(recurrence_parent_id);
CREATE TRIGGER tasks_set_updated_at BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- completions (multiple per task allowed; latest is authoritative)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE completions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status_claimed TEXT NOT NULL
        CHECK (status_claimed IN ('done', 'partial', 'skipped', 'couldnt_do')),
    status_verified TEXT NOT NULL DEFAULT 'claimed_only'
        CHECK (status_verified IN ('claimed_only', 'evidence_submitted', 'counsellor_verified')),
    verification_method TEXT
        CHECK (verification_method IN ('artifact_submitted', 'voice_reflection', 'photo', 'none')),
    notes_text TEXT,
    time_taken_minutes INTEGER,
    source TEXT NOT NULL
        CHECK (source IN ('dashboard_form', 'whatsapp_text', 'whatsapp_voice', 'counsellor_manual_entry')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_completions_task ON completions(task_id);
CREATE INDEX idx_completions_submitted ON completions(submitted_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- artifacts
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    file_url TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size_bytes BIGINT,
    original_filename TEXT,
    transcription_text TEXT,
    tags TEXT[] DEFAULT '{}',
    source TEXT NOT NULL
        CHECK (source IN ('dashboard_upload', 'whatsapp_forward', 'counsellor_manual_entry')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_artifacts_student ON artifacts(student_id);
CREATE INDEX idx_artifacts_task ON artifacts(task_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- conversations (Phase 10 — schema only in Phase 1)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel TEXT NOT NULL CHECK (channel IN ('student', 'counsellor', 'system')),
    student_id UUID REFERENCES students(id),
    counsellor_id UUID REFERENCES counsellors(id),
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    content_text TEXT,
    content_voice_url TEXT,
    content_image_url TEXT,
    classified_intent TEXT,
    processed_at TIMESTAMPTZ,
    processing_outcome TEXT,
    metadata JSONB DEFAULT '{}'
);
CREATE INDEX idx_conversations_student ON conversations(student_id, sent_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- sessions (manually populated until Phase 6)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES students(id),
    counsellor_id UUID NOT NULL REFERENCES counsellors(id),
    scheduled_at TIMESTAMPTZ NOT NULL,
    actual_started_at TIMESTAMPTZ,
    duration_minutes INTEGER,
    transcript_text TEXT,
    transcript_url TEXT,
    recording_url TEXT,
    spinach_summary_text TEXT,
    spinach_metadata JSONB,
    structured_extraction_id UUID,
    agenda_used_id UUID,
    status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sessions_student ON sessions(student_id, scheduled_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- assessments (Phase 7)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE assessments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    questions JSONB NOT NULL,
    answer_key JSONB,
    rubric JSONB,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'approved', 'delivered', 'submitted', 'graded')),
    delivered_at TIMESTAMPTZ,
    created_by_worker TEXT,
    metadata JSONB DEFAULT '{}'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- submissions (Phase 7) — final_grade per CLAUDE_CODE.md §3 carve-out
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answer_text TEXT,
    answer_artifact_id UUID REFERENCES artifacts(id),
    ai_proposed_grade DECIMAL(5,2),
    grade_correctness DECIMAL(5,2),
    grade_type TEXT CHECK (grade_type IN ('memory', 'application', 'both')),
    grade_quality_of_working DECIMAL(5,2),
    ai_grade_confidence DECIMAL(5,2),
    counsellor_override BOOLEAN DEFAULT false,
    counsellor_override_reason TEXT,
    final_grade DECIMAL(5,2),
    metadata JSONB DEFAULT '{}'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- reports (Phase 8)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('weekly', 'monthly_parent', 'quarterly_deep', 'counsellor_working', 'student_facing')),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    draft_content TEXT,
    reviewed_content TEXT,
    status TEXT NOT NULL DEFAULT 'ai_drafted'
        CHECK (status IN ('ai_drafted', 'counsellor_reviewed', 'published')),
    published_at TIMESTAMPTZ,
    sent_to JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_reports_student_period ON reports(student_id, period_start, period_end);
CREATE TRIGGER reports_set_updated_at BEFORE UPDATE ON reports
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- plans (Phase 6+)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    valid_from DATE NOT NULL,
    valid_to DATE NOT NULL,
    focus_areas JSONB NOT NULL DEFAULT '[]',
    milestones JSONB DEFAULT '[]',
    generated_from_session_id UUID REFERENCES sessions(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_plans_student_valid ON plans(student_id, valid_from, valid_to);

-- ─────────────────────────────────────────────────────────────────────────────
-- change_requests
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE change_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    original_task_id UUID REFERENCES tasks(id),
    pattern_description TEXT,
    proposed_change TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    counsellor_notes TEXT,
    decided_by UUID REFERENCES counsellors(id),
    decided_at TIMESTAMPTZ
);
CREATE INDEX idx_change_requests_student_status ON change_requests(student_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- review_queue (Layer 1, kept indefinitely — clarifications.md Q5)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE review_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    counsellor_id UUID NOT NULL REFERENCES counsellors(id),
    student_id UUID REFERENCES students(id),
    type TEXT NOT NULL CHECK (type IN (
        'assessment_draft',
        'timetable_draft',
        'report_draft',
        'change_request',
        'profile_draft',
        'flagged_grading',
        'session_extraction',
        'meeting_prep_brief'
    )),
    reference_id UUID NOT NULL,
    priority INTEGER NOT NULL DEFAULT 5,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_review', 'resolved', 'dismissed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES counsellors(id),
    resolution_notes TEXT
);
CREATE INDEX idx_review_queue_counsellor_status ON review_queue(counsellor_id, status, priority);

-- ─────────────────────────────────────────────────────────────────────────────
-- errors
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE errors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'error', 'critical')),
    source TEXT NOT NULL,
    student_id UUID REFERENCES students(id),
    error_message TEXT NOT NULL,
    error_stack TEXT,
    context JSONB DEFAULT '{}',
    resolved BOOLEAN DEFAULT false
);
CREATE INDEX idx_errors_severity_unresolved ON errors(severity, resolved) WHERE resolved = false;

-- ─────────────────────────────────────────────────────────────────────────────
-- Operational tables — schema-built-once (clarifications.md Q3)
-- ─────────────────────────────────────────────────────────────────────────────

-- sync_outbox — Pattern 1; active in Phase 4
CREATE TABLE sync_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type TEXT NOT NULL,
    entity_id UUID NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_flight', 'completed', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);
CREATE INDEX idx_sync_outbox_pending ON sync_outbox(status, created_at) WHERE status = 'pending';

-- calendar_watch_channels — Phase 4
CREATE TABLE calendar_watch_channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL UNIQUE,
    resource_id TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_calendar_watch_expiry ON calendar_watch_channels(expires_at);

-- events — Pattern 2 event bus; active in Phase 5+
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    correlation_id UUID,
    emitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    processed_at TIMESTAMPTZ,
    error_text TEXT
);
CREATE INDEX idx_events_pending ON events(status, emitted_at) WHERE status = 'pending';
CREATE INDEX idx_events_correlation ON events(correlation_id);

-- ai_calls — AI substrate logs (Claude only); active in Phase 5+
CREATE TABLE ai_calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_name TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    prompt_version INTEGER NOT NULL,
    model TEXT NOT NULL,
    student_id UUID REFERENCES students(id),
    counsellor_id UUID REFERENCES counsellors(id),
    session_id UUID REFERENCES sessions(id),
    inputs JSONB NOT NULL,
    raw_response TEXT,
    parsed_output JSONB,
    schema_validation_passed BOOLEAN,
    tokens_input INTEGER,
    tokens_output INTEGER,
    cost_usd DECIMAL(10,6),
    cost_inr DECIMAL(10,2),
    latency_ms INTEGER,
    status TEXT NOT NULL CHECK (status IN ('success', 'retry', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ai_calls_worker_date ON ai_calls(worker_name, created_at);
CREATE INDEX idx_ai_calls_student ON ai_calls(student_id);

-- transcriptions — OpenAI Whisper logs (metadata only); active in Phase 5+
-- PII rule: never store audio_url or transcript text here.
CREATE TABLE transcriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    artifact_id UUID NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    model_version TEXT NOT NULL,
    duration_seconds DECIMAL(10,2),
    cost_usd DECIMAL(10,6),
    cost_inr DECIMAL(10,2),
    latency_ms INTEGER,
    status TEXT NOT NULL CHECK (status IN ('success', 'retry', 'failed')),
    error_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_transcriptions_artifact ON transcriptions(artifact_id);

-- student_profile_drafts — Layer 2; written by Worker 1 in Phase 5
CREATE TABLE student_profile_drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID REFERENCES students(id) ON DELETE CASCADE,
    onboarding_token TEXT,
    counsellor_id UUID REFERENCES counsellors(id),
    ai_call_id UUID REFERENCES ai_calls(id),
    profile JSONB NOT NULL,
    flags_for_counsellor JSONB DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending_review'
        CHECK (status IN ('pending_review', 'in_review', 'accepted', 'rejected', 'superseded')),
    accepted_at TIMESTAMPTZ,
    accepted_by UUID REFERENCES counsellors(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_profile_drafts_status ON student_profile_drafts(status);
CREATE INDEX idx_profile_drafts_student ON student_profile_drafts(student_id);

-- idempotency_records — Pattern 7; active from Phase 1
CREATE TABLE idempotency_records (
    key TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_status INTEGER NOT NULL,
    response_body JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);
CREATE INDEX idx_idempotency_expires ON idempotency_records(expires_at);
