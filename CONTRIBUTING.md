# Contributing

Thanks for contributing to `support-overlay`.

## Workflow

- Create a branch from `main` using `feature/<short-desc>` or `fix/<short-desc>`.
- Open a pull request to `main`.
- Use conventional commit style when possible (`feat`, `fix`, `docs`, `chore`).

## Local Development

```bash
npm ci
npm run doctor
npm run demo:start
```

## Adding A Connector

- Implement adapter logic under `packages/connectors/src/<provider>/` and export
  it from `packages/connectors/src/index.ts`.
- Keep provider-specific details encapsulated in connector modules.
- **Classify failures.** Throw `TimeoutError` when a request was sent but no
  response arrived, `PermanentError` for rejections that retrying cannot fix,
  and a plain `Error` for everything else. The worker's retry policy depends on
  this distinction; a timeout misreported as a generic failure is what causes a
  duplicate side effect.
- Add tests for connector behavior, including the timeout path.
- Document any required environment variables in `README.md` and docs.

## Tests

- Smoke tests: `npm run demo:smoke`
- Reset local state when needed: `npm run demo:reset`

## Pull Request Checklist

- [ ] Lint and typecheck pass (`npm run lint`)
- [ ] Tests pass (`npm test`)
- [ ] Smoke tests pass (`npm run demo:smoke`)
- [ ] Docs updated for behavior/config changes
- [ ] New connector logic includes tests
