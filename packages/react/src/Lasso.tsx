/**
 * Lasso — the Shift+drag freeform selection overlay.
 *
 * A transparent div rendered above the engine canvas that captures pointer
 * events ONLY while Shift is held (or a lasso drag is already in progress);
 * otherwise `pointer-events: none` so it never intercepts canvas interaction.
 *
 * Gesture: pointerdown starts capture; pointermove appends polygon points
 * throttled to at most one per animation frame (leading edge + trailing
 * commit); an SVG path previews the polygon; pointerup with ≥3 points calls
 * `instance.selectWithinPolygon(polygon, { additive: metaKey })`. Abort paths
 * (pointercancel, Escape, unmount) always release capture and leave no state.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { useAmbientGraphInstance } from './GraphProvider';

interface DragState {
  pointerId: number;
  /** Committed polygon vertices (overlay-local screen coordinates). */
  points: [number, number][];
  /** Latest uncommitted pointer position (throttle window open). */
  pending: [number, number] | null;
  /** Scheduled animation frame id; null when no frame is pending. */
  frame: number | null;
}

const OVERLAY_BASE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  touchAction: 'none',
  userSelect: 'none',
};

const OVERLAY_INACTIVE: CSSProperties = { ...OVERLAY_BASE, pointerEvents: 'none' };
const OVERLAY_ACTIVE: CSSProperties = {
  ...OVERLAY_BASE,
  pointerEvents: 'auto',
  cursor: 'crosshair',
};

const SVG_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
  overflow: 'visible',
};

function toPathData(points: readonly [number, number][]): string {
  let d = `M ${points[0]![0]} ${points[0]![1]}`;
  for (let i = 1; i < points.length; i++) d += ` L ${points[i]![0]} ${points[i]![1]}`;
  return points.length >= 3 ? `${d} Z` : d;
}

/** rAF when available; otherwise run synchronously (headless environments
 * throttling degrades to per-event appends, which is still correct). */
function scheduleFrame(cb: () => void): number | null {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
  cb();
  return null;
}

function cancelFrame(id: number | null): void {
  if (id !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
}

/** Guarded pointer capture: jsdom (and older engines) may not implement it. */
function capturePointer(el: HTMLElement, pointerId: number): void {
  if (typeof el.setPointerCapture === 'function') {
    try {
      el.setPointerCapture(pointerId);
    } catch {
      /* capture unavailable for this pointer — the gesture still works */
    }
  }
}

function releasePointer(el: HTMLElement, pointerId: number): void {
  if (typeof el.releasePointerCapture === 'function') {
    try {
      el.releasePointerCapture(pointerId);
    } catch {
      /* no active capture — already released */
    }
  }
}

/** Internal to <Graph> (gated by its `enableLasso` prop); reads the ambient
 * instance so advanced hosts composing GraphProvider directly can reuse it. */
export function Lasso(): ReactElement {
  const instance = useAmbientGraphInstance('Lasso');
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [shiftHeld, setShiftHeld] = useState(false);
  /** Render mirror of the committed polygon; null = no drag in progress. */
  const [preview, setPreview] = useState<readonly [number, number][] | null>(null);

  /** Tear down the in-progress drag: cancel the pending frame, release
   * capture, clear all drag state. Safe to call when idle. */
  const releaseDrag = useCallback((): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    dragRef.current = null;
    cancelFrame(drag.frame);
    const el = overlayRef.current;
    if (el !== null) releasePointer(el, drag.pointerId);
    setPreview(null);
  }, []);

  // Shift tracking + Escape abort. Window-level so the overlay activates
  // before it can receive any pointer event; blur releases a stuck Shift.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Shift') setShiftHeld(true);
      else if (e.key === 'Escape') releaseDrag();
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'Shift') setShiftHeld(false);
    };
    const onBlur = (): void => setShiftHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      releaseDrag(); // unmount mid-drag leaves no capture and no frame
    };
  }, [releaseDrag]);

  const localPoint = (e: ReactPointerEvent<HTMLDivElement>): [number, number] => {
    const el = overlayRef.current;
    if (el === null) return [e.clientX, e.clientY];
    const rect = el.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const commitPending = (drag: DragState): void => {
    if (drag.pending === null) return;
    drag.points.push(drag.pending);
    drag.pending = null;
    setPreview([...drag.points]);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current !== null || e.button !== 0) return;
    // Lasso is a Shift gesture: the overlay only receives events while Shift
    // is held, but re-check for robustness (tests, synthetic dispatch).
    if (!e.shiftKey && !shiftHeld) return;
    const pointerId = e.pointerId ?? -1;
    const el = overlayRef.current;
    if (el !== null) capturePointer(el, pointerId);
    const p = localPoint(e);
    dragRef.current = { pointerId, points: [p], pending: null, frame: null };
    setPreview([p]);
    e.preventDefault();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || (e.pointerId ?? -1) !== drag.pointerId) return;
    drag.pending = localPoint(e);
    if (drag.frame !== null) return; // throttle window open — coalesce
    // Leading edge: append immediately, then hold the window one frame at a
    // time while moves keep streaming in (trailing commit per frame).
    commitPending(drag);
    const tick = (): void => {
      drag.frame = null;
      if (dragRef.current !== drag) return; // drag ended while scheduled
      if (drag.pending !== null) {
        commitPending(drag);
        drag.frame = scheduleFrame(tick);
      }
    };
    drag.frame = scheduleFrame(tick);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || (e.pointerId ?? -1) !== drag.pointerId) return;
    commitPending(drag); // the trailing point must land in the polygon
    const polygon = drag.points;
    const additive = e.metaKey;
    releaseDrag();
    if (polygon.length >= 3) instance.selectWithinPolygon(polygon, { additive });
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || (e.pointerId ?? -1) !== drag.pointerId) return;
    releaseDrag();
  };

  const active = shiftHeld || preview !== null;
  return (
    <div
      ref={overlayRef}
      data-orbit-lasso=""
      style={active ? OVERLAY_ACTIVE : OVERLAY_INACTIVE}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {preview !== null && preview.length > 0 ? (
        <svg data-orbit-lasso-preview="" style={SVG_STYLE}>
          <path
            d={toPathData(preview)}
            fill="rgba(88, 134, 255, 0.12)"
            stroke="rgba(88, 134, 255, 0.9)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
        </svg>
      ) : null}
    </div>
  );
}
