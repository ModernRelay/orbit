# OmniGraph 0.14 integration fixtures

These are verbatim HTTP bodies recorded from the official **OmniGraph 0.14.0**
server. Adapter tests replay them through the real TypeScript SDK. The live
integration tests also start a fresh local server and exercise both the adapter
and the demo's same-origin `/og` proxy.

## Contents

| Path | Purpose |
| --- | --- |
| `cluster/cluster.yaml` | One graph, `demo`, with a stored search query and no credentials or policies |
| `cluster/demo.pg` | Five node types and six edge types; dates, enums, numeric values, nullable properties, and a nullable user property named `Signal.id` |
| `cluster/queries.gq` | `search_signals`: ordered whole-node and title projections, bounded to ten rows |
| `seed.ndjson` | Deterministic 300-node, 500-edge seed, including hostile strings, Unicode, `Number.MAX_SAFE_INTEGER`, and parallel edges |
| `recorded/health.json` | `GET /healthz` |
| `recorded/http.json` | The required API contract header and actual `HEAD /healthz` discovery response |
| `recorded/schema.json` | `GET /graphs/demo/schema`, including `schema_source` and `system_columns` |
| `recorded/commits.json` | `GET /graphs/demo/commits?branch=main&limit=1` |
| `recorded/snapshot.json` | `GET /graphs/demo/snapshot` |
| `recorded/export.ndjson` | Full `POST /graphs/demo/export`, body `{}` |
| `recorded/export-partial.ndjson` | Export with `{"type_names":["Correlates","Signal"]}` |
| `recorded/search.json` | Stored `search_signals` invocation with `{"branch":"main","params":{"q":"Signal 1:"}}` |
| `recorded/manifest.json` | Server/HTTP versions, source heads, counts, and verified export ordering |

## Wire contract covered

- Requests and responses carry `Omnigraph-Http-Api: 0.14`. The SDK performs a
  public `HEAD /healthz` discovery request before graph operations. Public probes
  carry no bearer token; authenticated graph requests do.
- Commit listing returns a page envelope. The loader uses its captured
  `head_commit_id` to check source stability and requests just one commit.
- Export places physical identity in the **top-level `id`**. The `data` object
  contains only schema properties. Keyed node IDs equal their slugs; unkeyed
  edges use deterministic top-level IDs such as `own-0001`.
- `Signal.id` is an ordinary nullable numeric property. It must remain separate
  from the graph node's type-qualified identity. Other node types have no
  generated `attrs.id` field.
- Query columns are `s` and `s.title`; the whole-node value uses **`s['@id']`**
  for physical identity and `s.id` for the ordinary user property.
- `Date` exports as calendar strings. `DateTime` exports as UTC date-time
  strings without a `Z` suffix. The adapter normalizes the latter to ISO UTC
  strings with milliseconds and `Z`.
- Null-valued properties are omitted on the wire. The adapter fills declared
  nullable properties with explicit `null`, matching the generated `T | null`
  attribute types.
- The 500 edge records precede the 300 node records. The fixture script verifies
  this order and checks that the branch head is unchanged across export.

## Regenerate or serve locally

Install the official 0.14.0 CLI and server in a separate directory. Release
archives and their SHA256 files are available in the
[0.14.0 release](https://github.com/ModernRelay/omnigraph/releases/tag/v0.14.0).
The script checks the exact CLI and running server versions and fails if they
are missing or incompatible.

```sh
export OMNIGRAPH_BIN=/path/to/omnigraph-0.14.0/omnigraph
export OMNIGRAPH_SERVER_BIN=/path/to/omnigraph-0.14.0/omnigraph-server

# Regenerate seed + recordings, then stop and remove the temporary cluster.
node scripts/omnigraph-fixture.mjs

# Serve a fresh seeded fixture for the demo until Ctrl-C; no files regenerated.
node scripts/omnigraph-fixture.mjs --serve
```

Each invocation copies the declaration into a unique temporary directory and
creates its own operator configuration with an anonymous loopback server target.
It validates/lints the source, plans and applies to an explicit local root target, releases the exact
bootstrap writer lock after that process completes, starts the server, waits
for `/readyz`, and loads the seed through the served target. No operator defaults
or credentials from the host are used. It never opens or
wipes an existing graph. Shutdown waits for the owned server to exit before
removing that temporary directory. The default bind address is
`127.0.0.1:8199`; `OMNIGRAPH_FIXTURE_PORT` changes the port. An occupied port fails
rather than reusing an unrelated server.

Seed bytes and row values are deterministic. Commit IDs and `recordedAt` change
on each recording. After schema/codegen changes, rebuild the adapter and update
the demo's generated types:

```sh
pnpm --filter @modernrelay/orbit-omnigraph build
node packages/omnigraph/dist/codegen-cli.js fixtures/omnigraph/cluster/demo.pg \
  -o apps/demo/src/omnigraph-types.generated.ts
```

## Live verification

With the binary variables above, run:

```sh
OMNIGRAPH_LIVE_REQUIRED=1 pnpm --filter orbit-demo exec playwright test e2e/omnigraph.spec.ts
```

The spec owns fixture startup and teardown. It checks real export/search identity,
ordinary `id` data, nullable/date normalization, and browser loading through the
demo proxy. The dedicated CI job downloads the checksum-verified 0.14.0 Linux
release and requires both live tests; missing binaries fail that job. Other
local/demo runs may skip this spec when the pinned binaries are unavailable.
