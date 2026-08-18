# @modernrelay/orbit-omnigraph

## 0.15.0

### Minor Changes

- 5771a0d: Correctness and lifecycle hardening across graph admission, worker packaging,
  deferred engine commits, data preparation, Omnigraph parsing, and React
  interactions. Invalid inputs are rejected consistently, deferred buffers and
  asynchronous sources have explicit ownership, generated types match runtime
  identity rules, and keyboard and pointer paths preserve host callback
  contracts.

### Patch Changes

- Updated dependencies [5771a0d]
  - @modernrelay/orbit-core@0.15.0

## 0.14.0

### Minor Changes

- First public release. The orbit source repository is now open at
  [github.com/ModernRelay/orbit](https://github.com/ModernRelay/orbit) —
  public issue tracker, contributor guide, engineering rules, and CI with
  required status checks. Package behavior is unchanged from 0.13.6; the
  published READMEs and diagnostic messages were reworded for the public
  repository.

## 0.13.6

### Patch Changes

- External-review fix pass (16 findings; 15 confirmed, 1 partial — every fix
  pinned from the failing side).

  Release blockers: the inline worker asset now builds SELF-CONTAINED (its
  chunk imports broke under bundlers that inline worker URLs — pack-smoke
  gates the shape); `setViewState` applies the serialized `layout.kind`;
  a cosmos link click no longer fires the background path first; Omnigraph
  partial exports join sorted `typeNames` into `datasetKey`/`sourceRevision`/
  `dataRef` (two subsets at one head can no longer replay as one another —
  NOTE: persisted partial-export revisions from ≤0.13.5 no longer match; full
  exports are unchanged); `.pg` node head annotations parse instead of
  silently dropping the declaration; an initially-fixed mount pauses the
  engine (probe evidence: cosmos holds positions without start() — this is
  state alignment, not drift repair).

  Correctness: node ids containing U+0000 are rejected at validation in both
  lanes (internal scene-key collision); export streams resolve visibility at
  capture; the dead-worker fallback re-validates mid-flight-mutated
  snapshots; malformed columnar objects reject whole instead of throwing;
  `<GraphTable>` clears its previous brush on dimension/mode/instance
  changes; data-lane hardening (a first yielded `undefined` reports malformed
  row zero, peeked iterators close on failure/early exit, `__proto__` row
  keys land as own properties, Arrow/Parquet BigInt normalization reaches
  nested list/struct leaves); same-line `.pg` properties all parse.

- Updated dependencies
  - @modernrelay/orbit-core@0.13.6

## 0.13.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @modernrelay/orbit-core@0.13.5

## 0.2.0

### Minor Changes

- **BREAKING (pre-1.0):** the adapter's node/edge kind discriminator moves from
  `attrs.type` to `attrs['orbit:type']`.

  The adapter injects a synthetic field into someone else's data, so it now takes
  the namespaced key and leaves the generic word to the schema author. A colon is
  illegal in `.pg` identifiers, so `orbit:type` can never collide — which means a
  schema-declared `type` property (e.g. `Company.type = investor | bigtech`) now
  loads as **ordinary data**, with no preservation mechanism, no per-load warning,
  and no schema migration needed on the graph side.

  This supersedes the short-lived `attrs['og:type']` preservation scheme: that
  mechanism, its load warning, and its codegen special case are all deleted, since
  the collision class is now closed by construction rather than mitigated after the
  fact. The convention matches GraphQL's `__typename` and JSON-LD's `@type`.

  - `ORBIT_TYPE_KEY` is exported so consumers never hardcode the string.
  - Generated attrs unions discriminate on `'orbit:type'`; a schema property named
    `type` emits as an ordinary member.
  - The injected value still lands last in the attrs spread, so an export field
    literally named `orbit:type` cannot forge the discriminator.

  **Migration:** anything reading `attrs.type` off an adapter-loaded snapshot must
  read `attrs[ORBIT_TYPE_KEY]`. This fails _silently_ under `Record<string,
unknown>` access — and on a graph whose schema declares its own `type`, the old
  key now returns that source value instead.

- First release of the Omnigraph source adapter.

  - `createOmnigraphSource()`: streams `og.export()` NDJSON through the official
    `@modernrelay/omnigraph@0.8.0` SDK into an orbit replace `IngestSession` with
    bounded backpressure — edge-before-node order handled by the core's
    pending-endpoint index. Branch-head revision stamping (`headBefore`/
    `headAfter` + schema fingerprint) with `reject`/`accept-warn`/`retry-once`
    drift policies; SDK/server version-mismatch surfacing; per-type partial
    loads; abort forwarding.
  - Collision-proof tuple id codec (`encodeSourceId`) + synthetic-edge codec
    (never mixable with physical ids); `.pg` schema parser with edge endpoint
    resolution, schema fingerprinting, and i64/u64 `@key` hazard warnings.
  - Wire normalization: export-path `Date` day-numbers → 'YYYY-MM-DD',
    `DateTime` epoch-ms → ISO strings, `base64:` blobs → data URIs,
    `attrs['orbit:type']` discriminator injection.
  - `.pg` → TypeScript codegen (`orbit-omnigraph-codegen` CLI): typed attrs
    interfaces + discriminated unions per node/edge type.
  - `@modernrelay/orbit-omnigraph/server`: the only authenticated client
    construction, excluded from client bundles (gate enforced in pack-smoke).
  - Deferred beyond this release: `SearchService` wiring, count-annotated
    legend, and query-path expansion.

- v0.9 data preparation package, search, and inspection components.

  - **New package `@modernrelay/orbit-data`**: `prepareGraphData` turns
    CSV (streaming RFC-4180), JSON documents, Arrow tables (`/arrow`), and
    Parquet files (`/parquet`) into typed columnar `GraphHostUpdate`s with
    per-column summaries and a `mappingFingerprint` for reload skipping.
  - **search seam**: `SearchService` contract on the instance
    (`instance.search` / `activateSearchResult` / `clearSearch`) with
    revision-keyed caching, supersede cancellation, and admission-gated stale
    rejection. Built-in `createLocalSearchService` indexes the id plus declared
    `searchIndex` fields once per model revision. Tiered scoring: exact id (3)
    > exact field (2.5) > id prefix (2) > field prefix (1.5) > token-start
    > substring (1.25) > substring (1) — an exact name match outranks id-substring
    > floods. Activation resolves to `focused` or a typed unavailable reason
    > (`not-loaded` / `out-of-scope` / `filtered`).
  - **Omnigraph stored-query search**: `createOmnigraphSearchService` runs
    server-side stored queries (bm25/fuzzy/vector) and returns namespaced ids.
  - **New components**: `/components/Search` (ARIA combobox, debounced,
    `renderResult` escape hatch), `/components/Minimap` (256² CPU overview
    rasterizer with brush-to-pan), `/components/Tooltip`, and
    `/components/Inspector`; the Navigator lists search results.
  - **Cosmos camera**: `setViewport` now really pans (exact center+zoom via
    `setZoomTransformByPointPositions` with explicit scale) — recovery
    restores the full camera, lifting the zoom-only limitation.

- Hardening plus post-merge review follow-up fixes.

  The hardening pass covered ingestion serialization, edge identity (collision-proof
  escaped synthesis — ids for endpoint ids containing `\`, `→`, `#` differ
  from earlier releases), cosmos lifecycle/queued
  commits/recovery, the Omnigraph loader's drift and abort paths, and React
  remount lifecycles, and made Playwright (including a real WebGL
  context-recovery scenario) a required CI gate.

  Follow-up (post-merge audit fixes):

  - `orbit-core`: an over-budget atomic append now rejects only that append —
    the session and staged prefix survive (a regression temporarily made it
    a terminal session abort); unchanged declared node.x/y seeds no longer
    snap drifted force layouts back (and reheat) on attrs-only revisions —
    a declaration wins only when new to the scene or changed.
  - `orbit-engine-cosmos`: a queued `restart: false` no longer cancels a
    pending queued restart directive (contract: false ≡ absent = keep state).
  - `orbit-omnigraph`: accept-warn loads no longer fail late (or livelock)
    when unrelated overlay publications race a long export stream — the
    deferred session reads a fresh CAS base and only a source-lineage change
    aborts the load; schemas declaring a property named `type` now get a
    shadowing warning instead of a silent drop.

### Patch Changes

- Packages become publishable: MIT license (a LICENSE copy ships in every
  tarball — previously there was none, which reads as all-rights-reserved on
  public npm), plus `description` and `repository` (with `directory`, as npm
  provenance requires) in every manifest.

  Infrastructure landing alongside, recorded here for the changelog: Playwright
  e2e is a blocking CI gate again (retired — during its opt-in period two
  stale assertions sat red for three releases unnoticed), and the changesets
  release workflow is live — merging the auto-opened "Version Packages"
  PR is now the one human act that publishes, gated behind build + pack-smoke
  in the same invocation.

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @modernrelay/orbit-core@0.2.0
