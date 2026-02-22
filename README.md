# IRIL — Issue Resolution Integrity Layer (Phase 1 Pilot)

Implementation of the IRIL spec v1.1.3. A Zendesk sidebar app for support agents resolving refund-related tickets, backed by a Node.js API, Postgres, and a DB-backed outbox worker.

---

## Table of contents

- [What this is](#what-this-is)
- [Prerequisites](#prerequisites)
- [Publish safely (GitHub)](#publish-safely-github)
- [Demo mode — first run](#demo-mode--first-run)
- [Demo mode — normal run](#demo-mode--normal-run)
- [Demo mode — reset and stop](#demo-mode--reset-and-stop)
- [Smoke test](#smoke-test)
- [Dev mode](#dev-mode)
- [Common errors](#common-errors)
- [Project structure](#project-structure)
- [Approval toggle](#approval-toggle)

---

## What this is

- **Resolution Card** — Zendesk sidebar UI for agents resolving refund tickets
- **Core Integrity Engine** — policy preflight, approval lifecycle, action execution, effects ledger, audit log
- **Refund Resolution Playbook** — Stripe + Shopify + Zendesk evidence normalization

---

## Prerequisites

| Requirement | Version | Check |
|---|---|---|
| Node.js | ≥ 18 (22 recommended) | `node --version` |
| npm | ≥ 9 | `npm --version` |
| Docker Desktop | any recent | `docker --version` |
| docker compose | V2 (built into Docker Desktop) | `docker compose version` |

Using nvm: `nvm use` will pick up the `.nvmrc` pin (Node 22).

Run `npm run doctor` to check all requirements before starting.

---

## Publish safely (GitHub)

This repo is set up to keep local secrets out of Git:

- `.env` is ignored by `.gitignore`
- only `.env.example` files are commit-safe templates

Before your first push, verify what would be committed:

```bash
git add -n .
```

If `.env` ever appears in staged files, remove it from Git tracking:

```bash
git rm --cached .env
```

---

## Demo mode — first run

```bash
# 1. Clone
git clone <repo> iisl && cd iisl

# 2. Start everything (one command)
npm run demo:start
```

`demo:start` does all of this automatically:
1. Installs npm dependencies if `node_modules` is missing
2. Checks for `.env` and creates it from `infra/.env.example` if missing
3. Validates required env vars and checks credential consistency
4. Starts Docker (Postgres)
5. Waits for Postgres health
6. Runs migrations (idempotent)
7. Seeds demo data (idempotent — skips if already present)
8. Starts API (port 3001), Worker, and Sidebar (port 5173)
9. Prints URLs and credentials

If you prefer manual dependency install first, `npm install` still works.

---

## Demo mode — normal run

After first run, subsequent starts are:

```bash
npm run demo:start
```

That is the only command needed. It is idempotent — safe to run whether or not Postgres is already running or data is already seeded.

To open the sidebar directly:
```
http://localhost:5173
```

---

## Demo mode — reset and stop

```bash
# Full reset: destroys all local Postgres data and reseeds from scratch
# Prints a 5-second countdown — CTRL+C to abort
npm run demo:reset

# Stop Docker infrastructure only (keeps data)
npm run infra:down

# View Docker logs
npm run infra:logs
```

`demo:reset` is **local only** — it only touches your local Docker volume. It does not affect any external database or production system.

---

## Smoke test

Run after `demo:start` to verify everything is working:

```bash
npm run demo:smoke
```

Checks:
- API `/health` responds 200
- API can reach the database
- Worker heartbeat visible via metrics
- Sidebar (Vite) responds 200
- All 3 seeded demo tickets are present and card state is loaded

---

## Doctor (pre-flight check)

```bash
npm run doctor
```

Checks Node/npm versions, Docker daemon, container health, ports, `.env` presence, `DATABASE_URL` parse, credential consistency between `DATABASE_URL` and `POSTGRES_*` vars. Prints exact fix commands for every failure.

Run this first when anything is broken.

---

## Dev mode

For active development (no automated startup sequence):

```bash
# Infra only
npm run infra:up

# Migrations + seed
npm run db:migrate
npm run db:seed

# All three services (concurrently)
npm run dev
```

Individual services:
```bash
npm run dev --workspace=apps/api
npm run dev --workspace=apps/worker
npm run dev --workspace=apps/sidebar
```

---

## Common errors

| Error | Likely cause | Fix |
|---|---|---|
| `Connection refused` on API start | Postgres not running | `npm run infra:up` then wait 5s |
| `password authentication failed for user "iisl"` | DATABASE_URL and POSTGRES_PASSWORD are out of sync, or volume has old password | Re-run `npm run demo:start` once (auto-recovers local Postgres volume). If it still fails, run `npm run demo:reset`. |
| `role "iisl" does not exist` | DB was created with different user | Re-run `npm run demo:start` once (auto-recovers local Postgres volume). If it still fails, run `npm run demo:reset`. |
| `database "iisl" does not exist` | POSTGRES_DB mismatch or volume from old setup | Re-run `npm run demo:start` once (auto-recovers local Postgres volume). If it still fails, run `npm run demo:reset`. |
| `DATABASE_URL credentials don't match POSTGRES_*` | Edited one without editing the others | Edit `.env` so all four values are consistent: `DATABASE_URL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` |
| `role "iisl" does not exist` even after reset | Shell env overrides `.env`, or localhost resolves to another DB | Use `DATABASE_URL=postgresql://iisl:iisl_dev@127.0.0.1:5432/iisl` in `.env`, then run `unset DATABASE_URL POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB` and `npm run demo:start` |
| `container name "/iisl_postgres" is already in use` | Legacy container from an older setup | `docker rm -f iisl_postgres iisl_redis` once, then `npm run demo:start` |
| `Port 5432 already in use` | Local Postgres running outside Docker | Stop local Postgres, or add `POSTGRES_PORT=5433` to `.env` and update `DATABASE_URL` port |
| `Port 3001 already in use` | Another process on 3001 | Change `API_PORT` in `.env` and update `VITE_API_BASE_URL` |
| Migrations fail: `relation already exists` | Partial migration from broken run | `npm run demo:reset` |
| Seed fails: `duplicate key value` | Seed already ran but failed partway | `npm run demo:reset` |
| Sidebar shows `Unable to load card` | API not running or CORS | Check API terminal for errors; check `VITE_API_BASE_URL` in `.env` |
| `docker compose: command not found` | Using old `docker-compose` (V1) | Update Docker Desktop — Compose V2 is built in |

---

## Project structure

```
apps/
  api/          Fastify API server (port 3001)
  worker/       DB-backed outbox worker (polls every 2s)
  sidebar/      React sidebar UI — Vite dev server (port 5173)
packages/
  shared/       Canonical enums, types, contracts (single source of truth)
  policy/       Table-driven policy engine
  connectors/   Zendesk/Stripe/Shopify adapters + fixture simulators
db/
  migrations/   SQL migration files (run in filename order)
  seed.sql      Demo seed data (3 scenarios)
scripts/
  demo-start-bootstrap.js  npm run demo:start (installs deps if needed, then starts)
  demo-start.ts            npm run demo:start:internal
  demo-reset.ts    npm run demo:reset
  demo-smoke.ts    npm run demo:smoke
  doctor.ts        npm run doctor
  migrate.ts       npm run db:migrate
  seed.ts          npm run db:seed
  lib/
    env-validator.ts  Shared env validation used by all scripts
infra/
  docker-compose.yml  Postgres (pinned: postgres:15.6-alpine3.19)
  .env.example        All vars with comments — copy to .env
docs/
  DEMO.md        Step-by-step demo walkthrough for all 4 scenarios
```

---

## Approval toggle

Approvals are **OFF by default** for all pilot tenants.

To enable for the demo tenant:
```bash
curl -X PATCH http://localhost:3001/ops/tenants/00000000-0000-0000-0000-000000000001/config \
  -H "Authorization: Bearer operator-token-dev" \
  -H "Content-Type: application/json" \
  -d '{"approvals_enabled": true}'
```

To disable:
```bash
curl -X PATCH http://localhost:3001/ops/tenants/00000000-0000-0000-0000-000000000001/config \
  -H "Authorization: Bearer operator-token-dev" \
  -H "Content-Type: application/json" \
  -d '{"approvals_enabled": false}'
```

See [docs/DEMO.md](docs/DEMO.md) for the full Scenario 4 walkthrough (manager approval flow).

---

## Validation levels

Files in this repo carry explicit validation level annotations in their headers:

- `[Generated]` — written, not yet locally compiled
- `[Syntax-checked]` — basic syntax verified in this environment
- `[Compile: pending npm install]` — requires local `npm install` to type-check
- `[Runtime: pending Docker/Postgres]` — requires local infrastructure to run

Full compile and runtime verification occurs on your machine after `npm install`.
