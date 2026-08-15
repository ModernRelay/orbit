/**
 * React binding tests — jsdom + @testing-library/react + FakeEngine.
 */

import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { StrictMode, createRef } from 'react';
import type {
  AcceptedEdge,
  DimensionSpec,
  ExpandNodeResult,
  GraphNode,
  GraphSnapshot,
  NodeId,
} from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import type { EngineHostEvents } from '@modernrelay/orbit-core/engine';
import {
  Graph,
  useGraphEdgeHover,
  useGraphHistory,
  useGraphInstance,
  useGraphOverlays,
  useGraphPendingExpansions,
  useGraphPins,
  useGraphScope,
  useGraphSelection,
} from '../src/index';
import type { GraphHandle } from '../src/index';

const snapshot: GraphSnapshot = {
  datasetKey: 'ds',
  sourceRevision: 1,
  nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  edges: [{ source: 'a', target: 'b' }],
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** FakeEngine whose mount result is controlled independently of destroy. */
class DelayedMountEngine extends FakeEngine {
  private readonly mountGate = deferred<void>();

  override mount(container: HTMLElement, events: EngineHostEvents): Promise<void> {
    // Preserve FakeEngine's event wiring and call recording while withholding
    // the readiness result that GraphInstance awaits.
    void super.mount(container, events);
    return this.mountGate.promise;
  }

  resolveMount(): void {
    this.mountGate.resolve();
  }

  rejectMount(reason: unknown): void {
    this.mountGate.reject(reason);
  }

  get destroyCallCount(): number {
    return this.calls.filter((call) => call.method === 'destroy').length;
  }
}

/** Flush the engine mount promise (and any deferred microtasks) inside act. */
async function flush(): Promise<void> {
  await act(async () => {});
}

describe('<Graph>', () => {
  it('renders the container, mounts the engine into the canvas div, and commits structure', async () => {
    const fake = new FakeEngine();
    const { container } = render(<Graph engine={() => fake} data={snapshot} />);
    await flush();

    const canvas = container.querySelector('[data-orbit-canvas]');
    expect(canvas).not.toBeNull();
    // The engine-owned canvas layer must have no React children.
    expect(canvas!.childNodes.length).toBe(0);

    const mountCall = fake.calls.find((c) => c.method === 'mount');
    expect(mountCall).toBeDefined();
    expect(mountCall!.args[0]).toBe(canvas);

    // Exactly one commit (the ready replay) carrying the full structure.
    expect(fake.commits.length).toBe(1);
    const commit = fake.lastCommit!;
    expect(commit.structure?.pointCount).toBe(3);
    expect(commit.structure?.links.length).toBe(2);
  });

  it('StrictMode double-mount ends with one live attached engine and a ready instance', async () => {
    const engines: FakeEngine[] = [];
    const factory = (): FakeEngine => {
      const e = new FakeEngine();
      engines.push(e);
      return e;
    };
    const handleRef = createRef<GraphHandle>();
    render(
      <StrictMode>
        <Graph ref={handleRef} engine={factory} data={snapshot} />
      </StrictMode>,
    );
    await flush();

    // mount → simulated unmount (detach destroys engine #1) → mount (fresh engine #2).
    expect(engines.length).toBe(2);
    expect(engines[0]!.destroyed).toBe(true);
    expect(engines[1]!.destroyed).toBe(false);

    // The live engine received the full-state replay commit.
    expect(engines[1]!.commits.length).toBe(1);
    expect(engines[1]!.lastCommit?.structure?.pointCount).toBe(3);

    const instance = handleRef.current!.instance;
    expect(instance.store.getState().status).toBe('ready');
    expect(instance.store.getState().nodeCount).toBe(3);
  });

  it('ignores a delayed attach resolution after unmount and destroys its engine exactly once', async () => {
    const engine = new DelayedMountEngine();
    const onReady = vi.fn();
    const onError = vi.fn();
    const handleRef = createRef<GraphHandle>();
    const { unmount } = render(
      <Graph
        ref={handleRef}
        engine={() => engine}
        data={snapshot}
        onReady={onReady}
        onError={onError}
      />,
    );

    const instance = handleRef.current!.instance;
    expect(instance.store.getState().status).toBe('mounting');
    unmount();
    await Promise.resolve(); // true-unmount destroy gate
    const destroyedState = instance.store.getState();
    expect(destroyedState.status).toBe('destroyed');
    expect(engine.destroyed).toBe(true);
    expect(engine.destroyCallCount).toBe(1);

    await act(async () => {
      engine.resolveMount();
    });
    await flush();

    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(instance.store.getState()).toBe(destroyedState);
    expect(engine.destroyCallCount).toBe(1);
  });

  it('ignores a delayed attach rejection after unmount without calling stale onError', async () => {
    const engine = new DelayedMountEngine();
    const onReady = vi.fn();
    const onError = vi.fn();
    const handleRef = createRef<GraphHandle>();
    const { unmount } = render(
      <Graph
        ref={handleRef}
        engine={() => engine}
        data={snapshot}
        onReady={onReady}
        onError={onError}
      />,
    );

    const instance = handleRef.current!.instance;
    unmount();
    await Promise.resolve();
    const destroyedState = instance.store.getState();

    await act(async () => {
      engine.rejectMount(new Error('late mount failure'));
    });
    await flush();

    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(instance.store.getState()).toBe(destroyedState);
    expect(engine.destroyed).toBe(true);
    expect(engine.destroyCallCount).toBe(1);
  });

  it('reports a delayed rejection from the current mount exactly once', async () => {
    const engine = new DelayedMountEngine();
    const onReady = vi.fn();
    const onError = vi.fn();
    const handleRef = createRef<GraphHandle>();
    render(
      <Graph
        ref={handleRef}
        engine={() => engine}
        data={snapshot}
        onReady={onReady}
        onError={onError}
      />,
    );

    const instance = handleRef.current!.instance;
    expect(instance.store.getState().status).toBe('mounting');
    const failure = new Error('current mount failure');
    await act(async () => {
      engine.rejectMount(failure);
    });
    await flush();

    // Core emits the fatal mount error first; Graph's attach catch observes
    // the error state and must not deliver the same failure a second time.
    expect(instance.store.getState().status).toBe('error');
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ error: failure }));
    expect(engine.destroyed).toBe(false);
  });

  it('keeps an imperatively reattached session healthy when the old mount rejects', async () => {
    const engines: DelayedMountEngine[] = [];
    const factory = (): DelayedMountEngine => {
      const engine = new DelayedMountEngine();
      engines.push(engine);
      return engine;
    };
    const onReady = vi.fn();
    const onError = vi.fn();
    const handleRef = createRef<GraphHandle>();
    const rendered = render(
      <Graph
        ref={handleRef}
        engine={factory}
        data={snapshot}
        onReady={onReady}
        onError={onError}
      />,
    );

    const instance = handleRef.current!.instance;
    const host = rendered.container.querySelector<HTMLElement>('[data-orbit-canvas]')!;
    expect(engines).toHaveLength(1);
    const discarded = engines[0]!;

    let currentAttach!: Promise<void>;
    act(() => {
      instance.detach();
      currentAttach = instance.attach(host);
    });
    expect(engines).toHaveLength(2);
    const current = engines[1]!;
    expect(discarded.destroyed).toBe(true);

    await act(async () => {
      current.resolveMount();
      await currentAttach;
    });
    expect(instance.store.getState().status).toBe('ready');
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    const readyState = instance.store.getState();

    await act(async () => {
      discarded.rejectMount(new Error('discarded imperative mount failure'));
    });
    await flush();

    expect(instance.store.getState()).toBe(readyState);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(discarded.destroyCallCount).toBe(1);
    expect(current.destroyed).toBe(false);
  });

  it.each(['resolve', 'reject'] as const)(
    'StrictMode ignores the discarded first mount when it later %ss',
    async (outcome) => {
      const engines: DelayedMountEngine[] = [];
      const factory = (): DelayedMountEngine => {
        const engine = new DelayedMountEngine();
        engines.push(engine);
        return engine;
      };
      const onReady = vi.fn();
      const onError = vi.fn();
      const handleRef = createRef<GraphHandle>();
      render(
        <StrictMode>
          <Graph
            ref={handleRef}
            engine={factory}
            data={snapshot}
            onReady={onReady}
            onError={onError}
          />
        </StrictMode>,
      );

      expect(engines).toHaveLength(2);
      const discarded = engines[0]!;
      const current = engines[1]!;
      expect(discarded.destroyed).toBe(true);
      expect(discarded.destroyCallCount).toBe(1);
      expect(current.destroyed).toBe(false);

      await act(async () => {
        current.resolveMount();
      });
      await flush();

      const instance = handleRef.current!.instance;
      expect(instance.store.getState().status).toBe('ready');
      expect(onReady).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      const readyState = instance.store.getState();

      await act(async () => {
        if (outcome === 'resolve') discarded.resolveMount();
        else discarded.rejectMount(new Error('discarded mount failure'));
      });
      await flush();

      expect(instance.store.getState()).toBe(readyState);
      expect(onReady).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(discarded.destroyCallCount).toBe(1);
      expect(current.destroyed).toBe(false);
    },
  );

  it('changing two props in one re-render issues exactly one additional engine commit', async () => {
    const fake = new FakeEngine();
    const handleRef = createRef<GraphHandle>();
    const { rerender } = render(
      <Graph ref={handleRef} engine={() => fake} data={snapshot} nodeColor="#ff0000" />,
    );
    await flush();

    const commitsBefore = fake.commits.length;
    const renderRevBefore = handleRef.current!.getRevisions().render;

    const nextColor = (): string => '#00ff00';
    rerender(
      <Graph
        ref={handleRef}
        engine={() => fake}
        data={snapshot}
        nodeColor={nextColor}
        theme={{ background: '#000000' }}
      />,
    );

    // Binding parity: one multi-prop commit → one host update → one engine commit.
    expect(fake.commits.length).toBe(commitsBefore + 1);
    const commit = fake.lastCommit!;
    expect(commit.buffers?.pointColor).toBeDefined();
    expect(commit.config?.backgroundColor).toBe('#000000');
    expect(handleRef.current!.getRevisions().render).toBe(renderRevBefore + 1);
  });

  it('emphasisRing prop REMOVAL restores the documented default (D2 prop-removal rule)', async () => {
    const fake = new FakeEngine();
    const { rerender } = render(<Graph engine={() => fake} data={snapshot} emphasisRing={false} />);
    await flush();

    const ringsBefore = fake.calls.filter((c) => c.method === 'setFocusedIndex').length;
    act(() => {
      fake.injectPointHover(0); // suppressed: the toggle is off
    });
    expect(fake.calls.filter((c) => c.method === 'setFocusedIndex')).toHaveLength(ringsBefore);

    // The natural React idiom: dropping the prop means "back to default".
    rerender(<Graph engine={() => fake} data={snapshot} />);
    await flush();

    // Toggle-on restore re-rings the live hover — proof the removal
    // re-enabled the surface rather than leaving it silently stuck off.
    expect(fake.calls.filter((c) => c.method === 'setFocusedIndex').at(-1)!.args).toEqual([0]);
  });

  it('ladder wiring: limits is construction-only, onDegrade/onPerfSample fire', async () => {
    const fake = new FakeEngine();
    const degrades: unknown[] = [];
    const samples: unknown[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { rerender } = render(
        <Graph
          engine={() => fake}
          data={snapshot}
          limits={{ domLabelNodes: 2, minimumDwellMs: 0 }}
          onDegrade={(e) => degrades.push(e)}
          onPerfSample={(s) => samples.push(s)}
        />,
      );
      await flush();

      // 3 visible nodes > 2 → cap-dom-labels engaged through the prop lane.
      expect(degrades).toContainEqual(
        expect.objectContaining({ step: 'cap-dom-labels', engaged: true }),
      );

      // Throttled telemetry rides engine frames.
      act(() => {
        fake.emitFrame(0);
      });
      expect(samples).toHaveLength(1);

      // D7: a runtime limits change warns once and is ignored.
      rerender(
        <Graph
          engine={() => fake}
          data={snapshot}
          limits={{ domLabelNodes: 999 }}
          onDegrade={(e) => degrades.push(e)}
        />,
      );
      await flush();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('construction-only'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('re-rendering with unchanged props issues no host update', async () => {
    const fake = new FakeEngine();
    const handleRef = createRef<GraphHandle>();
    const { rerender } = render(<Graph ref={handleRef} engine={() => fake} data={snapshot} />);
    await flush();

    const commitsBefore = fake.commits.length;
    const revBefore = handleRef.current!.getRevisions();
    rerender(<Graph ref={handleRef} engine={() => fake} data={snapshot} />);

    expect(fake.commits.length).toBe(commitsBefore);
    expect(handleRef.current!.getRevisions()).toEqual(revBefore);
  });

  it('click injection delivers the caller node object and updates useGraphSelection', async () => {
    function SelectionProbe(): JSX.Element {
      // v0.3: useGraphSelection returns the full namespaced SelectionState.
      const selection = useGraphSelection();
      return <div data-testid="selection">{selection.nodeIds.join(',')}</div>;
    }

    const fake = new FakeEngine();
    const clicked: GraphNode[] = [];
    render(
      <Graph engine={() => fake} data={snapshot} onNodeClick={(p) => clicked.push(p.node)}>
        <SelectionProbe />
      </Graph>,
    );
    await flush();
    expect(screen.getByTestId('selection').textContent).toBe('');

    act(() => {
      fake.injectPointClick(1);
    });

    expect(clicked.length).toBe(1);
    // Payload carries the caller's node object (identity, not a copy).
    expect(clicked[0]).toBe(snapshot.nodes[1]);
    expect(screen.getByTestId('selection').textContent).toBe('b');
  });

  it('controlled selection: prop drives the store; clicks emit intent without a store write', async () => {
    const fake = new FakeEngine();
    const changes: (readonly NodeId[])[] = [];
    const handleRef = createRef<GraphHandle>();
    render(
      <Graph
        ref={handleRef}
        engine={() => fake}
        data={snapshot}
        selection={['a']}
        onSelectionChange={(p) => changes.push(p.nodeIds)}
      />,
    );
    await flush();

    const store = handleRef.current!.instance.store;
    expect(store.getState().selection.nodeIds).toEqual(['a']);

    act(() => {
      fake.injectPointClick(1);
    });

    // Controlled mode: intent surfaces via the callback, store is untouched.
    expect(changes).toEqual([['b']]);
    expect(store.getState().selection.nodeIds).toEqual(['a']);
  });

  it('edge callbacks receive typed AcceptedEdge payloads and drive useGraphEdgeHover', async () => {
    function EdgeHoverProbe(): JSX.Element {
      const edgeId = useGraphEdgeHover();
      return <div data-testid="edge-hover">{edgeId ?? 'none'}</div>;
    }

    const fake = new FakeEngine();
    const clicks: AcceptedEdge[] = [];
    const hovers: (AcceptedEdge | null)[] = [];
    render(
      <Graph
        engine={() => fake}
        data={snapshot}
        onEdgeClick={(p) => clicks.push(p.edge)}
        onEdgeHover={(p) => hovers.push(p.edge)}
      >
        <EdgeHoverProbe />
      </Graph>,
    );
    await flush();
    expect(screen.getByTestId('edge-hover').textContent).toBe('none');

    act(() => {
      fake.injectLinkClick(0);
    });
    expect(clicks.length).toBe(1);
    expect(clicks[0]).toMatchObject({ id: 'a→b#0', source: 'a', target: 'b' });

    act(() => {
      fake.injectLinkHover(0);
    });
    expect(hovers).toEqual([clicks[0]]);
    expect(screen.getByTestId('edge-hover').textContent).toBe('a→b#0');

    act(() => {
      fake.injectLinkHover(null);
    });
    expect(hovers).toEqual([clicks[0], null]);
    expect(screen.getByTestId('edge-hover').textContent).toBe('none');
  });

  it('drag callbacks receive typed payloads; drag end pins the node and updates useGraphPins', async () => {
    function PinsProbe(): JSX.Element {
      const pins = useGraphPins();
      return (
        <div data-testid="pins">
          {[...pins.entries()].map(([id, xy]) => `${id}:${xy[0]},${xy[1]}`).join(';')}
        </div>
      );
    }

    const fake = new FakeEngine();
    const starts: GraphNode[] = [];
    const ends: { node: GraphNode; x: number; y: number }[] = [];
    const handleRef = createRef<GraphHandle>();
    render(
      <Graph
        ref={handleRef}
        engine={() => fake}
        data={snapshot}
        onNodeDragStart={(p) => starts.push(p.node)}
        onNodeDragEnd={(p) => ends.push(p)}
      >
        <PinsProbe />
      </Graph>,
    );
    await flush();

    act(() => {
      fake.injectDragStart(1);
    });
    expect(starts.length).toBe(1);
    expect(starts[0]).toBe(snapshot.nodes[1]);

    act(() => {
      fake.injectDragEnd(1, 7, 8);
    });
    expect(ends).toEqual([{ node: snapshot.nodes[1], x: 7, y: 8 }]);
    // Built-in follow-up: the node is pinned at its release position.
    const pins = handleRef.current!.instance.store.getState().pins;
    expect(pins.get('b')).toEqual([7, 8]);
    expect(fake.pinnedIndices).toEqual([1]);
    expect(screen.getByTestId('pins').textContent).toBe('b:7,8');
  });

  it('handle selection/pin/hide methods delegate to the instance', async () => {
    const fake = new FakeEngine();
    const handleRef = createRef<GraphHandle>();
    render(<Graph ref={handleRef} engine={() => fake} data={snapshot} />);
    await flush();

    const handle = handleRef.current!;
    const nodeIds = (): readonly NodeId[] => handle.instance.store.getState().selection.nodeIds;

    handle.selectAll();
    expect(nodeIds()).toEqual(['a', 'b', 'c']);

    handle.invertSelection();
    expect(nodeIds()).toEqual([]);

    handle.selectNeighbors('a');
    expect(nodeIds()).toEqual(['a', 'b']);

    // hidden nodes drop out of the selectAll population
    handle.hideNodes(['c']);
    expect(handle.instance.store.getState().hiddenNodeIds.has('c')).toBe(true);
    handle.selectAll();
    expect(nodeIds()).toEqual(['a', 'b']);
    handle.showAll();
    handle.selectAll();
    expect(nodeIds()).toEqual(['a', 'b', 'c']);
    handle.clearSelection();

    // seeded positions: a(0,0) b(10,0) c(20,0) — the triangle covers b and c
    const resolved = handle.selectWithinPolygon(
      [
        [5, -5],
        [50, -5],
        [5, 20],
      ],
      { additive: false },
    );
    expect(resolved).toEqual(['b', 'c']);
    expect(nodeIds()).toEqual(['b', 'c']);

    handle.pinNode('a', [3, 4]);
    expect(handle.instance.store.getState().pins.get('a')).toEqual([3, 4]);
    handle.pinNode('b'); // current (seeded) position
    expect(handle.instance.store.getState().pins.get('b')).toEqual([10, 0]);
    handle.unpinNode('a');
    expect(handle.instance.store.getState().pins.has('a')).toBe(false);
    handle.clearPins();
    expect(handle.instance.store.getState().pins.size).toBe(0);
  });

  it('subgraph prop hard-scopes the scene, diffs structurally, and null clears', async () => {
    function ScopeProbe(): JSX.Element {
      const scope = useGraphScope();
      return <div data-testid="scope">{scope === null ? 'full' : scope.seedIds.join(',')}</div>;
    }

    const fake = new FakeEngine();
    const handleRef = createRef<GraphHandle>();
    const { rerender } = render(
      <Graph ref={handleRef} engine={() => fake} data={snapshot}>
        <ScopeProbe />
      </Graph>,
    );
    await flush();
    const handle = handleRef.current!;
    expect(screen.getByTestId('scope').textContent).toBe('full');
    const revBefore = handle.getRevisions();

    rerender(
      <Graph ref={handleRef} engine={() => fake} data={snapshot} subgraph={{ seedIds: ['a', 'b'] }}>
        <ScopeProbe />
      </Graph>,
    );
    expect(handle.instance.store.getState().scope).toEqual({ seedIds: ['a', 'b'] });
    expect(handle.instance.getVisibleNodeIds()).toEqual(['a', 'b']);
    expect(screen.getByTestId('scope').textContent).toBe('a,b');
    // Scope-only change: scope + render advance, model does NOT.
    const scoped = handle.getRevisions();
    expect(scoped.model).toBe(revBefore.model);
    expect(scoped.scope).toBe(revBefore.scope + 1);

    // A NEW but structurally-equal spec object is a no-op (JSON diff).
    rerender(
      <Graph ref={handleRef} engine={() => fake} data={snapshot} subgraph={{ seedIds: ['a', 'b'] }}>
        <ScopeProbe />
      </Graph>,
    );
    expect(handle.getRevisions()).toEqual(scoped);

    // null restores the full accepted model.
    rerender(
      <Graph ref={handleRef} engine={() => fake} data={snapshot} subgraph={null}>
        <ScopeProbe />
      </Graph>,
    );
    expect(handle.instance.store.getState().scope).toBeNull();
    expect(handle.instance.getVisibleNodeIds()).toEqual(['a', 'b', 'c']);
    expect(screen.getByTestId('scope').textContent).toBe('full');
  });

  it('handle isolateSelection/resetIsolation delegate to the instance scope', async () => {
    const fake = new FakeEngine();
    const handleRef = createRef<GraphHandle>();
    render(<Graph ref={handleRef} engine={() => fake} data={snapshot} />);
    await flush();
    const handle = handleRef.current!;

    act(() => {
      handle.setSelection(['b']);
    });
    act(() => {
      handle.isolateSelection();
    });
    expect(handle.instance.store.getState().scope).toEqual({ seedIds: ['b'] });
    expect(handle.instance.getVisibleNodeIds()).toEqual(['b']);

    act(() => {
      handle.resetIsolation();
    });
    expect(handle.instance.store.getState().scope).toBeNull();
    expect(handle.instance.getVisibleNodeIds()).toEqual(['a', 'b', 'c']);
  });

  it('handle expandNode/retractExpansion round-trip through the local service and pendingExpansions', async () => {
    function PendingProbe(): JSX.Element {
      const pending = useGraphPendingExpansions();
      return <div data-testid="pending">{[...pending].join(',')}</div>;
    }

    const fake = new FakeEngine();
    const handleRef = createRef<GraphHandle>();
    render(
      <Graph ref={handleRef} engine={() => fake} data={snapshot} subgraph={{ seedIds: ['a'] }}>
        <PendingProbe />
      </Graph>,
    );
    await flush();
    const handle = handleRef.current!;
    expect(handle.instance.getVisibleNodeIds()).toEqual(['a']);
    expect(screen.getByTestId('pending').textContent).toBe('');

    // The pending set publishes synchronously at issue.
    let result!: Promise<ExpandNodeResult>;
    act(() => {
      result = handle.expandNode('a');
    });
    expect(screen.getByTestId('pending').textContent).toBe('a');

    await act(async () => {
      await expect(result).resolves.toEqual({ added: 1 });
    });
    expect(screen.getByTestId('pending').textContent).toBe('');
    // Accretion: the revealed neighbor joined the resolved scope.
    expect(handle.instance.getVisibleNodeIds()).toEqual(['a', 'b']);
    expect(handle.instance.getOverlayIds().length).toBe(1);

    // Collapse removes the expansion overlay AND its scope accretion.
    await act(async () => {
      handle.retractExpansion('a');
    });
    expect(handle.instance.getVisibleNodeIds()).toEqual(['a']);
    expect(handle.instance.getOverlayIds()).toEqual([]);
  });

  it('handle beginIngest/removeOverlay drive a overlay session; useGraphOverlays tracks it', async () => {
    function OverlaysProbe(): JSX.Element {
      const overlays = useGraphOverlays();
      return <div data-testid="overlays">{overlays.join(',')}</div>;
    }

    const fake = new FakeEngine();
    const handleRef = createRef<GraphHandle>();
    render(
      <Graph ref={handleRef} engine={() => fake} data={snapshot}>
        <OverlaysProbe />
      </Graph>,
    );
    await flush();
    const handle = handleRef.current!;
    const store = handle.instance.store;
    expect(screen.getByTestId('overlays').textContent).toBe('');

    const session = handle.beginIngest({
      purpose: 'overlay',
      datasetKey: 'ds',
      baseModelRevision: handle.getRevisions().model,
      overlayId: 'extra',
    });
    await act(async () => {
      const receipt = await session.append({
        sequence: 0,
        batchId: 'b0',
        nodes: [{ id: 'x' }],
        edges: [{ source: 'a', target: 'x' }],
      });
      expect(receipt.admittedNodes).toBe(1);
      const committed = await session.commit();
      expect(committed.overlayId).toBe('extra');
    });
    expect(store.getState().nodeCount).toBe(4);
    expect(screen.getByTestId('overlays').textContent).toBe('extra');

    let removed!: { removed: boolean };
    act(() => {
      removed = handle.removeOverlay('extra');
    });
    expect(removed).toEqual({ removed: true });
    expect(store.getState().nodeCount).toBe(3);
    expect(screen.getByTestId('overlays').textContent).toBe('');
    // Unknown ids are an idempotent { removed: false }.
    expect(handle.removeOverlay('extra')).toEqual({ removed: false });
  });

  it('hooks throw a descriptive error outside <Graph>/<GraphProvider>', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      function BadSelection(): null {
        useGraphSelection();
        return null;
      }
      function BadInstance(): null {
        useGraphInstance();
        return null;
      }
      expect(() => render(<BadSelection />)).toThrow(
        /useGraphSelection\(\) must be used within a <Graph> or <GraphProvider>/,
      );
      expect(() => render(<BadInstance />)).toThrow(
        /useGraphInstance\(\) must be used within a <Graph> or <GraphProvider>/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('unmount destroys the instance and the engine', async () => {
    const fake = new FakeEngine();
    const handleRef = createRef<GraphHandle>();
    const { unmount } = render(<Graph ref={handleRef} engine={() => fake} data={snapshot} />);
    await flush();

    const instance = handleRef.current!.instance;
    expect(instance.store.getState().status).toBe('ready');

    unmount();
    // destroy is deferred one microtask (StrictMode-safe); flush it.
    await Promise.resolve();

    expect(instance.store.getState().status).toBe('destroyed');
    expect(fake.destroyed).toBe(true);
    expect(() => fake.commit({ revision: 99 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Filter prop, crossfilter prop, history handle.
// ---------------------------------------------------------------------------

describe('<Graph> filter/crossfilter props + history handle', () => {
  const attrSnapshot: GraphSnapshot = {
    datasetKey: 'ds9',
    sourceRevision: 1,
    nodes: [
      { id: 'a', attrs: { v: 1 } },
      { id: 'b', attrs: { v: 2 } },
      { id: 'c', attrs: { v: 3 } },
    ],
    edges: [{ source: 'a', target: 'b' }],
  };

  it('filter prop masks via the atomic host update; canonical-equal re-renders are no-ops', async () => {
    const fake = new FakeEngine();
    const handleRef = createRef<GraphHandle>();
    const { rerender } = render(
      <Graph
        ref={handleRef}
        engine={() => fake}
        data={attrSnapshot}
        filter={{ nodes: { op: 'range', field: 'v', min: 2 } }}
      />,
    );
    await flush();
    const instance = handleRef.current!.instance;
    // 'hide' mode: a fails v>=2; edge a→b loses an endpoint.
    expect(instance.store.getState().visible).toEqual({ nodes: 2, edges: 0 });
    expect(instance.store.getState().nodeCount).toBe(3); // accepted counts untouched
    expect(handleRef.current!.getCrossfilterSession()).toBeNull(); // no dimensions

    const spy = vi.spyOn(instance, 'applyHostUpdate');
    try {
      // New-but-canonically-equal spec object (expr side compared by JSON).
      rerender(
        <Graph
          ref={handleRef}
          engine={() => fake}
          data={attrSnapshot}
          filter={{ nodes: { op: 'range', field: 'v', min: 2 } }}
        />,
      );
      expect(spy).not.toHaveBeenCalled();

      // null clears the mask through exactly one host update.
      rerender(<Graph ref={handleRef} engine={() => fake} data={attrSnapshot} filter={null} />);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ filter: null });
      expect(instance.store.getState().visible).toEqual({ nodes: 3, edges: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  it('function filter predicates diff by reference', async () => {
    const fake = new FakeEngine();
    const handleRef = createRef<GraphHandle>();
    const keep = (node: GraphNode): boolean => node.id !== 'a';
    const { rerender } = render(
      <Graph ref={handleRef} engine={() => fake} data={attrSnapshot} filter={{ nodes: keep }} />,
    );
    await flush();
    const instance = handleRef.current!.instance;
    expect(instance.store.getState().visible.nodes).toBe(2);

    const spy = vi.spyOn(instance, 'applyHostUpdate');
    try {
      // New spec object, SAME predicate reference → no update.
      rerender(
        <Graph ref={handleRef} engine={() => fake} data={attrSnapshot} filter={{ nodes: keep }} />,
      );
      expect(spy).not.toHaveBeenCalled();

      // New predicate reference → forwarded (the core re-evaluates O(n)).
      const keepAll = (): boolean => true;
      rerender(
        <Graph
          ref={handleRef}
          engine={() => fake}
          data={attrSnapshot}
          filter={{ nodes: keepAll }}
        />,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(instance.store.getState().visible.nodes).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });

  it('crossfilter prop builds the session and forwards only on array-reference change', async () => {
    const dims: readonly DimensionSpec[] = [
      { key: 'v', kind: 'numeric', get: (n) => n.attrs?.['v'], bins: 3 },
    ];
    const fake = new FakeEngine();
    const handleRef = createRef<GraphHandle>();
    const { rerender } = render(
      <Graph ref={handleRef} engine={() => fake} data={attrSnapshot} crossfilter={dims} />,
    );
    await flush();
    const handle = handleRef.current!;
    const session = handle.getCrossfilterSession();
    expect(session).not.toBeNull();
    expect(session!.summarize('v').bins.length).toBe(3);

    const spy = vi.spyOn(handle.instance, 'applyHostUpdate');
    try {
      // Same array reference → no update.
      rerender(<Graph ref={handleRef} engine={() => fake} data={attrSnapshot} crossfilter={dims} />);
      expect(spy).not.toHaveBeenCalled();

      // New array, same DimensionSpec elements → forwarded; the core no-ops
      // reference-equal specs, so the session (and its brushes) persist.
      const sameElements = [...dims];
      rerender(
        <Graph ref={handleRef} engine={() => fake} data={attrSnapshot} crossfilter={sameElements} />,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ crossfilter: sameElements });
      expect(handle.getCrossfilterSession()).toBe(session);
    } finally {
      spy.mockRestore();
    }
  });

  it('handle undo/redo delegate: a recorded selection mutation round-trips; useGraphHistory is live', async () => {
    function HistoryProbe(): JSX.Element {
      const history = useGraphHistory();
      return <span data-testid="history">{`${history.undoDepth}/${history.redoDepth}`}</span>;
    }
    const fake = new FakeEngine();
    const handleRef = createRef<GraphHandle>();
    const { container } = render(
      <Graph ref={handleRef} engine={() => fake} data={snapshot}>
        <HistoryProbe />
      </Graph>,
    );
    await flush();
    const handle = handleRef.current!;
    const store = handle.instance.store;
    const historyText = (): string | null =>
      container.querySelector('[data-testid="history"]')!.textContent;

    expect(historyText()).toBe('0/0');
    expect(handle.undo()).toBe(false); // empty stack: silent false, no publish

    act(() => {
      handle.instance.selectNodes(['a', 'b']);
    });
    expect(store.getState().selection.nodeIds).toEqual(['a', 'b']);
    expect(historyText()).toBe('1/0');

    let undone = false;
    act(() => {
      undone = handle.undo();
    });
    expect(undone).toBe(true);
    expect(store.getState().selection.nodeIds).toEqual([]); // store restored
    expect(historyText()).toBe('0/1');

    let redone = false;
    act(() => {
      redone = handle.redo();
    });
    expect(redone).toBe(true);
    expect(store.getState().selection.nodeIds).toEqual(['a', 'b']);
    expect(historyText()).toBe('1/0');
    expect(handle.redo()).toBe(false); // nothing left to redo
  });
});

describe('services construction prop', () => {
  it('forwards a custom expansion service so handle.expandNode merges its response', async () => {
    const seen: NodeId[][] = [];
    const services = {
      expansion: {
        revisionDependencies: ['source' as const],
        neighbors(seedIds: readonly NodeId[]) {
          seen.push([...seedIds]);
          return Promise.resolve({
            nodes: [{ id: 'remote-1' }, { id: 'remote-2' }],
            edges: [
              { source: 'a', target: 'remote-1' },
              { source: 'a', target: 'remote-2' },
            ],
          });
        },
      },
    };
    const ref = createRef<GraphHandle>();
    render(
      <Graph
        ref={ref}
        engine={() => new FakeEngine()}
        data={snapshot}
        services={services}
        fitViewOnFirstData={false}
      />,
    );
    await act(async () => {});

    let result: ExpandNodeResult | undefined;
    await act(async () => {
      result = await ref.current!.expandNode('a');
    });

    expect(seen).toEqual([['a']]);
    expect(result !== undefined && 'added' in result && result.added > 0).toBe(true);
    const visible = ref.current!.instance.getVisibleNodeIds();
    expect(visible).toContain('remote-1');
    expect(visible).toContain('remote-2');
  });
});
