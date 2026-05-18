import { sql } from 'drizzle-orm';
import { db } from '@wgc/db';

async function main() {
  console.log('— Briefs whose Pass A mentions "20 March 2026" —');
  const res = await db.execute(sql`
    SELECT b.id, b.target_session_id, b.pass_a_generated_at, b.pass_b_generated_at,
           s.scheduled_at, s.status, s.student_id,
           st.full_name,
           LEFT(b.pass_a_content, 200) AS pass_a_preview
    FROM meeting_prep_briefs b
    JOIN sessions s ON s.id = b.target_session_id
    JOIN students st ON st.id = s.student_id
    WHERE b.pass_a_content ILIKE '%20 March 2026%' OR b.pass_a_content ILIKE '%generated: 20 march%'
    ORDER BY b.pass_a_generated_at DESC
  `);
  for (const r of (res as unknown as { rows: Record<string, unknown>[] }).rows) {
    console.log(r);
    console.log('---');
  }

  console.log('\n— All students named like Hetvika —');
  const stu = await db.execute(sql`
    SELECT id, full_name, current_grade, counsellor_id, created_at FROM students
    WHERE full_name ILIKE '%hetvika%' ORDER BY created_at
  `);
  for (const r of (stu as unknown as { rows: Record<string, unknown>[] }).rows) {
    console.log(r);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
