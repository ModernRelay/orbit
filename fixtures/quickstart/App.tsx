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
