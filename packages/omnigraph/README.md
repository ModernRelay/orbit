# @modernrelay/orbit-omnigraph

Optional Omnigraph data-source adapter for Orbit. Framework-agnostic:
depends only on the framework-free ingestion/error surface of `@modernrelay/orbit-core`
and the official TypeScript SDK `@modernrelay/omnigraph` (0.14.0) — never on React, and
core never depends on it.

Requires Node.js 22+ for server/CLI use and the OmniGraph HTTP API contract `0.14`.
Upgrade the server and SDK together: 0.13 servers are rejected before graph reads.

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
graph. Ids are namespaced through the codec, and export values are normalized as
described below. Byte progress and budgets use re-serialized UTF-8 NDJSON size,
including one line break per export row.

OmniGraph 0.14 exports physical identity at the top level:

```json
{"type":"Signal","id":"signal-001","data":{"id":42,"title":"Latency spike"}}
{"edge":"Correlates","id":"edge-001","from":"signal-001","to":"signal-002","data":{"confidence":0.9}}
```

The node becomes `id: encodeSourceId('Signal', 'signal-001')` with
`attrs: { id: 42, title: 'Latency spike', 'orbit:type': 'Signal' }`.
Physical IDs never come from `data.id`; that field is an ordinary schema property.
Generated props contain only schema properties, retaining a declared `id` type and
nullability. Use `GraphNode.id` / `GraphEdge.id` for physical identity.

`Date` calendar strings are retained, with signed years padded to ISO's six digits.
UTC `DateTime` strings from the server omit
their zone, so the adapter adds explicit UTC and canonical milliseconds
(`2024-01-01T12:00:00` → `2024-01-01T12:00:00.000Z`), including list elements.
Omitted nullable schema properties become explicit `null`, matching generated
`T | null` fields. Inline `base64:` blobs become data URIs; external URIs pass through.
Null list elements are retained, so generated `[T]` attributes use `(T | null)[]`.
Vectors retain `number[]`: the server rejects null vector elements.

The `target` is structural (`IngestTarget`: `beginIngest` + `getRevisions` +
optional `getDiagnostics`) — deliberately decoupled from `GraphInstance`, which satisfies
it structurally; so does any recorder or headless pipeline.

## `sourceRevision` and drift

The canonical `sourceRevision` is a hash of
`{ graphId, branch, headBefore, headAfter, schemaFingerprint }` (plus `typeNames`
for partial exports). `/export` accepts a branch and pins an internal snapshot, but
does not accept the caller's sampled head, so `headAfter` is only knowable after the stream,
while core's `beginIngest` requires `sourceRevision` up front for a replace session.
Each head check requests a fresh commit-history page with `limit: 1` and reads its
captured `headCommitId`; it does not fetch the full history or follow continuation tokens.

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
  typeOf: { s: 'Signal' }, // REQUIRED: result column → node type for the id encoding
  // labelColumn: 's.title', // default: the first string-valued column per row
});

const instance = createGraphInstance({ engine, services: { search } });
```

For the repository's `search_signals` fixture query, use `queryName: 'search_signals'`
and `params: (q) => ({ q })`: that query declares only `q` and has a fixed server
limit of 10. The adapter still caps returned results at the caller's requested limit.

Row mapping (override wholesale with `mapRow: (row) => SearchResult | null`, `null` skips):

- **id** — Omnigraph ids are unique per type only and query rows carry no type
  discriminator, so the adapter **requires** a caller-supplied column→node-type mapping
  (`typeOf`): a record keyed by the bare-variable projection columns holding node structs
  (`return { $s }` → `{ s: 'Signal' }`; the first listed column present wins), or a
  per-row function returning the type name (the row's first node-struct column supplies the
  physical `@id`). For example, `{ s: { '@id': 'signal-001', id: 42 } }` identifies
  `signal-001`; its ordinary `id` property is not used. Every physical id is qualified via `encodeSourceId(nodeType, physicalId)` — it
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
> full graph, to avoid the mismatch. Discovery via `og.queries.list()` returns the
> full stored-query registry; MCP exposure does not restrict SDK discovery or invocation.

## Server-only entry — do not import from the browser

`@modernrelay/orbit-omnigraph/server` (`createOmnigraphServerClient`) is the only
authenticated SDK construction supplied by this adapter and must stay server-side:
the helper accepts a static bearer token (secret material). Browser deployments
pass a preconfigured safe same-origin/public client to `createOmnigraphSource` — the
browser entry deliberately has no `baseUrl`/`token` option — and typically route reads
through a proxy/BFF. A client-bundle exclusion gate (`scripts/pack-smoke.mjs`,
`treeshake:omnigraph-client`) asserts the server entry never reaches a client bundle.

The SDK sends `Omnigraph-Http-Api: 0.14` and checks the matching response header,
including on streams and errors. It performs an unauthenticated `HEAD /healthz`
contract check before each graph request; `GET /healthz` is also public. A proxy
must preserve these methods and headers. Configure the server access policy to
permit the adapter's schema, commit, export, and stored-query reads; supplying a
static token alone does not grant every operation under the server's access policy.

## Error surface

SDK typed errors (`NetworkError`, `ConflictError`, …) never cross this package's public
surface — failures rethrow as plain `Error`s with a stable `omnigraph:` message prefix.
Cancellation (`AbortSignal`) surfaces as an `AbortError`; the session is aborted and the
graph left untouched. This includes cancellation during contract discovery and
stored read-query invocation. Missing or mismatched HTTP contract headers fail closed
before ingestion can commit. A build-version `major.minor` mismatch (`og.health()`
vs the SDK's pinned `SERVER_VERSION`) warns only when the HTTP contract checks pass.

## Also in the box

- `encodeSourceId`/`decodeSourceId`/`encodeSyntheticEdgeId` — the identity codec
  every adapter path must use.
- `parsePgSchema`/`edgeEndpointTypes`/`schemaFingerprint`/`bigIntKeyWarnings` — the `.pg`
  schema model: endpoint-type resolution, wire-type knowledge, revision fingerprint.
- `classifyExportLine`/`normalizeNode`/`normalizeEdge` — export-line normalization.
