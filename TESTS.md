# Tests And Smoke Tests

## Smoke Tests (fast validation)

`npm run demo:smoke` verifies:

- API `/health` returns HTTP 200.
- API metrics endpoint is reachable and DB-backed.
- Worker heartbeat is visible through metrics.
- Sidebar responds on configured local port.
- Seeded demo tickets return card payloads.

## Run Locally

```bash
# terminal 1: bring up all demo services
npm run demo:start

# terminal 2: run smoke checks
npm run demo:smoke

# optional cleanup
npm run demo:reset
```

## CI Notes

GitHub Actions runs a smoke workflow by starting the local demo stack and then running `npm run demo:smoke`.

## Adding Tests

- Put unit tests under `tests/unit/`.
- Put integration tests under `tests/integration/`.
- Keep smoke checks short and deterministic (< 60s target).
