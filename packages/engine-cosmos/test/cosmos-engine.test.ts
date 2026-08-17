/**
 * CosmosEngine unit tests. @cosmos.gl/graph is fully mocked — the real Graph
 * is never constructed (jsdom has no WebGL). The stub records constructor
 * config and method calls in order so batching/ordering can be asserted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EngineCommit,
  EngineDiagnostic,
  EngineHostEvents,
} from '@modernrelay/orbit-core/engine';
import { CosmosEngine } from '../src/CosmosEngine';
import type { CosmosEngineOptions } from '../src/CosmosEngine';

interface RecordedCall {
  method: string;
  args: unknown[];
}

const h = vi.hoisted(() => {
  const constructed: MockGraph[] = [];
  const constructorSpy = { count: 0 };

  class MockGraph {
    div: unknown;
    config: Record<string, any>;
    ready: Promise<void>;
    calls: { method: string; args: unknown[] }[] = [];
    zoomLevel = 1;
    /** Real jsdom canvas appended to the div, mirroring cosmos' own canvas. */
    canvas: HTMLCanvasElement | null = null;
    /**
     * Mirrors cosmos' runtime `graph.store` (private in the d.ts): cosmos
     * assigns `draggingPointIndex` right before invoking onDragStart and
     * clears it right before onDragEnd.
     */
    store: {
      hoveredPoint: { index: number; position: [number, number] } | undefined;
      draggingPointIndex: number | undefined;
    } = { hoveredPoint: undefined, draggingPointIndex: undefined };

    /** When true, the next construction throws (GL reinit-failure knob). */
    static constructorShouldThrow = false;
    /** One-shot override for the next instance's `ready` (async-race knob). */
    static nextReady: Promise<void> | null = null;

    constructor(div: unknown, config?: Record<string, any>) {
      constructorSpy.count += 1;
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
    }

    setConfigPartial(...args: unknown[]): void { this.rec('setConfigPartial', args); }
    setPointPositions(...args: unknown[]): void { this.rec('setPointPositions', args); }
    setLinks(...args: unknown[]): void { this.rec('setLinks', args); }
    setPointColors(...args: unknown[]): void { this.rec('setPointColors', args); }
    setPointSizes(...args: unknown[]): void { this.rec('setPointSizes', args); }
    setLinkColors(...args: unknown[]): void { this.rec('setLinkColors', args); }
    setLinkWidths(...args: unknown[]): void { this.rec('setLinkWidths', args); }
    setImageData(...args: unknown[]): void { this.rec('setImageData', args); }
    setPointImageIndices(...args: unknown[]): void { this.rec('setPointImageIndices', args); }
    setPointClusters(...args: unknown[]): void { this.rec('setPointClusters', args); }
    setClusterPositions(...args: unknown[]): void { this.rec('setClusterPositions', args); }
    setPointClusterStrength(...args: unknown[]): void { this.rec('setPointClusterStrength', args); }
    render(...args: unknown[]): void { this.rec('render', args); }
    start(...args: unknown[]): void { this.rec('start', args); }
    pause(...args: unknown[]): void { this.rec('pause', args); }
    fitView(...args: unknown[]): void { this.rec('fitView', args); }
    zoomToPointByIndex(...args: unknown[]): void { this.rec('zoomToPointByIndex', args); }
    setZoomLevel(value: number, duration?: number): void {
      this.rec('setZoomLevel', [value, duration]);
      this.zoomLevel = value;
    }
    setZoomTransformByPointPositions(
      positions: Float32Array,
      duration?: number,
      scale?: number,
      padding?: number,
    ): void {
      this.rec('setZoomTransformByPointPositions', [positions, duration, scale, padding]);
      // Mirrors the dist: an explicit scale becomes eventTransform.k verbatim.
      if (scale !== undefined) this.zoomLevel = scale;
    }
    getZoomLevel(): number { return this.zoomLevel; }
    getPointPositions(): number[] { return [1, 2, 3, 4]; }
    screenToSpacePosition(p: [number, number]): [number, number] {
      return [p[0] * 2 - 5, p[1] * 2 - 5];
    }
    spaceToScreenPosition(p: [number, number]): [number, number] {
      // exact inverse of screenToSpacePosition
      return [(p[0] + 5) / 2, (p[1] + 5) / 2];
    }
    findPointsInPolygon(path: [number, number][]): number[] {
      this.rec('findPointsInPolygon', [path]);
      return [1, 3];
    }
    findPointsInRect(rect: [[number, number], [number, number]]): number[] {
      this.rec('findPointsInRect', [rect]);
      return [2, 5];
    }
    getNeighboringPointIndices(indices: number | number[]): number[] {
      this.rec('getNeighboringPointIndices', [indices]);
      // includes the queried point itself (self-loop case) to exercise filtering
      return typeof indices === 'number' ? [indices, 2, 7] : [2, 7];
    }
    setPinnedPoints(...args: unknown[]): void { this.rec('setPinnedPoints', args); }
    destroy(): void {
      this.rec('destroy', []);
      this.canvas?.remove();
      this.canvas = null;
    }
  }

  return { constructed, constructorSpy, MockGraph };
});

vi.mock('@cosmos.gl/graph', () => ({ Graph: h.MockGraph }));

function makeEvents() {
  return {
    onPointClick: vi.fn(),
    onPointHover: vi.fn(),
    onLinkClick: vi.fn(),
    onLinkHover: vi.fn(),
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
    onContextMenu: vi.fn(),
    onFrame: vi.fn(),
    onViewportChange: vi.fn(),
    onSimulationEnd: vi.fn(),
    onError: vi.fn(),
    onContextEvent: vi.fn(),
    onDiagnostic: vi.fn(),
  } satisfies EngineHostEvents;
}

/** Calls to onDiagnostic carrying the given code. */
function diagnosticsWithCode(
  events: ReturnType<typeof makeEvents>,
  code: string,
): EngineDiagnostic[] {
  return events.onDiagnostic.mock.calls
    .map(([d]) => d as EngineDiagnostic)
    .filter((d) => d.code === code);
}

/** Per-test teardown hooks (rAF restore, DOM overrides, spies). */
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

type RafCallback = (time: number) => void;

/**
 * Replaces window.requestAnimationFrame/cancelAnimationFrame (the exact
 * objects the adapter reaches via ownerDocument.defaultView) with a manual
 * queue; restored automatically after the test.
 */
function installFakeRaf() {
  const win = window;
  const originalRaf = win.requestAnimationFrame;
  const originalCaf = win.cancelAnimationFrame;
  let nextId = 1;
  const pending = new Map<number, RafCallback>();
  const raf = vi.fn((cb: RafCallback): number => {
    const id = nextId;
    nextId += 1;
    pending.set(id, cb);
    return id;
  });
  const caf = vi.fn((id: number): void => {
    pending.delete(id);
  });
  win.requestAnimationFrame = raf as unknown as typeof win.requestAnimationFrame;
  win.cancelAnimationFrame = caf as unknown as typeof win.cancelAnimationFrame;
  cleanups.push(() => {
    win.requestAnimationFrame = originalRaf;
    win.cancelAnimationFrame = originalCaf;
  });
  return {
    raf,
    caf,
    pendingCount: (): number => pending.size,
    /** Fires every currently pending callback with one shared timestamp. */
    fire(timeMs: number): void {
      const batch = Array.from(pending.values());
      pending.clear();
      for (const cb of batch) cb(timeMs);
    },
  };
}

/**
 * Routes document.createElement('canvas') to a stubbed offscreen 2D canvas
 * (jsdom has no real 2D context) so captureScreenshot's drawImage/toBlob path
 * is observable. Restored automatically after the test.
 */
function stubOffscreenCanvas(blob: Blob | null) {
  const drawImage = vi.fn();
  const ctx = { drawImage } as unknown as CanvasRenderingContext2D;
  const getContext = vi.fn((): CanvasRenderingContext2D | null => ctx);
  const toBlob = vi.fn((cb: (b: Blob | null) => void): void => {
    cb(blob);
  });
  const offscreen = { width: 0, height: 0, getContext, toBlob };
  const original = document.createElement.bind(document);
  const spy = vi
    .spyOn(document, 'createElement')
    .mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      if (tagName === 'canvas') return offscreen as unknown as HTMLCanvasElement;
      return original(tagName, options);
    }) as typeof document.createElement);
  cleanups.push(() => {
    spy.mockRestore();
  });
  return { offscreen, drawImage, getContext, toBlob };
}

/**
 * Patches HTMLCanvasElement.prototype.getContext with a recording 2D stub so
 * the ImageBitmap→ImageData atlas conversion path is observable (jsdom has no
 * real 2D context). getImageData returns a plain {width, height, data} object
 * so atlas entries are identifiable by their dimensions. Prototype-level (not
 * createElement-level) so MockGraph's own real jsdom canvas keeps working.
 * Restored automatically after the test.
 */
function stubCanvas2d() {
  const drawImage = vi.fn();
  const getImageData = vi.fn((_x: number, _y: number, w: number, h: number) => ({
    width: w,
    height: h,
    data: new Uint8ClampedArray(w * h * 4),
  }));
  const ctx = { drawImage, getImageData } as unknown as CanvasRenderingContext2D;
  const spy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(((() => ctx) as unknown) as typeof HTMLCanvasElement.prototype.getContext);
  cleanups.push(() => spy.mockRestore());
  return { drawImage, getImageData };
}

/** getContext('2d') → null, deterministically (the jsdom-without-canvas shape). */
function stubCanvas2dUnavailable(): void {
  const spy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(((() => null) as unknown) as typeof HTMLCanvasElement.prototype.getContext);
  cleanups.push(() => spy.mockRestore());
}

/** Width/height-tagged stand-in for a decoded ImageBitmap (jsdom has none). */
function fakeBitmap(size: number): ImageBitmap {
  return { width: size, height: size } as unknown as ImageBitmap;
}

/** Shape of the stubbed atlas entries recorded by setImageData. */
interface AtlasEntry {
  width: number;
  height: number;
}

async function mounted(options?: CosmosEngineOptions) {
  const engine = new CosmosEngine(options);
  const events = makeEvents();
  const container = document.createElement('div');
  await engine.mount(container, events);
  const graph = h.constructed[h.constructed.length - 1]!;
  return { engine, events, container, graph };
}

function methodsOf(calls: RecordedCall[]): string[] {
  return calls.map((c) => c.method);
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

/** Modifiers of a plain MouseEvent (no keys held). */
const noMods = { metaKey: false, shiftKey: false };

describe('CosmosEngine', () => {
  it('is node-safe: importing the module does not construct cosmos, pre-mount methods are neutral', () => {
    // The module was imported at file load; the mock class must be untouched.
    expect(h.constructorSpy.count).toBe(0);
    expect(h.constructed).toHaveLength(0);

    const engine = new CosmosEngine();
    expect(h.constructorSpy.count).toBe(0);

    // Every method is safe pre-mount and returns neutral values.
    expect(engine.appliedRevision()).toBeNull();
    expect(engine.getViewport()).toBeNull();
    expect(engine.getPositions()).toBeNull();
    engine.fitView();
    engine.zoom(2);
    engine.setViewport({ x: 1, y: 2, zoom: 3 });
    engine.zoomToIndex(0);
    engine.start();
    engine.pause();
    engine.setSelectedIndices([1]);
    engine.setSelectedIndices(null);
    engine.setFocusedIndex(0);
    engine.setFocusedIndex(null);
    expect(engine.pointsInPolygon([[0, 0], [1, 0], [1, 1]])).toEqual([]);
    expect(engine.pointsInRect([0, 0, 1, 1])).toEqual([]);
    expect(engine.neighborIndices(0)).toEqual([]);
    expect(engine.screenToSpace([0, 0])).toBeNull();
    expect(engine.spaceToScreen([0, 0])).toBeNull();
    engine.setPinnedIndices([0]);
    engine.setPinnedIndices(null);
    expect(h.constructorSpy.count).toBe(0);
  });

  it('exposes evidence-backed capabilities: native link picking is enabled', () => {
    expect(new CosmosEngine().capabilities.linkPicking).toBe(true);
  });

  it('destroys a graph exactly once when initial readiness rejects', async () => {
    const ready = deferred<void>();
    h.MockGraph.nextReady = ready.promise;
    const before = h.constructed.length;
    const engine = new CosmosEngine();
    const events = makeEvents();
    const container = document.createElement('div');
    const mount = engine.mount(container, events);

    await vi.waitFor(() => expect(h.constructed).toHaveLength(before + 1));
    const graph = h.constructed[before]!;
    const error = new Error('initial ready failed');
    ready.reject(error);

    await expect(mount).rejects.toBe(error);
    expect(graph.calls.filter((call) => call.method === 'destroy')).toHaveLength(1);
    expect(events.onError).toHaveBeenCalledOnce();
    expect(events.onError).toHaveBeenCalledWith(error);
    expect(container.children).toHaveLength(0);

    engine.destroy();
    expect(graph.calls.filter((call) => call.method === 'destroy')).toHaveLength(1);
  });

  it('destroy cleans an initial graph immediately without waiting for readiness', async () => {
    const ready = deferred<void>();
    h.MockGraph.nextReady = ready.promise;
    const before = h.constructed.length;
    const engine = new CosmosEngine();
    const events = makeEvents();
    const container = document.createElement('div');
    const mount = engine.mount(container, events);

    await vi.waitFor(() => expect(h.constructed).toHaveLength(before + 1));
    const graph = h.constructed[before]!;
    engine.destroy();

    // Cleanup cannot depend on a promise that may never settle.
    expect(graph.calls.filter((call) => call.method === 'destroy')).toHaveLength(1);
    expect(container.children).toHaveLength(0);
    expect(events.onError).not.toHaveBeenCalled();
    expect(events.onDiagnostic).not.toHaveBeenCalled();

    // Even a later rejection is absorbed after terminal teardown: no second
    // destroy, stale callback, or rejected mount promise escapes.
    ready.reject(new Error('late ready rejection'));
    await mount;
    expect(graph.calls.filter((call) => call.method === 'destroy')).toHaveLength(1);
    expect(events.onError).not.toHaveBeenCalled();
    expect(events.onDiagnostic).not.toHaveBeenCalled();
  });

  it('destroy during the lazy import prevents graph construction', async () => {
    const before = h.constructed.length;
    const engine = new CosmosEngine();
    const events = makeEvents();
    const container = document.createElement('div');

    const mount = engine.mount(container, events);
    engine.destroy();
    await mount;

    expect(h.constructed).toHaveLength(before);
    expect(container.children).toHaveLength(0);
    expect(events.onError).not.toHaveBeenCalled();
    expect(events.onDiagnostic).not.toHaveBeenCalled();
  });

  it('mount creates a 100%-filling inner div and wires cosmos callbacks to host events', async () => {
    const { events, container, graph } = await mounted();

    expect(container.children).toHaveLength(1);
    const inner = container.children[0] as HTMLDivElement;
    expect(inner.style.width).toBe('100%');
    expect(inner.style.height).toBe('100%');
    expect(graph.div).toBe(inner);
    expect(graph.config.fitViewOnInit).toBe(false);

    // point click → index (+ modifiers read off the MouseEvent)
    graph.config.onPointClick(7, [0, 0], new MouseEvent('click'));
    expect(events.onPointClick).toHaveBeenLastCalledWith(7, noMods);
    expect(events.onPointClick).toHaveBeenCalledTimes(1);

    // background click → null
    graph.config.onBackgroundClick(new MouseEvent('click'));
    expect(events.onPointClick).toHaveBeenLastCalledWith(null, noMods);
    expect(events.onPointClick).toHaveBeenCalledTimes(2);

    // onClick with undefined index → null…
    const ev = new MouseEvent('click');
    graph.config.onClick(undefined, undefined, ev);
    expect(events.onPointClick).toHaveBeenLastCalledWith(null, noMods);
    expect(events.onPointClick).toHaveBeenCalledTimes(3);
    // …and the follow-up onBackgroundClick for the SAME event is not double-reported
    // (real cosmos fires both for one background click).
    graph.config.onBackgroundClick(ev);
    expect(events.onPointClick).toHaveBeenCalledTimes(3);

    // onClick with a point index emits nothing (onPointClick handles it).
    graph.config.onClick(4, [0, 0], new MouseEvent('click'));
    expect(events.onPointClick).toHaveBeenCalledTimes(3);

    // hover mappings
    graph.config.onPointMouseOver(5, [0, 0], undefined, false, false);
    expect(events.onPointHover).toHaveBeenLastCalledWith(5);
    graph.config.onPointMouseOut(undefined);
    expect(events.onPointHover).toHaveBeenLastCalledWith(null);

    // simulation end
    graph.config.onSimulationEnd();
    expect(events.onSimulationEnd).toHaveBeenCalledTimes(1);

    // zoom → viewport change: space position of the canvas center + zoom level.
    // jsdom clientWidth/Height are 0, so center is [0,0] → mock maps to [-5,-5].
    graph.config.onZoom({}, true);
    expect(events.onViewportChange).toHaveBeenLastCalledWith({ x: -5, y: -5, zoom: 1 });
    graph.config.onZoomEnd({}, false);
    expect(events.onViewportChange).toHaveBeenCalledTimes(2);
  });

  it('forwards click modifiers (metaKey/shiftKey) from the MouseEvent', async () => {
    const { events, graph } = await mounted();

    graph.config.onPointClick(7, [0, 0], new MouseEvent('click', { metaKey: true }));
    expect(events.onPointClick).toHaveBeenLastCalledWith(7, { metaKey: true, shiftKey: false });

    graph.config.onPointClick(8, [0, 0], new MouseEvent('click', { shiftKey: true }));
    expect(events.onPointClick).toHaveBeenLastCalledWith(8, { metaKey: false, shiftKey: true });

    // background clicks carry modifiers too (shift-click on empty space)
    graph.config.onBackgroundClick(new MouseEvent('click', { metaKey: true, shiftKey: true }));
    expect(events.onPointClick).toHaveBeenLastCalledWith(null, { metaKey: true, shiftKey: true });
  });

  it('enables native drag by default with an option override; escape hatch wins', async () => {
    const { graph } = await mounted();
    expect(graph.config.enableDrag).toBe(true);

    const disabled = await mounted({ enableDrag: false });
    expect(disabled.graph.config.enableDrag).toBe(false);

    const hatch = await mounted({ enableDrag: false, initialConfig: { enableDrag: true } });
    expect(hatch.graph.config.enableDrag).toBe(true);
  });

  it('a click while a link is hovered never fires the background path', async () => {
    const { events, graph } = await mounted();

    // Cosmos reports a link click as unified onClick(undefined) — no POINT
    // was hit — plus onLinkClick. The old wiring cleared selection first.
    graph.config.onLinkMouseOver(2);
    graph.config.onClick(undefined, undefined, new MouseEvent('click'));
    graph.config.onBackgroundClick(new MouseEvent('click'));
    expect(events.onPointClick).not.toHaveBeenCalled();

    // Off the link, the same channels ARE background again.
    graph.config.onLinkMouseOut(new MouseEvent('mousemove'));
    graph.config.onClick(undefined, undefined, new MouseEvent('click'));
    expect(events.onPointClick).toHaveBeenCalledTimes(1);
    expect(events.onPointClick).toHaveBeenLastCalledWith(null, expect.anything());
  });

  it('forwards link click and hover, including null on mouse-out', async () => {
    const { events, graph } = await mounted();

    graph.config.onLinkClick(3, new MouseEvent('click'));
    expect(events.onLinkClick).toHaveBeenCalledTimes(1);
    expect(events.onLinkClick).toHaveBeenLastCalledWith(3);

    graph.config.onLinkMouseOver(2);
    expect(events.onLinkHover).toHaveBeenLastCalledWith(2);
    graph.config.onLinkMouseOut(new MouseEvent('mousemove'));
    expect(events.onLinkHover).toHaveBeenLastCalledWith(null);
    expect(events.onLinkHover).toHaveBeenCalledTimes(2);
  });

  it('forwards drag start with the dragged index and drag end with final SPACE coords', async () => {
    const { events, graph } = await mounted();

    // cosmos assigns store.draggingPointIndex right before invoking onDragStart
    graph.store.hoveredPoint = { index: 4, position: [0, 0] };
    graph.store.draggingPointIndex = 4;
    graph.config.onDragStart({ x: 10, y: 20 });
    expect(events.onDragStart).toHaveBeenCalledTimes(1);
    expect(events.onDragStart).toHaveBeenLastCalledWith(4);

    // …and clears it BEFORE invoking onDragEnd; the adapter latched the index.
    graph.store.draggingPointIndex = undefined;
    graph.config.onDragEnd({ x: 30, y: 40 });
    // screenToSpacePosition([30,40]) → [55,75] via the mock converter
    expect(events.onDragEnd).toHaveBeenCalledTimes(1);
    expect(events.onDragEnd).toHaveBeenLastCalledWith(4, 55, 75);

    // a drag end without a matching start emits nothing
    graph.config.onDragEnd({ x: 1, y: 1 });
    expect(events.onDragEnd).toHaveBeenCalledTimes(1);

    // a drag start with no dragged point (defensive) emits nothing
    graph.store.hoveredPoint = undefined;
    graph.config.onDragStart({ x: 0, y: 0 });
    expect(events.onDragStart).toHaveBeenCalledTimes(1);
  });

  it('drag start falls back to the last publicly hovered index when store internals are absent', async () => {
    const { events, graph } = await mounted();

    // no store hints — only the public onPointMouseOver stream
    graph.config.onPointMouseOver(6, [0, 0], undefined, false, false);
    graph.config.onDragStart({ x: 0, y: 0 });
    expect(events.onDragStart).toHaveBeenLastCalledWith(6);

    graph.config.onDragEnd({ x: 5, y: 5 });
    expect(events.onDragEnd).toHaveBeenLastCalledWith(6, 5, 5);
  });

  it('pointsInPolygon passes the SCREEN polygon through to findPointsInPolygon (defensive copy)', async () => {
    const { engine, graph } = await mounted();

    const polygon: readonly [number, number][] = [[0, 0], [10, 0], [10, 10]];
    expect(engine.pointsInPolygon(polygon)).toEqual([1, 3]);

    const call = graph.calls.find((c) => c.method === 'findPointsInPolygon')!;
    // cosmos expects screen coordinates (0..canvas size) — values pass through…
    expect(call.args[0]).toEqual([[0, 0], [10, 0], [10, 10]]);
    // …but never the caller's (readonly) array instance
    expect(call.args[0]).not.toBe(polygon);
  });

  it('pointsInRect normalizes [x0,y0,x1,y1] to ordered [[left,top],[right,bottom]] SCREEN corners', async () => {
    const { engine, graph } = await mounted();

    // opposite corners given in reverse order still form a valid cosmos rect
    expect(engine.pointsInRect([30, 40, 10, 20])).toEqual([2, 5]);
    const call = graph.calls.find((c) => c.method === 'findPointsInRect')!;
    expect(call.args[0]).toEqual([
      [10, 20],
      [30, 40],
    ]);

    // an already-ordered rect passes through unchanged (screen coords, no conversion)
    graph.calls.length = 0;
    engine.pointsInRect([1, 2, 3, 4]);
    expect(graph.calls[0]).toEqual({
      method: 'findPointsInRect',
      args: [
        [
          [1, 2],
          [3, 4],
        ],
      ],
    });
  });

  it('neighborIndices delegates to getNeighboringPointIndices and strips the point itself', async () => {
    const { engine, graph } = await mounted();

    // mock returns [5, 2, 7] for index 5 (self-loop includes the point itself)
    expect(engine.neighborIndices(5)).toEqual([2, 7]);
    const call = graph.calls.find((c) => c.method === 'getNeighboringPointIndices')!;
    expect(call.args).toEqual([5]);
  });

  it('screenToSpace/spaceToScreen delegate to the cosmos converters', async () => {
    const { engine } = await mounted();
    expect(engine.screenToSpace([10, 20])).toEqual([15, 35]);
    expect(engine.spaceToScreen([15, 35])).toEqual([10, 20]);
  });

  it('setPinnedIndices replaces the full pinned set; null and [] unpin', async () => {
    const { engine, graph } = await mounted();
    graph.calls.length = 0;

    engine.setPinnedIndices([1, 2]);
    engine.setPinnedIndices([]);
    engine.setPinnedIndices(null);

    expect(graph.calls).toEqual([
      { method: 'setPinnedPoints', args: [[1, 2]] },
      { method: 'setPinnedPoints', args: [[]] },
      { method: 'setPinnedPoints', args: [null] },
    ]);
  });

  it('spatial queries & pinning are inert while the context is lost and after destroy', async () => {
    const { engine, graph } = await mounted();

    graph.canvas!.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    graph.calls.length = 0; // drop the loss-handler pause() record
    expect(engine.pointsInPolygon([[0, 0], [1, 0], [1, 1]])).toEqual([]);
    expect(engine.pointsInRect([0, 0, 1, 1])).toEqual([]);
    expect(engine.neighborIndices(1)).toEqual([]);
    expect(engine.screenToSpace([0, 0])).toBeNull();
    expect(engine.spaceToScreen([0, 0])).toBeNull();
    engine.setPinnedIndices([1]);
    engine.setPinnedIndices(null);
    expect(graph.calls).toEqual([]); // nothing reached the dead-context graph

    // drag callbacks wired to the dead graph emit nothing either
    graph.store.hoveredPoint = { index: 1, position: [0, 0] };
    graph.store.draggingPointIndex = 1;
    graph.config.onDragStart({ x: 0, y: 0 });
    graph.config.onDragEnd({ x: 0, y: 0 });

    const second = await mounted();
    second.engine.destroy();
    second.graph.calls.length = 0;
    expect(second.engine.pointsInPolygon([[0, 0], [1, 0], [1, 1]])).toEqual([]);
    expect(second.engine.pointsInRect([0, 0, 1, 1])).toEqual([]);
    expect(second.engine.neighborIndices(1)).toEqual([]);
    expect(second.engine.screenToSpace([0, 0])).toBeNull();
    expect(second.engine.spaceToScreen([0, 0])).toBeNull();
    second.engine.setPinnedIndices([1]);
    second.engine.setPinnedIndices(null);
    expect(second.graph.calls).toEqual([]);
  });

  it('re-wires link/drag callbacks and enableDrag on the graph recreated after context restore', async () => {
    const { engine, events, graph } = await mounted();

    graph.canvas!.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    graph.canvas!.dispatchEvent(new Event('webglcontextrestored'));
    await flushAsync();

    const recreated = h.constructed[h.constructed.length - 1]!;
    expect(recreated).not.toBe(graph);

    // buildInitialConfig ran again: enableDrag and the interaction callbacks are live.
    expect(recreated.config.enableDrag).toBe(true);
    recreated.config.onLinkClick(9, new MouseEvent('click'));
    expect(events.onLinkClick).toHaveBeenLastCalledWith(9);
    recreated.config.onLinkMouseOver(1);
    expect(events.onLinkHover).toHaveBeenLastCalledWith(1);
    recreated.config.onLinkMouseOut(new MouseEvent('mousemove'));
    expect(events.onLinkHover).toHaveBeenLastCalledWith(null);
    recreated.config.onPointClick(2, [0, 0], new MouseEvent('click', { metaKey: true }));
    expect(events.onPointClick).toHaveBeenLastCalledWith(2, { metaKey: true, shiftKey: false });
    recreated.config.onContextMenu(
      8,
      [0, 0],
      new MouseEvent('contextmenu', { clientX: 3, clientY: 4, cancelable: true }),
    );
    expect(events.onContextMenu).toHaveBeenLastCalledWith(8, [3, 4]);

    recreated.store.hoveredPoint = { index: 2, position: [0, 0] };
    recreated.store.draggingPointIndex = 2;
    recreated.config.onDragStart({ x: 0, y: 0 });
    expect(events.onDragStart).toHaveBeenLastCalledWith(2);
    recreated.store.draggingPointIndex = undefined;
    recreated.config.onDragEnd({ x: 5, y: 5 });
    expect(events.onDragEnd).toHaveBeenLastCalledWith(2, 5, 5);

    // spatial queries & pinning now hit the NEW graph, not the dead one
    engine.setPinnedIndices([3]);
    expect(recreated.calls.some((c) => c.method === 'setPinnedPoints')).toBe(true);
    expect(graph.calls.some((c) => c.method === 'setPinnedPoints')).toBe(false);
  });

  it('commit applies config, structure, and buffers as one batch with exactly one render', async () => {
    const { engine, graph } = await mounted();
    graph.calls.length = 0;

    engine.commit({
      revision: 1,
      structure: {
        pointCount: 2,
        positions: new Float32Array([0, 0, 10, 10]),
        links: new Uint32Array([0, 1]),
      },
      buffers: {
        pointColor: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1]),
        pointSize: new Float32Array([4, 8]),
        linkColor: new Float32Array([0, 0, 1, 1]),
        linkWidth: new Float32Array([2]),
      },
      config: { backgroundColor: '#101010' },
      restart: { alpha: 1 },
    });

    expect(methodsOf(graph.calls)).toEqual([
      'setConfigPartial',
      'setPointPositions',
      'setLinks',
      'setPointColors',
      'setPointSizes',
      'setLinkColors',
      'setLinkWidths',
      'render',
      'start', // restart runs after render
    ]);

    // links are converted to a Float32Array of index pairs
    const linksArg = graph.calls[2]!.args[0] as Float32Array;
    expect(linksArg).toBeInstanceOf(Float32Array);
    expect(Array.from(linksArg)).toEqual([0, 1]);

    // colors pass through in cosmos' native [0,1] RGBA scale
    const colorsArg = graph.calls[3]!.args[0] as Float32Array;
    expect(Array.from(colorsArg)).toEqual([1, 0, 0, 1, 0, 1, 0, 1]);

    // restart carries the alpha
    expect(graph.calls[8]!.args).toEqual([1]);

    // a second commit renders exactly once more, without restart
    graph.calls.length = 0;
    engine.commit({ revision: 2, buffers: { pointSize: new Float32Array([6, 6]) } });
    expect(methodsOf(graph.calls)).toEqual(['setPointSizes', 'render']);
  });

  it('replaces NaN seed pairs with ring positions and passes explicit positions verbatim', async () => {
    const { engine, graph } = await mounted({ spaceSize: 400, seedRadius: 50 });

    engine.commit({
      revision: 1,
      structure: {
        pointCount: 3,
        positions: new Float32Array([NaN, NaN, 30, 40, NaN, NaN]),
        links: new Uint32Array([]),
      },
    });
    const pos = graph.calls.find((c) => c.method === 'setPointPositions')!.args[0] as Float32Array;
    expect(Array.from(pos).some(Number.isNaN)).toBe(false);
    // explicit pair untouched
    expect(pos[2]).toBe(30);
    expect(pos[3]).toBe(40);
    // seeded pairs land on the ring: radius 50 around the space center (200, 200)
    expect(Math.hypot(pos[0]! - 200, pos[1]! - 200)).toBeCloseTo(50, 2);
    expect(Math.hypot(pos[4]! - 200, pos[5]! - 200)).toBeCloseTo(50, 2);

    // no NaN → the exact same array instance is forwarded
    graph.calls.length = 0;
    const explicit = new Float32Array([1, 2, 3, 4]);
    engine.commit({
      revision: 2,
      structure: { pointCount: 2, positions: explicit, links: new Uint32Array([0, 1]) },
    });
    expect(graph.calls.find((c) => c.method === 'setPointPositions')!.args[0]).toBe(explicit);

    // default seed radius is spaceSize/4 around spaceSize/2
    const second = await mounted();
    second.engine.commit({
      revision: 1,
      structure: { pointCount: 1, positions: new Float32Array([NaN, NaN]), links: new Uint32Array([]) },
    });
    const seeded = second.graph.calls.find((c) => c.method === 'setPointPositions')!
      .args[0] as Float32Array;
    expect(Math.hypot(seeded[0]! - 2048, seeded[1]! - 2048)).toBeCloseTo(1024, 1);
  });

  it('maps simulation config to cosmos simulation* keys via setConfigPartial', async () => {
    const { engine, graph } = await mounted();
    graph.calls.length = 0;

    engine.commit({
      revision: 1,
      config: {
        backgroundColor: '#000000',
        simulation: {
          gravity: 0.5,
          repulsion: 2,
          friction: 0.9,
          linkDistance: 15,
          linkSpring: 1.5,
        },
      },
    });

    expect(graph.calls[0]).toEqual({
      method: 'setConfigPartial',
      args: [
        {
          backgroundColor: '#000000',
          simulationGravity: 0.5,
          simulationRepulsion: 2,
          simulationFriction: 0.9,
          simulationLinkDistance: 15,
          simulationLinkSpring: 1.5,
        },
      ],
    });
  });

  it('maps the effective tunable set; repulsionTheta is unmapped with ONE deprecation diagnostic', async () => {
    const { engine, graph, events } = await mounted();
    graph.calls.length = 0;

    engine.commit({
      revision: 1,
      config: {
        simulation: {
          decay: 1200,
          collision: 0.8,
          collisionRadius: 6,
          collisionPadding: 2,
          repulsionTheta: 0.9,
          center: 0.3,
          repulsionFromMouse: 4,
        },
      },
    });

    // Every effective tunable maps 1:1 onto its cosmos key; repulsionTheta
    // does NOT map (cosmos >= 3.4 grid-based repulsion ignores it) and the
    // host is told once instead of wondering silently.
    expect(graph.calls[0]).toEqual({
      method: 'setConfigPartial',
      args: [
        {
          simulationDecay: 1200,
          simulationCollision: 0.8,
          simulationCollisionRadius: 6,
          simulationCollisionPadding: 2,
          simulationCenter: 0.3,
          simulationRepulsionFromMouse: 4,
        },
      ],
    });
    expect(diagnosticsWithCode(events, 'engine:repulsion-theta-deprecated')).toHaveLength(1);

    // The diagnostic is one-shot: a second theta write stays silent.
    engine.commit({ revision: 2, config: { simulation: { repulsionTheta: 1.5 } } });
    expect(diagnosticsWithCode(events, 'engine:repulsion-theta-deprecated')).toHaveLength(1);

    // …and OMISSION is not a value: a partial config writes only what it
    // carries, so cosmos' own defaults stand for everything else.
    graph.calls.length = 0;
    engine.commit({ revision: 3, config: { simulation: { collision: 0 } } });
    expect(graph.calls[0]).toEqual({
      method: 'setConfigPartial',
      args: [{ simulationCollision: 0 }],
    });
  });

  it('merges queued pre-mount channels, keeping the latest revision and restart directive', async () => {
    const engine = new CosmosEngine();
    engine.commit({
      revision: 1,
      buffers: {
        pointColor: new Float32Array([1, 0, 0, 1]),
        pointSize: new Float32Array([1]),
      },
      config: { backgroundColor: '#111111', simulation: { gravity: 0.2 } },
      restart: { alpha: 0.4 },
    });
    engine.commit({
      revision: 2,
      structure: {
        pointCount: 1,
        positions: new Float32Array([10, 20]),
        links: new Uint32Array([]),
      },
      buffers: { pointSize: new Float32Array([9]) },
      config: { simulation: { friction: 0.8 } },
      // Omission preserves the earlier pending restart.
    });
    expect(engine.appliedRevision()).toBeNull();

    const container = document.createElement('div');
    await engine.mount(container, makeEvents());

    const graph = h.constructed[h.constructed.length - 1]!;
    expect(methodsOf(graph.calls)).toEqual([
      'setConfigPartial',
      'setPointPositions',
      'setLinks',
      'setPointColors',
      'setPointSizes',
      'render',
      'start',
    ]);
    expect(graph.calls[0]!.args[0]).toEqual({
      backgroundColor: '#111111',
      simulationGravity: 0.2,
      simulationFriction: 0.8,
    });
    const colorCalls = graph.calls.filter((c) => c.method === 'setPointColors');
    expect(colorCalls).toHaveLength(1);
    expect(Array.from(colorCalls[0]!.args[0] as Float32Array)).toEqual([1, 0, 0, 1]);
    const sizeCalls = graph.calls.filter((c) => c.method === 'setPointSizes');
    expect(sizeCalls).toHaveLength(1); // latest value within the point-size channel
    expect(Array.from(sizeCalls[0]!.args[0] as Float32Array)).toEqual([9]);
    expect(graph.calls.filter((c) => c.method === 'render')).toHaveLength(1);
    expect(graph.calls.filter((c) => c.method === 'start')[0]!.args).toEqual([0.4]);
    expect(engine.appliedRevision()).toBe(2);

    // Contract: `restart: false` ≡ absent ("keep state") — NEITHER cancels a
    // pending queued restart directive.
    const withoutRestart = new CosmosEngine();
    withoutRestart.commit({ revision: 3, restart: { alpha: 1 } });
    withoutRestart.commit({ revision: 4, restart: false });
    const secondContainer = document.createElement('div');
    await withoutRestart.mount(secondContainer, makeEvents());
    const secondGraph = h.constructed[h.constructed.length - 1]!;
    expect(secondGraph.calls.filter((c) => c.method === 'render')).toHaveLength(1);
    const preservedStart = secondGraph.calls.filter((c) => c.method === 'start');
    expect(preservedStart).toHaveLength(1);
    expect(preservedStart[0]!.args).toEqual([1]);
    expect(withoutRestart.appliedRevision()).toBe(4);
  });

  it('owns every array in an initial queued commit before commit() returns', async () => {
    const positions = new Float32Array([10, 20, 30, 40]);
    const links = new Uint32Array([0, 1]);
    const pointColor = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1]);
    const pointSize = new Float32Array([3, 4]);
    const linkColor = new Float32Array([0, 0, 1, 1]);
    const patchData = new Float32Array([7]);
    const pointClusters = new Float32Array([0, 1]);
    const centers = new Float32Array([5, 6, 7, 8]);
    const pointImageIndex = new Float32Array([0, 1]);
    const engine = new CosmosEngine();

    engine.commit({
      revision: 1,
      structure: { pointCount: 2, positions, links },
      buffers: { pointColor, pointSize, linkColor },
      bufferPatches: { linkWidth: [{ start: 0, data: patchData }] },
      config: { cluster: { pointClusters, centers, strength: 0.5 } },
      resources: { pointImageIndex },
    });

    // The patch channel is unsupported by cosmos and therefore is not
    // applied, but it still crosses the same queued ownership boundary.
    const pending = (
      engine as unknown as { pendingCommit: EngineCommit | null }
    ).pendingCommit!;
    expect(pending.bufferPatches!.linkWidth![0]!.data).not.toBe(patchData);

    positions.fill(99);
    links.set([1, 0]);
    pointColor.fill(0.25);
    pointSize.fill(99);
    linkColor.fill(0.25);
    patchData.fill(99);
    pointClusters.fill(9);
    centers.fill(99);
    pointImageIndex.fill(-1);

    const container = document.createElement('div');
    await engine.mount(container, makeEvents());
    const graph = h.constructed[h.constructed.length - 1]!;

    expect(Array.from(graph.calls.find((c) => c.method === 'setPointPositions')!.args[0] as Float32Array))
      .toEqual([10, 20, 30, 40]);
    expect(Array.from(graph.calls.find((c) => c.method === 'setLinks')!.args[0] as Float32Array))
      .toEqual([0, 1]);
    expect(Array.from(graph.calls.find((c) => c.method === 'setPointColors')!.args[0] as Float32Array))
      .toEqual([1, 0, 0, 1, 0, 1, 0, 1]);
    expect(Array.from(graph.calls.find((c) => c.method === 'setPointSizes')!.args[0] as Float32Array))
      .toEqual([3, 4]);
    expect(Array.from(graph.calls.find((c) => c.method === 'setLinkColors')!.args[0] as Float32Array))
      .toEqual([0, 0, 1, 1]);
    expect(graph.calls.find((c) => c.method === 'setPointClusters')!.args[0])
      .toEqual([0, 1]);
    expect(graph.calls.find((c) => c.method === 'setClusterPositions')!.args[0])
      .toEqual([5, 6, 7, 8]);
    expect(Array.from(graph.calls.find((c) => c.method === 'setPointImageIndices')!.args[0] as Float32Array))
      .toEqual([0, 1]);
  });

  it('merges only owned array snapshots across queued commits', async () => {
    const positions = new Float32Array([1, 2, 3, 4]);
    const links = new Uint32Array([0, 1]);
    const pointColor = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1]);
    const pointColorPatch = new Float32Array([0.5]);
    const engine = new CosmosEngine();

    engine.commit({
      revision: 1,
      structure: { pointCount: 2, positions, links },
      buffers: { pointColor },
      bufferPatches: { pointSize: [{ start: 0, data: pointColorPatch }] },
    });
    positions.fill(90);
    links.fill(1);
    pointColor.fill(0.25);
    pointColorPatch.fill(90);

    const pointSize = new Float32Array([8, 9]);
    const linkWidthPatch = new Float32Array([2]);
    const pointClusters = new Float32Array([1, 0]);
    const pointImageIndex = new Float32Array([1, 0]);
    engine.commit({
      revision: 2,
      buffers: { pointSize },
      bufferPatches: { linkWidth: [{ start: 0, data: linkWidthPatch }] },
      config: { cluster: { pointClusters } },
      resources: { pointImageIndex },
    });
    pointSize.fill(90);
    linkWidthPatch.fill(90);
    pointClusters.fill(9);
    pointImageIndex.fill(-1);

    const pending = (
      engine as unknown as { pendingCommit: EngineCommit | null }
    ).pendingCommit!;
    expect(Array.from(pending.bufferPatches!.pointSize![0]!.data)).toEqual([0.5]);
    expect(Array.from(pending.bufferPatches!.linkWidth![0]!.data)).toEqual([2]);

    const container = document.createElement('div');
    await engine.mount(container, makeEvents());
    const graph = h.constructed[h.constructed.length - 1]!;

    expect(Array.from(graph.calls.find((c) => c.method === 'setPointPositions')!.args[0] as Float32Array))
      .toEqual([1, 2, 3, 4]);
    expect(Array.from(graph.calls.find((c) => c.method === 'setLinks')!.args[0] as Float32Array))
      .toEqual([0, 1]);
    expect(Array.from(graph.calls.find((c) => c.method === 'setPointColors')!.args[0] as Float32Array))
      .toEqual([1, 0, 0, 1, 0, 1, 0, 1]);
    expect(Array.from(graph.calls.find((c) => c.method === 'setPointSizes')!.args[0] as Float32Array))
      .toEqual([8, 9]);
    expect(graph.calls.find((c) => c.method === 'setPointClusters')!.args[0])
      .toEqual([1, 0]);
    expect(Array.from(graph.calls.find((c) => c.method === 'setPointImageIndices')!.args[0] as Float32Array))
      .toEqual([1, 0]);
    expect(engine.appliedRevision()).toBe(2);
  });

  it('appliedRevision tracks the last rendered commit', async () => {
    const { engine, graph } = await mounted();
    expect(engine.appliedRevision()).toBeNull();

    engine.commit({ revision: 5 });
    expect(engine.appliedRevision()).toBe(5);
    expect(graph.calls.filter((c) => c.method === 'render')).toHaveLength(1);

    engine.commit({ revision: 6, buffers: { pointSize: new Float32Array([2]) } });
    expect(engine.appliedRevision()).toBe(6);
    expect(graph.calls.filter((c) => c.method === 'render')).toHaveLength(2);
  });

  it('maps camera, selection, focus, and simulation controls to cosmos APIs', async () => {
    const { engine, graph } = await mounted();
    graph.calls.length = 0;

    engine.fitView({ durationMs: 300, padding: 0.2 });
    engine.zoom(2, 100); // zoomLevel 1 * factor 2
    engine.setViewport({ zoom: 5 }, { durationMs: 50 });
    engine.zoomToIndex(4, 500);
    engine.setSelectedIndices([1, 2]);
    engine.setSelectedIndices(null);
    engine.setFocusedIndex(3);
    engine.setFocusedIndex(null);
    engine.start(0.8);
    engine.pause();

    expect(graph.calls).toEqual([
      { method: 'fitView', args: [300, 0.2] },
      { method: 'setZoomLevel', args: [2, 100] },
      { method: 'setZoomLevel', args: [5, 50] },
      { method: 'zoomToPointByIndex', args: [4, 500] },
      { method: 'setConfigPartial', args: [{ highlightedPointIndices: [1, 2] }] },
      { method: 'setConfigPartial', args: [{ highlightedPointIndices: undefined }] },
      { method: 'setConfigPartial', args: [{ focusedPointIndex: 3 }] },
      { method: 'setConfigPartial', args: [{ focusedPointIndex: undefined }] },
      { method: 'start', args: [0.8] },
      { method: 'pause', args: [] },
    ]);

    expect(engine.getPositions()).toEqual(Float32Array.from([1, 2, 3, 4]));
    expect(engine.getViewport()).toEqual({ x: -5, y: -5, zoom: 5 });
  });

  // Real setViewport pan via setZoomTransformByPointPositions. The
  // derived formula (see the CosmosEngine module header): centering (x, y) at
  // zoom z is exactly setZoomTransformByPointPositions([x, y], duration, z);
  // an explicit scale bypasses the fit math and padding, and the single-point
  // bbox is widened symmetrically so the center is preserved.
  describe('setViewport pan (zoom-only limitation lifted)', () => {
    it('centers (x, y) at the requested zoom with one exact-formula call', async () => {
      const { engine, graph } = await mounted();
      graph.calls.length = 0;

      engine.setViewport({ x: 10, y: 20, zoom: 5 }, { durationMs: 100 });

      expect(graph.calls).toEqual([
        {
          method: 'setZoomTransformByPointPositions',
          args: [Float32Array.of(10, 20), 100, 5, undefined],
        },
      ]);
      // The mock mirrors the dist (explicit scale → eventTransform.k).
      expect(graph.getZoomLevel()).toBe(5);
    });

    it('holds the CURRENT zoom when zoom is omitted, and is instant by default', async () => {
      const { engine, graph } = await mounted();
      engine.setViewport({ zoom: 3 }); // establish current zoom via the zoom path
      graph.calls.length = 0;

      engine.setViewport({ x: -7, y: 8 });

      // duration 0 (never cosmos' 250ms default — recovery replays are instant).
      expect(graph.calls).toEqual([
        {
          method: 'setZoomTransformByPointPositions',
          args: [Float32Array.of(-7, 8), 0, 3, undefined],
        },
      ]);
    });

    it('fills a missing axis from the current viewport', async () => {
      const { engine, graph } = await mounted();
      graph.calls.length = 0;

      // getViewport center: screenToSpacePosition([0, 0]) = [-5, -5] (mock);
      // current zoom is the mock default 1.
      engine.setViewport({ x: 42 });

      expect(graph.calls).toEqual([
        {
          method: 'setZoomTransformByPointPositions',
          args: [Float32Array.of(42, -5), 0, 1, undefined],
        },
      ]);
    });

    it('zoom-only calls keep the setZoomLevel path (scaleTo preserves the center)', async () => {
      const { engine, graph } = await mounted();
      graph.calls.length = 0;

      engine.setViewport({ zoom: 7 }, { durationMs: 40 });

      expect(graph.calls).toEqual([{ method: 'setZoomLevel', args: [7, 40] }]);
    });
  });

  it('passes options through and applies initialConfig last', async () => {
    const { graph } = await mounted({
      spaceSize: 1000,
      fitViewOnInit: true,
      initialConfig: { spaceSize: 2000, pointDefaultSize: 9 },
    });
    expect(graph.config.fitViewOnInit).toBe(true);
    expect(graph.config.pointDefaultSize).toBe(9);
    // escape hatch wins over the spaceSize option
    expect(graph.config.spaceSize).toBe(2000);
  });

  it('destroy tears down cosmos and the inner div; later calls are no-ops (commit throws)', async () => {
    const { engine, container, graph } = await mounted();

    engine.destroy();
    expect(graph.calls.some((c) => c.method === 'destroy')).toBe(true);
    expect(container.children).toHaveLength(0);

    // post-destroy: everything is a safe no-op…
    const callCount = graph.calls.length;
    expect(engine.getViewport()).toBeNull();
    expect(engine.getPositions()).toBeNull();
    expect(engine.appliedRevision()).toBeNull();
    engine.fitView();
    engine.zoom(2);
    engine.start();
    engine.pause();
    engine.setSelectedIndices([0]);
    engine.setFocusedIndex(null);
    engine.destroy(); // idempotent
    expect(graph.calls.length).toBe(callCount);

    // …except commit, which is a programmer error
    expect(() => engine.commit({ revision: 9 })).toThrow();
  });
});

describe('CosmosEngine activity clock (onFrame)', () => {
  it('starts one rAF loop at mount, forwards tick timestamps to onFrame, and emits the degradation diagnostic once', async () => {
    const fake = installFakeRaf();
    const { events } = await mounted();

    // exactly one loop armed at mount; no tick has fired yet
    expect(fake.raf).toHaveBeenCalledTimes(1);
    expect(fake.pendingCount()).toBe(1);
    expect(events.onFrame).not.toHaveBeenCalled();

    fake.fire(100);
    expect(events.onFrame).toHaveBeenCalledTimes(1);
    expect(events.onFrame).toHaveBeenLastCalledWith(100);
    expect(fake.pendingCount()).toBe(1); // rescheduled for the next tick

    fake.fire(116.7);
    expect(events.onFrame).toHaveBeenCalledTimes(2);
    expect(events.onFrame).toHaveBeenLastCalledWith(116.7);

    // postDrawFrames:false degradation reported exactly once, as info
    const diags = diagnosticsWithCode(events, 'engine:overlay-activity-clock');
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe('info');
  });

  it('skips the onFrame callback while document.hidden but keeps a HELD clock armed', async () => {
    const fake = installFakeRaf();
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    cleanups.push(() => {
      delete (document as unknown as Record<string, unknown>)['hidden'];
    });
    const { engine, events } = await mounted();
    // Hold the clock open with a run reason — a bare tick budget would
    // (correctly) drain and stop under the gated clock.
    engine.start();

    hidden = true;
    fake.fire(10);
    fake.fire(20);
    expect(events.onFrame).not.toHaveBeenCalled();
    expect(fake.pendingCount()).toBe(1); // still ticking, just silent

    hidden = false;
    fake.fire(30);
    expect(events.onFrame).toHaveBeenCalledTimes(1);
    expect(events.onFrame).toHaveBeenLastCalledWith(30);
  });

  it('stops the clock on destroy, cancelling the pending rAF', async () => {
    const fake = installFakeRaf();
    const { engine, events } = await mounted();
    expect(fake.pendingCount()).toBe(1);

    engine.destroy();
    expect(fake.caf).toHaveBeenCalledTimes(1);
    expect(fake.pendingCount()).toBe(0);

    fake.fire(50); // nothing pending; nothing fires
    expect(events.onFrame).not.toHaveBeenCalled();
  });

  it('pauses the clock while the context is lost and resumes after recovery without re-emitting the diagnostic', async () => {
    const fake = installFakeRaf();
    const { events, graph } = await mounted();
    expect(fake.pendingCount()).toBe(1);

    graph.canvas!.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(fake.pendingCount()).toBe(0); // pending tick cancelled at loss
    fake.fire(10);
    expect(events.onFrame).not.toHaveBeenCalled();

    graph.canvas!.dispatchEvent(new Event('webglcontextrestored'));
    await flushAsync();
    expect(fake.pendingCount()).toBe(1); // clock re-armed by recovery

    fake.fire(50);
    expect(events.onFrame).toHaveBeenCalledTimes(1);
    expect(events.onFrame).toHaveBeenLastCalledWith(50);

    // the degradation diagnostic is mount-scoped: still exactly one
    expect(diagnosticsWithCode(events, 'engine:overlay-activity-clock')).toHaveLength(1);
  });

  it('tears down recovery listeners and clock when restored delivery throws', async () => {
    const fake = installFakeRaf();
    const { engine, events, graph } = await mounted();
    const failure = new Error('restored callback failed');
    events.onContextEvent.mockImplementation((event) => {
      if (event.type === 'restored') throw failure;
    });

    const oldCanvas = graph.canvas!;
    oldCanvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(fake.pendingCount()).toBe(0);

    oldCanvas.dispatchEvent(new Event('webglcontextrestored'));
    const replacement = h.constructed[h.constructed.length - 1]!;
    const replacementCanvas = replacement.canvas!;
    await flushAsync();

    expect(replacement.calls.filter((call) => call.method === 'destroy')).toHaveLength(1);
    expect(replacement.canvas).toBeNull();
    expect(fake.pendingCount()).toBe(0);
    expect(events.onContextEvent).toHaveBeenLastCalledWith({
      type: 'failed',
      error: failure,
    });

    const eventCount = events.onContextEvent.mock.calls.length;
    const lateLoss = new Event('webglcontextlost', { cancelable: true });
    replacementCanvas.dispatchEvent(lateLoss);
    expect(lateLoss.defaultPrevented).toBe(false);
    expect(events.onContextEvent).toHaveBeenCalledTimes(eventCount);

    engine.destroy();
    expect(replacement.calls.filter((call) => call.method === 'destroy')).toHaveLength(1);
  });
});

describe('CosmosEngine context menu', () => {
  it('maps the unified cosmos callback to onContextMenu with container-relative CSS px and prevents the native menu', async () => {
    const { events, container, graph } = await mounted();
    const inner = container.children[0] as HTMLDivElement;
    // jsdom rects are all-zero; give the container a real screen offset so
    // the client→container conversion is observable.
    vi.spyOn(inner, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 810,
      bottom: 620,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    } as DOMRect);

    // node target: index passes through; clientX/Y become container-relative
    const nodeEvent = new MouseEvent('contextmenu', {
      clientX: 110,
      clientY: 220,
      cancelable: true,
    });
    graph.config.onContextMenu(3, [0, 0], nodeEvent);
    expect(events.onContextMenu).toHaveBeenCalledTimes(1);
    expect(events.onContextMenu).toHaveBeenLastCalledWith(3, [100, 200]);
    expect(nodeEvent.defaultPrevented).toBe(true);

    // background target: undefined index → null
    const bgEvent = new MouseEvent('contextmenu', { clientX: 10, clientY: 20, cancelable: true });
    graph.config.onContextMenu(undefined, undefined, bgEvent);
    expect(events.onContextMenu).toHaveBeenCalledTimes(2);
    expect(events.onContextMenu).toHaveBeenLastCalledWith(null, [0, 0]);
    expect(bgEvent.defaultPrevented).toBe(true);
  });

  it('handles the touch long-press path (cosmos forwards the originating pointer event)', async () => {
    const { events, graph } = await mounted();

    // cosmos' long-press timer forwards the pointerdown event, not a
    // contextmenu MouseEvent — same unified callback, same mapping.
    const pointerDown = new MouseEvent('pointerdown', {
      clientX: 42,
      clientY: 24,
      cancelable: true,
    });
    graph.config.onContextMenu(6, [0, 0], pointerDown);
    expect(events.onContextMenu).toHaveBeenLastCalledWith(6, [42, 24]);
  });

  it('leaves the native event alone when the host registered no onContextMenu', async () => {
    const engine = new CosmosEngine();
    const events = { onPointClick: vi.fn() } satisfies EngineHostEvents;
    const container = document.createElement('div');
    await engine.mount(container, events);
    const graph = h.constructed[h.constructed.length - 1]!;

    const ev = new MouseEvent('contextmenu', { clientX: 5, clientY: 5, cancelable: true });
    graph.config.onContextMenu(2, [0, 0], ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('CosmosEngine captureScreenshot', () => {
  it('draws the cosmos canvas onto an offscreen 2D canvas inside one rAF tick and resolves the Blob', async () => {
    const fake = installFakeRaf();
    const { engine, graph } = await mounted();
    const src = graph.canvas!;
    src.width = 640;
    src.height = 480;
    const blob = new Blob(['png-bytes'], { type: 'image/png' });
    const stub = stubOffscreenCanvas(blob);

    const promise = engine.captureScreenshot();
    // same-tick method: nothing is read until the rAF tick fires
    expect(stub.drawImage).not.toHaveBeenCalled();

    fake.fire(1000);
    await expect(promise).resolves.toBe(blob);
    expect(stub.offscreen.width).toBe(640);
    expect(stub.offscreen.height).toBe(480);
    expect(stub.getContext).toHaveBeenCalledWith('2d');
    expect(stub.drawImage).toHaveBeenCalledTimes(1);
    expect(stub.drawImage).toHaveBeenCalledWith(src, 0, 0);
  });

  it('resolves null pre-mount, after destroy, while lost, and when loss races the capture tick', async () => {
    const fake = installFakeRaf();

    // pre-mount: no canvas yet
    await expect(new CosmosEngine().captureScreenshot()).resolves.toBeNull();

    // destroyed
    const first = await mounted();
    first.engine.destroy();
    await expect(first.engine.captureScreenshot()).resolves.toBeNull();

    // already lost: resolves immediately, no rAF needed
    const second = await mounted();
    second.graph.canvas!.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    await expect(second.engine.captureScreenshot()).resolves.toBeNull();

    // loss landing between scheduling and the rAF tick
    const third = await mounted();
    const racing = third.engine.captureScreenshot();
    third.graph.canvas!.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    fake.fire(1);
    await expect(racing).resolves.toBeNull();
  });

  it('resolves null when no 2D context is available', async () => {
    const fake = installFakeRaf();
    const { engine } = await mounted();
    const stub = stubOffscreenCanvas(new Blob(['unused']));
    stub.getContext.mockReturnValue(null);

    const promise = engine.captureScreenshot();
    fake.fire(1);
    await expect(promise).resolves.toBeNull();
    expect(stub.toBlob).not.toHaveBeenCalled();
  });

  it('resolves null when toBlob yields null (encoder failure)', async () => {
    const fake = installFakeRaf();
    const { engine } = await mounted();
    const stub = stubOffscreenCanvas(null);

    const promise = engine.captureScreenshot();
    fake.fire(1);
    await expect(promise).resolves.toBeNull();
    expect(stub.drawImage).toHaveBeenCalledTimes(1);
  });
});

describe('CosmosEngine styling channels', () => {
  it('exposes the edgeArrows and pointImages capabilities', () => {
    const caps = new CosmosEngine().capabilities;
    expect(caps.edgeArrows).toBe(true);
    expect(caps.pointImages).toBe(true);
  });

  it('maps linkArrows/renderLinks/default colors/emphasis ring to cosmos config keys in one atomic batch', async () => {
    const { engine, graph } = await mounted();
    graph.calls.length = 0;

    engine.commit({
      revision: 1,
      config: {
        linkArrows: true,
        renderLinks: false,
        defaultPointColor: '#ff0000',
        defaultLinkColor: 'rgba(0, 255, 0, 0.5)',
        emphasisRingColor: '#7aa2f7',
      },
    });

    // One setConfigPartial carrying all five mapped keys, one render. The
    // emphasis ring maps to the FOCUSED ring (never renderHoveredPointRing
    // orbit chooses the ringed node, cosmos' own hover state does not).
    expect(graph.calls).toEqual([
      {
        method: 'setConfigPartial',
        args: [
          {
            linkDefaultArrows: true,
            renderLinks: false,
            pointDefaultColor: '#ff0000',
            linkDefaultColor: 'rgba(0, 255, 0, 0.5)',
            focusedPointRingColor: '#7aa2f7',
          },
        ],
      },
      { method: 'render', args: [] },
    ]);
  });

  it('round-trips the arrows toggle through the linkDefaultArrows config key', async () => {
    const { engine, graph } = await mounted();
    graph.calls.length = 0;

    engine.commit({ revision: 1, config: { linkArrows: true } });
    engine.commit({ revision: 2, config: { linkArrows: false } });

    expect(graph.calls).toEqual([
      { method: 'setConfigPartial', args: [{ linkDefaultArrows: true }] },
      { method: 'render', args: [] },
      { method: 'setConfigPartial', args: [{ linkDefaultArrows: false }] },
      { method: 'render', args: [] },
    ]);
  });

  it('renderLinks toggling is config-only: zero buffer setters reached', async () => {
    const { engine, graph } = await mounted();
    // Real structure + buffers first, so "no buffer rebuild" is meaningful.
    engine.commit({
      revision: 1,
      structure: {
        pointCount: 2,
        positions: new Float32Array([0, 0, 10, 10]),
        links: new Uint32Array([0, 1]),
      },
      buffers: {
        linkColor: new Float32Array([0, 0, 1, 1]),
        linkWidth: new Float32Array([2]),
      },
    });
    graph.calls.length = 0;

    engine.commit({ revision: 2, config: { renderLinks: false } });
    engine.commit({ revision: 3, config: { renderLinks: true } });

    // Full call-list equality proves no set* buffer call was involved.
    expect(graph.calls).toEqual([
      { method: 'setConfigPartial', args: [{ renderLinks: false }] },
      { method: 'render', args: [] },
      { method: 'setConfigPartial', args: [{ renderLinks: true }] },
      { method: 'render', args: [] },
    ]);
  });

  it('converts ImageBitmap upserts via a 2D canvas and uploads the full slot array plus indices in one render', async () => {
    const ctx2d = stubCanvas2d();
    const { engine, events, graph } = await mounted();
    graph.calls.length = 0;

    const bmpA = fakeBitmap(4);
    const bmpC = fakeBitmap(8);
    const indices = new Float32Array([0, -1, 2]);
    engine.commit({
      revision: 1,
      resources: {
        imageAtlas: {
          upserts: [
            { slot: 0, bitmap: bmpA },
            { slot: 2, bitmap: bmpC },
          ],
        },
        pointImageIndex: indices,
      },
    });

    // Atlas + indices are staged before the SAME single render.
    expect(methodsOf(graph.calls)).toEqual(['setImageData', 'setPointImageIndices', 'render']);

    // Both bitmaps went through the offscreen 2D conversion canvas.
    expect(ctx2d.drawImage).toHaveBeenCalledWith(bmpA, 0, 0);
    expect(ctx2d.drawImage).toHaveBeenCalledWith(bmpC, 0, 0);

    // Full array upload: slot 0 and 2 carry the converted images, the
    // never-written hole at slot 1 is a 1x1 blank.
    const atlas = graph.calls[0]!.args[0] as AtlasEntry[];
    expect(atlas).toHaveLength(3);
    expect([atlas[0]!.width, atlas[0]!.height]).toEqual([4, 4]);
    expect([atlas[1]!.width, atlas[1]!.height]).toEqual([1, 1]);
    expect([atlas[2]!.width, atlas[2]!.height]).toEqual([8, 8]);

    // pointImageIndex passes through as the same instance.
    expect(graph.calls[1]!.args[0]).toBe(indices);

    expect(diagnosticsWithCode(events, 'engine:image-channel-unavailable')).toHaveLength(0);
  });

  it('removeSlots blanks entries while keeping slot order stable', async () => {
    stubCanvas2d();
    const { engine, graph } = await mounted();
    engine.commit({
      revision: 1,
      resources: {
        imageAtlas: {
          upserts: [
            { slot: 0, bitmap: fakeBitmap(4) },
            { slot: 1, bitmap: fakeBitmap(8) },
          ],
        },
      },
    });
    graph.calls.length = 0;

    engine.commit({ revision: 2, resources: { imageAtlas: { removeSlots: [0] } } });

    expect(methodsOf(graph.calls)).toEqual(['setImageData', 'render']);
    const atlas = graph.calls[0]!.args[0] as AtlasEntry[];
    expect(atlas).toHaveLength(2); // slot indices stay stable
    expect(atlas[0]!.width).toBe(1); // blanked
    expect(atlas[1]!.width).toBe(8); // untouched image survives

    // Removing already-blank/out-of-range slots is a no-op: no atlas re-upload.
    graph.calls.length = 0;
    engine.commit({ revision: 3, resources: { imageAtlas: { removeSlots: [0, 5] } } });
    expect(methodsOf(graph.calls)).toEqual(['render']);
  });

  it('folds resources into the pending commit while lost: per-slot union, latest index wins', async () => {
    const ctx2d = stubCanvas2d();
    const { engine, graph } = await mounted();
    graph.canvas!.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));

    const bmpA = fakeBitmap(4);
    const bmpB = fakeBitmap(8);
    const bmpA2 = fakeBitmap(16);
    const idxA = new Float32Array([0, 1]);
    const idxB = new Float32Array([0, -1]);
    engine.commit({
      revision: 5,
      resources: {
        imageAtlas: {
          upserts: [
            { slot: 0, bitmap: bmpA },
            { slot: 1, bitmap: bmpB },
          ],
        },
        pointImageIndex: idxA,
      },
    });
    engine.commit({
      revision: 6,
      resources: {
        imageAtlas: { upserts: [{ slot: 0, bitmap: bmpA2 }], removeSlots: [1] },
        pointImageIndex: idxB,
      },
    });

    graph.canvas!.dispatchEvent(new Event('webglcontextrestored'));
    await flushAsync();
    const recreated = h.constructed[h.constructed.length - 1]!;
    expect(recreated).not.toBe(graph);

    // Slot 0 converted the LATEST bitmap only; slot 1's earlier pending
    // upsert was dropped by the later remove — superseded bitmaps never
    // reach the conversion canvas.
    expect(ctx2d.drawImage).toHaveBeenCalledWith(bmpA2, 0, 0);
    expect(ctx2d.drawImage).not.toHaveBeenCalledWith(bmpA, 0, 0);
    expect(ctx2d.drawImage).not.toHaveBeenCalledWith(bmpB, 0, 0);

    const uploads = recreated.calls.filter((c) => c.method === 'setImageData');
    expect(uploads).toHaveLength(1);
    const atlas = uploads[0]!.args[0] as AtlasEntry[];
    expect(atlas).toHaveLength(1);
    expect(atlas[0]!.width).toBe(16);

    const indexCalls = recreated.calls.filter((c) => c.method === 'setPointImageIndices');
    expect(indexCalls).toHaveLength(1);
    expect(indexCalls[0]!.args[0]).not.toBe(idxB); // queued resources are owned snapshots
    expect(Array.from(indexCalls[0]!.args[0] as Float32Array)).toEqual([0, -1]);

    expect(recreated.calls.filter((c) => c.method === 'render')).toHaveLength(1);
    expect(engine.appliedRevision()).toBe(6);
  });

  it('no-ops the image channel with ONE diagnostic when no 2D context exists (jsdom), never throwing', async () => {
    stubCanvas2dUnavailable();
    const { engine, events, graph } = await mounted();
    graph.calls.length = 0;

    expect(() =>
      engine.commit({
        revision: 1,
        resources: {
          imageAtlas: { upserts: [{ slot: 0, bitmap: fakeBitmap(4) }] },
          pointImageIndex: new Float32Array([0]),
        },
        config: { renderLinks: false },
      }),
    ).not.toThrow();

    // The rest of the commit still lands; the image channel no-ops entirely.
    expect(methodsOf(graph.calls)).toEqual(['setConfigPartial', 'render']);
    expect(engine.appliedRevision()).toBe(1);
    const diags = diagnosticsWithCode(events, 'engine:image-channel-unavailable');
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe('warning');

    // A later image commit stays a silent no-op: the diagnostic is one-shot.
    engine.commit({
      revision: 2,
      resources: { imageAtlas: { upserts: [{ slot: 1, bitmap: fakeBitmap(8) }] } },
    });
    expect(diagnosticsWithCode(events, 'engine:image-channel-unavailable')).toHaveLength(1);
    expect(graph.calls.filter((c) => c.method === 'setImageData')).toHaveLength(0);
    expect(graph.calls.filter((c) => c.method === 'setPointImageIndices')).toHaveLength(0);
  });
});

/**
 * stage-4 cluster force. Evidence for the honest
 * `clusterForce: true` declaration lives in the CosmosEngine capability
 * comment and README: cosmos 3.3.0's `index.d.ts` exposes setPointClusters /
 * setClusterPositions / setPointClusterStrength and `config.d.ts` the
 * `simulationCluster` coefficient.
 */
describe('CosmosEngine cluster force', () => {
  it('declares the clusterForce capability', () => {
    expect(new CosmosEngine().capabilities.clusterForce).toBe(true);
  });

  it('maps pointClusters/centers/strength onto cosmos in ONE atomic commit', async () => {
    const { engine, graph } = await mounted();
    graph.calls.length = 0;

    engine.commit({
      revision: 1,
      structure: {
        pointCount: 4,
        positions: new Float32Array([0, 0, 1, 1, 2, 2, 3, 3]),
        links: new Uint32Array([0, 1]),
      },
      config: {
        cluster: {
          // Slot 3 is unclustered (the contract's NaN).
          pointClusters: Float32Array.from([0, 0, 1, NaN]),
          centers: Float32Array.from([10, 20, 30, 40]),
          strength: 0.6,
        },
      },
    });

    expect(methodsOf(graph.calls)).toEqual([
      'setConfigPartial',
      'setPointPositions',
      'setLinks',
      'setPointClusters',
      'setClusterPositions',
      'render',
    ]);
    // The scene-wide strength is cosmos' simulationCluster config key.
    expect(graph.calls[0]!.args[0]).toEqual({ simulationCluster: 0.6 });
    // NaN → cosmos' documented `undefined` ("not in any cluster").
    expect(graph.calls[3]!.args[0]).toEqual([0, 0, 1, undefined]);
    expect(graph.calls[4]!.args[0]).toEqual([10, 20, 30, 40]);
  });

  it('cluster: null clears the force for the CURRENT roster length', async () => {
    const { engine, graph } = await mounted();
    engine.commit({
      revision: 1,
      structure: {
        pointCount: 3,
        positions: new Float32Array([0, 0, 1, 1, 2, 2]),
        links: new Uint32Array([]),
      },
      config: { cluster: { pointClusters: Float32Array.from([0, 1, 0]) } },
    });
    graph.calls.length = 0;

    engine.commit({ revision: 2, config: { cluster: null } });

    expect(methodsOf(graph.calls)).toEqual([
      'setPointClusters',
      'setClusterPositions',
      'render',
    ]);
    expect(graph.calls[0]!.args[0]).toEqual([undefined, undefined, undefined]);
    expect(graph.calls[1]!.args[0]).toEqual([]);
  });

  it('a non-finite center entry becomes undefined (centermass fallback)', async () => {
    const { engine, graph } = await mounted();
    graph.calls.length = 0;

    engine.commit({
      revision: 1,
      config: {
        cluster: {
          pointClusters: Float32Array.from([0, 1]),
          centers: Float32Array.from([5, 6, NaN, NaN]),
        },
      },
    });

    const centers = graph.calls.find((c) => c.method === 'setClusterPositions')!.args[0];
    expect(centers).toEqual([5, 6, undefined, undefined]);
  });

  it('a queued (pre-ready) cluster payload merges per channel and lands once', async () => {
    const engine = new CosmosEngine();
    engine.commit({
      revision: 1,
      config: { cluster: { pointClusters: Float32Array.from([0, 0]) }, renderLinks: false },
    });
    engine.commit({ revision: 2, config: { cluster: null } }); // latest wins

    const container = document.createElement('div');
    await engine.mount(container, makeEvents());
    const graph = h.constructed[h.constructed.length - 1]!;
    const clusterCalls = graph.calls.filter((c) => c.method === 'setPointClusters');
    expect(clusterCalls).toHaveLength(1);
    expect(clusterCalls[0]!.args[0]).toEqual([]); // no roster yet → empty clear
  });
});

describe('CosmosEngine gated activity clock', () => {
  /** Drain any pending tick budget so assertions start from true rest. */
  function drain(fake: ReturnType<typeof installFakeRaf>): void {
    for (let i = 0; i < 10 && fake.pendingCount() > 0; i += 1) fake.fire(1000 + i);
    expect(fake.pendingCount()).toBe(0);
  }

  it('the mount burst drains and the clock STOPS — no rAF at rest', async () => {
    const fake = installFakeRaf();
    const { events } = await mounted();
    expect(fake.pendingCount()).toBe(1); // mount burst scheduled
    drain(fake);
    // Nothing re-arms on its own: rest means zero registrations.
    const registrationsAtRest = fake.raf.mock.calls.length;
    expect(fake.pendingCount()).toBe(0);
    expect(fake.raf.mock.calls.length).toBe(registrationsAtRest);
    expect(events.onFrame).toHaveBeenCalled(); // the burst itself delivered
  });

  it('every visual write at rest re-arms >= 1 tick and re-freezes', async () => {
    const fake = installFakeRaf();
    const { engine, graph } = await mounted();
    drain(fake);

    const writes: Array<[string, () => void]> = [
      ['commit', () => engine.commit({ revision: 9, buffers: { pointSize: new Float32Array([3]) } })],
      ['setSelectedIndices', () => engine.setSelectedIndices([1])],
      ['setFocusedIndex', () => engine.setFocusedIndex(2)],
      ['setPinnedIndices', () => engine.setPinnedIndices([0])],
      ['setViewport', () => engine.setViewport({ zoom: 2 })],
      ['fitView', () => engine.fitView()],
      ['zoom', () => engine.zoom(1.5)],
      ['zoomToIndex', () => engine.zoomToIndex(1)],
      ['hover', () => graph.config.onPointMouseOver?.(3, [0, 0] as never)],
    ];
    for (const [label, write] of writes) {
      write();
      expect(fake.pendingCount(), `${label} must re-arm the clock`).toBeGreaterThan(0);
      drain(fake); // …and the burst must drain back to rest
    }
  });

  it('simulation lifecycle HOLDS the clock; end releases it after one trailing tick', async () => {
    const fake = installFakeRaf();
    const { engine, events, graph } = await mounted();
    drain(fake);

    engine.start();
    // Held: every fired tick reschedules the next.
    fake.fire(1);
    fake.fire(2);
    fake.fire(3);
    expect(fake.pendingCount()).toBe(1);

    graph.config.onSimulationEnd?.();
    expect(events.onSimulationEnd).toHaveBeenCalledTimes(1);
    drain(fake); // trailing tick(s) drain, then silence
  });

  it('drag gestures hold the clock; release drains after the trailing tick', async () => {
    const fake = installFakeRaf();
    const { graph } = await mounted();
    drain(fake);

    graph.store.draggingPointIndex = 4;
    graph.config.onDragStart?.({} as never);
    fake.fire(1);
    fake.fire(2);
    expect(fake.pendingCount()).toBe(1); // held by the drag reason

    graph.config.onDragEnd?.({ x: 10, y: 10 } as never);
    drain(fake);
  });

  it('zoom events grant self-sustaining bursts, not a held reason', async () => {
    const fake = installFakeRaf();
    const { graph } = await mounted();
    drain(fake);

    graph.config.onZoom?.({} as never, false);
    expect(fake.pendingCount()).toBe(1);
    fake.fire(1);
    fake.fire(2);
    expect(fake.pendingCount()).toBe(0); // burst drained — no leak
  });

  it('a tick requested INSIDE onFrame is honored next frame (decrement-before-deliver)', async () => {
    const fake = installFakeRaf();
    const { engine, events } = await mounted();
    drain(fake);

    let rearmed = false;
    events.onFrame.mockImplementation(() => {
      if (!rearmed) {
        rearmed = true;
        engine.setFocusedIndex(1); // wake from inside the callback
      }
    });
    engine.setSelectedIndices([0]);
    fake.fire(1); // delivers onFrame, which re-arms mid-tick
    expect(fake.pendingCount()).toBe(1);
    drain(fake);
    events.onFrame.mockImplementation(() => undefined);
  });

  it('a throwing onFrame callback cannot kill a held clock', async () => {
    const fake = installFakeRaf();
    const { engine, events } = await mounted();
    drain(fake);

    engine.start();
    events.onFrame.mockImplementation(() => {
      throw new Error('host bug');
    });
    expect(() => fake.fire(1)).toThrow('host bug');
    expect(fake.pendingCount()).toBe(1); // rescheduled BEFORE delivery
    events.onFrame.mockImplementation(() => undefined);
    engine.pause();
    drain(fake);
  });

  it('context loss clears reasons and ticks; restore re-arms a fresh burst', async () => {
    const fake = installFakeRaf();
    const { engine } = await mounted();
    const graph = h.constructed[h.constructed.length - 1]!;
    drain(fake);

    engine.start(); // held
    fake.fire(1);
    expect(fake.pendingCount()).toBe(1);

    graph.canvas!.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(fake.pendingCount()).toBe(0); // stopped AND reasons cleared

    graph.canvas!.dispatchEvent(new Event('webglcontextrestored'));
    await flushAsync();
    expect(fake.pendingCount()).toBe(1); // restore burst (fresh graph, paused)
    fake.fire(2);
    fake.fire(3);
    expect(fake.pendingCount()).toBe(0); // NOT held: the sim reason died with the context
  });

  it('initialConfig callback overrides COMPOSE with the clock wiring, never clobber it', async () => {
    // The escape hatch merges last, so a caller
    // supplying its own lifecycle callbacks used to silently sever the
    // gated clock's wake/sleep wiring (and the host event channels).
    const fake = installFakeRaf();
    const callerSaw: string[] = [];
    const { engine, events, graph } = await mounted({
      initialConfig: {
        onSimulationStart: () => callerSaw.push('sim-start'),
        onSimulationEnd: () => callerSaw.push('sim-end'),
        onZoom: () => callerSaw.push('zoom'),
      } as never,
    });
    drain(fake);

    // The adapter's wiring still runs: sim-start HOLDS the clock…
    graph.config.onSimulationStart?.();
    fake.fire(1);
    fake.fire(2);
    expect(fake.pendingCount()).toBe(1);
    // …sim-end releases it and still forwards the host event…
    graph.config.onSimulationEnd?.();
    expect(events.onSimulationEnd).toHaveBeenCalledTimes(1);
    drain(fake);
    // …zoom still re-arms and still emits the viewport change…
    graph.config.onZoom?.({} as never, false);
    expect(fake.pendingCount()).toBeGreaterThan(0);
    drain(fake);
    // …and the caller's own callbacks all fired too.
    expect(callerSaw).toEqual(['sim-start', 'sim-end', 'zoom']);
    void engine;
  });

  it('captureScreenshot at rest wakes cosmos with render() before the capture tick', async () => {
    const fake = installFakeRaf();
    const { engine, graph } = await mounted();
    drain(fake);
    graph.calls.length = 0;

    const capture = engine.captureScreenshot();
    expect(graph.calls.some((c) => c.method === 'render')).toBe(true);
    expect(fake.pendingCount()).toBeGreaterThan(0); // the capture rAF
    drain(fake);
    await expect(capture).resolves.toBeNull(); // jsdom has no 2D pixel backend
  });
});
