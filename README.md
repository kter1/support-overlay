# support-overlay

A Zendesk sidebar and backend prototype for policy-driven issue resolution:
evidence-backed resolution cards, approval workflows, and — the part that
matters — exactly-once side effects against Stripe and Zendesk.

The central problem it addresses: when an agent (or an AI) triggers a refund and
the API call times out, did the refund happen? Treating that as a retriable
failure is how customers get refunded twice. Here it is a first-class outcome —
`SENT_UNCERTAIN` — resolved by reading provider state, and for money movement
never resolved by retrying.

**Status: prototype, installable, exercised end to end.** The exactly-once
machinery, matching engine, policy engine, audit trail, and the Zendesk app
package are implemented and tested — including multi-worker contention against
a real Postgres — and the full stack (API, worker, sidebar) has been run live:
auth enforced, match bands computed, an approval-gated refund executed through
the outbox, and the audit trail exported. Connectors run against fixture
simulators by default and have not been exercised against live provider APIs,
and the app has not been loaded in a live Zendesk instance.

## Table Of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Demo - First Run](#demo---first-run)
- [Architecture](#architecture)
- [Development](#development)
- [Testing And CI](#testing-and-ci)
- [Contributing](#contributing)
- [License](#license)
- [Contact](#contact)

## Features

- **Exactly-once side effects.** A transactional outbox plus an append-only
  effects ledger keyed by a deterministic `effect_key`. A crash, a restart, or a
  duplicate claim resolves to the same single side effect.
- **Per-action retry classification.** Money movement is `OPERATOR_RETRY_ONLY`
  and is never auto-retried; ticket status is `RECONCILIATION_FIRST` (read the
  provider before retrying); comments are `AUTO_RETRY_WITH_DEDUPE`.
- **Explainable evidence matching.** A deterministic scorer compares payment and
  order evidence — identifier linkage, amount, currency, refund status, timing —
  and stores the band with the sentence that justifies it. Rule-based on
  purpose: a confidence score nobody can reconstruct is worse than none.
- **Context extracted from the conversation.** Amounts, dates, order and payment
  references, and what the customer is actually asking for are pulled from the
  ticket thread, each carrying the span of text it came from. The card shows the
  quote next to the claim, so a wrong reading is visibly wrong. Rule-based, not
  an LLM: this text is untrusted input on a path that moves money.
- **Customer history across tickets.** Before an agent refunds, the card says
  whether this same order or charge was already refunded on another ticket —
  the most common way a team pays twice for one purchase. Matched on identifiers
  only, never on amount, and counted only when the provider confirmed the
  refund.
- **Table-driven policy** emitting `policy_rule_id` and `policy_version` on
  every evaluation, with approval lifecycle support.
- **Token-derived tenancy.** Bearer credentials carry their tenant and role;
  no endpoint accepts a caller-supplied tenant id.
- **Real Zendesk app.** ZAF v2 ticket sidebar; `npm run app:package` produces an
  installable zip. Backend calls go through Zendesk's server-side proxy, so the
  credential never reaches the browser. See `docs/ZENDESK_APP.md`.
- One-command local startup: `npm run demo:start`. Diagnostics: `npm run doctor`.
  Smoke checks: `npm run demo:smoke`.

## Quick Start

```bash
git clone https://github.com/kter1/support-overlay.git
cd support-overlay
npm ci
export POSTGRES_PASSWORD="$(openssl rand -hex 18)"
export OPERATOR_TOKEN="$(openssl rand -hex 24)"
export AGENT_TOKEN="$(openssl rand -hex 24)"
export WEBHOOK_TOKEN="$(openssl rand -hex 24)"
export POSTGRES_USER=iisl
export POSTGRES_DB=iisl
export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}"
export API_PORT=3001
export WORKER_POLL_INTERVAL_MS=2000
export WORKER_MAX_ATTEMPTS=5
export USE_ZENDESK_SIMULATOR=true
export USE_STRIPE_SIMULATOR=true
export USE_SHOPIFY_SIMULATOR=true
export VITE_API_BASE_URL=http://localhost:3001
export VITE_AGENT_TOKEN="$AGENT_TOKEN"
npm run demo:start
```

If `openssl` is unavailable, set unique local strings for `POSTGRES_PASSWORD`,
`OPERATOR_TOKEN`, `AGENT_TOKEN`, and `WEBHOOK_TOKEN`.

Tokens are stored only as SHA-256 hashes (`api_credentials`), and each one
determines the tenant and role of every request made with it. `scripts/seed.ts`
provisions them from the environment, so no usable credential is ever committed.

Local demo note: this setup is intended for an isolated local environment only.

Open:

- UI: `http://localhost:5173`
- API health: `http://localhost:3001/health`

## Demo - First Run

`npm run demo:start` performs:

1. Dependency/bootstrap checks.
2. Process environment validation (required vars must be set in shell).
3. Docker/Postgres startup.
4. DB migration + idempotent seed.
5. API, worker, and sidebar startup.

If your local state is inconsistent:

```bash
npm run demo:reset
```

![Architecture diagram for support-overlay showing sidebar, API, Postgres, outbox worker, and third-party connectors](docs/architecture-diagram.png)

Alt text: architecture diagram showing Zendesk sidebar -> Fastify API -> Postgres -> outbox worker -> Stripe, Shopify, and Zendesk connectors.

## Zendesk app

```bash
npm run app:package   # → dist/zendesk-app.zip
```

Upload via Admin Center → Apps and integrations → Upload private app. Full
install guide, including why the token stays server-side:
[`docs/ZENDESK_APP.md`](docs/ZENDESK_APP.md).

## Architecture

See `ARCHITECTURE.md` for component details, data flows, and diagram source.

## Development

- `npm run doctor`: environment and infra preflight checks.
- `npm run demo:start`: full local demo startup.
- `npm run demo:reset`: destructive local reset and reseed.
- `npm run demo:smoke`: runtime smoke verification.
- `npm run infra:up` / `npm run infra:down`: infra-only controls.

Helper scripts in this repo:

- `scripts/doctor.ts`: env/docker diagnostics.
- `scripts/seed.ts`: demo data plus credential provisioning from env.
- `scripts/demo-start.ts`: main local bootstrap flow.
- `scripts/demo-reset.ts`: local reset flow.
- `scripts/demo-smoke.ts`: smoke checks against live services.

## Testing And CI

GitHub Actions workflow: `.github/workflows/ci.yml`

CI validates:

1. ESLint and full typecheck across every package.
2. The test suite, which runs an in-process Postgres (PGlite) against the real
   migration files — so schema/code drift fails CI rather than the demo.
3. The Zendesk app manifest and package build.
4. End-to-end local smoke flow (`demo:start` + `demo:smoke`) on a Linux runner.

CI runs a Postgres service so the multi-worker concurrency suite executes rather
than skipping, and fails if it did not run.

See `TESTS.md`. The two suites that matter most are
`apps/api/test/exactly-once.test.ts` — real timeouts and provider rejections
driven through the adapter, asserted against the effects ledger and the
provider's own record — and `apps/api/test/concurrency.test.ts`, which races
real workers over a shared backlog.

## Contributing

See `CONTRIBUTING.md`.

## License

MIT. See `LICENSE`.
