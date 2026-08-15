# orbit

**A typed, declarative React library for rendering and exploring graphs with WebGL.**

Handles 100K+ node graphs. UI components included: search, tables, histograms, and more.

Why orbit:

- **Declarative end to end** — the graph is a prop. Rendering, force layout, transitions,
  selection, and undo/redo are handled; there is no imperative canvas code to write.
- **Built for large graphs** — GPU rendering holds 100K+ nodes interactive, and
  incremental O(Δ) filtering keeps the core's per-brush cost near 1 ms at that scale,
  measured on a disclosed reference machine with a real-GPU-only protocol.
- **Analyst UI included** — 13 packaged components: search, minimap, tables, histograms,
  timelines, legends, inspectors, and more. Headless-styleable, one import each.
- **Testable without WebGL** — a headless core and an engine seam with a `FakeEngine`
  double; your integration tests run in plain jsdom.
- **Typed and honest at the boundaries** — malformed data degrades with batched
  diagnostics, never throws mid-render.

```bash
npm install @modernrelay/orbit-react @modernrelay/orbit-core @modernrelay/orbit-engine-cosmos
```

**Status:** `0.13.6` on npm — all five packages release in lockstep. See
[Releases](https://github.com/ModernRelay/orbit/releases) for changelogs.

## Packages

| Package | Role |
|---|---|
| `@modernrelay/orbit-core` | Headless core: validation, reconciliation, projection, the instance + store. Subpaths: `/engine` (the `GraphEngine` contract), `/testing` (`FakeEngine`, worker double). No React or engine imports. |
| `@modernrelay/orbit-react` | `<Graph/>`, `GraphProvider`, 13 packaged UI components, hooks, ref API. React 18+ peer. |
| `@modernrelay/orbit-engine-cosmos` | `CosmosEngine` — the only package that imports `@cosmos.gl/graph` (lazy-loaded at mount). |
| `@modernrelay/orbit-data` | Prepared-data adapters: rows/CSV/JSON in the root entry; Arrow and Parquet as isolated subpath entries that never reach the root bundle. |
| `@modernrelay/orbit-omnigraph` | Omnigraph server adapter: streamed export loader, `.pg` schema tooling, search service. |

## UI components

Built into `<Graph/>` itself — no extra imports:

- **DOM labels** with collision-ranked visibility and a `renderNodeLabel` custom renderer
- **Lasso selection** (freehand polygon)
- **Emphasis ring** for hover, focus, and keyboard navigation
- **Drag & pin** handles on nodes
- **`LiveRegion`** — screen-reader announcements for selection and navigation

Packaged components — each ships as its own entry point
(`@modernrelay/orbit-react/components/<Name>`), headless-styleable, wired through
`GraphProvider` context:

| Component | Entry | What it does |
|---|---|---|
| `GraphSearch` | `components/Search` | Search box with debounced queries, result list, keyboard activation |
| `GraphNavigator` | `components/Navigator` | Bounded semantic keyboard navigator (arrow/paging traversal with a11y announcements) |
| `GraphMinimap` | `components/Minimap` | Whole-graph thumbnail with a draggable viewport rectangle |
| `GraphTooltip` | `components/Tooltip` | Hover card for nodes and edges |
| `GraphInspector` | `components/Inspector` | Docked detail panel for the focused/selected entity |
| `GraphTable` | `components/Table` | Virtualized tabular view of nodes or edges, crossfilter-connected text filtering |
| `GraphHistogram` | `components/Histogram` | Crossfilter histogram — drag-brush a numeric dimension to filter the graph |
| `GraphTimeline` | `components/Timeline` | Timeline band over a temporal dimension with brush + playback |
| `GraphLegend` | `components/Legend` | Legend over any scale-valued styling channel, row-click filtering |
| `GraphToolbar` | `components/Toolbar` | Camera & simulation controls: zoom, fit, reset, pause/resume |
| `GraphContextMenu` | `components/ContextMenu` | Right-click / long-press menu on nodes, edges, and background |
| `GraphSelectionActions` | `components/SelectionActions` | Action panel that appears while a selection is non-empty |
| `GraphSimControls` | `components/SimControls` | Force-simulation tunables panel (live, no restart) |

## Features

- **Data & identity**
  - Typed snapshots in two lanes: plain objects, or columnar (typed arrays,
    dictionary-encoded strings, transferable buffers with `borrowed`/`transfer` ownership)
  - Validation with batched diagnostics — malformed rows drop loudly, never throw
  - Streaming ingest sessions (replace and overlay) with atomic commit
  - Stable id-based identity: positions, selection, and history survive data updates
- **Layout & simulation**
  - GPU force layout (cosmos.gl) and fixed coordinates, switchable at runtime
  - Live simulation tunables, pause/resume, reheat on structural change
  - Quiescence: zero rAF at rest, measured and gated
- **Interaction**
  - Node and native edge picking (click, hover, drag), lasso, pins
  - Context menus on desktop right-click and touch long-press
  - Full keyboard navigation with accessible labels and live announcements
- **Exploration**
  - Hard scope / isolate selection, service-backed node expansion
  - Manual groups and derived `groupBy` with collapse to super-nodes and meta-edges
  - Node folds (containment), parallel-edge bundling, semantic zoom
  - Path emphasis between endpoints, search across ids and configured attrs
- **Filtering & analytics**
  - Crossfilter dimensions with O(Δ) brushing — pointer-speed filtering at 100K+ nodes
  - Hide or dim soft masks, predicate/expression filters
  - Built-in degree metrics plus async metric columns joined by revision
  - Categorical and sequential scales with domain policies, rendered by `GraphLegend`
- **Appearance**
  - Dark/light themes as one token object, hot-swappable
  - Node image sprites via a texture atlas, edge arrows, animated transitions
- **Persistence & export**
  - `GraphViewState` deep links: camera, selection, folds, layout, filters in one payload
  - Undo/redo history across exploration steps
  - Exports: SVG snapshot, JSON/NDJSON data (streamed, memory-bounded), PNG screenshot
- **Scale**
  - Performance gates measured on a disclosed reference profile (real GPU only,
    n≥3 runs, variance-qualified): the S-tier first-paint gate passes; the L-tier
    active-frame gate is a tracked open miss
  - Telemetry: `getPerfSnapshot()` + throttled `onPerfSample` (never raw data or ids)
  - Degradation ladder with hysteresis (label caps, deferred picking, batched histograms)
  - Worker lane: columnar acceptance runs off the main thread (`execution: 'auto'`)
  - Ranged buffer patches for engines that declare them

## Hooks & imperative API

All hooks read the instance through `GraphProvider` (or the nearest `<Graph/>`):

| Hooks | Surface |
|---|---|
| `useGraphInstance`, `useResolvedInstance` | The headless instance itself |
| `useGraphStatus`, `useGraphDiagnostics` | Lifecycle + batched diagnostics |
| `useGraphSelection`, `useGraphHover`, `useGraphEdgeHover`, `useGraphPins` | Interaction state |
| `useGraphViewport`, `useGraphSimulationRunning` | Camera + simulation state |
| `useGraphScope`, `useGraphOverlays`, `useGraphPendingExpansions` | Exploration state |
| `useGraphVisible`, `useGraphCrossfilter`, `useGraphTimeline` | Filtering state |
| `useGraphHistory`, `useGraphSearch`, `useGraphTheme` | History, search, theme |

Beyond hooks:

- **`GraphHandle`** (ref on `<Graph/>`): camera ops, `focusNode`, `emphasizeNode`,
  fold/expand/group ops, `getViewState`/`setViewState`, exports, `getPerfSnapshot`
- **`createGraphInstance`** (core): the same engine-driving instance with no React —
  everything except the React component layer works headless (data, layout,
  interaction events, exploration ops, filtering, view state, exports, telemetry)

## Development

```bash
pnpm install
pnpm check        # boundaries + anchor/pin guards + lint + types + tests + gate evaluator
pnpm demo:dev     # demo app at http://localhost:5199
pnpm --filter orbit-demo e2e            # Playwright suite
node scripts/perf-lite.mjs --tier S     # perf measurement (headful, real GPU only)
```

Ground rules enforced by `pnpm boundaries` and the test suites:

- React never touches per-node hot data; buffers stay below the adapter line
- Core imports no React; nothing outside `orbit-engine-cosmos` imports cosmos
- One `applyHostUpdate` = one store publication = at most one atomic engine commit
- Position readback is per-event, never per-tick
- Perf numbers count only from real GPUs, n≥3 runs, variance-qualified —
  software rasterizers are never accepted

Integration testing: swap the engine for the bundled double —
`import { FakeEngine } from '@modernrelay/orbit-core/testing'` — and the full
component tree runs without WebGL.
