# @modernrelay/orbit-engine-cosmos

## 0.14.0

### Patch Changes

- e018c16: Documentation scrub: internal specification/register anchors removed from
  all published surfaces — package READMEs, code comments, diagnostic message
  strings, and the codegen output header (regenerated golden). No behavioral
  changes beyond the reworded diagnostic/codegen strings.
- Updated dependencies [e018c16]
- Updated dependencies
  - @modernrelay/orbit-core@0.14.0

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

### Minor Changes

- **Emphasis ring** — named, themed, toggleable, keyboard-accessible.

  The ring that follows pointer hover has been rendering since v0.1 (cosmos
  draws its focused-point ring whenever a focused index is set — silently
  white, untoggleable, unthemed). This release takes control of it:

  - `theme.emphasisRing` token (dark `#7aa2f7`, light `#2563eb`) — the ring is
    now themed instead of hardcoded white. **Pre-1.0 breaking**: `GraphTheme`
    gains a required token, so full-literal theme constructions need the new
    field; `Partial` theme inputs are unaffected.
  - `emphasisRing` prop (default `true`, preserving today's affordance).
    `false` clears the ring once and suppresses every driver — hover,
    `focusNode`, `emphasizeNode` — at one core gate.
  - `emphasizeNode(id | null)` instance op + `GraphHandle` forward: ring
    WITHOUT the camera move. `<GraphNavigator>` now rings the active row on
    arrow/paging navigation and clears on Escape/blur/unmount — keyboard users
    previously got no ring at all.

- **Quiescence via cosmos 3.4.0.**

  A settled, untouched graph now consumes ZERO requestAnimationFrame callbacks —
  no GPU, CPU, or battery burn at rest (measured: 0 idle frames and 0 rAF
  registrations per 750ms, down from 91 on cosmos 3.3).

  - **engine-cosmos**: pin bumped to `@cosmos.gl/graph@3.4.0` (on-demand
    rendering upstream; all 11 probes re-run and green). The
    adapter's onFrame activity clock is now GATED: it free-runs only while the
    sim is hot, a drag is active, or a cosmos transition runs, and otherwise
    burns a small tick budget that every visual write re-arms. Every wake
    release grants one trailing frame, so drag drops and final sim frames
    always render. `captureScreenshot()` wakes the renderer first (idle buffers
    read blank under on-demand rendering). `pointOcclusionCulling` is pinned
    off for pixel-baseline stability; enabling it requires separate threshold validation.
    `simulation.repulsionTheta` is no longer forwarded — cosmos ≥3.4 grid-based
    repulsion ignores it — with a one-shot `engine:repulsion-theta-deprecated`
    diagnostic.
  - **core**: `EngineCapabilities` gains `idleFrames: 'stops' | 'free-running'`
    and `postDrawFrames: boolean` (previously prose-only); `EnginePolicy`
    resolves `quiescence` for telemetry. New public `/testing` instrument
    `installRafAudit` counts rAF scheduling separately from delivered ticks —
    the stop-at-rest evidence tool. `SimulationConfig.repulsionTheta` is
    `@deprecated` (retained for Barnes-Hut engines).
  - **react**: the `<GraphSimControls>` repulsionTheta slider is removed (inert
    on cosmos ≥3.4 — a control that visibly does nothing is worse than none).

### Patch Changes

- **telemetry + degradation ladder**.

  - `getPerfSnapshot()` and the throttled `onPerfSample` event: counts, byte
    estimates, queue depth, revisions, last-commit phase decomposition,
    active ladder steps, execution lane, range availability, and a pressure
    mirror (frame EWMA / dropped frames / idle wakeups) — never raw attrs or
    ids.
  - The degradation ladder: `limits` (construction-only) over the spec
    defaults, `onDegrade` events, ±10% hysteresis with a 1s dwell, and the
    trigger families — count thresholds, measured frame pressure (engages
    the cheap steps early, releases on recovery), resource order.
  - Step effects: `cap-dom-labels` holds DOM labels at the label budget,
    `defer-link-picking` arms edge hover at rest only, `batch-histograms`
    coalesces crossfilter notifications to one flush per frame,
    `disable-transitions` turns engine transitions into atomic jumps,
    `defer-images` queues rosters until pressure clears.
  - React: `<Graph limits onDegrade onPerfSample>`, `handle.getPerfSnapshot()`;
    event subscriptions now attach before the first host update, so
    mount-time events reach first-render listeners.

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

- Expose the rest of the force tunables.

  `SimulationConfig` carried five knobs (gravity, repulsion, friction, link
  distance, link spring) while the engine implemented several more that no host
  could reach. It now covers the full set:

  - **`decay`** — the cool-down coefficient. Controls how long a run takes to
    settle; smaller cools slower.
  - **`collision`** (+ `collisionRadius`, `collisionPadding`) — overlap
    resolution. Ships **off** at the engine default, which is why dense clusters
    render as solid blobs until you turn it on.
  - **`repulsionTheta`** — the Barnes-Hut opening angle behind the many-body
    approximation: larger is coarser and faster, smaller is more exact.
  - **`center`** — attraction toward the scene's centre of mass (off by default).
  - **`repulsionFromMouse`** — how strongly nodes shy away from the cursor.

  Every field stays optional and **omission still means "leave the engine's
  default alone"** — an unset field is never written, so nothing changes for
  existing callers. Each maps 1:1 onto a cosmos config key through the same
  atomic config-only commit, so a write never resets positions or restarts the
  layout.

  `<GraphSimControls>` grows a slider per new tunable, and its **speed preset now
  targets `decay`** — the tunable always designated for it. It previously
  proxied through `friction` because `decay` had no core lane; that documented
  workaround is retired.

  `spaceSize` is deliberately not included: it stays a construction option on the
  adapter, since cosmos documents that large values crash some devices and the
  position-seeding ring is derived from it.

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

- Hardening: typed error taxonomy and WebGL context-loss recovery.

  - `orbit-core`: new `GraphError`/`GraphOperationError` unions with a structural
    fatality model; `InstanceStatus` gains `lost`/`recovering`; the `error` event
    payload gains an optional `detail`; destroyed-instance calls now throw typed
    `OrbitOperationError`; `FakeEngine` gains context-event injection helpers and
    a `mountError` option; the engine contract gains optional
    `onContextEvent`/`onDiagnostic` host events.
  - `orbit-engine-cosmos`: detects `webglcontextlost`/`webglcontextrestored` on
    the cosmos canvas, stashes commits latest-wins while lost, runs a
    visibility-gated restore deadline (default 10s), and recreates the cosmos
    Graph in-place on restore before signaling the core to replay the scene.
    Publishes the tested-version capability profile and probe-backed recovery policy.
  - `orbit-react`: forwards the new `detail` on error payloads and no longer
    double-reports mount failures through both the event and the attach rejection.

- Interaction and selection.

  - `orbit-core`: namespaced `SelectionState` (nodes/edges/groups) with set
    algebra (`selectNeighbors`/`selectAll`/`invertSelection`), click semantics
    (replace/meta-toggle/background-clear) behind a synchronous, exception-
    isolated event dispatcher with `preventDefault` on built-in follow-ups;
    hide/pin slices with departed-id pruning and selection survival; lasso
    `selectWithinPolygon`; edge-picking facade — native route or the new
    oracle-tested CPU uniform-grid fallback (settle-armed, chunked build);
    CSR adjacency module; typed `edgeClick`/`edgeHover`/`nodeDragStart`/
    `nodeDragEnd` events; drag-release pins the node (preventDefault cancels).
  - `orbit-engine-cosmos`: `linkPicking: true`,
    native link click/hover forwarding, drag events with space coords,
    `pointsInPolygon`/`neighborIndices`/`setPinnedIndices`/coordinate
    converters, `enableDrag` option.
  - `orbit-react`: `onEdgeClick`/`onEdgeHover`/`onNodeDragStart`/`onNodeDragEnd`
    props, Shift-drag lasso overlay (`enableLasso`), `GraphHandle` selection/pin
    methods; BREAKING for hooks: `useGraphSelection()` now returns the full
    `SelectionState`; new `useGraphPins()`/`useGraphEdgeHover()`.

- DOM overlay layer, component foundation, and accessibility.

  - `orbit-core`: label lane — pure zoom-LOD/ranked candidate selector with
    `showLabelsFor` capacity-first claims and the `label-overload` diagnostic;
    overlay scheduler on the engine's `onFrame` fan-out positioning labels from
    the CPU position cache via `spaceToScreen` (never per-frame GPU readback —
    evidence), sim-hot cache refresh capped at 500ms; `contextMenu` typed
    event; `pauseSimulation`/`resumeSimulation` + `simulationRunning` store
    field; `captureScreenshot`; reduced-motion camera-duration coercion;
    `LabelConfig`/`AccessibilityConfig` host-update keys.
  - `orbit-engine-cosmos`: adapter-owned `onFrame` activity clock (documented
    one-sample-lag degradation), context-menu forwarding with native-menu
    suppression, `pointsInRect`, same-tick `captureScreenshot`.
  - `orbit-react`: tree-shakeable `/components/*` entries — `GraphToolbar`,
    `GraphContextMenu` (keyboard-reachable, render-prop replaceable),
    `GraphSelectionActions`, and the `GraphNavigator` (roving tabindex,
    paged neighborhood, `getAccessibleLabel`); built-in DOM label layer with
    imperative transform writes and `renderNodeLabel` escape hatch; coalesced
    polite live region; `prefers-reduced-motion` detection; label clicks drive
    click-selection. All attr-derived strings render as text nodes under the
    untrusted-content rule, enforced by lint + the shared security fixture.

- Styling depth and the capability-policy module.

  - `orbit-core`: Scale-valued `nodeColor`/`nodeSize` (sequential/categorical/
    diverging) with canonical structural equality (equal literals never
    reproject) and revision-frozen domains (`DomainPolicy`: dataset/hard-scope/
    visible scopes, freeze-per-revision/expand streaming); built-in
    degree/inDegree/outDegree metrics + revision-gated async `MetricColumn`
    admission with `getMetricValue`; the shared numeric-hygiene layer
    (NaN never reaches a GPU buffer); `GraphTheme` tokens with light/dark
    bases + partial merge (mutedAlpha drives dim); the image-atlas pipeline
    (dedupe, budgets, generation gating, batched failure diagnostics) behind
    `nodeImage`; `edgeArrows`/`showLinks` as atomic config-only commits;
    accessor-churn dev detector; the capability policy
    (resolveEnginePolicy/normalizeCommitForCapabilities) gating every commit.
  - `orbit-engine-cosmos`: edgeArrows/pointImages capabilities, arrow +
    renderLinks + theme-token config mapping, image-atlas resources
    (ImageBitmap→ImageData conversion) applied atomically per commit.
  - `orbit-react`: Scale/theme/metrics/nodeImage/edgeArrows/showLinks props,
    `renderLegend`, `useGraphTheme`, and the new tree-shakeable
    `/components/Legend` — sequential ramps with domain ticks, diverging bars,
    categorical swatch rows with live counts and host-wired click-to-filter,
    graduated size dots.

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

- Hardening and post-merge fixes.

  The hardening pass covered ingestion serialization, edge identity (collision-proof
  escaped synthesis — ids for endpoint ids containing `\`, `→`, `#` differ
  from earlier releases), cosmos lifecycle/queued
  commits/recovery, the Omnigraph loader's drift and abort paths, and React
  remount lifecycles, and made Playwright (including a real WebGL
  context-recovery scenario) a required CI gate.

  Additional fixes:

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
