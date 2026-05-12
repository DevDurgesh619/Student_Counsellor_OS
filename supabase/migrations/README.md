# Supabase migrations

This directory is **intentionally empty** of migration SQL. The canonical
migrations live in [`packages/db/migrations/`](../../packages/db/migrations/)
and are owned by Drizzle (`drizzle-kit generate` + `pnpm db:migrate`).

## Why

Two separate migration runners would race each other (Supabase CLI's runner +
Drizzle's runner against the same Postgres). We treat Drizzle as authoritative
and Supabase CLI strictly as the **local Postgres + Auth + Storage runtime**.

## Local dev workflow

```bash
pnpm supabase:start          # boots Postgres on :54322, Auth, Studio, Storage
pnpm db:migrate              # apply Drizzle migrations to the local DB
pnpm db:seed                 # populate Gahan reference data
```

For staging / production: `pnpm db:migrate` runs against the cloud Supabase
project's Postgres URL. Supabase CLI is not used in those environments.
