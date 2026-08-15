# @modernrelay/orbit-engine-cosmos

Cosmos engine adapter for Orbit.

## Tested engine range

This adapter is developed and probed against exactly **`@cosmos.gl/graph@3.4.0`**
(exact pin, no range). In the repository, `pnpm cosmos:pin-check` verifies that
the adapter and `apps/spike` declare the same exact version. Any pin bump must
update both manifests, pass that check and `pnpm probe:node`, then be exercised
locally with the headful `pnpm probe` suite on a real GPU before the new version
is considered supported. The 3.3.0 → 3.4.0 bump was re-probed on 2026-08-10;
upstream on-demand rendering made the quiescence probe pass.

## Capability profile

Node-verifiable facts (measured by `pnpm probe:node`, re-checked in CI):

| Capability | Value | Basis |
| --- | --- | --- |
| `rangeUpdates` | `[]` | Every buffer setter in `dist/index.d.ts` (`setPointPositions`, `setPointColors`, `setLinks`, …) takes a full array; no offset/count variants exist. Whole-buffer re-upload is the only update path. |
| `postDrawFrames` | `false` | The `config.d.ts` callback inventory has no draw/render-phase hook — only simulation (`onSimulationTick/Start/End/Pause/Unpause`), transition, zoom, drag and pointer callbacks. Post-draw work must be scheduled externally. Since v0.13 this is a REAL `EngineCapabilities` field, not just prose. |
| `idleFrames` | `'stops'` | cosmos ≥3.4 on-demand rendering idle-stops the engine loop, and the adapter's gated activity clock stops with it — measured 0 idle frames and 0 rAF registrations per 750 ms at rest by the quiescence probe below. |
| `node-import-safe` | `true` | `await import('@cosmos.gl/graph')` succeeds in plain Node (module scope guards `typeof window`), so SSR and test imports never crash. |

GPU-probed capabilities (re-measured 2026-08-10 on Apple M5 Pro, ANGLE Metal, headful
Chromium):

| Capability | Result | Finding |
| --- | --- | --- |
| `atomic-commit` | ✅ pass | Multi-channel commit (positions+colors+links) applied mid-simulation shows zero mixed frames — a monotonic A→B switch one frame after commit. Visibly atomic commits are real. |
| `point-picking` | ✅ pass | `onPointClick` delivers the exact index at `spaceToScreenPosition` coords; misses report `undefined`. |
| `link-picking` | ✅ pass | Native `onLinkClick`/`onLinkMouseOver` deliver correct link indices; ~4 px perpendicular tolerance on a 2 px link. **Flipped:** the adapter now reports `capabilities.linkPicking: true` and wires `onLinkClick`/`onLinkMouseOver`/`onLinkMouseOut` to the host events, backed by the headful probe. |
| `nan-tombstones` | ✅ pass | NaN'd points escape hit-testing, incident links vanish, `fitView` ignores tombstoned slots. |
| `native-pinning` | ✅ pass | `setPinnedPoints` excludes points from force integration; `[]`/repeat calls are idempotent. |
| `tracked-positions` | ⚠️ fail (budget) | Semantics correct (packing order, last-call-replaces), but each `getTrackedPointPositionsArray` read stalls ~8.7 ms p50 on 3.4.0 (was ~18 ms on 3.3) **regardless of k** — a sync pipeline flush, not payload cost. Per-frame tracked readback stays non-viable; DOM-label positioning reads at settle/idle cadence. |
| `quiescence` | ✅ pass (3.4.0) | On-demand rendering: 0 idle frames AND 0 rAF registrations per 750 ms at rest (was 91 on 3.3.0). Settle lands ~5 s after `onSimulationEnd` (trailing transitions). Picking stays index-truthful at rest, drag release renders its final frame, and a `render()` + same-tick capture reads valid pixels (the stale-wake micro-cases). |
| `context-loss` | ⚠️ fail (by design) | `lost`/`restored` events surface, but no combination of buffer/config replay revives rendering after `restoreContext()` — only a full `Graph` destroy + re-create recovers. This validates the adapter's recreate-on-restore protocol: `CosmosEngine` rebuilds the Graph in the same container and the core replays the scene. |

## Interaction surface

Coordinate-space facts verified against the exact-pin 3.4.0 dist (see the
`CosmosEngine.ts` module header for the exact evidence):

- `pointsInPolygon(screenPolygon)` — cosmos' `findPointsInPolygon` takes
  **screen** coordinates (0 to canvas width/height per its d.ts), so the
  host's screen polygon passes through without conversion.
- `onDragEnd(index, x, y)` reports **space** coordinates: cosmos' drag shader
  pins the dragged point to the mouse's space position every frame, so
  `screenToSpacePosition([event.x, event.y])` at drag end is the point's exact
  final position (O(1), no GPU readback).
- Native dragging is on by default (`CosmosEngineOptions.enableDrag`
  overrides); setting any `onLink*` callback is what enables cosmos' native
  link hit-testing.
- `setPinnedIndices` maps to `setPinnedPoints` (full-set replace; `null`/`[]`
  unpin all). Re-applying pins after context-loss recovery is core-owned.

## Overlay & toolbar surface

| Capability | Behavior | Basis / degradation |
| --- | --- | --- |
| `onFrame` GATED activity clock | The adapter owns the single `requestAnimationFrame` loop, GATED to match cosmos ≥3.4's on-demand rendering: it free-runs only under a held run reason (sim hot, drag gesture, cosmos transition) and otherwise burns a one-shot tick budget that every visual write re-arms (commits, highlight/focus/pin setters, camera moves, hover; animated camera moves self-sustain via per-step `onZoom` bursts). Every reason release grants ONE trailing tick (the final GPU write lands after the current draw pass). Stopped on context loss/`destroy()`, re-armed on recovery; the callback is skipped while `document.hidden`. **At rest: zero rAF registrations** (`idleFrames: 'stops'`). | **Documented degradation:** cosmos still exposes no draw/render-phase hook (`postDrawFrames: false`), so this is an *activity* clock, not a post-draw hook — DOM overlays may lag the canvas by one frame. Reported once at mount via `engine:overlay-activity-clock`; `showFPSMonitor` via the config escape hatch keeps cosmos rendering and is diagnosed once (`engine:fps-monitor-defeats-quiescence`). |
| `onContextMenu` | cosmos' unified `onContextMenu(index \| undefined, pos, event)` config callback → host `onContextMenu(index \| null, [containerX, containerY])` (container-relative CSS px from the event's `clientX/Y`). Covers desktop right-click and touch long-press (cosmos synthesizes the latter). The native event is `preventDefault`-ed only when the host registered `onContextMenu` (Orbit's core always does — it owns the typed `contextMenu` event). | Only the unified callback is wired: the per-target `onPointContextMenu`/`onLinkContextMenu`/`onBackgroundContextMenu` callbacks fire *additionally* for the same gesture and would double-report. A context menu over a link arrives with `index === undefined` and is reported as background. |
| `pointsInRect(screenRect)` | `[x0, y0, x1, y1]` → cosmos `findPointsInRect([[left, top], [right, bottom]])` (corners normalized to min/max so any opposite-corner pair works). Lifecycle-guarded: `[]` pre-mount / while lost / after destroy. | Same **screen** coordinate space as `findPointsInPolygon` (0 to canvas width/height per the exact-pin d.ts; the dist flips Y assuming ordered corners) — no conversion. |
| `captureScreenshot()` | Resolves a PNG `Blob` of the current frame, or `null` when unsupported, not ready, lost, or on any capture failure. | The same-tick capture method (`apps/spike/src/instrument.ts`): cosmos renders with a non-preserved drawing buffer, so the WebGL canvas is only readable via a synchronous `drawImage` onto an offscreen 2D canvas inside the same rAF tick. Under on-demand rendering an idle scene draws nothing (blank buffer), so the adapter first calls `graph.render()` — a visual mutator that schedules the frame the capture rAF then samples. |

## Styling channels

Facts verified against the exact-pin 3.4.0 dist typings (`config.d.ts` / `index.d.ts`):

| Capability | Value | Mechanism / basis |
| --- | --- | --- |
| `edgeArrows` | `true` | Commit `config.linkArrows` maps to cosmos' `linkDefaultArrows` config key (config.d.ts, default `false`) via `setConfigPartial` — instanced arrowheads toggle atomically within the commit's single `render()`. No per-link `setLinkArrows(boolean[])` buffer is used (Orbit's toggle is scene-wide). |
| `pointImages` | `true` | cosmos 3.4.0 exposes `setImageData(ImageData[])` + `setPointImageIndices(Float32Array)` (index.d.ts). The adapter maintains a slot→`ImageData` mirror of the atlas: commit upserts transcode each `ImageBitmap` through an offscreen 2D canvas (`drawImage` + `getImageData`), `removeSlots` blanks entries with a 1×1 transparent `ImageData` (slot indices stay stable), and any atlas change re-uploads the FULL array (cosmos has no partial image update — consistent with `rangeUpdates: []`). The mirror is CPU-side, so it survives context loss; post-restore atlas commits re-upload everything to the fresh graph. **Degradation:** where no 2D context exists (jsdom without the canvas package), the image channel no-ops — never throws — and reports the `engine:image-channel-unavailable` warning diagnostic exactly once. |
| `renderLinks` toggle | config-only | cosmos 3.4.0 has a first-class `renderLinks: boolean` config key (config.d.ts, default `true`), so commit `config.renderLinks` is a pure `setConfigPartial` toggle — **zero buffer setters**, no `linkOpacity` workaround, no link-buffer rebuild. |
| Theme default colors | config-only | Commit `config.defaultPointColor`/`config.defaultLinkColor` map to cosmos' `pointDefaultColor`/`linkDefaultColor` config keys (CSS color strings accepted natively). |

While pre-mount, context-lost, or terminally failed, resources fold into the
pending-commit per-channel merge like every other channel: image upserts union
per slot (latest bitmap wins; a later remove drops an earlier pending upsert of
the same slot), and the latest `pointImageIndex` replaces wholesale.

## Cluster force

| Capability | Value | Mechanism / basis |
| --- | --- | --- |
| `clusterForce` | `true` | **Dist investigation (3.4.0, the exact pin):** `dist/index.d.ts` exposes `setPointClusters((number \| undefined)[])`, `setClusterPositions((number \| undefined)[])`, `setPointClusterStrength(Float32Array)` and `getClusterPositions()`; `dist/config.d.ts` exposes the `simulationCluster` coefficient (default `0.1`); `dist/modules/Clusters/index.d.ts` is the GPU module implementing it (centermass FBO + force application pass). The capability is therefore declared honestly, not faked. **Evidence class: Node-verifiable (dist typing scan), like `rangeUpdates`/`postDrawFrames` — the API surface is present and wired, but the visible force behavior still requires a headful probe (see the GPU evidence policy below).** |

Contract mapping applied inside the single atomic commit (staged after the
roster, before the one `render()`):

- `config.cluster.pointClusters` (`Float32Array`, **NaN = unclustered**) →
  `setPointClusters`, converting NaN to cosmos' documented `undefined`
  ("does not belong to any cluster and will not be affected by cluster
  forces").
- `config.cluster.centers` (`[x0,y0,x1,y1,…]`) → `setClusterPositions`; a
  non-finite entry becomes `undefined`, which cosmos documents as "position
  not defined → use centermass positioning instead".
- `config.cluster.strength` → the **scene-wide** `simulationCluster` config
  key via `setConfigPartial`, not the per-point `setPointClusterStrength`
  buffer (Orbit's strength is scene-wide by contract; the per-point buffer is
  available for a future per-node strength channel).
- `config.cluster: null` (the D2 explicit clear) → an all-`undefined`
  membership array of the **current roster length** plus empty cluster
  positions, so the mapping length never lags the roster (I2).

## Camera surface

| Capability | Behavior | Basis / formula |
| --- | --- | --- |
| `setViewport({x, y, zoom})` — **real pan** | Centers space point `(x, y)` at exactly the requested (or current) zoom in one call; a follow-up `getViewport()` returns the same `{x, y, zoom}` (modulo cosmos' d3 `scaleExtent` clamp). A missing `x` or `y` is filled from the current viewport; zoom-only calls keep the `setZoomLevel` path (d3 `scaleTo` preserves the center). Instant unless `durationMs` is given. | **The former zoom-only limitation is LIFTED.** The exact-pin API has no pan-to method, but `setZoomTransformByPointPositions(positions, duration, scale, padding)` is an exact center+zoom when `scale` is explicit — verified in the 3.4.0 dist (`zoomInstance.getTransform`): `store.scaleX/scaleY` are linear slope-±1 space→screen maps, a single-point bbox is widened ±0.5 *symmetrically* (center preserved), and an explicit `scale` bypasses the fit math and `padding` entirely, yielding `translate(w/2 − scaleX(x)·k, h/2 − scaleY(y)·k).scale(k)` with `k = scale`. The adapter calls `setZoomTransformByPointPositions(Float32Array.of(x, y), durationMs ?? 0, zoom ?? getZoomLevel())`. |
| viewport restore | Context-loss recovery now restores the full camera: the core replays the last stored `{x, y, zoom}` through `setViewport` after the scene commit, and the pan lands (previously only `zoom` was honored). | Supersedes the earlier zoom-only restore behavior. |

## GPU evidence policy

GPU probe records are produced locally by running the probe suite headful on a
real GPU (`pnpm probe`, which sets `PROBE_HEADFUL=1`; set `PROBE_GPU` to
describe the hardware). CI verifies the exact dependency pins with
`pnpm cosmos:pin-check` and re-runs the Node-safe probes
(`pnpm probe:node`); it never produces GPU evidence. Results rendered through
SwiftShader or any other software rasterizer are not accepted as GPU evidence.
Headless runs are permitted solely as a harness smoke test and their records
must not be committed.
