# support_overlay

IRIL: Issue Resolution Integrity Layer.

`support_overlay` is a Zendesk sidebar + backend prototype focused on policy-driven issue resolution, approval workflows, and safer third-party side effects through an outbox worker.

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

- Table-driven policy checks and approval lifecycle support.
- One-command local startup with recovery logic: `npm run demo:start`.
- Environment diagnostics: `npm run doctor`.
- Local smoke checks for demo confidence: `npm run demo:smoke`.
- Outbox worker model for safer side effects against Zendesk, Stripe, and Shopify.

## Quick Start

```bash
git clone https://github.com/kter1/support_overlay.git
cd support_overlay
npm ci
export POSTGRES_PASSWORD=<postgres_password>
export OPERATOR_TOKEN=<operator_token>
export AGENT_TOKEN=<agent_token>
export DATABASE_URL="postgresql://iisl:${POSTGRES_PASSWORD}@127.0.0.1:5432/iisl"
export POSTGRES_USER=iisl
export POSTGRES_DB=iisl
export API_PORT=3001
export WORKER_POLL_INTERVAL_MS=2000
export WORKER_MAX_ATTEMPTS=5
export USE_ZENDESK_SIMULATOR=true
export USE_STRIPE_SIMULATOR=true
export USE_SHOPIFY_SIMULATOR=true
export VITE_API_BASE_URL=http://localhost:3001
npm run demo:start
```

Optional: generate local random values (macOS/Linux):

```bash
export POSTGRES_PASSWORD="$(openssl rand -hex 18)"
export OPERATOR_TOKEN="$(openssl rand -hex 24)"
export AGENT_TOKEN="$(openssl rand -hex 24)"
```

These values are local demo credentials/tokens for this shell session only.

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

![Architecture diagram for support_overlay showing sidebar, API, Postgres, outbox worker, and third-party connectors](docs/architecture-diagram.png)

Alt text: architecture diagram showing Zendesk sidebar -> Fastify API -> Postgres -> outbox worker -> Stripe, Shopify, and Zendesk connectors.

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
- `scripts/demo-start.ts`: main local bootstrap flow.
- `scripts/demo-reset.ts`: local reset flow.
- `scripts/demo-smoke.ts`: smoke checks against live services.

## Testing And CI

GitHub Actions workflow: `.github/workflows/ci.yml`

CI validates:

1. Static lint/type checks.
2. End-to-end local smoke flow (`demo:start` + `demo:smoke`) on Linux runner.

## Contributing

See `CONTRIBUTING.md`.

## License

MIT. See `LICENSE`.
