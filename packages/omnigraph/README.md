# @modernrelay/orbit-omnigraph

Optional Omnigraph data-source adapter for Orbit. Framework-agnostic:
depends only on the framework-free ingestion/error surface of `@modernrelay/orbit-core`
and the official TypeScript SDK `@modernrelay/omnigraph` (0.9.x) — never on React, and
core never depends on it.

## The v1 rule

> **v1 loads graphs via `og.export()`; queries only ever resolve ids** for search and
> overlay selection. The query path never introduces nodes or
> edges into the graph.

Export is the only complete-graph read: it streams NDJSON with full identity — physical
edge ids included — so every v1 edge carries an export id and no synthesized-id scheme ever
mixes in. Server-backed expansion, query-path loading, and authenticated blob fetches
remain outside the adapter's v1 scope.

## Quick start

```ts
// server.ts — the ONLY place authenticated construction lives
import { createOmnigraphServerClient } from '@modernrelay/orbit-omnigraph/server';

const client = createOmnigraphServerClient({
  baseUrl: 'http://127.0.0.1:8080',
  token: process.env.OMNIGRAPH_TOKEN!, // secret material — server-side only
});
```

```ts
// anywhere (browser code passes a preconfigured safe client instead — see below)
import { createOmnigraphSource } from '@modernrelay/orbit-omnigraph';
import { createGraphInstance } from '@modernrelay/orbit-core';

const source = createOmnigraphSource({
  client, // preconfigured SDK client — no token option here
  graphId: 'demo',
  branch: 'main', // default
  // typeNames: ['Signal', 'Correlates'], // partial per-type load (wire: type_names)
  // driftPolicy: 'reject', // default; see below
  // maxPendingBytes: 512 * 1024 * 1024, // default whole-load atomic budget
  onProgress: ({ lines, nodes, edges, bytes }) => console.log(lines, nodes, edges, bytes),
});

const instance = createGraphInstance({ engine });
const result = await source.load(instance /*, abortSignal */);
// result: { sourceRevision, dataRef, counts, serverVersion, warnings }
```

`load()` drives one streamed export pass into a `purpose:'replace'` ingest session
(`datasetKey` = `og:<graphId>:<branch>`): edge lines arrive first (lexicographic table-key
order) and pass straight through — core's pending-endpoint index links them as nodes land. Every append is awaited, and the atomic load has a finite whole-export byte budget
(`maxPendingBytes`, 512 MiB by default); exceeding it aborts without publishing a partial
graph. Ids are namespaced through the codec, and wire encodings are normalized to
the query-path string forms. Byte progress and budgets use re-serialized UTF-8 NDJSON size,
including one line break per export row.

The `target` is structural (`IngestTarget`: `beginIngest` + `getRevisions` +
optional `getDiagnostics`) — deliberately decoupled from `GraphInstance`, which satisfies
it structurally; so does any recorder or headless pipeline.

## `sourceRevision` and drift

The canonical `sourceRevision` is a hash of
`{ graphId, branch, headBefore, headAfter, schemaFingerprint }` — but `/export` is
branch-only (no snapshot isolation), so `headAfter` is only knowable after the stream,
while core's `beginIngest` requires `sourceRevision` up front for a replace session.

Resolution: under `'reject'` and `'retry-once'`, a session begins under the **provisional**
revision (the canonical hash with `headAfter := headBefore`), the stream appends into it,
and the head is re-read **before** `commit()`. `'accept-warn'` buffers the bounded export
until that second head is known, then opens one session under the canonical final revision:

- **equal heads** — provisional === final; commit cleanly. The steady-state path.
- **drift** (`driftPolicy`):
  - `'reject'` (default) — abort the session and throw `OmnigraphDriftError`; the graph is
    untouched. Right for durable/shareable sessions.
  - `'accept-warn'` — commit under the canonical final revision; `dataRef` records
    **both** heads and a warning is added to the result.
  - `'retry-once'` — abort and restart the whole load once; a second drift rejects.

This is sound because a replace session is atomic and invisible until commit:
nothing publishes under a revision the policy did not explicitly accept, and the decision
is never hidden — every accepted drift or retry appears in `result.warnings`.

A second identical load of a quiescent branch produces the same
`{datasetKey, sourceRevision}` and replays idempotently — core publishes nothing.

## Search: stored-query `SearchService`

`createOmnigraphSearchService` wires a stored server-side search query (BM25 / fuzzy /
vector / RRF with `order { score desc } limit K`) as a core `SearchService` — plug it into
core as `services.search` and the instance owns `RequestContext` creation, revision-keyed
caching, supersede cancellation, and stale-result admission. The service declares
`revisionDependencies: ['source']` and passes `ctx.signal` through SDK `CallOptions`, so a
superseded keystroke cancels the in-flight HTTP call.

```ts
import { createOmnigraphSearchService } from '@modernrelay/orbit-omnigraph';

const search = createOmnigraphSearchService({
  client, // preconfigured SDK client — same rule as the loader
  graphId: 'demo',
  branch: 'main', // default
  queryName: 'search-intel', // registry name; invoked as POST /queries/search-intel
  // params: (q, limit) => ({ q, limit }), // default — reshape for your query's params
  typeOf: { $s: 'Signal' }, // REQUIRED: column → node type for the id encoding
  // labelColumn: '$s.title', // default: the first string-valued column per row
});

const instance = createGraphInstance({ engine, services: { search } });
```

Row mapping (override wholesale with `mapRow: (row) => SearchResult | null`, `null` skips):

- **id** — Omnigraph ids are unique per type only and query rows carry no type
  discriminator, so the adapter **requires** a caller-supplied column→node-type mapping
  (`typeOf`): a record keyed by the bare-variable projection columns holding node structs
  (`return { $s }` → `{ $s: 'Signal' }`; the first listed column present wins), or a
  per-row function returning the type name (the row's first node-struct column supplies the
  physical id). Every id is qualified via `encodeSourceId(nodeType, physicalId)` — it
  round-trips `decodeSourceId` and matches export-loaded node ids exactly.
- **score** — a finite number in the row's `score` column (the score lane never doubles as
  a label).
- **label** — `labelColumn`'s value when configured, else the first string-valued column in
  row key order.

Trivial calls (empty query, non-positive limit) resolve `[]` without a network call, and
results are defensively capped at the requested limit. SDK typed errors
rethrow as plain `omnigraph:`-prefixed `Error`s; aborts surface as `AbortError`.

> **v1 caveat:** the stored query searches the WHOLE branch server-side, so against a
> *partial* export load (`typeNames`) it can return ids outside the loaded set.
> `activateSearchResult` classifies those as `'not-loaded'` — the host may remedy
> that only by re-running export for the relevant types (query-path single-node fetch is
> not implemented in v1). Constrain the stored query to the loaded types, or load the
> full graph, to avoid the mismatch. Discovery via `og.queries.list()` returns only the
> `mcp.expose == true` registry subset — invoking a known `queryName` works regardless.

## Server-only entry — do not import from the browser

`@modernrelay/orbit-omnigraph/server` (`createOmnigraphServerClient`) is the only
authenticated SDK construction and must stay server-side: `omnigraph-server` ships no CORS
configuration and uses static bearer tokens (secret material). Browser deployments
pass a preconfigured safe same-origin/public client to `createOmnigraphSource` — the
browser entry deliberately has no `baseUrl`/`token` option — and typically route reads
through a proxy/BFF. A client-bundle exclusion gate (`scripts/pack-smoke.mjs`,
`treeshake:omnigraph-client`) asserts the server entry never reaches a client bundle.

## Error surface

SDK typed errors (`NetworkError`, `ConflictError`, …) never cross this package's public
surface — failures rethrow as plain `Error`s with a stable `omnigraph:` message prefix.
Cancellation (`AbortSignal`) surfaces as an `AbortError`; the session is aborted and the
graph left untouched. SDK/server `major.minor` version mismatches (`og.health()` vs the
SDK's pinned `SERVER_VERSION`) surface as a result warning, never a hard failure.

## Also in the box

- `encodeSourceId`/`decodeSourceId`/`encodeSyntheticEdgeId` — the identity codec
  every adapter path must use.
- `parsePgSchema`/`edgeEndpointTypes`/`schemaFingerprint`/`bigIntKeyWarnings` — the `.pg`
  schema model: endpoint-type resolution, wire-type knowledge, revision fingerprint.
- `classifyExportLine`/`normalizeNode`/`normalizeEdge` — export-line normalization.
