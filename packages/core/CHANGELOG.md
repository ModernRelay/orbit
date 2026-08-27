# @modernrelay/orbit-core

## 0.16.0

### Minor Changes

- 212b31f: Fit zoom clamp: small graphs no longer balloon.

  Measured: a 60-node graph fit at zoom 4.3 (nodes render as balloons), 300
  nodes at 3.3. Every internally issued fit (first-data fit, settle follow,
  public `fitView`) now carries a zoom upper bound — new `fitViewMaxZoom`
  option, default 1.5, `null` to disable. The engine contract's
  `FitViewOptions` gains `maxZoom`; when the natural fit zoom exceeds the
  bound, the cosmos engine centers the scene bbox at the bound with one
  animated transform instead. Verified live: small-graph fits land at exactly
  1.5 (previously 3.1–4.3).

- 893a1d2: First-load feel: the settle camera and simulation presets.

  Two measured problems on every fresh force-layout mount: the first-data fit
  frames the seed ring while the simulation contracts the graph to 5–17% of
  that frame (a distant blob), and the engine's default cooling keeps visible
  motion alive for tens of seconds (reads as endless jitter).

  - **Settle camera** — new `fitViewOnSettle` option (`'follow'` (default) |
    `'once'` | `false`). Under `'follow'` the camera keeps the settling graph
    framed with periodic animated refits riding the engine frame fan-out (no
    timers, no extra rAF) and a final fit at first quiescence; any user camera
    input cancels it. `'once'` fits a single time at quiescence; `false`
    restores the previous behavior.
  - **Simulation presets** — `simulation` now also accepts a preset name:
    `'calm'`, `'spread'`, `'tight'`, or `'lively'` (`SIMULATION_PRESETS` and
    `resolveSimulation` are exported). Presets were selected on a measured
    protocol: seconds until sustained visible stillness on an 800-node
    clustered graph.
  - **Default changed**: an omitted `simulation` now resolves to the `'calm'`
    preset (visually still in ~5s) instead of the engine's own defaults. The
    old feel is one prop away: `simulation="lively"`.

## 0.15.0

### Minor Changes

- 5771a0d: Correctness and lifecycle hardening across graph admission, worker packaging,
  deferred engine commits, data preparation, Omnigraph parsing, and React
  interactions. Invalid inputs are rejected consistently, deferred buffers and
  asynchronous sources have explicit ownership, generated types match runtime
  identity rules, and keyboard and pointer paths preserve host callback
  contracts.

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

## 0.13.5

### Minor Changes

- The columnar lane's ground floor.

  - **Columnar snapshots**: `data` accepts
    `ColumnarGraphSnapshot` (typed columns, dictionary-encoded strings,
    pre-indexed endpoints). Structural corruption rejects the WHOLE snapshot
    (`invalid-columnar-snapshot`, prior scene intact); a valid snapshot lands
    byte-identical to its object-form twin through the one shared pipeline —
    pinned per generator family and seed.
  - **Buffer ownership**: `bufferOwnership: 'transfer'` detaches every
    supplied ArrayBuffer only AFTER validation succeeds; rejected snapshots
    leave caller buffers intact, and a consumed snapshot is structurally
    single-use.
  - **Serializable field descriptors**: `FieldAccessor` /
    `SerializableTransform` / `field()` as data-only building blocks with a
    closed transform whitelist — descriptors are never evaluated as code.
  - **Ranged buffer patches**: `EngineCommit.bufferPatches` for channels an
    engine declares in `capabilities.rangeUpdates`; the brush fast path
    now uploads Δ-proportional patches on such engines (full-upload fallback
    on composer reseed). The cosmos adapter declares none — full uploads
    remain its documented state.
  - **Worker wire contract**: envelope codec, epoch guards, consolidated
    transfer lists, and the guaranteed/throttled request ledger land as pure,
    fully-pinned modules. Worker EXECUTION itself has not landed — the XL
    tier remains unconformant, with the main-lane degradation profile
    published in local measurement records

  React: `<Graph data>` widens to `GraphSnapshotInput` (object or columnar).

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

- **The O(Δ) brush publish path** — a crossfilter brush move now does
  work proportional to the delta, not the graph:

  - `SoftMask` gains an O(Δ) delta-membership API with per-call zero-crossing
    reporting; the node→edge cascade gains an O(incident-edges) form
    driven by a new CSR incidence index (point → incident edge slots).
  - Crossfilter filtered layers are live-maintained: `summarize()` drops from
    O(rows) to O(bins) during scrubbing (histogram consumers unchanged).
  - Alpha composition runs through persistent ping-pong buffers — O(Δ) slot
    rewrites, zero steady-state allocation (was ~5.6 MB fresh allocation per
    pointer move at the 100K/250K tier).
  - Fallbacks preserve semantics exactly (group ANY-member rule, path
    emphasis, structural/hidden/filter re-baselines) — proven byte-identical
    to a fresh-instance oracle, plus a CI op-count gate asserting zero
    full-path work across a 60-step scrub.

  Measured: core main-thread cost per brush step at the L tier is now
  **0.71 ms p50 / 2.11 ms p95** (was the dominant CPU share). Browser-level
  frame p95 is unchanged within run variance — the remaining tail is the
  full-channel GPU upload and the demo-layer histogram re-render, documented
  in the local performance measurements.

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
    read blank under on-demand rendering). `pointOcclusionCulling` remains
    disabled for pixel-baseline stability.
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

- **telemetry + degradation ladder**.

  - `getPerfSnapshot()` and the throttled `onPerfSample` event: counts, byte
    estimates, queue depth, revisions, last-commit phase decomposition,
    active ladder steps, execution lane, range availability, and a pressure
    mirror (frame EWMA / dropped frames / idle wakeups) — never raw attrs or
    ids.
  - The degradation ladder: `limits` (construction-only) over the built-in
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

- Worker execution lands for the first cargo: columnar acceptance off-thread.

  - **`execution: 'auto' | 'main' | 'worker'`** construction option (core and
    `<Graph>`, read-once): under `'auto'`/`'worker'`, a columnar snapshot's
    acceptance — dedupe, self-loop resolution, link building — derives in a
    Web Worker (`acceptColumnar`, pinned equal to the object lane down to
    diagnostic message strings) and lands through the acceptance queue.
    Other lanes in the same update apply immediately (stream-commit
    semantics); a sync acceptance mid-flight supersedes pending derives;
    `bufferOwnership: 'transfer'` detaches at async admission.
  - **`workerFactory`** tri-option (URL / `create()` / inline default — the
    worker asset ships inside core as `dist/worker/entry.js`). An unavailable
    lane degrades to the main path with one `worker-unavailable` diagnostic
    (info under `'auto'`, error under `'worker'`);
    `GraphPerfSnapshot.execution` reports the booted truth.
  - Wire discipline: dictionaries cross as UTF-8 string tables in
    transferables (never structured-clone string arrays); epoch-stamped
    envelopes; request supersession aborts promptly. The in-process test
    double drives the real runtime through `structuredClone` with real
    transfer lists.
  - Measured at 1M/2.5M: acceptance main-block 1,640 → 1,006 ms (−39%),
    621 ms moved off-thread. Registered next: pre-encoded string tables,
    zero-materialization acceptance, channel-projection cargo.

### Patch Changes

- The phase clock now stamps the ready replay.

  `buildAndCommitFullReplay` — the commit that actually uploads when data was
  applied before the engine attached (the ordering every React mount hits, and
  every context-recovery replay) — never recorded `lastCommitMs`, so the
  first paint of a normal `<Graph data>` mount had no phase decomposition.
  It now stamps `kind: 'model'` with derive (re-reconcile), project (channel +
  atlas rebuild), and upload (engine commit) phases, pinned from the failing
  side (apply-before-attach).

  Alongside (repo-level, no package surface): the harness completes —
  perf-lite generator families, tier-sized S first-paint scenario, multi-run
  CV qualification, WebKit lane, frame-discipline probes, and the
  published S/L gate matrix on the M5 Pro reference profile; CI now runs the
  `perf:gate` evaluator suite in the check job.

## 0.2.0

### Minor Changes

- `<GraphTooltip>` now serves edge hovers, and `instance.getEdge(id)` resolves an
  edge id to its record.

  Core tracked `store.hover.edgeId` and `SelectionState.edgeIds`, and edge picking
  was already implemented — but nothing could turn an edge id back into an edge, so no
  component could show anything for one. `getEdge(id)` is the symmetric partner of
  `getNode(id)` and closes that gap for hover, selection, and any future
  edge-aware component.

  `<GraphTooltip>` serves both hover namespaces. A **node wins** when both are
  set — it is the more specific target and sits above its own links. Edges never
  enter the overlay position lane (that lane tracks labeled node slots), so an
  edge card always rides the cursor fallback, which is exactly right: the hovered
  edge is under the pointer. Edge cards carry a `data-orbit-tooltip-edge` marker.

  New props: `renderEdge` (replace the card body), `getEdgeText` (retitle without
  taking over the body — for graphs whose meaningful name lives in an
  adapter-injected attr rather than `label`), and `edges={false}` to opt out
  entirely. Untrusted edge text stays text-node-only.

  This is deliberately hover-only, not a persistent edge-label lane: a graph with
  8,437 edges would bury its own canvas, whereas one card under the cursor costs
  nothing and answers "what is this relationship?" directly.

- **Exports** — get your work out of Orbit as artifacts.

  - `exportImage('svg')` renders the VISIBLE set through an **engine-free**
    exporter (positions + projected styles in, markup out — the post-v1 server
    path reuses it verbatim, enforced by a plain-Node CI fixture). Bounded at
    50K elements with a typed `export-too-large` rejection; pass
    `{ fallback: 'raster-hybrid' }` for a screenshot base layer with a vector
    label overlay. Every label is XML-escaped — untrusted-content rule in
    its XML form, proven end to end by an e2e that pushes a literal `<script>`
    label through the whole pipeline.
  - `exportImage('png')` — the engine screenshot, typed rejection when the
    capability is absent.
  - `exportData(scope)` / `exportLayout()` — bounded object forms that reject
    `export-materialization-too-large` BEFORE allocating.
  - `exportDataStream(scope)` / `exportLayoutStream()` — memory-bounded JSONL
    over ONE pinned revision: a commit landing mid-stream never mixes epochs.

  All five forward on `GraphHandle`; the demo ships Export SVG / Export JSONL
  buttons.

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

- **Node collapse/uncollapse** — `foldNode` / `unfoldNode` / `getFold`, built by
  generalizing group collapse rather than adding a mechanism beside it.

  **BREAKING (pre-1.0):** `collapseNode(id)` is renamed **`retractExpansion(id)`**.

  ## The gap

  Orbit had two operations that read as "collapse" and neither did the obvious
  thing. `collapseNode` undid _your own_ `expandNode` — a Back button, a no-op on
  a graph you never expanded from. `setGroupCollapsed` replaced a declared group's
  members with a **synthetic** super-node, so the node you clicked was exactly the
  thing that disappeared.

  Neither could do: _click a node, its neighbourhood tucks into it, the node stays
  put wearing a +N badge, click again and they come back._

  ## One rule

  Stage 3 is now a single containment rewrite over a singly-parented
  **representative forest**:

  > An entity — a physical node id, or a synthetic group scene key — is drawn iff
  > **no ancestor is collapsed**. Each edge endpoint reroutes to its **outermost
  > collapsed ancestor**; edges whose endpoints rewrite to the same key are
  > dropped; the rest merge per directed pair into one meta-edge carrying the
  > underlying count. A **synthetic** representative materializes only while
  > collapsed; a **real** one is always drawn.

  `collapsed` became a property of the _representative_, not of the node. That is
  what lets a fold anchor stay visible while its children hide, and it makes
  manual groups, `groupBy`, and folds three entry points into one mechanism.

  Two things fell out rather than being built:

  - **Nesting works.** Fold a node, then collapse a group containing it: the
    folded subtree hides inside the group's bubble and its edges route there. So
    `validateGroupSpecs` trades its `nested groups` rejection for **cycle**
    detection. Overlap is still an error — containment is hierarchical but singly
    parented.
  - **One edge check replaced two.** `sk === tk` drops both a same-group internal
    edge and the self-loop an anchor would otherwise emit toward its own member.

  ## Folds

  Members default to the anchor's neighbours that no representative has claimed —
  **first claim wins**, which is what makes folding two adjacent hubs
  well-defined with no leaf-only restriction. Verified on the intel graph:
  folding Anthropic then OpenAI produced zero member overlap.

  Folds are instance-owned and uncontrolled (no prop — the pins precedent, so the
  controlled/uncontrolled duality never arises), record a `'folds'`
  history step, prune on every accepted-model publication, and arm the accretion
  pin lane so the layout does not lurch.

  Deliberately **not** built on `effectiveRemovedIds`: that path cascades edges
  away from removed nodes, which is right for retracting an expansion and wrong
  here, where a member's outside edges are exactly what must survive.

  ## New `store.folds`

  Anchor → hidden count. A fold changes no id and no label text, and the
  label lane re-renders content only when the candidate SET changes — so without
  this slice, nothing tells a subscriber that fold-derived chrome went stale.
  This was found by driving the real demo, not by the test suite.

  ## Migration

  `collapseNode(id)` → `retractExpansion(id)`. The rename is the point: with
  `foldNode` landing, one word now means containment and another means navigation
  history. `<GraphContextMenu>` gains `fold`/`unfold` items ("Collapse/Expand
  neighborhood"), distinct from "Expand neighbors", which fetches.

- Right-clicking a **label** now opens Orbit's node context menu instead of the
  browser's native one.

  Label divs are `pointerEvents: 'auto'` by design (click-to-focus), so the
  right-click died in the DOM and never reached the engine canvas — on exactly
  the nodes prominent enough to carry labels (hubs, `showFor`-forced ids). Every
  other label interaction was fully wired (selection algebra with meta/shift,
  text-only rendering); `contextmenu` had simply never been.

  New core op `requestNodeContextMenu(id, screen)` — also on `GraphHandle` — lets
  any DOM presenter (a list row, custom chrome) feed the SAME typed
  `'contextMenu'` event the canvas gesture emits. `screen` is container-relative
  CSS px; unknown ids are a silent no-op. Cluster labels keep the native menu
  for now (no cluster menu target exists).

  The restored e2e gate exposed this on its first run: a spec that right-clicked
  "the graph" was actually right-clicking a label, and nothing opened.

- v0.10 semantic exploration — groups, groupBy, semantic zoom,
  clusters, paths, pins, table and sim controls — plus the eight remaining
  verified findings from external review.

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

- Revisioned ingestion, hard scope, and expansion.

  - `orbit-core`: `beginIngest()` sessions (replace/overlay, atomic/progressive)
    serialized through the instance-local acceptance queue — sequence/batchId
    replay idempotency, CAS `baseModelRevision`, byte backpressure via awaited
    receipts, coalesced flushes (≤50ms), per-session rollback (tag index +
    store deltas, never scene checkpoints), overlay identity with cross-overlay
    shadowing + `removeOverlay` promotion, edge-before-node pending-endpoint
    resolution with commit-time dangling diagnostics. Hard scope: `subgraph`
    host-update key + `isolateSelection`/`resetIsolation` feeding only the
    resolved subset through the reconciler — the first genuine scope/model
    revision split; shared `cascadeEdges` primitive exported for soft filtering. Service
    seam: `RequestContext`/`RevisionAwareService` admission gate (stale declared
    revisions discarded even when services ignore abort), local
    `ExpansionService` over the accepted-base adjacency, `expandNode`/
    `collapseNode` with same-id coalescing, atomic-or-nothing overlay merges,
    and pinned accretion during expansion settle.
  - `orbit-react`: `subgraph` prop; `GraphHandle` gains isolate/expand/ingest/
    overlay delegations; `useGraphScope`/`useGraphPendingExpansions`/
    `useGraphOverlays` hooks; context menu gains Expand neighbors + Isolate.

- Soft filtering, crossfilter, histograms, timeline, and the history kernel.

  - `orbit-core`: failure-counter soft mask — the `filter` host-update key
    (typed `FilterExpr` or predicates, hide/dim modes) masks via buffers-only
    alpha commits with ZERO relayout; `hiddenNodeIds` now masks pixels; the
    edge cascade runs on the mask lane; canonical-structural filter equality
    skips re-evaluation. typed-column crossfilter backend (parse-once
    extraction, O(Δ·D) brush deltas, dual-layer summaries, append-without-
    rebuild, brush rebase by key) behind `getCrossfilterSession()`; the
    `crossfilter` host-update key declares dimensions. Headless timeline
    playback (`playTimeline`/`pauseTimeline`, sliding/cumulative).
    history kernel: undo/redo over selection/hidden/pins/scope/brushes with
    windowed coalescing (a brush drag or play session = one entry). Link
    picking, label candidates, `getVisibleNodeIds`, and selection set algebra
    now honor the live mask; new `getSceneNodeIds()` keeps the navigator
    listing masked nodes with state exposed in text.
  - `orbit-react`: `filter`/`crossfilter` props; `GraphHandle` gains
    undo/redo/timeline/session methods; hooks `useGraphVisible`/
    `useGraphTimeline`/`useGraphHistory`/`useGraphCrossfilter`; new
    tree-shakeable components `/components/Histogram` (dual-layer bars,
    drag-brush, categorical toggles, slider a11y semantics) and
    `/components/Timeline` (brush band + play/pause).

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

- v0.9.1 remediation: six correctness fixes from external review.

  - **Crossfilter re-extraction:** model sync now proves a
    pure append by row-object identity — an id-stable attribute change
    re-extracts columns via `replaceAll` (brushes preserved by dimension
    key), so histograms and brush hiding always reflect the accepted values.
  - **Theme-derived mask bases:** no-accessor mask composition
    synthesizes base colors from the active theme's `nodeDefault`/
    `edgeDefault` (including edge translucency) instead of a hardcoded
    opaque gray; theme changes rebuild synthesized bases while masked.
  - **Metric revision stamps — BREAKING:** `MetricColumn` gains
    a required `forModelRevision` (capture `getRevisions().model` when the
    update is built). Admission gates per column against the issue-time
    revision, so stale async columns can no longer join a newer roster.
  - **Domain freeze coordinate:** default scale domains
    stay frozen across progressive overlay flushes (coordinate =
    sourceRevision + metric column generation); `streaming: 'expand'`
    unions only within one source lineage — a same-key replacement starts
    fresh instead of unioning dead extrema.
  - **`clearSearch` supersede:** clearing advances the search
    publication token and aborts the in-flight request — a service that
    settles after the clear can no longer resurrect the cleared query.
  - **`searchIndex` construction-only — BREAKING:** `searchIndex` moves from
    `GraphHostUpdate` to `CreateGraphInstanceOptions` (and is read once by
    `<Graph>`; key-remount to change it). Runtime attempts warn once and
    are ignored; the search cache key defensively carries the field list.

- Hardening and post-merge fixes.

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

- **Saving & state** — `getViewState()` / `setViewState()`, the view-state
  lane. Nothing you build in Orbit dies with the tab anymore.

  A `GraphViewState` serializes the exploration state: camera, selection, hidden
  ids, isolation, groups (manual specs, or `{key, collapsed}` pairs under
  `groupBy`), pins, **folds**, layout, crossfilter brushes (tagged; categorical
  stores EXCLUSIONS so later-arriving categories stay visible), the Scale-valued
  styling subset, and a host-owned `dataRef` compared canonically on restore.
  `getViewState({ includePositions: true })` embeds quantized coordinates that
  restore as a frozen fixed-equivalent — pixel-faithful across engines.

  `setViewState` is **atomic**: structural validation and the version gate run
  before anything applies (a truncated URL leaves the store byte-identical and
  publishes one `invalid-view-state` diagnostic); a `dataRef` mismatch fires
  `viewStateMismatch` INSTEAD of applying, with an explicit opt-in re-call. The
  apply runs through the history kernel, so a restore is itself one undoable
  step. Restores touching controlled slices emit ONE `viewStateRestore`
  intent and hold the previous scene until the host's reflection acknowledges —
  timeout, divergence, and concurrency all resolve as typed results with nothing
  applied. undo/redo ride the same protocol.

  React: `dataRef`, `onViewStateRestore`, `onViewStateMismatch` props;
  `getViewState`/`setViewState` on the handle. The wire format is a
  compatibility commitment: additive fields never bump `v`; breaking bumps ship
  in-code migrations.

  Deep-links carry the whole thing in a URL — and they are for HUMAN-scale
  state: bulk payloads belong to the export lane, not the URL bar.

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
