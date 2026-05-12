-- Phase 6 follow-on — Spinach MCP integration.
-- Spinach doesn't offer custom webhooks, so we poll their MCP server every
-- 5 min per connected counsellor. This migration adds the per-counsellor
-- OAuth token store + a watermark for incremental sync + an inbox table for
-- meetings that haven't been auto-matched to a student.

ALTER TABLE counsellors
    ADD COLUMN IF NOT EXISTS spinach_oauth_token JSONB,
    ADD COLUMN IF NOT EXISTS spinach_last_synced_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS spinach_ingested_meetings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    counsellor_id UUID NOT NULL REFERENCES counsellors(id) ON DELETE CASCADE,
    spinach_meeting_id TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    scheduled_at TIMESTAMPTZ,
    title TEXT,
    attendees JSONB NOT NULL DEFAULT '[]'::jsonb,
    raw JSONB,
    status TEXT NOT NULL DEFAULT 'unassigned'
        CHECK (status IN ('linked', 'unassigned', 'ignored')),
    linked_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
    UNIQUE (counsellor_id, spinach_meeting_id)
);

CREATE INDEX IF NOT EXISTS idx_spinach_ingested_status
    ON spinach_ingested_meetings(counsellor_id, status);
