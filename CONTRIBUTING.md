# Contributing

## Setup

```bash
pnpm install
pnpm check        # boundaries + lint + typecheck + all tests + gate evaluator
pnpm demo:dev     # demo app at http://localhost:5199
```

## Ground rules

- **One focused change per PR**, with tests. When a PR fixes a bug, add the
  regression test that fails without the fix.
- **`pnpm check` must pass** locally before pushing; the CI `check` job runs
  the same chain plus builds.
- **Boundaries are enforced**: core imports no React and nothing outside
  `orbit-engine-cosmos` imports cosmos (`pnpm boundaries`); the `orbit-data`
  root entry never bundles optional format parsers (pack-smoke's tree-shake
  gates, run by `pnpm smoke` and every release).
- **Performance claims need measurement.** CI runs deterministic
  operation-count gates only. Any wall-clock number must come from a real GPU,
  n≥3 runs, variance-qualified. SwiftShader numbers are never accepted.
- **Cross-cutting properties are non-negotiable** — read
  [docs/dev/engineering-rules.md](./docs/dev/engineering-rules.md)
  before your first substantial PR; reviews check against it.

## Docs layout

- `docs/core/` — consumer guides
- `docs/dev/` — contributor docs (invariants, design rules, process policies)
- `docs/internal/` — local-only working notes (gitignored, never committed)

## Releases

Versioning is [changesets](https://github.com/changesets/changesets)-based —
add a changeset with your PR when a package's public behavior changes. All
five packages release in lockstep.
