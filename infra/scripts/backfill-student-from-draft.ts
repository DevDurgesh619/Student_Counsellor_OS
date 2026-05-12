// Backfill students.email / phone / parent_contacts from the approved
// student_profile_drafts.form_responses for any rows where the original
// approve flow dropped these factual fields.
//
// Safe to run multiple times — only updates rows where email is currently NULL.

import { sql } from 'drizzle-orm';
import { db } from '@wgc/db';

async function main() {
  const res = await db.execute(sql`
    UPDATE students
    SET email = pd.form_responses->'basic_info'->>'email',
        phone = COALESCE(NULLIF(students.phone, ''),
                         pd.form_responses->'basic_info'->>'phone',
                         students.phone),
        parent_contacts = COALESCE(
          (SELECT jsonb_agg(jsonb_build_object(
            'name', p->>'name',
            'relationship', COALESCE(p->>'relationship', 'other'),
            'phone', p->>'phone',
            'email', p->>'email'
          )) FROM jsonb_array_elements(pd.form_responses->'parent_info') p
            WHERE p->>'name' IS NOT NULL AND p->>'name' <> ''),
          students.parent_contacts
        )
    FROM student_profile_drafts pd
    WHERE pd.student_id = students.id
      AND pd.status = 'approved'
      AND pd.form_responses IS NOT NULL
      AND students.email IS NULL
    RETURNING students.id, students.full_name, students.email
  `);
  const rows = (res as unknown as { rows: Array<Record<string, unknown>> }).rows;
  console.log(`Updated ${rows.length} student row(s):`);
  for (const r of rows) console.log('  ', r);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
