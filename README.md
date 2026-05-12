# WGC Platform

Education-delivery platform for Class 8–12 students with one counsellor managing 5–15 students. Monorepo. Built per `CLAUDE_CODE.md` (binding spec).

## Quick start (local development)

Requirements: Node 20.18+, pnpm 9+, Docker (for Supabase CLI), Supabase CLI 1.200+.

```bash
pnpm install
cp .env.example .env
pnpm supabase:start          # spin up local Postgres + Auth + Storage
pnpm db:migrate              # apply Drizzle migrations
pnpm db:seed                 # seed Gahan reference data
pnpm dev                     # start api + admin in parallel via Turbo
```

## Workspace layout

```
apps/
  api/            Hono API service
  admin/          Refine + shadcn internal admin UI
  workers-cron/   Croner-based scheduler runner
packages/
  config/         Env loader (Zod)
  shared/         Domain types, enums, error envelope
  db/             Drizzle schema + migrations + seed
docs/             Specifications (read CLAUDE_CODE.md first)
```

## Binding decisions

See `CLAUDE_CODE.md` §4 (tech stack) and `docs/clarifications.md` for resolved design questions. Do not substitute equivalents without explicit human approval.

## Phase status

- [x] Phase 1 — Foundation (DB + Auth + Admin)
- [ ] Phase 2 — Student dashboard
- [ ] Phase 3 — Counsellor dashboard
- [ ] ...
