// Remove the two stale duplicate "Durgesh Patidar" students; keep the active
// "Duggu Patidar" (most recent) row that the counsellor is currently viewing.
// Cascading deletes will remove tasks/completions/artifacts/etc. tied to these.
import { sql } from 'drizzle-orm';
import { db } from '@wgc/db';

const DELETE_IDS = [
  '5a67a31b-b815-4c9e-9da8-e4ebb53fa3e7',
  'd5a72f7d-2256-446d-8226-71377bfae009',
];

async function main() {
  // Show what we're about to lose so the cleanup is auditable.
  for (const id of DELETE_IDS) {
    const tasks = await db.execute(sql`SELECT COUNT(*) FROM tasks WHERE student_id = ${id}`);
    const drafts = await db.execute(
      sql`SELECT COUNT(*) FROM student_profile_drafts WHERE student_id = ${id}`,
    );
    console.log(`student ${id}: tasks=${(tasks as any).rows[0].count}, drafts=${(drafts as any).rows[0].count}`);
  }

  // Drop or null-out the rows whose FKs don't cascade (per Phase 1 schema).
  for (const id of DELETE_IDS) {
    await db.execute(sql`
      DELETE FROM sync_outbox
      WHERE entity_type = 'task'
        AND entity_id IN (SELECT id FROM tasks WHERE student_id = ${id})
    `);
    // conversations.student_id is NOT cascaded; safe to delete the rows
    // outright since they're test consent/system audit entries.
    await db.execute(sql`DELETE FROM conversations WHERE student_id = ${id}`);
    await db.execute(sql`DELETE FROM artifacts WHERE student_id = ${id}`);
    await db.execute(sql`DELETE FROM ai_calls WHERE student_id = ${id}`);
    await db.execute(sql`DELETE FROM errors WHERE student_id = ${id}`);
    await db.execute(sql`DELETE FROM review_queue WHERE student_id = ${id}`);
    await db.execute(sql`DELETE FROM assistant_conversations WHERE student_id = ${id}`);
  }
  for (const id of DELETE_IDS) {
    const res = await db.execute(
      sql`DELETE FROM students WHERE id = ${id} RETURNING id, full_name`,
    );
    console.log('Deleted:', (res as any).rows);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
