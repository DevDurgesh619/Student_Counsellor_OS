-- Phase 5 (post-incident): students.email and counsellors.email must be unique.
-- Without this, the auth middleware's `WHERE email = ?` lookup is ambiguous —
-- duplicate rows cause sign-in to map to whichever student row Postgres
-- happens to return first, producing dashboards that show data belonging to
-- a different student than the counsellor is viewing.

-- Partial uniqueness: NULL emails coexist (counsellors are seeded with emails;
-- students may legitimately have NULL email until they're invited).
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_email
    ON students(LOWER(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_counsellors_email
    ON counsellors(LOWER(email)) WHERE email IS NOT NULL;
