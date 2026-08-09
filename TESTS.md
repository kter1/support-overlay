# Tests

## Running

```bash
npm test              # full suite
npm run typecheck     # every package
npm run lint          # eslint + typecheck
```

No database or Docker required by default: `apps/api/test/helpers/db.ts` boots an
in-process Postgres (PGlite) and applies the real files in `db/migrations/`, so
tests exercise actual SQL — column names, constraints, triggers — and
schema/code drift fails here rather than at demo time.

Point it at a real server to run everything, including the concurrency suite:

```bash
export TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/postgres
npm test
```

Each suite gets a throwaway database, dropped on teardown.

## What is covered

| Suite | What it protects |
|---|---|
| `apps/api/test/exactly-once.test.ts` | One side effect per `effect_key`, across timeouts, crashes, re-claims, and provider rejections |
| `apps/api/test/concurrency.test.ts` | Real multi-worker contention: no double refunds, one claim per row, one state transition per execution |
| `apps/api/test/matching.test.ts` | Match bands are computed from stored evidence, not seeded |
| `apps/api/test/hardening.test.ts` | Input validation, and that internal errors never leak schema detail |
| `packages/matching/src/index.test.ts` | Scoring, band ordering, and non-accusatory explanations |
| `scripts/lib/manifest-validator.test.ts` | Zendesk manifest, especially that credential parameters are marked secure |
| `apps/api/test/auth.test.ts` | Token-derived tenancy, cross-tenant isolation, revocation, approval authority |
| `apps/api/test/idempotency.test.ts` | Replayed submits resolve to the original execution; keys are scoped per tenant |
| `apps/api/test/webhooks.test.ts` | Signatures verified over raw bytes, replay window, fail-closed on missing secret |
| `apps/api/test/schema.test.ts` | The columns application SQL actually queries exist |
| `apps/api/test/seed.test.ts` | Demo seed stays in step with the schema |
| `packages/policy/src/engine.test.ts` | Policy rule table and approval-toggle remapping |

`exactly-once.test.ts` is the one that encodes the product claim. If you change
the worker, read it first.

## Concurrency coverage

`concurrency.test.ts` requires a real server and **skips** under PGlite, which
is a single connection and cannot exercise `FOR UPDATE SKIP LOCKED` at all. A
suite that "passed" under PGlite would be proving nothing, so it skips loudly
instead.

CI provides a Postgres service and then asserts the suite actually executed — a
silent skip would hide the one property that cannot be verified any other way.

## Smoke tests

`npm run demo:smoke` verifies a running stack:

- API `/health` returns 200
- Metrics endpoint is reachable and DB-backed
- Worker heartbeat is visible through metrics
- Sidebar responds on the configured port
- Seeded demo tickets return card payloads

It requires `OPERATOR_TOKEN` and `AGENT_TOKEN` to be exported, since every
endpoint is authenticated.

```bash
npm run demo:start    # terminal 1
npm run demo:smoke    # terminal 2
npm run demo:reset    # optional cleanup
```

## Adding tests

Put new API tests in `apps/api/test/`. Use the helpers in
`test/helpers/db.ts` (`createTestDb`, `createTenant`, `createIssue`,
`createEvidence`) rather than hand-rolling fixtures.
