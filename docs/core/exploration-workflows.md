# Graph exploration workflows

Orbit can combine search, inspection, bounded expansion, paths, and saved
investigations in one workspace. The headless APIs live in
`@modernrelay/orbit-core`; the optional React workspace is a component subpath:

```tsx
import { Graph } from '@modernrelay/orbit-react';
import { GraphExplorer } from '@modernrelay/orbit-react/components/Explorer';

<Graph
  engine={engine}
  data={snapshot}
  dataRef={{ graph: 'suppliers', revision: '2026-09-04' }}
  searchIndex={['label']}
  crossfilter={[{ key: 'table', kind: 'categorical', get: (node) => node.id }]}
>
  <GraphExplorer title="Supplier investigation" typeField="type" />
</Graph>
```

Inside `<Graph>`, the explorer uses its instance from context. To place it beside
the canvas, pass `instance={instance}` and `layout="panel"` in your own layout.
The default `layout="dock"` positions the workspace over its parent. Use `height`,
`style`, and `className` to size the panel. Importing the root React package does
not eagerly import the explorer.

Run `pnpm --filter orbit-storybook dev` and open **Exploration → Investigation
workflows** for seven runnable examples. They share a fictional supplier catalog
with six initially loaded entities and six additional entities available through
a cancellable asynchronous service. No credentials or network are needed. The
complete example host and service are in
`apps/storybook/src/exploration/InvestigationWorkspace.tsx` and
`apps/storybook/src/exploration/supplyChainServices.ts`.

## Find, inspect, and recover explicitly

Search does not alter scope, filters, or the loaded graph. The built-in service
indexes IDs plus the declared `searchIndex` attributes. A remote search service
can return IDs that are not loaded. Activating a result produces one of:

| Result | Meaning | Host action |
| --- | --- | --- |
| Focused | Loaded, in scope, and visible | Inspect or navigate |
| `not-loaded` | Absent from the accepted graph | Fetch and ingest it |
| `out-of-scope` | Loaded but outside the current hard scope | Change or clear that scope |
| `filtered` | Loaded but hidden by a mask | Change the relevant mask or host filter |

`GraphExplorer` exposes a recovery action for unavailable hits through
`onRecoverSearchResult`. Make the change deliberate and specific to your host:

```tsx
<GraphExplorer
  instance={instance}
  layout="panel"
  onRecoverSearchResult={async (result, reason) => {
    if (reason === 'not-loaded') {
      await loadEntity(result.id); // resolve after ingestion commits
    } else if (reason === 'out-of-scope') {
      instance.resetIsolation();
    } else {
      instance.showNodes([result.id]); // appropriate for explicit hidden IDs
    }
    // Explorer activates after recovery, unless the query/source changed.
  }}
/>
```

`showNodes` clears explicit hiding. It cannot undo a predicate filter or a
crossfilter brush. When those are the cause, update the corresponding host state
and wait for it to apply. Pass host-owned active filters as explorer `constraints`
with `{ id, label, onClear }` so the user can see and remove them. Query-coherent
search prevents results for an old input from becoming current after a slow
request completes.

## Expand a bounded neighborhood

Use the investigation session wrapper when an expansion should be replayable in
a saved investigation:

```ts
import { createInvestigationSession } from '@modernrelay/orbit-core';

const investigation = createInvestigationSession(instance);
const query = {
  direction: 'incoming',
  relationshipTypes: ['SUPPLIES'],
  relationshipTypeField: 'type',
  hops: 1,
  limit: 2,
  edgeLimit: 20,
  preserveLayout: true,
} as const;

const first = await investigation.expandNode('atlas', query);
const cursor = 'page' in first ? first.page?.nextCursor : undefined;
if (cursor !== undefined) {
  await investigation.expandNode('atlas', { ...query, cursor });
}

instance.cancelExpansion('atlas');       // pending request only
investigation.retractExpansion('atlas'); // retract the most recent recorded page
```

Relationship matching uses exact strings in `edge.attrs[relationshipTypeField]`.
The field defaults to `type`; an Omnigraph adapter uses `orbit:type`. Keep the
same seed, relationship options, and limits when following a cursor. A page can
contain only already-loaded neighbors and still have a continuation. Do not
infer completion from the number of newly visible nodes. Read `page.nextCursor`
and `page.truncated`; `totalNeighbors` can be absent when the service cannot know
its full universe. Retraction removes the most recent recorded page for that seed. It leaves base
data and contributions still owned by other expansions intact.

For passive inspection, `instance.getNeighborhood(id, options)` reads a bounded
neighborhood from the loaded graph without revealing anything. Its options
include `direction`, `relationshipTypes`, `relationshipTypeField`, `limit`,
`edgeLimit`, `cursor`, and `visibility: 'loaded' | 'visible'`. Results distinguish
node pagination from `edgesTruncated` and report visibility for returned nodes.

### Asynchronous service contract

A custom `ExpansionService` keeps the existing `neighbors(seedIds, hops, ctx)`
method and can implement `queryNeighbors(seedIds, options, ctx)` for typed,
bounded queries. Return nodes and edges, or an asynchronous batch iterable, with
optional page metadata and provenance:

```ts
const response = {
  nodes: pageNodes,
  edges: pageEdges,
  page: {
    returnedNodes: neighborCount, // exclude seed nodes
    returnedEdges: pageEdges.length,
    totalNeighbors,
    truncated: nextCursor !== undefined,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  },
  provenance: { source: 'supplier-catalog', revision: sourceRevision },
};
```

Enforce the requested node and edge budgets before returning a response. Bind
cursors to the query and source revision; reject a cursor from another query.
The fixture service deliberately supports one hop per request and reports an
error for larger values. It uses a timer and `AbortSignal`, then streams two
small batches. A production implementation can use `fetch(url, { signal:
ctx.signal })` and validate the response before returning it.

Declare the revision dimensions the service actually reads. The fixture's remote
catalog depends on `source`, while a computation over the current loaded model
may also depend on `model` or `scope`. Core checks dataset lineage and declared
revision coordinates before admitting results. Cancellation reduces wasted
work; revision admission protects correctness even when a transport ignores
abort. Expansion ingestion is atomic: cancelling a staged request must not
publish half of its neighborhood. `onProgress` reports receipt/staging progress,
not partial graph visibility.

Services, engine factories, and `searchIndex` are construction options. Use a
new instance or keyed `<Graph>` remount when replacing them.

## Keep layout and camera context

`preserveLayout: true` holds established nodes internally and cancels
automatic settle-camera follow while new neighbors arrive. Users can continue
reading their current region, then explicitly choose `instance.fitView()` when
they want to include the new area. This option does not promise that newly added
nodes already have a settled layout.

Use an explicit resume action to release exploration holds and let the existing
layout move again:

```ts
instance.resumeSimulation();
```

Changing layout kind also clears these holds. They are separate from user pins,
which remain intact; `pinnedNodeIds` reports user pins, not exploration holds. Prefer explicit camera actions to fitting after every filter,
inspection, or search input change. The **Stable layout and camera** story uses
the real force engine so these actions can be observed.

## Inspect relationships and compare selections

The reusable inspector accepts an explicit subject. Selecting a subject for
inspection can remain separate from graph selection or camera movement:

```tsx
import { GraphInspector } from '@modernrelay/orbit-react/components/Inspector';

<GraphInspector
  instance={instance}
  layout="panel"
  typeField="type"
  subject={{ kind: 'edge', id: 'harbor-atlas' }}
/>

<GraphInspector
  instance={instance}
  layout="panel"
  subject={{ kind: 'selection', nodeIds: ['harbor', 'cedar'] }}
/>
```

Relationship inspection includes directed endpoints and attributes. The supplier
example carries `evidence`, `confidence`, and `observedAt`, so a user can assess
why the relationship is present. Multiselection inspection supports comparison
without requiring an arbitrary single selected node. `GraphExplorer` composes
these surfaces with a persistent node table and neighborhood actions.

## Preserve path order and state the searched universe

Use `findPathDetailed` when the UI needs an explanatory outcome. Its default
universe is `visible`. The `loaded` universe deliberately includes loaded nodes
outside the current scope or hidden by masks. Neither built-in universe fetches
unloaded remote topology.

```ts
const options = {
  direction: 'outgoing',
  universe: 'loaded',
  maxHops: 6,
} as const;
const result = await instance.findPathDetailed('report', 'bike', options);

if (result.status === 'found') {
  investigation.savePath({
    title: 'Evidence to product',
    sourceId: 'report',
    targetId: 'bike',
    options,
    path: result.path,
  });
}
```

A found result contains ordered `nodeIds` and the corresponding `edgeIds` between
them. Retain that order when rendering steps. Other outcomes are `not-loaded`,
`filtered`, `unreachable`, and `hop-limit`; an unreachable result is scoped to the
chosen loaded/visible universe and relationship constraints. A hidden
intermediate node can disconnect the visible graph even when both endpoints are
visible; the built-in resolver reports `filtered` with blocker node IDs when a
corresponding loaded path exists. The detailed query is passive; saving or inspecting its result need not
move the camera or overwrite selection.

## Save and reopen investigations

An investigation checkpoint contains a title, notes, source coordinates, view
state, search text, saved paths, and replayable expansion requests. Use
`dataRef` for the host's durable source reference. Runtime overlay IDs and
revision-bound cursor strings are not the durable representation: restoring
replays requests and obtains fresh continuation cursors.

```ts
investigation.setTitle('Atlas supplier disruption');
investigation.setNotes('Verify the port bulletin before changing suppliers.');
const saved = await investigation.checkpoint('Initial evidence', {
  includePositions: true,
});

// Storage is a host choice: local storage, a file, or your authenticated backend.
const json = investigation.exportCheckpoint(saved);
localStorage.setItem('supplier-investigation', json);

const stored = localStorage.getItem('supplier-investigation');
if (stored !== null) {
  const imported = investigation.importCheckpoint(stored); // validates; no restore yet
  await investigation.restoreCheckpoint(imported);
}
```

To survive host remounts, construct the session with a getter:

```ts
const investigation = createInvestigationSession(
  () => graphRef.current?.instance ?? null,
  {
    async loadSource(source, { signal }) {
      await loadAndAcceptSource(source, signal);
      // Resolve only once the getter returns the current instance AND its
      // accepted datasetKey, sourceRevision, and dataRef match source exactly.
    },
    captureHostState: () => serializableFilters,
    async restoreHostState(savedFilters, { signal }) {
      await reflectFiltersAndWaitForGraph(savedFilters, signal);
    },
  },
);
```

`loadAndAcceptSource` and `reflectFiltersAndWaitForGraph` are host functions, not
Orbit exports. A host loader can use an awaited replacing ingest session; a
React state setter alone does not mean the source has been accepted. A source
mismatch without a loader fails explicitly. A loader that cannot serve the
requested revision must reject rather than substitute its current revision.
Use `captureHostState`/`restoreHostState` for predicate-filter intent or other
host state that view-state serialization cannot reconstruct.

Call `investigation.refreshSource()` after replacing the instance returned by the
getter; `GraphExplorer` does this when its instance changes. Source changes discard
current source-specific evidence while retaining saved checkpoints. Undo and redo
reconcile recorded expansion recipes with the live expansion stack.

Pass this session as `<GraphExplorer investigation={investigation} />`. Route
durable expansion and path actions through it; unrelated direct instance actions
are not automatically recorded as replay recipes. Dispose the session when its
owning workspace closes. Handle storage failures and restore errors in the host.

The **Save and reopen investigations** story stores up to eight exported
checkpoints under its own localStorage key. **Fresh canvas** recreates the graph
from the seed data, and reopening replays the saved supplier pages. **Try
unavailable source** demonstrates an explicit failure without substituting data.
Checkpoint replay requires the referenced source and services to remain
available; the checkpoint is an investigation recipe, not an offline graph dump.

Checkpoint restore replays multiple operations. If replay fails or is cancelled,
it removes contributions admitted by that restore and reports the error; it does
not reconstruct the previous investigation or reverse host loader/filter side
effects. Save the current work as a checkpoint before switching investigations.
