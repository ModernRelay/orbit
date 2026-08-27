# @modernrelay/orbit-data

## 0.16.0

### Patch Changes

- Updated dependencies [212b31f]
- Updated dependencies [893a1d2]
  - @modernrelay/orbit-core@0.16.0

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

- v0.10 semantic exploration — groups, groupBy, semantic zoom,
  clusters, paths, pins, table and sim controls — plus the eight remaining
  verified correctness fixes.

  ### groups and derived grouping

  - **Stage-3 group rewrite**: collapsed groups become super-nodes with
    count-badged meta-edges, rerouted through the existing structural
    diff — a 1,000-member collapse/expand costs O(members + incident edges),
    never a reload. Flat/disjoint validation rejects before any rewrite.
    Caller accessors never see synthetics (aggregate channels style them).
  - **Group operations and events**: `groupNodes` / `ungroup` /
    `setGroupCollapsed` / `selectGroups` through ownership; typed
    `groupClick` / `metaEdgeClick` events; group ids occupy their own
    namespace (a node and a group may share an id); isolating a selection
    containing a collapsed group scopes to its members as a unit.
  - **`groupBy`**: derived read-only membership with a collision-safe id
    codec, per-key collapsed residue, and `groups` + `groupBy` together as
    one config error where _neither_ lane applies.
  - **Semantic zoom**: hysteresis band tracking from viewport events —
    below `collapseBelow` everything collapses, above `expandAbove` only
    groups intersecting the viewport expand, and the corridor between holds.
    The in-view test measures the group _as drawn_ and fails open, so a
    group is never stranded collapsed.

  ### clusters, paths, pins

  - **Clusters**: non-collapsing stage-4 derivation preserving every node
    and edge, with force centers generated deterministically from ordered
    keys plus the layout seed using only correctly-rounded IEEE-754 ops —
    identical centers across machines, not just runs. Capability-gated,
    degrading loudly where absent. **CosmosEngine declares `clusterForce:
true`**: the 3.3.0 pin genuinely ships `setPointClusters`,
    `setClusterPositions`, `setPointClusterStrength` and a `Clusters` GPU
    module (typing-scan evidence; the visible force behavior is not yet
    GPU-probed — recorded in the adapter README).
  - **Cluster labels** join the overlay lane: anchored to force centers
    while hot, re-anchored from the single permitted settle readback, with
    zero per-frame member scans; `label.maxZoom` switches the cluster and
    node label bands; clicking a cluster label selects its members.
  - **Paths**: `findPath` / `clearPath` with a local BFS service. One
    application is one atomic link commit plus one highlight push; the path
    owns emphasis until `clearPath`, any selection mutation, undo/redo, or a
    scene rebuild releases it — never a history step, never serialized.
  - **Persistent pins**: `pinnedNodeIds` plus `pinNodes` / `unpinNodes`
    through, unioned with transient drag pins at the engine, so
    releasing a drag on a persistently pinned node leaves it pinned.
  - **Parallel-edge grouping** collapses same-pair edges into one
    count-weighted meta-edge, with a documented no-op diagnostic on datasets
    whose ids already collapse parallels.

  ### New components

  `/components/Table` — virtualized `<GraphTable>` (bounded mounted rows at
  100K), bidirectional crossfilter and selection sync, `coerceNumeric`-aware sorting,
  and RFC-4180 CSV export with formula-injection neutralization plus a
  documented opt-out. `/components/SimControls` — `<GraphSimControls>`
  writing config-only commits that never move the layout.

  ### Remediation follow-up

  Transactional crossfilter swap (a failed spec replacement leaves the live
  engine untouched), timeline option validation at the boundary, an explicit
  `nodeImage` clear transition, roster-atomic `pointImageIndex` on every
  structural commit, `ImageBitmap` close paths with a bounded live count,
  query-coherent search activation, admitted-schema fingerprints, and an
  evaluated perf gate whose true L tier (100K/250K) now actually runs.

  ### Fixed

  `expandNode` resolved one microtask _before_ its own trailing publication,
  so a host that awaited it observed a stale `pendingExpansions` loading
  affordance and an under-reported `history.undoDepth`. Found by the new
  history random-walk suite.

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
