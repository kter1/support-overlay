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

**Prerequisites:** [Node.js 20+](https://nodejs.org) and
[Docker Desktop](https://www.docker.com/products/docker-desktop/) — running,
not just installed. Nothing else.

```bash
git clone https://github.com/kter1/support-overlay.git
cd support-overlay
npm run demo:start
```

That is the whole thing. The first run takes a few minutes: it installs
dependencies, writes a `.env` with a generated database password and three
random API tokens, starts Postgres in Docker, migrates, seeds four demo
tickets, and brings up the API, the worker, and the sidebar.

Then open **<http://localhost:5173>**.

You will see four tickets in the left rail. Click through them:

| Ticket | What it shows |
|---|---|
| **#10001** | Happy path — evidence matches, one click resolves it |
| **#10002** | The Shopify order is gone. Last known state is shown, and the card says so rather than pretending |
| **#10003** | A previous action whose outcome was never confirmed, held for an operator instead of retried |
| **#10005** | **A refund was already issued for this order on another ticket.** The warning sits above the buttons |

To stop everything: `Ctrl-C`, then `npm run infra:down`.

If something looks wrong, `npm run doctor` checks each piece and names what is
broken. `npm run demo:reset` returns the database to a clean seeded state.

### About the generated `.env`

Written on first run, git-ignored, and never overwritten — edit or delete it
freely. Its tokens are random per machine, so nothing published here can be a
real credential anywhere. Tokens are stored only as SHA-256 hashes in
`api_credentials`, and each one determines the tenant and role of every request
made with it.

This configuration is for an isolated local machine, not a deployment.

## Demo - First Run

`npm run demo:start` performs:

1. Writes `.env` on first run; loads it on every run.
2. Installs dependencies if they are missing.
3. Validates configuration and checks it is internally consistent.
4. Starts Postgres via Docker and waits for it to be healthy.
5. Runs migrations and an idempotent seed.
6. Starts the API, worker, and sidebar.

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
