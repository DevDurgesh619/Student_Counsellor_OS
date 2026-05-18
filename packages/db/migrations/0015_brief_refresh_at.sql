-- Phase: brief freshness.
--
-- Pass B briefs go stale because the old `pass_b_24h_check` cron only catches
-- sessions in a narrow 24-25h window. Sessions created less than 24h before
-- they're scheduled, or sessions rescheduled into a tighter window, slip past
-- it. There's also no refresh signal when new artifacts/completions land
-- between brief generation and the meeting.
--
-- `refresh_at` is the explicit "this brief should regenerate by this time"
-- signal. The cron picks up briefs where refresh_at <= now() AND not yet
-- regenerated since. Pass A sets refresh_at on insert; reschedules and
-- relevant student activity bump it; the cron clears it after generating.

ALTER TABLE meeting_prep_briefs
  ADD COLUMN IF NOT EXISTS refresh_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_meeting_prep_briefs_refresh_at
  ON meeting_prep_briefs(refresh_at)
  WHERE refresh_at IS NOT NULL;
