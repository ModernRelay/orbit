# Scope, versions, and streaming data

This guide covers three workflows: choosing between the two "show me less"
modes, flipping between versions of the same dataset, and
streaming data in through revisioned ingest sessions.

## Choosing a mode: `filter` vs `subgraph`

Two different intents hide behind "focus on this subset":

| You want | Use |
|---|---|
| Timeline/legend toggle, keep the map stable | `filter` (soft) |
| "Show me only this cluster and re-arrange it" | `subgraph` (hard, reflow) |
| Progressive neighborhood exploration | `subgraph` with `hops`, pinned accretion |

**Soft filter** will dim/hide out-of-filter elements without touching the
layout — positions stay put, so toggling a legend entry never reshuffles the
map.

**Hard subgraph** feeds *only* the resolved subset through the reconciler: the
scene is rebuilt around what remains, positions come from the position cache,
and (by default) the layout reflows so the remainder reorganizes. This is what
users usually mean by "drill down".

```tsx
import { Graph } from '@modernrelay/orbit-react';

// Hard-scope to two seeds plus their 1-hop neighborhoods.
<Graph
  engine={engineFactory}
  data={snapshot}
  subgraph={{ seedIds: ['a', 'b'], hops: 1 }}
/>

// Keep the survivors where they are instead of reflowing:
<Graph engine={engineFactory} data={snapshot} subgraph={{ seedIds: ['a', 'b'], reflow: false }} />

// Restore the full model (cached positions return with it):
<Graph engine={engineFactory} data={snapshot} subgraph={null} />
```

Notes on the `subgraph` prop:

- It is **uncontrolled-only** in v0.5: the prop, `isolateSelection()`, and
  `resetIsolation()` all write the same instance-owned state — last writer
  wins, and *omitting* the prop leaves the last written scope in place.
- It is diffed **structurally** (specs are small), so passing a new but equal
  object every render is a no-op.
- A scope-only change advances the `scope` and `render` revisions but **not**
  `model` — counts in the store stay accepted-model counts, and
  `getVisibleNodeIds()` reflects the scoped scene.

The same state is reachable imperatively, which is what a context-menu
"Isolate" action wants:

```ts
const handle = graphRef.current!;
handle.setSelection(['a', 'b']);
handle.isolateSelection(); // subgraph: { seedIds: ['a', 'b'] }
handle.resetIsolation(); // subgraph: null

// Progressive exploration: reveal neighbors through the expansion service.
// Already-placed nodes are pinned while the arrivals settle (accretion).
const result = await handle.expandNode('a'); // { added } | { noop: true }
handle.collapseNode('a'); // undo that expansion
```

`expandNode` resolves neighbors through `GraphServices.expansion`. The default
service is **local**: it walks the core's adjacency over the accepted base
dataset — including currently out-of-scope nodes — with zero configuration and
zero network. While a call is in flight the node id appears in the store's
`pendingExpansions` set (`useGraphPendingExpansions()`), which is the hook to
drive spinners or ghost skeletons from.

## Version switching (branches / snapshots)

For sources with version coordinates, **switching versions is just a new
`sourceRevision` under the same `datasetKey`**:

```tsx
// Version A
<Graph engine={engineFactory} data={{ datasetKey: 'deps', sourceRevision: 'branch@41', nodes: a.nodes, edges: a.edges }} />

// Version B — same datasetKey, new sourceRevision
<Graph engine={engineFactory} data={{ datasetKey: 'deps', sourceRevision: 'branch@42', nodes: b.nodes, edges: b.edges }} />
```

The structural diff applies (added ids appear, removed ids leave), and the
position cache keeps shared nodes exactly where they were — which is what
makes "flip between two versions and see what moved" legible.

Caveats and levers:

- **Exact cross-version position identity holds for non-live layouts**
  (`layout: 'fixed'`). Under `layout: 'force'` a structure change restarts the
  simulation (`alpha: 1`), so everything drifts as it re-settles.
- If you must stay on `force`, suppress the visual churn instead: call
  `instance.pauseSimulation()` right after the swap, or pre-pin the ids you
  are comparing (`pinNode`) so only unpinned nodes move.
- Replaying the **same** `{datasetKey, sourceRevision}` is idempotent — an
  ordinary React re-render never rebuilds anything, and (importantly) never
  clears committed overlays or expansion results.
- Changing the `datasetKey` is a different statement entirely: it declares a
  *new dataset* and clears all per-dataset id-keyed state, including the
  position cache and any active hard scope.

**Diff styling** (added/removed/changed) is ordinary accessor work over an
externally computed change set — computing that set is your job, rendering it
is one accessor:

```tsx
const changed: ReadonlySet<string> = diffAgainstPreviousVersion(a, b);
const added: ReadonlySet<string> = addedInThisVersion(a, b);

const nodeColor = (node: GraphNode<Attrs>): string =>
  added.has(node.id) ? '#3fb950' : changed.has(node.id) ? '#f2cc60' : '#58a6ff';

<Graph engine={engineFactory} data={current} nodeColor={nodeColor} />
```

Accessors are identity-diffed, so derive them with `useMemo` keyed on the
change set.

## Streaming data in: `IngestSession`

`beginIngest()` opens a bounded, cancellable session against an explicit
`datasetKey` and a compare-and-set `baseModelRevision` (the model revision
current when the session begins; zero on an empty instance — a mismatch
throws `stale-revision`).

### Replace: atomically establish a new source coordinate

```ts
const instance = graphRef.current!.instance;

const session = instance.beginIngest({
  purpose: 'replace', // always atomic
  datasetKey: 'feed-2026-07',
  sourceRevision: 1, // the coordinate the commit establishes
  baseModelRevision: instance.getRevisions().model,
  // An atomic session only drains at commit, so size the byte budget for the
  // WHOLE payload. An append that would cross it rejects and aborts the
  // session; it never parks waiting for an unreachable pre-commit drain.
  maxPendingBytes: 128 * 1024 * 1024,
});

let sequence = 0;
for await (const rows of feed) { // rows: { nodes?, edges?, bytes? }
  // Backpressure pattern: NEVER send batch n+1 before receipt n resolves.
  const receipt = await session.append({
    sequence,
    batchId: `feed-${sequence}`, // idempotency key (safe to retry)
    nodes: rows.nodes,
    edges: rows.edges,
    bytes: rows.bytes, // declared size; estimated if omitted
  });
  sequence += 1;
  meter.update(receipt.pendingBytes); // bytes admitted but not yet flushed
}
await session.commit(); // ONE publication: the new base
```

Rules worth knowing:

- `maxPendingBytes` is soft backpressure for progressive overlays, whose
  staged batches can drain on a timed flush. It is a hard whole-session cap
  for atomic overlays and replace sessions: an append that would exceed it
  rejects with `queue-overflow` and terminally rolls the session back.
- Sequences are consecutive from zero. Replaying an admitted
  `{sequence, batchId}` returns the original receipt without reprocessing —
  retries are free. The same sequence with a *different* batchId rejects.
- Nothing publishes until `commit()` — no partial frames, because progressive
  replace would expose rows before their `sourceRevision` existed.
- Edges may arrive before their nodes; dangling-edge diagnostics are emitted
  only at commit, so source order does not matter.
- While a **declarative** snapshot is actively driving the instance (you have
  passed `data` through `<Graph>`/`applyHostUpdate`), `purpose: 'replace'` is
  rejected at begin — two writers may not race for the base. Either keep
  applying snapshots, or own the base via sessions from the start (the demo
  remounts `<Graph>` without `data` before streaming).

### Progressive overlay: rows appear as they stream

Overlays merge *on top of* the current dataset (they must name the current
`datasetKey`) and advance only the model revision. With `atomic: false` the
session flushes at most once per commit turn and no later than
`maxFlushLatencyMs`:

```ts
const overlay = instance.beginIngest({
  purpose: 'overlay',
  datasetKey: 'feed-2026-07',
  baseModelRevision: instance.getRevisions().model,
  atomic: false, // progressive — rows appear as flushed
  overlayId: 'enrichment-a', // stable caller id (generated when omitted)
  maxFlushLatencyMs: 50,
});

const receipt = await overlay.append({ sequence: 0, batchId: 'b0', nodes: extraNodes });
// Progressive receipts resolve AFTER their flush is public:
receipt.publishedModelRevision; // → number

await overlay.commit(); // registers the overlay id
instance.getOverlayIds(); // → ['enrichment-a']

// Later: atomically remove exactly this contribution (id is released for reuse).
instance.removeOverlay('enrichment-a'); // → { removed: true }
```

Overlay behavior to rely on:

- Concurrent overlay sessions are append-only and merge in global admission
  order; a same-id row that lost emits an `overlay-node-shadowed` diagnostic
  and is promoted automatically if the winning overlay is removed.
- `abort()` on a progressive overlay rolls back only *that session's* rows —
  every other session and overlay stays intact.
- A replacing snapshot or replace session clears every overlay; replaying the
  same base source coordinate does **not** — ordinary React re-renders never
  erase expansion or enrichment results.
- Expansion results (`expandNode`) merge through exactly this machinery: one
  atomic overlay session per admitted result, so `collapseNode`/
  `removeOverlay` remove precisely the contribution they own.

The React binding exposes the read side as hooks: `useGraphScope()` for the
active hard scope, `useGraphOverlays()` for committed overlay ids, and
`useGraphPendingExpansions()` for in-flight expansions.
