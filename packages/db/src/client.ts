import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

let pool: pg.Pool | null = null;
let cached: Database | null = null;

/**
 * Lazily create the singleton Drizzle client. Reads DATABASE_URL from process.env.
 * Closing/recreating the pool happens via {@link closeDb}.
 */
export function getDb(): Database {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. See .env.example.');
  }
  pool = new pg.Pool({ connectionString: url, max: 10 });
  cached = drizzle(pool, { schema });
  return cached;
}

/** Convenience export — calls {@link getDb} on first access. */
export const db: Database = new Proxy({} as Database, {
  get(_target, prop) {
    return Reflect.get(getDb() as object, prop);
  },
});

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    cached = null;
  }
}
