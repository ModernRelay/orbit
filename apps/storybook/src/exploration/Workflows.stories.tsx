import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { InvestigationWorkspace } from './InvestigationWorkspace';

const meta = {
  title: 'Exploration/Investigation workflows',
  component: InvestigationWorkspace,
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component: 'Seven runnable workflows share a fictional supplier catalog. The graph loads six of twelve entities; a delayed, cancellable in-memory service supplies search and paginated neighborhoods. No credentials or network are needed. Use Canvas for the full workspace. The source files include the backend implementation and browser checkpoint persistence.',
      },
    },
  },
  argTypes: { workflow: { table: { disable: true } } },
} satisfies Meta<typeof InvestigationWorkspace>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FindAndInspect: Story = {
  name: '1 · Find and inspect',
  args: { workflow: 'find' },
  parameters: { docs: {
    description: { story: 'Search is query-coherent and does not mutate visibility. Harbor is loaded but hidden, Cedar can be outside an isolation, and Ember is remote-only. The host recovery callback explicitly reveals, resets scope, or fetches an entity before activation.' },
    source: { code: `import { GraphExplorer } from '@modernrelay/orbit-react/components/Explorer';

<GraphExplorer
  instance={instance}
  layout="panel"
  onRecoverSearchResult={async (result, reason) => {
    if (reason === 'not-loaded') await loadEntity(result.id);
    else if (reason === 'out-of-scope') instance.resetIsolation();
    else instance.showNodes([result.id]); // this host uses explicit hidden IDs
    // Explorer activates only if the query/source is still current.
  }}
/>` },
  } },
};

export const TypedExpansion: Story = {
  name: '2 · Bounded typed expansion',
  args: { workflow: 'expand' },
  parameters: { docs: {
    description: { story: 'Request incoming SUPPLIES only, capped at two neighbors. The first page contains already-loaded nodes and still has a continuation; keep following the server cursor. The session records expansion intent for later checkpoint replay. Retract preserves base data and contributions owned by other expansions.' },
    source: { code: `const result = await investigation.expandNode('atlas', {
  direction: 'incoming',
  relationshipTypes: ['SUPPLIES'],
  relationshipTypeField: 'type',
  hops: 1,
  limit: 2,
  preserveLayout: true,
  ...(cursor === undefined ? {} : { cursor }),
});
if ('page' in result) cursor = result.page?.nextCursor;
// A zero-new-node page can still have another cursor.
instance.cancelExpansion('atlas'); // pending work only
investigation.retractExpansion('atlas'); // most recent committed page` },
  } },
};

export const StableMap: Story = {
  name: '3 · Stable layout and camera',
  args: { workflow: 'stable' },
  parameters: { docs: {
    description: { story: 'This example runs a real force layout. Pan or zoom before loading another supplier page. preserveLayout retains established positions through internal holds and stops settle-camera follow. The new nodes can settle; Fit all is a deliberate camera action, and Resume full layout releases those holds while keeping user pins.' },
    source: { code: `await investigation.expandNode('atlas', {
  direction: 'incoming', relationshipTypes: ['SUPPLIES'],
  limit: 2, preserveLayout: true,
});
// Camera changes are explicit user actions.
instance.fitView();
// Release exploration holds; user pins remain intact.
instance.resumeSimulation();` },
  } },
};

export const RelationshipsAndComparison: Story = {
  name: '4 · Relationships and comparison',
  args: { workflow: 'inspect' },
  parameters: { docs: {
    description: { story: 'The relationship inspector shows the directed endpoints, type, evidence, confidence, and observation date. Compare two suppliers without converting inspection into navigation. The node, edge, and multiselection cases use the same persistent inspector.' },
    source: { code: `import { GraphInspector } from '@modernrelay/orbit-react/components/Inspector';

<GraphInspector instance={instance} layout="panel"
  subject={{ kind: 'edge', id: 'harbor-atlas' }} />
<GraphInspector instance={instance} layout="panel"
  subject={{ kind: 'selection', nodeIds: ['harbor', 'cedar'] }} />` },
  } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const compare = canvas.getByRole('button', { name: 'Compare Harbor and Cedar' });
    await waitFor(() => expect(compare).toBeEnabled());
    await userEvent.click(compare);
    await canvas.findByRole('heading', { name: '2 nodes selected' });
    await userEvent.click(canvas.getByRole('button', { name: 'Inspect Harbor → Atlas' }));
    await canvas.findByText('Supplier register: battery contract');
  },
};

export const OrderedPaths: Story = {
  name: '5 · Ordered paths and graph coverage',
  args: { workflow: 'paths' },
  parameters: { docs: {
    description: { story: 'The report-to-bicycle chain crosses hidden Harbor. A visible-only request reports filtered; a loaded-graph request returns report → delay → harbor → atlas → bike. The saved result preserves step order and relationship IDs, while the explorer can inspect each step. Neither universe searches unloaded remote topology.' },
    source: { code: `const options = { direction: 'outgoing', universe: 'loaded', maxHops: 6 } as const;
const result = await instance.findPathDetailed('report', 'bike', options);
if (result.status === 'found') {
  investigation.savePath({
    title: 'Evidence to product', sourceId: 'report', targetId: 'bike',
    options, path: result.path,
  });
}
// Handle not-loaded, filtered, unreachable, and hop-limit explicitly.` },
  } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const visible = canvas.getByRole('button', { name: 'Find visible path' });
    await waitFor(() => expect(visible).toBeEnabled());
    await userEvent.click(visible);
    await canvas.findByText('visible: filtered. No path was added.');
    await userEvent.click(canvas.getByRole('button', { name: 'Find loaded path' }));
    await canvas.findByText('loaded: report → delay → harbor → atlas → bike. Saved to the path list.');
  },
};

export const NamedInvestigations: Story = {
  name: '6 · Save and reopen investigations',
  args: { workflow: 'save' },
  parameters: { docs: {
    description: { story: 'Use named checkpoints to retain notes, source identity, search text, paths, expansion recipes, and view state. This host persists exported checkpoint JSON to localStorage (at most eight); the library does not choose your storage. A fresh canvas starts from the same seed snapshot. Reopening replays expansion requests, then restores the saved view. Clear saved examples removes only this story’s storage key.' },
    source: { code: `import { createInvestigationSession } from '@modernrelay/orbit-core';

const investigation = createInvestigationSession(() => graphRef.current?.instance ?? null);
investigation.setTitle('Atlas supplier disruption');
investigation.setNotes('Verify the port bulletin before changing suppliers.');
await investigation.expandNode('atlas', { direction: 'incoming', limit: 2 });
const checkpoint = await investigation.checkpoint('Initial evidence', { includePositions: true });
localStorage.setItem('my-investigation', investigation.exportCheckpoint(checkpoint));

// On reopening: load the intended source, validate the imported document, restore.
const imported = investigation.importCheckpoint(JSON.parse(localStorage.getItem('my-investigation')!));
await investigation.restoreCheckpoint(imported);
// The source includes the Graph dataRef; configure loadSource for other sources.` },
  } },
};

export const CancellableService: Story = {
  name: '7 · Async service lifecycle',
  args: { workflow: 'async' },
  parameters: { docs: {
    description: { story: 'The fixture implements ExpansionService.queryNeighbors and SearchService with real asynchronous delays, source-bound revision dependencies, bounded pages, request provenance, and AbortSignal checks. Expansion responses stream nodes and edges in separate batches; the instance stages them atomically. Cancel a request and inspect the lifecycle log, then retry.' },
    source: { code: `const expansion = {
  revisionDependencies: ['source'],
  async queryNeighbors(seedIds, options, ctx) {
    const response = await fetch('/api/neighbors', {
      method: 'POST', signal: ctx.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seedIds, ...options, sourceRevision: ctx.sourceRevision }),
    });
    if (!response.ok) throw new Error('Neighborhood request failed');
    // Validate the server's nodes, edges, and page metadata here.
    return parseNeighborhood(await response.json());
  },
  neighbors: legacyOneHopRequest,
};
// These service options are construction-only: remount for a new service.
<Graph engine={engine} services={{ expansion }} data={seedSnapshot} />` },
  } },
};
