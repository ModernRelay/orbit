/**
 * `@modernrelay/orbit-react/components/Minimap` — `<GraphMinimap>`, the
 * whole-graph thumbnail + viewport rectangle.
 *
 * v0.9 is CPU-fallback-only (no engine exposes `capabilities.overviewPass`
 * cosmos matrix): the component owns an {@link OverviewController} and
 * blits its `rasterize` output into a small canvas via `putImageData`. The
 * three lanes stay strictly decoupled:
 *
 * 1. **Thumbnail refresh** — a 500 ms `setInterval` probes the controller's
 * `shouldRefresh(now, simulationRunning, epoch)` gate, so the effective
 * cadence is the controller's spec budget (≤ 2 Hz hot, ≤ 1 Hz idle, zero
 * work idle-with-unchanged-epoch) and each `true` is followed by exactly
 * one `rasterize` + blit. The interval — not a per-frame engine lane —
 * is the documented v0.9 cadence: the `onFrame` fan-out only reaches
 * React through the label lane, which is gated on labels being enabled,
 * so a plain timer is the correct always-on ≤ 2 Hz driver. The epoch is
 * `revisions.render` (a positions-bearing superset — over-approximate but
 * bounded by the same throttle).
 * 2. **Viewport rectangle** — an imperative store subscription writes the
 * rect's transform/size O(1) per `store.viewport` publication (CSS
 * transform on a ref; no React re-render, no re-rasterize).
 * 3. **Pan** — pointer down/drag maps minimap px → world via the
 * controller's `minimapToWorld` (exact inverse over the last rasterized
 * frame) and calls `instance.setViewport({x, y})` — real camera pans.
 *
 * Scene source (documented v0.9 trim): the instance does not yet expose the
 * posBuf mirror (reserved for the columnar lane), so the
 * component probes a pinned structural seam `getOverviewScene` first
 * (optional access — picked up automatically once core lands
 * it) and falls back to the DECLARED node positions (`GraphNode.x/y`) of the
 * current scene roster — exact for prepared/fixed-position datasets from
 * orbit-data, and empty for force layouts without a position mirror.
 * Position-less nodes rasterize as NaN tombstones (skipped); mask-hidden nodes draw dimmed
 * via `getVisible`.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { OverviewController, OVERVIEW_HOT_INTERVAL_MS } from '@modernrelay/orbit-core';
import type { NodeId, OverviewScene, ViewportState } from '@modernrelay/orbit-core';
import type { AnyGraphInstance } from '../../GraphProvider';
import { cornerStyle, mergeStyle, useResolvedInstance } from '../shared';
import type { GraphCorner } from '../shared';

/** Default thumbnail edge (px) — the component default; the CPU target
 * default (256²) applies when a caller constructs a bare controller. */
const SIZE_DEFAULT = 200;

/** Minimum rendered viewport-rect edge so a tiny/degenerate viewport stays
 * visible as a marker. */
const MIN_RECT_PX = 6;

/** Pinned structural seam: the instance-side
 * posBuf mirror read. Optional access until core lands it — this view
 * stays signature-compatible when the member becomes required. */
interface OverviewSceneSurface {
  getOverviewScene?(): OverviewScene | null;
}

export interface GraphMinimapProps {
  /** Explicit instance (multi-instance pages); ambient context otherwise. */
  instance?: AnyGraphInstance;
  /** Square thumbnail edge in CSS px (also the raster resolution). Default 200. */
  size?: number;
  /** Accessible name. Default 'Graph minimap'. */
  label?: string;
  /** Corner this panel anchors to. Default 'bottom-right'. */
  position?: GraphCorner;
  /** Distance from the two anchored edges in CSS px. Default 12. */
  offset?: number;
  /** Class hook for the root; providing it drops the default styles
   * INCLUDING placement — position it yourself in CSS. */
  className?: string;
  /** Style overrides merged over the defaults; an inset you set here
   * wins over the one `position` implies (resolved per axis). */
  style?: CSSProperties;
}

const ROOT_STYLE: CSSProperties = {
  pointerEvents: 'auto',
  overflow: 'hidden',
  borderRadius: 8,
  background: 'rgba(23, 25, 32, 0.85)',
  border: '1px solid rgba(255, 255, 255, 0.14)',
};

const CANVAS_STYLE: CSSProperties = {
  display: 'block',
  cursor: 'crosshair',
  touchAction: 'none',
};

const RECT_STYLE: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  display: 'none',
  border: '1px solid rgba(255, 255, 255, 0.85)',
  background: 'rgba(255, 255, 255, 0.12)',
  pointerEvents: 'none',
  willChange: 'transform',
  boxSizing: 'border-box',
};

/** Declared-position scene over the current roster, cached by the roster's
 * identity (`scene.idByIndex` is a stable reference per reconciled scene). */
interface DeclaredSceneCache {
  ids: readonly NodeId[];
  scene: OverviewScene | null;
}

export function GraphMinimap(props: GraphMinimapProps): ReactElement {
  const instance = useResolvedInstance(props.instance, '<GraphMinimap>');
  const size = props.size ?? SIZE_DEFAULT;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rectRef = useRef<HTMLDivElement | null>(null);
  /** Pointer that owns the current pan gesture. Other simultaneous pointers
   * cannot move or terminate it. */
  const draggingPointerRef = useRef<number | null>(null);
  const declaredSceneRef = useRef<DeclaredSceneCache>({ ids: [], scene: null });
  /** mask lane for `getVisible`, recomputed once per refresh tick. */
  const visibleRef = useRef<{ ids: readonly NodeId[]; set: ReadonlySet<NodeId> | null }>({
    ids: [],
    set: null,
  });

  const controller = useMemo(() => {
    const getScene = (): OverviewScene | null => {
      // 1. Pinned core seam: the posBuf mirror, once it lands.
      const mirrored = (instance as unknown as OverviewSceneSurface).getOverviewScene?.();
      if (mirrored !== undefined) return mirrored;
      // 2. v0.9 fallback: declared node positions over the scene roster.
      const ids = instance.getSceneNodeIds();
      if (ids.length === 0) return null;
      const cache = declaredSceneRef.current;
      if (cache.ids === ids) return cache.scene;
      const positions = new Float32Array(2 * ids.length);
      let known = 0;
      for (let i = 0; i < ids.length; i++) {
        const node = instance.getNode(ids[i]!);
        const x = node?.x;
        const y = node?.y;
        if (typeof x === 'number' && typeof y === 'number') {
          positions[2 * i] = x;
          positions[2 * i + 1] = y;
          known++;
        } else {
          positions[2 * i] = NaN;
          positions[2 * i + 1] = NaN;
        }
      }
      const scene: OverviewScene | null = known > 0 ? { positions, count: ids.length } : null;
      declaredSceneRef.current = { ids, scene };
      return scene;
    };
    const getVisible = (index: number): boolean => {
      const v = visibleRef.current;
      if (v.set === null) return true;
      const id = v.ids[index];
      return id === undefined ? true : v.set.has(id);
    };
    return new OverviewController({ getScene, getVisible, size });
  }, [instance, size]);

  /** O(1) rect update from the store viewport over the LAST rasterized frame.
   * `zoom` is screen px per space unit; the world extent in view is the
   * host container's CSS size / zoom — measured from the positioned ancestor
   * (the <Graph> container). Zero-size hosts (jsdom/unmounted) degrade to a
   * MIN_RECT_PX center marker. */
  const updateRect = (v: ViewportState | null): void => {
    const rect = rectRef.current;
    if (rect === null) return;
    if (v === null || v.zoom <= 0) {
      rect.style.display = 'none';
      return;
    }
    const host = rootRef.current?.offsetParent;
    const hostW = host instanceof HTMLElement ? host.clientWidth : 0;
    const hostH = host instanceof HTMLElement ? host.clientHeight : 0;
    const halfW = hostW > 0 ? hostW / v.zoom / 2 : 0;
    const halfH = hostH > 0 ? hostH / v.zoom / 2 : 0;
    // Two opposite world corners (world y grows up, minimap y grows down).
    const a = controller.worldToMinimap(v.x - halfW, v.y + halfH);
    const b = controller.worldToMinimap(v.x + halfW, v.y - halfH);
    if (a === null || b === null) {
      rect.style.display = 'none'; // nothing rasterized yet
      return;
    }
    const w = Math.max(Math.abs(b[0] - a[0]), MIN_RECT_PX);
    const h = Math.max(Math.abs(b[1] - a[1]), MIN_RECT_PX);
    const x = (a[0] + b[0]) / 2 - w / 2;
    const y = (a[1] + b[1]) / 2 - h / 2;
    rect.style.display = 'block';
    rect.style.width = `${w}px`;
    rect.style.height = `${h}px`;
    rect.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };

  // Lane 1: thumbnail refresh — interval-probed controller throttle.
  useEffect(() => {
    const blit = (): void => {
      const state = instance.store.getState();
      // mask lane for the dimmed-alpha rasterization.
      if (state.visible.nodes !== state.nodeCount || state.hiddenNodeIds.size > 0) {
        const ids = instance.getSceneNodeIds();
        visibleRef.current = { ids, set: new Set(instance.getVisibleNodeIds()) };
      } else {
        visibleRef.current = { ids: [], set: null };
      }
      const raster = controller.rasterize();
      const canvas = canvasRef.current;
      if (canvas === null) return;
      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      if (raster === null) {
        ctx.clearRect(0, 0, size, size);
        updateRect(null);
        return;
      }
      if (typeof ImageData === 'undefined') return; // non-DOM environment
      // Copy: ImageData requires a plain-ArrayBuffer-backed clamped array.
      const pixels = new Uint8ClampedArray(raster.bitmap);
      ctx.putImageData(new ImageData(pixels, controller.size, controller.size), 0, 0);
      // A fresh frame can move the world→minimap mapping: re-derive the rect.
      updateRect(instance.store.getState().viewport);
    };
    const tick = (): void => {
      const state = instance.store.getState();
      // `revisions.render` is the v0.9 positions epoch (see module JSDoc):
      // idle with an unchanged render revision is provably position-stable.
      if (!controller.shouldRefresh(Date.now(), state.simulationRunning, state.revisions.render)) {
        return;
      }
      blit();
    };
    tick(); // first paint without waiting a full interval
    const timer = setInterval(tick, OVERVIEW_HOT_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
    // updateRect is stable for each (instance, controller) pair — refs + controller
    // only — so it is deliberately not a dependency (this repo does not
    // configure the react-hooks lint plugin).
  }, [instance, controller, size]);

  // Lane 2: viewport rectangle — imperative store subscription, O(1) per
  // viewport publication, no re-rasterize and no React re-render.
  useEffect(() => {
    let prev = instance.store.getState().viewport;
    updateRect(prev);
    return instance.store.subscribe(() => {
      const next = instance.store.getState().viewport;
      if (next === prev) return;
      prev = next;
      updateRect(next);
    });
    // updateRect deliberately not a dependency (see the refresh effect above).
  }, [instance, controller]);

  // Lane 3: pan. Down pans immediately; move keeps panning while dragging.
  const panTo = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const b = canvas.getBoundingClientRect();
    // Canvas CSS size vs raster size (zero-size rects — jsdom — map 1:1).
    const sx = b.width > 0 ? controller.size / b.width : 1;
    const sy = b.height > 0 ? controller.size / b.height : 1;
    const world = controller.minimapToWorld((e.clientX - b.left) * sx, (e.clientY - b.top) * sy);
    if (world === null) return; // nothing rasterized yet — nothing to map
    instance.setViewport({ x: world[0], y: world[1] });
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const owner = draggingPointerRef.current;
    if (owner !== null && owner !== e.pointerId) return;
    e.preventDefault();
    draggingPointerRef.current = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer capture unavailable (jsdom/legacy) */
    }
    panTo(e);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (draggingPointerRef.current !== e.pointerId) return;
    panTo(e);
  };

  const endDrag = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (draggingPointerRef.current !== e.pointerId) return;
    draggingPointerRef.current = null;
  };

  return (
    <div
      ref={rootRef}
      data-orbit-minimap=""
      role="group"
      aria-label={props.label ?? 'Graph minimap'}
      className={props.className}
      style={
        props.className !== undefined
          ? // The thumbnail is MECHANICAL, not decorative: dropping its box
            // would collapse the canvas, so size survives the class hook.
            { width: size, height: size, ...props.style }
          : mergeStyle(
              {
                ...cornerStyle(props.position ?? 'bottom-right', props.offset),
                ...ROOT_STYLE,
                width: size,
                height: size,
              },
              props.style,
            )
      }
    >
      <canvas
        ref={canvasRef}
        data-orbit-minimap-canvas=""
        width={size}
        height={size}
        style={CANVAS_STYLE}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onPointerLeave={endDrag}
      />
      <div ref={rectRef} data-orbit-minimap-viewport="" style={RECT_STYLE} />
    </div>
  );
}
