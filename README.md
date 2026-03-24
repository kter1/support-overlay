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
npm run demo:start
```

Open:

- UI: `http://localhost:5173`
- API health: `http://localhost:3001/health`

## Demo - First Run

`npm run demo:start` performs:

1. Dependency/bootstrap checks.
2. `.env` validation (manual `.env` required in repo root).
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
