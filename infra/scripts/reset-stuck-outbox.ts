// One-shot: any sync_outbox row stuck in 'in_progress' from a crashed worker
// goes back to 'pending' so it can be re-processed.
import { sql } from 'drizzle-orm';
import { db } from '@wgc/db';

async function main() {
  const res = await db.execute(sql`
    UPDATE sync_outbox SET status = 'pending', attempts = 0, last_error = NULL
    WHERE status = 'in_progress'
    RETURNING id
  `);
  const rows = (res as unknown as { rows: Array<{ id: string }> }).rows;
  console.log(`Reset ${rows.length} stuck rows back to pending`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
