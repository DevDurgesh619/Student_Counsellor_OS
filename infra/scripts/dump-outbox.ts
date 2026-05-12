import { sql } from 'drizzle-orm';
import { db } from '@wgc/db';

async function main() {
  const res = await db.execute(sql`
    SELECT id, entity_type, entity_id, operation, status, attempts, last_error, created_at, completed_at
    FROM sync_outbox ORDER BY created_at DESC LIMIT 10
  `);
  const rows = (res as unknown as { rows: Array<Record<string, unknown>> }).rows;
  console.log(`${rows.length} rows`);
  for (const r of rows) console.log(r);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
