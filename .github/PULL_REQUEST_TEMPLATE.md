## What & why

<!-- Two or three sentences: why this change, and any non-obvious how. Don't enumerate files touched — the diff already shows that. -->

**Testing:** <!-- Suites run, manual steps. e2e needs a live Stash instance, so it's not expected on every PR. -->

Closes:

## Checklist

- [ ] Title follows conventional commits (`type(scope): summary`) — enforced by the PR title check
- [ ] One type label (`enhancement` / `bug` / `documentation` / `chore`) and one `area:` label applied — docs-only changes take `documentation` alone
- [ ] Root `npm test` and `cd qa && npm test` pass; `npm run build` re-run if anything under `src/` changed (Stash serves `dist/`, not source)
