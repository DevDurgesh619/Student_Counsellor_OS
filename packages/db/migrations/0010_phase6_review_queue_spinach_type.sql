-- Add 'unassigned_spinach_meeting' to the review_queue.type CHECK constraint.
-- Migration 0008 introduced this code path but missed the constraint update,
-- so every insert from the Spinach poller fails with 23514.

ALTER TABLE review_queue DROP CONSTRAINT IF EXISTS review_queue_type_check;
ALTER TABLE review_queue ADD CONSTRAINT review_queue_type_check CHECK (type IN (
    'assessment_draft',
    'timetable_draft',
    'report_draft',
    'change_request',
    'profile_draft',
    'flagged_grading',
    'session_extraction',
    'meeting_prep_brief',
    'unassigned_spinach_meeting'
));
