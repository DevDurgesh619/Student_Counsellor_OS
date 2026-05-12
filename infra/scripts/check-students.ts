import { sql } from 'drizzle-orm';
import { db } from '@wgc/db';

async function main() {
  const all = await db.execute(sql`
    SELECT id, full_name, email, current_grade, counsellor_id, created_at
    FROM students ORDER BY created_at
  `);
  console.log('All students:');
  for (const r of (all as unknown as { rows: Record<string, unknown>[] }).rows) {
    console.log(' -', r);
  }

  const dupes = await db.execute(sql`
    SELECT email, COUNT(*) as count, array_agg(id::text) as ids
    FROM students WHERE email IS NOT NULL GROUP BY email HAVING COUNT(*) > 1
  `);
  const dupeRows = (dupes as unknown as { rows: Record<string, unknown>[] }).rows;
  console.log('\nDuplicate emails:', dupeRows.length === 0 ? 'NONE' : dupeRows);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
