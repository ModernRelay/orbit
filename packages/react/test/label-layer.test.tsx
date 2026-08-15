/**
 * DOM label lane tests — candidates render as text nodes,
 * position ticks are imperative (no React re-render), label clicks drive the
 * Selection semantics, escape hatch, and the enabled gate.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Profiler } from 'react';
import type { GraphSnapshot, GraphStoreState, LabelPlacement, NodeId } from '@modernrelay/orbit-core';
import { GRAPH_THEME_DARK } from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { Graph, GraphProvider, LabelLayer } from '../src/index';
import type { AnyGraphInstance } from '../src/GraphProvider';

const snapshot: GraphSnapshot = {
  datasetKey: 'ds',
  sourceRevision: 1,
  nodes: [{ id: 'a' }, { id: 'b' }],
  edges: [{ source: 'a', target: 'b' }],
};

async function flush(): Promise<void> {
  await act(async () => {});
}

function placement(id: NodeId, text: string, x = 0, y = 0): LabelPlacement {
  return { id, text, x, y, forced: false };
}

function makeState(): GraphStoreState {
  return {
    status: 'ready',
    revisions: { source: null, model: 0, scope: 0, render: 0, appliedRender: null },
    nodeCount: 2,
    edgeCount: 1,
    selection: { nodeIds: [], edgeIds: [], groupIds: [] },
    hover: { nodeId: null, edgeId: null },
    pins: new Map(),
    hiddenNodeIds: new Set(),
    scope: null,
    pendingExpansions: new Set(),
    folds: new Map(),
    visible: { nodes: 0, edges: 0 },
    timeline: { playingKey: null },
    history: { undoDepth: 0, redoDepth: 0 },
    overlayIds: [],
    groups: [],
    pinnedNodeIds: new Set<string>(),
    search: null,
    viewport: null,
    diagnostics: [],
    simulationRunning: false,
    theme: GRAPH_THEME_DARK,
  };
}

/** Structural mock of the pinned overlay interface: store + labels lane +
 * the public selection mutator LabelLayer clicks drive. */
function createLabelsMock(initialCandidates: readonly LabelPlacement[] = []): {
  instance: AnyGraphInstance;
  setSelection: ReturnType<typeof vi.fn>;
  selectCluster: ReturnType<typeof vi.fn>;
  requestNodeContextMenu: ReturnType<typeof vi.fn>;
  emitCandidates: (list: readonly LabelPlacement[]) => void;
  emitPositions: (list: readonly LabelPlacement[]) => void;
} {
  let state = makeState();
  const storeSubs = new Set<() => void>();
  let candidates = initialCandidates;
  const candidateSubs = new Set<(list: readonly LabelPlacement[]) => void>();
  const positionSubs = new Set<(list: readonly LabelPlacement[]) => void>();

  const setSelection = vi.fn((ids: readonly NodeId[]) => {
    state = { ...state, selection: { ...state.selection, nodeIds: [...ids] } };
    for (const cb of [...storeSubs]) cb();
  });
  const selectCluster = vi.fn((_key: string, _opts?: { additive?: boolean }) => {});
  const requestNodeContextMenu = vi.fn(
    (_id: NodeId, _screen: readonly [number, number]) => {},
  );

  const raw = {
    store: {
      getState: () => state,
      subscribe: (cb: () => void) => {
        storeSubs.add(cb);
        return () => {
          storeSubs.delete(cb);
        };
      },
    },
    labels: {
      subscribeCandidates(cb: (list: readonly LabelPlacement[]) => void) {
        candidateSubs.add(cb);
        cb(candidates); // replay current state on subscribe
        return () => {
          candidateSubs.delete(cb);
        };
      },
      subscribePositions(cb: (list: readonly LabelPlacement[]) => void) {
        positionSubs.add(cb);
        cb(candidates); // replay current state on subscribe
        return () => {
          positionSubs.delete(cb);
        };
      },
    },
    setSelection,
    selectCluster,
    requestNodeContextMenu,
    // the members a cluster label activation resolves to.
    getClusters: () => [
      { key: 'red', memberIds: ['a', 'b'], forceCenter: [0, 0], centroid: null },
    ],
    getNode: (id: NodeId) => ({ id }),
  };

  return {
    instance: raw as unknown as AnyGraphInstance,
    setSelection,
    selectCluster,
    requestNodeContextMenu,
    emitCandidates: (list) => {
      candidates = list;
      for (const cb of [...candidateSubs]) cb(list);
    },
    emitPositions: (list) => {
      for (const cb of [...positionSubs]) cb(list);
    },
  };
}

afterEach(() => {
  cleanup();
});

describe('<LabelLayer>', () => {
  it('renders candidate text as a TEXT NODE only — hostile strings appear literally', () => {
    const payload = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    const mock = createLabelsMock([placement('a', payload, 5, 6)]);
    const { container } = render(
      <GraphProvider instance={mock.instance}>
        <LabelLayer />
      </GraphProvider>,
    );

    const layer = container.querySelector('[data-orbit-label-layer]')!;
    const el = container.querySelector('[data-orbit-label="a"]')!;
    // The script payload appears literally: one text node, zero element children.
    expect(el.textContent).toBe(payload);
    expect(el.children.length).toBe(0);
    expect(el.childNodes.length).toBe(1);
    expect(el.childNodes[0]!.nodeType).toBe(Node.TEXT_NODE);
    expect(layer.querySelector('img')).toBeNull();
    expect(layer.querySelector('script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('position ticks move transforms imperatively without a React re-render', () => {
    const mock = createLabelsMock([placement('a', 'Alpha', 5, 6), placement('b', 'Beta', 7, 8)]);
    let commits = 0;
    const { container } = render(
      <Profiler
        id="labels"
        onRender={() => {
          commits++;
        }}
      >
        <GraphProvider instance={mock.instance}>
          <LabelLayer />
        </GraphProvider>
      </Profiler>,
    );

    const a = container.querySelector('[data-orbit-label="a"]') as HTMLElement;
    const b = container.querySelector('[data-orbit-label="b"]') as HTMLElement;
    expect(a.style.transform).toBe('translate3d(5px, 6px, 0)');
    expect(b.style.transform).toBe('translate3d(7px, 8px, 0)');

    const commitsBefore = commits;
    act(() => {
      mock.emitPositions([placement('a', 'Alpha', 50, 60), placement('b', 'Beta', 70, 80)]);
    });
    // Fresh transforms, zero committed renders.
    expect(a.style.transform).toBe('translate3d(50px, 60px, 0)');
    expect(b.style.transform).toBe('translate3d(70px, 80px, 0)');
    expect(commits).toBe(commitsBefore);

    // A candidate SET change DOES re-render (content changes).
    act(() => {
      mock.emitCandidates([placement('a', 'Alpha', 50, 60)]);
    });
    expect(commits).toBeGreaterThan(commitsBefore);
    expect(container.querySelector('[data-orbit-label="b"]')).toBeNull();
  });

  it('label clicks replace on plain click and toggle on meta/shift', () => {
    const mock = createLabelsMock([placement('a', 'Alpha'), placement('b', 'Beta')]);
    const { container } = render(
      <GraphProvider instance={mock.instance}>
        <LabelLayer />
      </GraphProvider>,
    );
    const a = container.querySelector('[data-orbit-label="a"]')!;
    const b = container.querySelector('[data-orbit-label="b"]')!;

    fireEvent.click(a);
    expect(mock.setSelection).toHaveBeenLastCalledWith(['a']);

    fireEvent.click(b, { metaKey: true }); // toggle-in
    expect(mock.setSelection).toHaveBeenLastCalledWith(['a', 'b']);

    fireEvent.click(a, { shiftKey: true }); // toggle-out
    expect(mock.setSelection).toHaveBeenLastCalledWith(['b']);

    fireEvent.click(a); // plain click replaces
    expect(mock.setSelection).toHaveBeenLastCalledWith(['a']);
  });

  it('label right-click routes into the typed context-menu channel, not the browser menu', () => {
    const mock = createLabelsMock([placement('a', 'Alpha')]);
    const { container } = render(
      <GraphProvider instance={mock.instance}>
        <LabelLayer />
      </GraphProvider>,
    );
    const a = container.querySelector('[data-orbit-label="a"]')!;

    // Label divs are pointerEvents:'auto', so the DOM (not the canvas) owns
    // this gesture — it must feed the SAME typed channel the canvas feeds,
    // and it must suppress the browser's native menu.
    const prevented = !fireEvent.contextMenu(a, { clientX: 40, clientY: 25 });
    expect(prevented, 'the native browser menu must be suppressed').toBe(true);
    expect(mock.requestNodeContextMenu).toHaveBeenCalledTimes(1);
    const [id, screen] = mock.requestNodeContextMenu.mock.calls[0]!;
    expect(id).toBe('a');
    // Container-relative CSS px (jsdom rects sit at 0,0 so client == local).
    expect(screen).toEqual([40, 25]);
  });

  it('cluster-label right-click stays native: no context-menu call, no preventDefault', () => {
    const mock = createLabelsMock([]);
    const { container } = render(
      <GraphProvider instance={mock.instance}>
        <LabelLayer />
      </GraphProvider>,
    );
    act(() => {
      mock.emitCandidates([{ id: 'red', text: 'red', x: 0, y: 0, forced: false, kind: 'cluster' }]);
    });
    const cluster = container.querySelector('[data-orbit-cluster-label="red"]')!;

    const prevented = !fireEvent.contextMenu(cluster, { clientX: 10, clientY: 10 });
    expect(prevented).toBe(false); // browser menu allowed — no cluster target exists
    expect(mock.requestNodeContextMenu).not.toHaveBeenCalled();
  });

  it('renderNodeLabel escape hatch renders custom content inside the positioned div', () => {
    const mock = createLabelsMock([placement('a', 'Alpha', 5, 6)]);
    const { container } = render(
      <GraphProvider instance={mock.instance}>
        <LabelLayer
          renderNodeLabel={({ node, text }) => (
            <em data-testid="custom">
              {text}:{node.id}
            </em>
          )}
        />
      </GraphProvider>,
    );
    const el = container.querySelector('[data-orbit-label="a"]') as HTMLElement;
    expect(el.style.transform).toBe('translate3d(5px, 6px, 0)');
    const custom = el.querySelector('[data-testid="custom"]');
    expect(custom).not.toBeNull();
    expect(custom!.tagName).toBe('EM');
    expect(custom!.textContent).toBe('Alpha:a');
  });

  it('applies the labelClassName class hook and keeps the layer pointer-inert', () => {
    const mock = createLabelsMock([placement('a', 'Alpha')]);
    const { container } = render(
      <GraphProvider instance={mock.instance}>
        <LabelLayer labelClassName="my-label" />
      </GraphProvider>,
    );
    const layer = container.querySelector('[data-orbit-label-layer]') as HTMLElement;
    const el = container.querySelector('[data-orbit-label="a"]') as HTMLElement;
    expect(layer.style.pointerEvents).toBe('none');
    expect(el.style.pointerEvents).toBe('auto');
    expect(el.classList.contains('my-label')).toBe(true);
  });

  it('<Graph labels={{ enabled: false }}> renders no label layer; the default renders one', async () => {
    const disabled = render(
      <Graph engine={() => new FakeEngine()} data={snapshot} labels={{ enabled: false }} />,
    );
    await flush();
    expect(disabled.container.querySelector('[data-orbit-label-layer]')).toBeNull();

    const enabled = render(<Graph engine={() => new FakeEngine()} data={snapshot} />);
    await flush();
    expect(enabled.container.querySelector('[data-orbit-label-layer]')).not.toBeNull();
  });
});

/** cluster labels: a DISTINCT placement kind on the same lane
 * — separate id namespace, separate class hook and render prop, and a click
 * that resolves to member node ids. */
describe('<LabelLayer> cluster placements', () => {
  const clusterPlacement = (key: string, text: string, x = 0, y = 0): LabelPlacement => ({
    id: key,
    text,
    x,
    y,
    forced: false,
    kind: 'cluster',
  });

  it('renders cluster labels under their own attribute, keyed apart from node ids', () => {
    // Same id in BOTH namespaces: a node 'red' and a cluster 'red'.
    const mock = createLabelsMock([
      clusterPlacement('red', 'red', 1, 2),
      placement('red', 'Red node', 3, 4),
    ]);
    const { container } = render(
      <GraphProvider instance={mock.instance}>
        <LabelLayer />
      </GraphProvider>,
    );
    const cluster = container.querySelector('[data-orbit-cluster-label="red"]') as HTMLElement;
    const node = container.querySelector('[data-orbit-label="red"]') as HTMLElement;
    expect(cluster).not.toBeNull();
    expect(node).not.toBeNull();
    expect(cluster.style.transform).toBe('translate3d(1px, 2px, 0)');
    expect(node.style.transform).toBe('translate3d(3px, 4px, 0)');
  });

  it('keeps text-node-only rendering for cluster keys', () => {
    const payload = '<img src=x onerror="window.__pwnedCluster=1">';
    const mock = createLabelsMock([clusterPlacement(payload, payload)]);
    const { container } = render(
      <GraphProvider instance={mock.instance}>
        <LabelLayer />
      </GraphProvider>,
    );
    const el = container.querySelector(`[data-orbit-cluster-label]`)!;
    expect(el.textContent).toBe(payload);
    expect(el.children.length).toBe(0);
    expect(el.childNodes[0]!.nodeType).toBe(Node.TEXT_NODE);
    expect((window as unknown as { __pwnedCluster?: number }).__pwnedCluster).toBeUndefined();
  });

  it('position ticks move cluster transforms without touching node labels', () => {
    const mock = createLabelsMock([
      clusterPlacement('red', 'red', 1, 2),
      placement('a', 'Alpha', 3, 4),
    ]);
    const { container } = render(
      <GraphProvider instance={mock.instance}>
        <LabelLayer />
      </GraphProvider>,
    );
    act(() => {
      mock.emitPositions([clusterPlacement('red', 'red', 11, 22), placement('a', 'Alpha', 3, 4)]);
    });
    const cluster = container.querySelector('[data-orbit-cluster-label="red"]') as HTMLElement;
    const node = container.querySelector('[data-orbit-label="a"]') as HTMLElement;
    expect(cluster.style.transform).toBe('translate3d(11px, 22px, 0)');
    expect(node.style.transform).toBe('translate3d(3px, 4px, 0)');
  });

  it('a cluster-label click resolves to member node ids via selectCluster', () => {
    const mock = createLabelsMock([clusterPlacement('red', 'red')]);
    const { container } = render(
      <GraphProvider instance={mock.instance}>
        <LabelLayer />
      </GraphProvider>,
    );
    const el = container.querySelector('[data-orbit-cluster-label="red"]')!;

    fireEvent.click(el);
    expect(mock.selectCluster).toHaveBeenLastCalledWith('red', { additive: false });
    expect(mock.setSelection).not.toHaveBeenCalled();

    fireEvent.click(el, { metaKey: true });
    expect(mock.selectCluster).toHaveBeenLastCalledWith('red', { additive: true });
  });

  it('clusterLabelClassName and renderClusterLabel apply only to cluster labels', () => {
    const mock = createLabelsMock([
      clusterPlacement('red', 'red'),
      placement('a', 'Alpha'),
    ]);
    const { container } = render(
      <GraphProvider instance={mock.instance}>
        <LabelLayer
          labelClassName="lbl"
          clusterLabelClassName="cluster-lbl"
          renderClusterLabel={({ clusterKey, memberIds }) => (
            <em data-testid="cluster-custom">
              {clusterKey}:{memberIds.join('+')}
            </em>
          )}
        />
      </GraphProvider>,
    );
    const cluster = container.querySelector('[data-orbit-cluster-label="red"]') as HTMLElement;
    const node = container.querySelector('[data-orbit-label="a"]') as HTMLElement;
    expect(cluster.classList.contains('lbl')).toBe(true);
    expect(cluster.classList.contains('cluster-lbl')).toBe(true);
    expect(node.classList.contains('cluster-lbl')).toBe(false);
    expect(cluster.querySelector('[data-testid="cluster-custom"]')!.textContent).toBe('red:a+b');
    expect(node.textContent).toBe('Alpha');
  });
});
