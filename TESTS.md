# Tests

## Running

```bash
npm test              # full suite
npm run typecheck     # every package
npm run lint          # eslint + typecheck
```

The suite needs no database or Docker: `apps/api/test/helpers/db.ts` boots an
in-process Postgres (PGlite) and applies the real files in `db/migrations/`.
Tests therefore exercise actual SQL — column names, constraints, triggers — and
schema/code drift fails here rather than at demo time.

## What is covered

| Suite | What it protects |
|---|---|
| `apps/api/test/exactly-once.test.ts` | One side effect per `effect_key`, across timeouts, crashes, re-claims, and provider rejections |
| `apps/api/test/auth.test.ts` | Token-derived tenancy, cross-tenant isolation, revocation, approval authority |
| `apps/api/test/idempotency.test.ts` | Replayed submits resolve to the original execution; keys are scoped per tenant |
| `apps/api/test/webhooks.test.ts` | Signatures verified over raw bytes, replay window, fail-closed on missing secret |
| `apps/api/test/schema.test.ts` | The columns application SQL actually queries exist |
| `apps/api/test/seed.test.ts` | Demo seed stays in step with the schema |
| `packages/policy/src/engine.test.ts` | Policy rule table and approval-toggle remapping |

`exactly-once.test.ts` is the one that encodes the product claim. If you change
the worker, read it first.

## Known gap

PGlite is a single connection, so these tests cannot exercise genuine
multi-connection contention. Concurrency is covered by replaying a claim
sequentially, which catches dedupe bugs but not lock-ordering bugs. Verifying
`FOR UPDATE SKIP LOCKED` behaviour across two live workers needs a real
Postgres and is not automated yet.

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
