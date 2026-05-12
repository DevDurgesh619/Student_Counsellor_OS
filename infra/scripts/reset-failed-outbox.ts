// Reset all failed sync_outbox rows so the worker retries them.
import { sql } from 'drizzle-orm';
import { db } from '@wgc/db';

async function main() {
  const res = await db.execute(sql`
    UPDATE sync_outbox SET status = 'pending', attempts = 0, last_error = NULL
    WHERE status IN ('failed', 'in_progress')
    RETURNING id
  `);
  const rows = (res as unknown as { rows: Array<{ id: string }> }).rows;
  console.log(`Reset ${rows.length} rows to pending`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
