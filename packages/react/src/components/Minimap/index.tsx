/**
 * Whole-graph thumbnail + viewport rectangle. Core owns the shared live
 * position cache; the CPU rasterizer paints at most 2 Hz hot / 1 Hz idle
 * after a change. Cache notifications and a bounded timer drive thumbnail
 * refresh; viewport changes move only the rectangle. No per-frame readback.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { OverviewController, OVERVIEW_HOT_INTERVAL_MS } from '@modernrelay/orbit-core';
import type { NodeId, ViewportState } from '@modernrelay/orbit-core';
import type { AnyGraphInstance } from '../../GraphProvider';
import { cornerStyle, mergeStyle, useResolvedInstance } from '../shared';
import type { GraphCorner } from '../shared';

/** Default thumbnail edge (px) — the component default; the CPU target
 * default (256²) applies when a caller constructs a bare controller. */
const SIZE_DEFAULT = 200;

/** Minimum rendered viewport-rect edge so a tiny/degenerate viewport stays
 * visible as a marker. */
const MIN_RECT_PX = 6;

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

export function GraphMinimap(props: GraphMinimapProps): ReactElement {
  const instance = useResolvedInstance(props.instance, '<GraphMinimap>');
  const size = props.size ?? SIZE_DEFAULT;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rectRef = useRef<HTMLDivElement | null>(null);
  /** Pointer that owns the current pan gesture. Other simultaneous pointers
   * cannot move or terminate it. */
  const draggingPointerRef = useRef<number | null>(null);
  /** mask lane for `getVisible`, recomputed once per refresh tick. */
  const visibleRef = useRef<{ ids: readonly NodeId[]; set: ReadonlySet<NodeId> | null }>({
    ids: [],
    set: null,
  });

  const controller = useMemo(() => {
    const getVisible = (index: number): boolean => {
      const v = visibleRef.current;
      if (v.set === null) return true;
      const id = v.ids[index];
      return id === undefined ? true : v.set.has(id);
    };
    return new OverviewController({ getScene: () => instance.getOverviewScene(), getVisible, size });
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
    let lastSnapshot = instance.getOverviewScene();
    let lastRender = instance.store.getState().revisions.render;
    let epoch = 0;
    const tick = (): void => {
      const state = instance.store.getState();
      const snapshot = instance.getOverviewScene();
      // Position samples have their own epoch: a settle/drag need not commit
      // a new render revision. Render changes also invalidate mask shading.
      if (snapshot !== lastSnapshot || state.revisions.render !== lastRender) {
        lastSnapshot = snapshot;
        lastRender = state.revisions.render;
        epoch += 1;
      }
      if (!controller.shouldRefresh(Date.now(), state.simulationRunning, epoch)) {
        return;
      }
      blit();
    };
    const unsubscribePositions = instance.subscribeOverview(tick); // includes first paint
    const unsubscribeStore = instance.store.subscribe(tick);
    const timer = setInterval(tick, OVERVIEW_HOT_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      unsubscribePositions();
      unsubscribeStore();
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
