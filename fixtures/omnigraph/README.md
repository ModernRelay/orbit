# Omnigraph real-data fixtures

Recorded HTTP responses from a real `omnigraph-server` (0.8.x), used to test
`@modernrelay/orbit-omnigraph` against genuine wire
bytes instead of hand-written mocks. Tests inject a replay `fetch` into the
real `@modernrelay/omnigraph` SDK (`OmnigraphOptions.fetch`) and serve these
files for the requests the SDK issues.

## Layout

| Path | What |
|---|---|
| `cluster/cluster.yaml` | Minimal cluster config: one graph `demo`, no policies, no embedding provider |
| `cluster/demo.pg` | Schema (5 node types, 6 edge types) — adapted from omnigraph's `context.pg` test fixture, extended to cover every wire encoding (`Date`, `DateTime`, `enum`, `F64`, `I64`, optional `String`, edge properties) |
| `seed.ndjson` | Deterministic seed data in the `omnigraph load` line format: 300 nodes + 500 edges, seeded PRNG, hostile strings (`<script>` payload in `decision-013`, quotes/backslashes in `decision-027`), non-ASCII text, dates spanning 2015–2026, one `I64` pinned at `Number.MAX_SAFE_INTEGER` (`trace-042`), two deliberate parallel `ParticipatedIn` edges (`part-0119`/`part-0120` duplicate `part-0001`'s endpoints) |
| `recorded/health.json` | `GET /healthz` |
| `recorded/schema.json` | `GET /graphs/demo/schema` |
| `recorded/commits.json` | `GET /graphs/demo/commits?branch=main` |
| `recorded/snapshot.json` | `GET /graphs/demo/snapshot` |
| `recorded/export.ndjson` | `POST /graphs/demo/export`, body `{}` — the full 800-line stream |
| `recorded/export-partial.ndjson` | `POST /graphs/demo/export`, body `{"type_names":["Correlates","Signal"]}` |
| `recorded/manifest.json` | `recordedAt`, `serverVersion`, `graphId`, `branch`, `headBefore`/`headAfter` (equal for a quiescent branch), per-table `rowCounts`, verified export line ordering |

All `recorded/*` bodies are **verbatim wire bytes** (captured with curl against
the exact paths/methods/bodies the SDK's transport builds — graph-scoped paths
are prefixed `/graphs/<graphId>`; envelope keys on the wire are snake_case,
the SDK camelizes them client-side).

Ground truth worth knowing (visible in `export.ndjson`):

- Tables stream in lexicographic table-key order, so all `edge:*` lines
  (500) precede all `node:*` lines (300).
- `Date` cells export as **numbers** (days since Unix epoch).
- `DateTime` cells export as ISO strings without a zone suffix
  (e.g. `"2026-02-28T03:04:27.939"`) on server 0.8.1 — normalization must be
  written against these recorded bytes rather than an assumed zone suffix.
- Node `data.id` equals the `@key` slug; edge `data.id` values are the
  explicit deterministic ids from `seed.ndjson` (`own-*`, `rec-*`, `part-*`,
  `sup-*`, `trig-*`, `corr-*`).

## Regenerating

```sh
node scripts/omnigraph-fixture.mjs
```

The script wipes `cluster/graphs/` + `cluster/__cluster/` (generated, git-
ignored), re-creates the graph via `omnigraph cluster import` + `cluster
apply --as fixture-bot`, regenerates `seed.ndjson` (fixed PRNG seed —
byte-identical every run), loads it with `--mode merge` (idempotent: every
edge carries an explicit `data.id`), boots `omnigraph-server --cluster
fixtures/omnigraph/cluster --unauthenticated --bind 127.0.0.1:8199`, records
the responses above, verifies them (line counts, edge-before-node ordering,
non-empty bodies), writes the manifest, and kills the server.

Commit ids and `recordedAt` differ per run; the row data does not.

## Binary requirements

- `omnigraph` CLI and `omnigraph-server`, 0.8.x, on `PATH`
  (`brew`-installed at `/opt/homebrew/bin` on the machine that recorded these)
- `curl`, Node ≥ 20

Neither binary is available in CI — there the script prints `SKIP` and exits
0; the committed recordings are authoritative until someone regenerates them
locally.
