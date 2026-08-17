/**
 * <GraphMinimap> minimap tests (jsdom + FakeEngine + real
 * core).
 *
 * jsdom has no real 2d canvas: `HTMLCanvasElement.getContext` is stubbed with
 * a RECORDED context so the blit lane is observable. Covers: the CPU-fallback
 * blit (OverviewController.rasterize → putImageData) over declared node
 * positions, the decoupled viewport-rectangle lane (O(1) CSS transform per
 * store.viewport publication — NO re-rasterize, spied via
 * OverviewController.prototype.rasterize), and click-to-pan through
 * `minimapToWorld` → `instance.setViewport` (REAL camera pan, FakeEngine
 * recorded).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { createGraphInstance, OverviewController } from '@modernrelay/orbit-core';
import type { GraphInstance, GraphSnapshot } from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { GraphProvider } from '../src/GraphProvider';
import { GraphMinimap } from '../src/components/Minimap/index';

// --- fixtures ---------------------------------------------------------------

/** Four declared-position corners spanning world (0,0)–(10,10). */
const positionedSnapshot: GraphSnapshot = {
  datasetKey: 'minimap-fixture',
  sourceRevision: 1,
  nodes: [
    { id: 'n0', x: 0, y: 0 },
    { id: 'n1', x: 10, y: 0 },
    { id: 'n2', x: 0, y: 10 },
    { id: 'n3', x: 10, y: 10 },
  ],
  edges: [{ source: 'n0', target: 'n3' }],
};

// --- recorded 2d context stub (jsdom has no canvas implementation) ----------

interface RecordedContext {
  putImageData: ReturnType<typeof vi.fn>;
  clearRect: ReturnType<typeof vi.fn>;
}

let ctx2d: RecordedContext;

/** jsdom ships no ImageData either — a structural stand-in the recorded
 * context receives verbatim. */
class StubImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

beforeEach(() => {
  ctx2d = { putImageData: vi.fn(), clearRect: vi.fn() };
  vi.stubGlobal('ImageData', StubImageData);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ctx2d as unknown as CanvasRenderingContext2D,
  );
});

// --- harness ----------------------------------------------------------------

const instances: GraphInstance[] = [];
const hosts: HTMLElement[] = [];

async function setup(size = 40): Promise<{
  instance: GraphInstance;
  engine: FakeEngine;
  view: RenderResult;
  canvas: HTMLCanvasElement;
  rect: HTMLDivElement;
}> {
  const engine = new FakeEngine();
  const instance = createGraphInstance({ engine: () => engine });
  instances.push(instance);
  instance.applyHostUpdate({ data: positionedSnapshot });

  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  await instance.attach(host);

  const view = render(
    <GraphProvider instance={instance}>
      <GraphMinimap size={size} />
    </GraphProvider>,
  );
  const canvas = view.container.querySelector<HTMLCanvasElement>('[data-orbit-minimap-canvas]');
  const rect = view.container.querySelector<HTMLDivElement>('[data-orbit-minimap-viewport]');
  if (canvas === null || rect === null) throw new Error('minimap not rendered');
  return { instance, engine, view, canvas, rect };
}

/** The exact mapping the component owns: an identically configured
 * controller over the same declared-position scene. */
function referenceController(size: number): OverviewController {
  const positions = Float32Array.from([0, 0, 10, 0, 0, 10, 10, 10]);
  const c = new OverviewController({ getScene: () => ({ positions, count: 4 }), size });
  if (c.rasterize() === null) throw new Error('reference rasterize failed');
  return c;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const instance of instances) instance.destroy();
  instances.length = 0;
  for (const host of hosts) host.remove();
  hosts.length = 0;
});

// --- tests ------------------------------------------------------------------

describe('<GraphMinimap> thumbnail blit', () => {
  it('blits the CPU-fallback raster of declared node positions into the canvas', async () => {
    const { canvas } = await setup(40);

    expect(canvas.width).toBe(40);
    expect(canvas.height).toBe(40);
    expect(ctx2d.putImageData).toHaveBeenCalledTimes(1);

    const image = ctx2d.putImageData.mock.calls[0]![0] as ImageData;
    expect(image.width).toBe(40);
    expect(image.height).toBe(40);
    // Four corner dots rasterized: exactly 4 lit pixels, correct alpha lane.
    let lit = 0;
    for (let i = 3; i < image.data.length; i += 4) {
      if (image.data[i]! > 0) lit++;
    }
    expect(lit).toBe(4);
    // Blit lands at the origin (full-thumbnail replace).
    expect(ctx2d.putImageData.mock.calls[0]![1]).toBe(0);
    expect(ctx2d.putImageData.mock.calls[0]![2]).toBe(0);
  });

  it('renders an empty thumbnail (no blit) when no node declares a position', async () => {
    const engine = new FakeEngine();
    const instance = createGraphInstance({ engine: () => engine });
    instances.push(instance);
    instance.applyHostUpdate({
      data: {
        datasetKey: 'unpositioned',
        sourceRevision: 1,
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [],
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    hosts.push(host);
    await instance.attach(host);
    render(
      <GraphProvider instance={instance}>
        <GraphMinimap />
      </GraphProvider>,
    );
    expect(ctx2d.putImageData).not.toHaveBeenCalled();
    expect(ctx2d.clearRect).toHaveBeenCalled();
  });
});

describe('<GraphMinimap> viewport rectangle lane', () => {
  it('updates the rect transform O(1) per viewport publication without re-rasterizing', async () => {
    // Reference mapping computed BEFORE the spy so it never inflates counts.
    const [cx, cy] = referenceController(40).worldToMinimap(5, 5)!;
    const rasterizeSpy = vi.spyOn(OverviewController.prototype, 'rasterize');
    const { engine, rect } = await setup(40);

    const blits = rasterizeSpy.mock.calls.length; // the mount blit
    expect(blits).toBeGreaterThan(0);

    act(() => {
      engine.injectViewportChange({ x: 5, y: 5, zoom: 2 });
    });
    expect(rect.style.display).toBe('block');
    const first = rect.style.transform;
    // World center (5,5) → thumbnail center (jsdom hosts are zero-size, so
    // the rect degrades to the MIN_RECT_PX marker around the mapped center).
    expect(first).toBe(`translate3d(${cx - 3}px, ${cy - 3}px, 0)`);

    act(() => {
      engine.injectViewportChange({ x: 10, y: 0, zoom: 2 });
    });
    expect(rect.style.transform).not.toBe(first);
    // The rect lane NEVER re-rasterizes.
    expect(rasterizeSpy.mock.calls.length).toBe(blits);
  });
});

/** jsdom has no PointerEvent: dispatch MouseEvents with pointer TYPES (the
 * same native event names React's onPointer* handlers listen for), which
 * carry real clientX/clientY. */
function firePointer(el: Element, type: string, x: number, y: number, pointerId = 1): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  fireEvent(
    el,
    event,
  );
}

describe('<GraphMinimap> click/drag pan', () => {
  it('pointer down pans the main camera via minimapToWorld → setViewport', async () => {
    const { instance, engine, canvas } = await setup(40);
    const setViewportSpy = vi.spyOn(instance, 'setViewport');

    // jsdom bounding rects are zero-size → client px map 1:1 to raster px.
    firePointer(canvas, 'pointerdown', 20, 20);

    expect(setViewportSpy).toHaveBeenCalledTimes(1);
    const arg = setViewportSpy.mock.calls[0]![0] as { x: number; y: number };
    const [wx, wy] = referenceController(40).minimapToWorld(20, 20)!;
    expect(arg.x).toBeCloseTo(wx, 10);
    expect(arg.y).toBeCloseTo(wy, 10);
    // The pan reached the engine camera (REAL setViewport).
    const cam = engine.cameraCalls.filter((c) => c.method === 'setViewport');
    expect(cam.length).toBe(1);
    expect((cam[0]!.args[0] as { x: number }).x).toBeCloseTo(wx, 10);
  });

  it('dragging keeps panning; release stops', async () => {
    const { instance, canvas } = await setup(40);
    const setViewportSpy = vi.spyOn(instance, 'setViewport');

    firePointer(canvas, 'pointerdown', 10, 10);
    firePointer(canvas, 'pointermove', 12, 12);
    firePointer(canvas, 'pointermove', 14, 14);
    expect(setViewportSpy).toHaveBeenCalledTimes(3);

    firePointer(canvas, 'pointerup', 15, 15);
    firePointer(canvas, 'pointermove', 20, 20);
    expect(setViewportSpy).toHaveBeenCalledTimes(3); // no pan after release
  });

  it.each(['pointercancel', 'lostpointercapture'])(
    '%s terminates the owning drag',
    async (terminalEvent) => {
      const { instance, canvas } = await setup(40);
      const setViewportSpy = vi.spyOn(instance, 'setViewport');

      firePointer(canvas, 'pointerdown', 10, 10, 7);
      firePointer(canvas, terminalEvent, 10, 10, 7);
      firePointer(canvas, 'pointermove', 20, 20, 7);

      expect(setViewportSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('only the pointer that started a drag may move or terminate it', async () => {
    const { instance, canvas } = await setup(40);
    const setViewportSpy = vi.spyOn(instance, 'setViewport');

    firePointer(canvas, 'pointerdown', 10, 10, 7);
    firePointer(canvas, 'pointermove', 20, 20, 8); // unrelated move
    firePointer(canvas, 'pointerup', 20, 20, 8); // unrelated release
    firePointer(canvas, 'pointerdown', 20, 20, 8); // cannot steal ownership
    expect(setViewportSpy).toHaveBeenCalledTimes(1);

    firePointer(canvas, 'pointermove', 14, 14, 7);
    expect(setViewportSpy).toHaveBeenCalledTimes(2);
    firePointer(canvas, 'pointerup', 14, 14, 7);
    firePointer(canvas, 'pointermove', 18, 18, 7);
    expect(setViewportSpy).toHaveBeenCalledTimes(2);
  });
});
