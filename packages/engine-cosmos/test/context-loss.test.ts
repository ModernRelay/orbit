/**
 * CosmosEngine WebGL context-loss detection + recovery tests.
 *
 * @cosmos.gl/graph is mocked (jsdom has no WebGL); the MockGraph appends a
 * real jsdom <canvas> to its div — exactly what CosmosEngine queries to wire
 * webglcontextlost/webglcontextrestored listeners — so loss/restore is driven
 * by dispatching genuine DOM events on that canvas.
 *
 * NOTE for fake-timer tests: mount dynamically imports the (mocked) cosmos
 * module, which may need real macrotasks — always mount BEFORE
 * vi.useFakeTimers. Recovery itself is pure-microtask (the constructor is
 * cached at mount), so flushing microtasks after a restore dispatch suffices.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EngineContextEvent,
  EngineDiagnostic,
  EngineHostEvents,
} from '@modernrelay/orbit-core/engine';
import { CosmosEngine } from '../src/CosmosEngine';
import type { CosmosEngineOptions } from '../src/CosmosEngine';

const h = vi.hoisted(() => {
  const constructed: MockGraph[] = [];
  /** Interleaved log of graph method calls + host events (order assertions). */
  const callLog: string[] = [];

  class MockGraph {
    div: unknown;
    config: Record<string, any>;
    ready: Promise<void>;
    calls: { method: string; args: unknown[] }[] = [];
    zoomLevel = 1;
    canvas: HTMLCanvasElement | null = null;

    static constructorShouldThrow = false;
    static nextReady: Promise<void> | null = null;

    constructor(div: unknown, config?: Record<string, any>) {
      if (MockGraph.constructorShouldThrow) {
        throw new Error('MockGraph: constructor failure');
      }
      this.div = div;
      this.config = config ?? {};
      this.ready = MockGraph.nextReady ?? Promise.resolve();
      MockGraph.nextReady = null;
      if (div instanceof HTMLElement) {
        this.canvas = div.ownerDocument.createElement('canvas');
        div.appendChild(this.canvas);
      }
      constructed.push(this);
    }

    private rec(method: string, args: unknown[]): void {
      this.calls.push({ method, args });
      callLog.push(method);
    }

    setConfigPartial(...args: unknown[]): void { this.rec('setConfigPartial', args); }
    setPointPositions(...args: unknown[]): void { this.rec('setPointPositions', args); }
    setLinks(...args: unknown[]): void { this.rec('setLinks', args); }
    setPointColors(...args: unknown[]): void { this.rec('setPointColors', args); }
    setPointSizes(...args: unknown[]): void { this.rec('setPointSizes', args); }
    setLinkColors(...args: unknown[]): void { this.rec('setLinkColors', args); }
    setLinkWidths(...args: unknown[]): void { this.rec('setLinkWidths', args); }
    render(...args: unknown[]): void { this.rec('render', args); }
    start(...args: unknown[]): void { this.rec('start', args); }
    pause(...args: unknown[]): void { this.rec('pause', args); }
    fitView(...args: unknown[]): void { this.rec('fitView', args); }
    zoomToPointByIndex(...args: unknown[]): void { this.rec('zoomToPointByIndex', args); }
    setZoomLevel(value: number, duration?: number): void {
      this.rec('setZoomLevel', [value, duration]);
      this.zoomLevel = value;
    }
    getZoomLevel(): number { return this.zoomLevel; }
    getPointPositions(): number[] { return [1, 2, 3, 4]; }
    screenToSpacePosition(p: [number, number]): [number, number] {
      return [p[0] * 2 - 5, p[1] * 2 - 5];
    }
    destroy(): void {
      this.rec('destroy', []);
      this.canvas?.remove();
      this.canvas = null;
    }
  }

  return { constructed, callLog, MockGraph };
});

vi.mock('@cosmos.gl/graph', () => ({ Graph: h.MockGraph }));

function makeEvents() {
  return {
    onPointClick: vi.fn(),
    onPointHover: vi.fn(),
    onViewportChange: vi.fn(),
    onSimulationEnd: vi.fn(),
    onError: vi.fn(),
    onContextEvent: vi.fn((ev: EngineContextEvent) => {
      h.callLog.push(`context:${ev.type}`);
    }),
    onDiagnostic: vi.fn((d: EngineDiagnostic) => {
      h.callLog.push(`diagnostic:${d.code}`);
    }),
  } satisfies EngineHostEvents;
}

async function mounted(options?: CosmosEngineOptions) {
  const engine = new CosmosEngine(options);
  const events = makeEvents();
  const container = document.createElement('div');
  await engine.mount(container, events);
  const graph = h.constructed[h.constructed.length - 1]!;
  return { engine, events, container, graph, canvas: graph.canvas! };
}

/**
 * onDiagnostic calls carrying the given code. Mount always emits one
 * unrelated `engine:overlay-activity-clock` info diagnostic (activity
 * clock), so deadline assertions filter by code instead of counting all calls.
 */
function diagnosticCount(events: ReturnType<typeof makeEvents>, code: string): number {
  return events.onDiagnostic.mock.calls.filter(([d]) => (d as EngineDiagnostic).code === code)
    .length;
}

const DEADLINE = 'engine:context-restore-deadline';

function loseContext(canvas: HTMLCanvasElement): Event {
  const event = new Event('webglcontextlost', { cancelable: true });
  canvas.dispatchEvent(event);
  return event;
}

/** Recovery after `webglcontextrestored` is pure-microtask; drain them. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function restoreContext(canvas: HTMLCanvasElement): Promise<void> {
  canvas.dispatchEvent(new Event('webglcontextrestored'));
  await flushAsync();
}

beforeEach(() => {
  h.constructed.length = 0;
  h.callLog.length = 0;
  h.MockGraph.constructorShouldThrow = false;
  h.MockGraph.nextReady = null;
});

afterEach(() => {
  vi.useRealTimers();
  // Remove any per-test visibilityState override (restores the prototype getter).
  delete (document as unknown as Record<string, unknown>)['visibilityState'];
});

describe('CosmosEngine context loss', () => {
  it('handles webglcontextlost: preventDefault, pause, exactly one lost event', async () => {
    const { events, graph, canvas } = await mounted();

    const event = loseContext(canvas);

    expect(event.defaultPrevented).toBe(true);
    expect(graph.calls.filter((c) => c.method === 'pause')).toHaveLength(1);
    expect(events.onContextEvent).toHaveBeenCalledTimes(1);
    expect(events.onContextEvent).toHaveBeenCalledWith({ type: 'lost' });

    // a duplicate lost event is still prevented but emits nothing new
    const dup = loseContext(canvas);
    expect(dup.defaultPrevented).toBe(true);
    expect(events.onContextEvent).toHaveBeenCalledTimes(1);
    expect(graph.calls.filter((c) => c.method === 'pause')).toHaveLength(1);
  });

  it('merges independent queued channels while lost and flushes one latest-revision commit', async () => {
    const { engine, graph, canvas } = await mounted();
    loseContext(canvas);
    graph.calls.length = 0;

    engine.commit({
      revision: 3,
      structure: {
        pointCount: 1,
        positions: new Float32Array([10, 20]),
        links: new Uint32Array([]),
      },
      buffers: {
        pointColor: new Float32Array([1, 0, 0, 1]),
        pointSize: new Float32Array([1]),
      },
      config: { backgroundColor: '#111111', simulation: { gravity: 0.2 } },
      restart: { alpha: 1 },
    });
    engine.commit({
      revision: 4,
      buffers: {
        pointSize: new Float32Array([7]),
        linkWidth: new Float32Array([]),
      },
      config: { simulation: { friction: 0.8 } },
      restart: false,
    });
    expect(graph.calls).toHaveLength(0); // zero graph calls while lost
    expect(engine.appliedRevision()).toBeNull();

    await restoreContext(canvas);

    const graph2 = h.constructed[1]!;
    // restart:false ≡ absent ("keep state") — it does NOT cancel the
    // earlier queued {alpha: 1}, which therefore fires after the flush.
    expect(graph2.calls.map((call) => call.method)).toEqual([
      'setConfigPartial',
      'setPointPositions',
      'setLinks',
      'setPointColors',
      'setPointSizes',
      'setLinkWidths',
      'render',
      'start',
    ]);
    expect(graph2.calls.find((call) => call.method === 'start')!.args).toEqual([1]);
    expect(graph2.calls[0]!.args[0]).toEqual({
      backgroundColor: '#111111',
      simulationGravity: 0.2,
      simulationFriction: 0.8,
    });
    expect(
      Array.from(
        graph2.calls.find((call) => call.method === 'setPointColors')!
          .args[0] as Float32Array,
      ),
    ).toEqual([1, 0, 0, 1]);
    const sizeCalls = graph2.calls.filter((c) => c.method === 'setPointSizes');
    expect(sizeCalls).toHaveLength(1); // latest value within the point-size channel
    expect(Array.from(sizeCalls[0]!.args[0] as Float32Array)).toEqual([7]);
    expect(engine.appliedRevision()).toBe(4);
    expect(graph2.calls.filter((call) => call.method === 'start')).toHaveLength(1);
    // the flush never touched the old graph — it only got torn down
    expect(graph.calls.map((c) => c.method)).toEqual(['destroy']);
  });

  it('restores by rebuilding cosmos in the same div, flushing BEFORE the restored event', async () => {
    const { engine, events, graph, canvas } = await mounted();
    loseContext(canvas);
    engine.commit({ revision: 9, buffers: { pointSize: new Float32Array([5]) } });

    await restoreContext(canvas);

    // old graph torn down; the replacement uses the SAME inner div
    expect(graph.calls.some((c) => c.method === 'destroy')).toBe(true);
    expect(h.constructed).toHaveLength(2);
    expect(h.constructed[1]!.div).toBe(graph.div);

    expect(events.onContextEvent).toHaveBeenCalledTimes(2);
    expect(events.onContextEvent).toHaveBeenLastCalledWith({ type: 'restored' });

    // the pending commit flushed before {type:'restored'} was emitted
    const renderIdx = h.callLog.lastIndexOf('render');
    const restoredIdx = h.callLog.indexOf('context:restored');
    expect(renderIdx).toBeGreaterThan(-1);
    expect(restoredIdx).toBeGreaterThan(renderIdx);
    expect(h.callLog.lastIndexOf('setPointSizes')).toBeLessThan(restoredIdx);
  });

  it('survives a second lost/restored cycle (listeners re-attached to the new canvas)', async () => {
    const { engine, events, canvas } = await mounted();
    loseContext(canvas);
    await restoreContext(canvas);

    const graph2 = h.constructed[1]!;
    const canvas2 = graph2.canvas!;
    expect(canvas2).not.toBe(canvas);

    const second = loseContext(canvas2);
    expect(second.defaultPrevented).toBe(true);
    expect(graph2.calls.filter((c) => c.method === 'pause')).toHaveLength(1);
    expect(events.onContextEvent).toHaveBeenCalledTimes(3); // lost, restored, lost

    engine.commit({ revision: 11, buffers: { pointSize: new Float32Array([3]) } });
    await restoreContext(canvas2);

    expect(h.constructed).toHaveLength(3);
    expect(events.onContextEvent).toHaveBeenCalledTimes(4);
    expect(events.onContextEvent).toHaveBeenLastCalledWith({ type: 'restored' });
    const graph3 = h.constructed[2]!;
    expect(graph3.calls.filter((c) => c.method === 'setPointSizes')).toHaveLength(1);
    expect(engine.appliedRevision()).toBe(11);
  });

  it('while lost: getPositions() is null and camera/selection methods are safe no-ops', async () => {
    const { engine, graph, canvas } = await mounted();
    loseContext(canvas);
    graph.calls.length = 0;

    expect(engine.getPositions()).toBeNull();
    expect(engine.getViewport()).toBeNull();
    engine.fitView({ durationMs: 100 });
    engine.zoom(2);
    engine.setViewport({ zoom: 3 });
    engine.zoomToIndex(1);
    engine.setSelectedIndices([1, 2]);
    engine.setSelectedIndices(null);
    engine.setFocusedIndex(0);
    engine.setFocusedIndex(null);
    engine.start();
    engine.pause();

    expect(graph.calls).toHaveLength(0);
  });

  it('emits the restore-deadline warning at exactly 10s of visible time; a late restore still recovers', async () => {
    const { events, canvas } = await mounted();
    vi.useFakeTimers();
    loseContext(canvas);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(diagnosticCount(events, DEADLINE)).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(diagnosticCount(events, DEADLINE)).toBe(1);
    expect(events.onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'engine:context-restore-deadline', severity: 'warning' }),
    );

    // the deadline fires once, ever
    await vi.advanceTimersByTimeAsync(60_000);
    expect(diagnosticCount(events, DEADLINE)).toBe(1);

    // listeners stayed mounted: restoring after expiry still recovers
    await restoreContext(canvas);
    expect(events.onContextEvent).toHaveBeenLastCalledWith({ type: 'restored' });
    expect(h.constructed).toHaveLength(2);
  });

  it('respects the restoreDeadlineMs option', async () => {
    const { events, canvas } = await mounted({ restoreDeadlineMs: 500 });
    vi.useFakeTimers();
    loseContext(canvas);

    await vi.advanceTimersByTimeAsync(499);
    expect(diagnosticCount(events, DEADLINE)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(diagnosticCount(events, DEADLINE)).toBe(1);
    expect(events.onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'engine:context-restore-deadline' }),
    );
  });

  it('counts the deadline only while the document is visible', async () => {
    const { events, canvas } = await mounted();
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    vi.useFakeTimers();
    loseContext(canvas);

    // consume 4s of the 10s budget while visible
    await vi.advanceTimersByTimeAsync(4_000);
    expect(diagnosticCount(events, DEADLINE)).toBe(0);

    // hidden time is banked, not consumed
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(diagnosticCount(events, DEADLINE)).toBe(0);

    // back to visible: exactly 6s of budget remains
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5_999);
    expect(diagnosticCount(events, DEADLINE)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(diagnosticCount(events, DEADLINE)).toBe(1);
    expect(events.onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'engine:context-restore-deadline' }),
    );
  });

  it('reports {type:"failed"} once when reinitialization throws; later commits are inert', async () => {
    const { engine, events, graph, canvas } = await mounted();
    loseContext(canvas);
    h.MockGraph.constructorShouldThrow = true;

    await restoreContext(canvas); // dispatch throws nothing outward

    expect(h.constructed).toHaveLength(1); // second construction threw
    expect(events.onContextEvent).toHaveBeenCalledTimes(2);
    expect(events.onContextEvent).toHaveBeenLastCalledWith({
      type: 'failed',
      error: expect.any(Error),
    });

    // subsequent commits stash inertly: no throw, no graph calls, no events
    graph.calls.length = 0;
    engine.commit({ revision: 42, buffers: { pointSize: new Float32Array([2]) } });
    expect(graph.calls).toHaveLength(0);
    expect(engine.getPositions()).toBeNull();
    expect(events.onContextEvent).toHaveBeenCalledTimes(2);
    expect(events.onError).not.toHaveBeenCalled();
  });

  it('destroys the replacement exactly once when recovery readiness rejects', async () => {
    const { engine, events, canvas } = await mounted();
    loseContext(canvas);
    const ready = deferred<void>();
    h.MockGraph.nextReady = ready.promise;
    canvas.dispatchEvent(new Event('webglcontextrestored'));

    expect(h.constructed).toHaveLength(2);
    const graph2 = h.constructed[1]!;
    const error = new Error('recovery ready failed');
    ready.reject(error);
    await flushAsync();

    expect(graph2.calls.filter((call) => call.method === 'destroy')).toHaveLength(1);
    expect(events.onContextEvent).toHaveBeenCalledTimes(2);
    expect(events.onContextEvent).toHaveBeenLastCalledWith({ type: 'failed', error });

    engine.destroy();
    expect(graph2.calls.filter((call) => call.method === 'destroy')).toHaveLength(1);
    expect(events.onContextEvent).toHaveBeenCalledTimes(2);
  });

  it.each(['setPointSizes', 'render'] as const)(
    'fully tears down recovery when queued %s throws after readiness',
    async (throwingMethod) => {
      const { engine, events, canvas } = await mounted();
      loseContext(canvas);
      engine.commit({ revision: 12, buffers: { pointSize: new Float32Array([3]) } });

      const ready = deferred<void>();
      h.MockGraph.nextReady = ready.promise;
      canvas.dispatchEvent(new Event('webglcontextrestored'));

      expect(h.constructed).toHaveLength(2);
      const graph2 = h.constructed[1]!;
      const canvas2 = graph2.canvas!;
      const failure = new Error(`${throwingMethod} failed`);
      const original = graph2[throwingMethod].bind(graph2);
      graph2[throwingMethod] = (...args: unknown[]): void => {
        original(...args);
        throw failure;
      };

      ready.resolve();
      await flushAsync();

      expect(graph2.calls.filter((call) => call.method === 'destroy')).toHaveLength(1);
      expect(graph2.canvas).toBeNull();
      expect(canvas2.parentElement).toBeNull();
      expect(engine.getPositions()).toBeNull();
      expect(engine.appliedRevision()).toBeNull();
      expect(events.onContextEvent).toHaveBeenCalledTimes(2);
      expect(events.onContextEvent).toHaveBeenLastCalledWith({
        type: 'failed',
        error: failure,
      });

      // Recovery listeners were removed before terminal failure reporting.
      const callsBefore = events.onContextEvent.mock.calls.length;
      const lateLoss = loseContext(canvas2);
      expect(lateLoss.defaultPrevented).toBe(false);
      expect(events.onContextEvent).toHaveBeenCalledTimes(callsBefore);

      engine.destroy();
      expect(graph2.calls.filter((call) => call.method === 'destroy')).toHaveLength(1);
    },
  );

  it('destroy() while lost cancels the deadline and removes the listeners', async () => {
    const { engine, events, canvas } = await mounted();
    vi.useFakeTimers();
    loseContext(canvas);
    expect(events.onContextEvent).toHaveBeenCalledTimes(1);

    engine.destroy();

    // deadline cancelled: no diagnostic no matter how long we wait
    await vi.advanceTimersByTimeAsync(60_000);
    expect(diagnosticCount(events, DEADLINE)).toBe(0);

    // listeners removed: a restore dispatch does nothing, no events after destroy
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    await flushAsync();
    expect(h.constructed).toHaveLength(1);
    expect(events.onContextEvent).toHaveBeenCalledTimes(1);
  });

  it('destroy() tears down a not-ready replacement immediately and emits nothing later', async () => {
    const { engine, events, canvas } = await mounted();
    loseContext(canvas);

    // hold the replacement graph's ready so destroy can land mid-reinit
    const ready = deferred<void>();
    h.MockGraph.nextReady = ready.promise;
    canvas.dispatchEvent(new Event('webglcontextrestored'));

    // the replacement is constructed synchronously by the listener, then parks on ready
    expect(h.constructed).toHaveLength(2);
    const graph2 = h.constructed[1]!;
    expect(graph2.calls.some((c) => c.method === 'destroy')).toBe(false);

    engine.destroy();
    // Cleanup does not wait for graph.ready, which may never settle.
    expect(graph2.calls.filter((c) => c.method === 'destroy')).toHaveLength(1);

    ready.resolve();
    await flushAsync();

    expect(graph2.calls.filter((c) => c.method === 'destroy')).toHaveLength(1);
    expect(events.onContextEvent).toHaveBeenCalledTimes(1); // only the initial 'lost'
    // only the mount-time activity-clock diagnostic ever fired
    expect(events.onDiagnostic).toHaveBeenCalledTimes(1);
    expect(diagnosticCount(events, 'engine:overlay-activity-clock')).toBe(1);
  });
});
