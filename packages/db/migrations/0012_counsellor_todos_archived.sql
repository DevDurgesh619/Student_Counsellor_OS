-- Counsellor todos refinement — add the 'archived' status.
--
-- The My Todos tab now tiers: pending → completed → archived. "Clear all
-- completed" bulk-flips completed rows to archived so they drop out of the
-- default view but stay in the DB for the record. 'cancelled' is retired
-- from new use but kept in the allowed set so any pre-existing rows (and
-- back-compat callers) don't trip the constraint.

ALTER TABLE counsellor_todos DROP CONSTRAINT IF EXISTS counsellor_todos_status_check;
ALTER TABLE counsellor_todos ADD CONSTRAINT counsellor_todos_status_check
  CHECK (status IN ('pending', 'completed', 'cancelled', 'archived'));
