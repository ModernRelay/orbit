# Your first Orbit graph

This example renders three people and two relationships. Click a node to select
it, or type **Grace** in the search box and press Enter. The selected ID appears
below the graph; **Clear selection** updates both the text and the graph.

Use Node.js 22.18+ or 24.11+ and a browser with WebGL. Orbit supports React 18 and
newer. The Cosmos renderer is imported lazily when the graph mounts.

## Create an app

Start with the Vite React TypeScript template:

```bash
npm create vite@latest orbit-first -- --template react-ts
cd orbit-first
npm install
npm install @modernrelay/orbit-core @modernrelay/orbit-react @modernrelay/orbit-engine-cosmos
```

Replace `src/App.tsx` with this complete example:

<!-- quickstart:App.tsx -->
```tsx
import { useState } from 'react';
import type { GraphSnapshot, NodeId } from '@modernrelay/orbit-core';
import type { EngineFactory } from '@modernrelay/orbit-core/engine';
import { CosmosEngine } from '@modernrelay/orbit-engine-cosmos';
import { Graph } from '@modernrelay/orbit-react';
import { GraphSearch } from '@modernrelay/orbit-react/components/Search';

type Person = { label: string };
type Relationship = { label: string };

const data: GraphSnapshot<Person, Relationship> = {
  datasetKey: 'first-graph',
  sourceRevision: 1,
  nodes: [
    { id: 'ada', x: -160, y: -100, attrs: { label: 'Ada' } },
    { id: 'grace', x: 0, y: 100, attrs: { label: 'Grace' } },
    { id: 'katherine', x: 160, y: -100, attrs: { label: 'Katherine' } },
  ],
  edges: [
    { id: 'ada-grace', source: 'ada', target: 'grace', attrs: { label: 'works with' } },
    { id: 'grace-katherine', source: 'grace', target: 'katherine', attrs: { label: 'works with' } },
  ],
};

// Keep the factory stable; create a fresh engine for every mount.
export const createEngine: EngineFactory = () => new CosmosEngine();

// The optional engine prop also lets tests supply Orbit's FakeEngine.
export default function App({ engine = createEngine }: { engine?: EngineFactory }) {
  const [selection, setSelection] = useState<readonly NodeId[]>([]);
  const [error, setError] = useState<string | null>(null);

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 24, fontFamily: 'system-ui' }}>
      <h1>My first graph</h1>
      <p>Click a node, or search for Grace and press Enter to select her.</p>
      <div style={{ height: 420, position: 'relative' }}>
        <Graph<Person, Relationship>
          engine={engine}
          data={data}
          layout="fixed"
          labels={{ minZoom: 0, maxVisible: 3 }}
          theme={{ base: 'light' }}
          nodeSize={12}
          searchIndex={['label']}
          selection={selection}
          onSelectionChange={({ nodeIds }) => setSelection(nodeIds)}
          onError={({ error: graphError }) => setError(graphError.message)}
        >
          <GraphSearch
            placeholder="Search people…"
            onResultActivate={(result) => setSelection([result.id])}
          />
        </Graph>
      </div>
      <p role="status">Selected: {selection.join(', ') || 'none'}</p>
      <button type="button" onClick={() => setSelection([])} disabled={selection.length === 0}>
        Clear selection
      </button>
      {error !== null && <p role="alert">Could not open the graph: {error}</p>}
    </main>
  );
}
```

Replace `src/main.tsx` with the entry below. It does not import the Vite starter's
CSS, so the starter layout does not constrain the graph container.

<!-- quickstart:main.tsx -->
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

Run the app and open the local URL printed by Vite:

```bash
npm run dev
```

The graph needs a container with a real height: the example gives it 420 pixels.
The fixed layout uses each node's `x`/`y` coordinates to form a readable triangle.
Name labels are enabled even when zoomed out, with a maximum of three labels.
To let the force simulation arrange a larger dataset, omit `layout="fixed"`
and the coordinates.
`GraphSearch` is a child of `Graph`, so it automatically shares the graph instance.
No separate `GraphProvider` is needed. Built-in search always indexes IDs;
`searchIndex={['label']}` adds the label stored in each node's `attrs`.

## Update data and selection

`datasetKey` identifies the dataset. Increment or replace `sourceRevision` when
its contents change, and pass a new snapshot to `data`. Reusing the same dataset
and revision is an idempotent replay. Changing `datasetKey` clears per-dataset
state, such as selection.

The example owns selection in React: `selection` contains node IDs, and
`onSelectionChange` reflects the graph's selection intent into that state.
Search activation focuses the result; this example's `onResultActivate` callback
also selects it by updating the same React state.
Always wire both when controlling selection. To let Orbit own selection, omit
the `selection` prop and optionally listen to `onSelectionChange`. Providing a
controlled prop once establishes that ownership for the instance; do not switch
between controlled and uncontrolled modes mid-mount. Groups and pins follow the
same ownership pattern through their corresponding props and callbacks.

The engine factory is defined outside the component so its identity stays stable.
It returns a **new** `CosmosEngine` for each mount, including React StrictMode's
remount checks. The optional `engine` prop on this example app lets a test pass
`() => new FakeEngine()` from `@modernrelay/orbit-core/testing`.

## Change configuration

Data, theme, styling, and filters can update on the existing graph. For example,
set `filter={null}` to explicitly clear a filter.

Engine, services, search index, execution options, and limits are read when an
instance is constructed. Changing those props later is ignored with a warning.
To change one, key-remount the graph with a stable identity for that configuration,
for example `<Graph key={sourceId} ... />`. A remount creates a fresh instance;
save any state you want to restore. Camera fit options are also construction-only.
Keep `sourceId` stable during ordinary renders.

For a server-rendered React app, place this component behind the framework's
client-component boundary (for example, add `'use client'` in Next.js). The
WebGL canvas mounts in the browser.

Next, use the [exploration workflow guide](exploration-workflows.md) to add
inspection, bounded expansion, paths, and saved investigations. See the
[package and component inventory](../../README.md#packages) for other building
blocks.

## Run this exact example from the repository

The source lives in [`fixtures/quickstart`](../../fixtures/quickstart). The
packaging gate checks that both code blocks above match those files, typechecks
against freshly packed packages, bundles the real Cosmos renderer, and exercises
click selection, search, clearing, and teardown with `FakeEngine` in jsdom.

```bash
pnpm install
pnpm build
pnpm smoke
python3 -m http.server 5200 --directory .smoke/bundles/quickstart
```

Open <http://localhost:5200> to drive the same example with the real WebGL renderer.
The browser bundle remains after the temporary consumer installation is cleaned up.
