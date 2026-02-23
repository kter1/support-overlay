# Contributing

Thanks for contributing to `support_overlay`.

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

- Implement adapter logic under `packages/connectors/src/<provider>/`.
- Keep provider-specific details encapsulated in connector modules.
- Add integration tests for connector behavior.
- Document any required environment variables in `README.md` and docs.

## Tests

- Smoke tests: `npm run demo:smoke`
- Reset local state when needed: `npm run demo:reset`

## Pull Request Checklist

- [ ] Lint passes (`npm run lint`)
- [ ] Smoke tests pass (`npm run demo:smoke`)
- [ ] Docs updated for behavior/config changes
- [ ] New connector logic includes tests
