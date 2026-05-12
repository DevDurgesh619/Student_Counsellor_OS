-- Phase 5: counsellor-assistant chat tables (per phase-5-ai-infra-and-workers-1-6.md).
-- These are distinct from the existing `conversations` table, which serves the
-- WhatsApp / onboarding-consent log per Phase 10's design. The chat tables
-- belong to Worker 6 (Counsellor Assistant) and store per-counsellor query
-- threads with full citation metadata.

CREATE TABLE assistant_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    counsellor_id UUID NOT NULL REFERENCES counsellors(id) ON DELETE CASCADE,
    student_id UUID REFERENCES students(id) ON DELETE SET NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    title TEXT
);

CREATE INDEX idx_assistant_conversations_counsellor
    ON assistant_conversations(counsellor_id, started_at DESC);

CREATE TABLE assistant_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    citations JSONB NOT NULL DEFAULT '[]'::jsonb,
    ai_call_id UUID REFERENCES ai_calls(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_assistant_messages_conversation
    ON assistant_messages(conversation_id, created_at);
