import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  },
  // Verbose-but-readable migration filenames
  migrations: {
    prefix: 'index',
    table: '__drizzle_migrations__',
    schema: 'public',
  },
  strict: true,
  verbose: true,
} satisfies Config;
