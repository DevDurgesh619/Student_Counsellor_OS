-- Phase 4: align sync_outbox.status check constraint with the canonical
-- vocabulary in docs/phases/phase-4-calendar-sync.md.
--
-- Phase 1 used ('pending', 'in_flight', 'completed', 'failed').
-- Phase 4 needs ('pending', 'in_progress', 'synced', 'failed', 'skipped').
-- Migrate legacy rows, then swap the constraint.

UPDATE sync_outbox SET status = 'in_progress' WHERE status = 'in_flight';
UPDATE sync_outbox SET status = 'synced'      WHERE status = 'completed';

ALTER TABLE sync_outbox DROP CONSTRAINT IF EXISTS sync_outbox_status_check;
ALTER TABLE sync_outbox
    ADD CONSTRAINT sync_outbox_status_check
    CHECK (status IN ('pending', 'in_progress', 'synced', 'failed', 'skipped'));
