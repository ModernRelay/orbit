/**
 * Shared range-brush interaction: pointer-drag over a plot maps x → a
 * {min,max} window in the dimension's domain units. Any drag REPLACES the
 * brush; double-click clears; ArrowLeft/ArrowRight nudge the window by one
 * bin; Escape clears. The plot element itself is focusable. Used by the
 * packaged Histogram and Timeline components.
 */

import { useCallback, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { BrushState } from '@modernrelay/orbit-core';

export interface RangeDomain {
  min: number;
  max: number;
}

export function clampValue(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Map a pointer clientX over the plot rect to a domain value (clamped). */
export function xToDomainValue(
  clientX: number,
  rect: { left: number; width: number },
  domain: RangeDomain,
): number {
  if (rect.width <= 0) return domain.min;
  const t = clampValue((clientX - rect.left) / rect.width, 0, 1);
  return domain.min + t * (domain.max - domain.min);
}

/** Range brush → left/width percentages inside the domain (null when the
 * brush is absent, categorical, or the domain is degenerate). */
export function brushRangePct(
  brush: BrushState,
  domain: RangeDomain | null,
): { leftPct: number; widthPct: number } | null {
  if (brush === null || !('min' in brush) || domain === null) return null;
  const span = domain.max - domain.min;
  if (span <= 0) return null;
  const lo = clampValue(brush.min, domain.min, domain.max);
  const hi = clampValue(brush.max, domain.min, domain.max);
  if (hi < lo) return null;
  return { leftPct: ((lo - domain.min) / span) * 100, widthPct: ((hi - lo) / span) * 100 };
}

/**
 * Shift a {min,max} brush by ±one bin (domain span / binCount), clamped so
 * the window keeps its width. Returns the INPUT reference when there is
 * nothing to nudge (no range brush / degenerate domain) — callers skip the
 * write on reference equality.
 */
export function nudgeRangeBrush(
  brush: BrushState,
  domain: RangeDomain,
  binCount: number,
  direction: -1 | 1,
): BrushState {
  if (brush === null || !('min' in brush)) return brush;
  const span = domain.max - domain.min;
  if (span <= 0 || binCount <= 0) return brush;
  const stepSize = span / binCount;
  const width = Math.min(brush.max - brush.min, span);
  const min = clampValue(brush.min + direction * stepSize, domain.min, domain.max - width);
  return { min, max: min + width };
}

/** Toggle one category exclusion; an empty exclusion list clears the brush. */
export function toggleCategoryExclusion(brush: BrushState, key: string): BrushState {
  const excluded = brush !== null && 'excluded' in brush ? brush.excluded : [];
  const next = excluded.includes(key) ? excluded.filter((k) => k !== key) : [...excluded, key];
  return next.length === 0 ? null : { excluded: next };
}

export interface RangeBrushOptions {
  /** Numeric/temporal domain; null disables pointer/arrow interaction. */
  domain: RangeDomain | null;
  /** Bin count — one arrow nudge moves the window by span/binCount. */
  binCount: number;
  brush: BrushState;
  setBrush(brush: BrushState): void;
}

export interface RangeBrushHandlers {
  onPointerDown(e: ReactPointerEvent<HTMLElement>): void;
  onPointerMove(e: ReactPointerEvent<HTMLElement>): void;
  onPointerUp(e: ReactPointerEvent<HTMLElement>): void;
  onPointerCancel(e: ReactPointerEvent<HTMLElement>): void;
  onDoubleClick(): void;
  onKeyDown(e: ReactKeyboardEvent<HTMLElement>): void;
}

/**
 * The drag/keyboard brush behavior over a plot element. Handler identities
 * are stable across renders (options are read through a ref), so spreading
 * them onto the plot never churns DOM listeners.
 */
export function useRangeBrush(options: RangeBrushOptions): RangeBrushHandlers {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const dragRef = useRef<{ pointerId: number; startValue: number } | null>(null);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    const { domain } = optionsRef.current;
    if (domain === null || e.button !== 0) return;
    const start = xToDomainValue(e.clientX, e.currentTarget.getBoundingClientRect(), domain);
    dragRef.current = { pointerId: e.pointerId, startValue: start };
    const el = e.currentTarget;
    if (typeof el.setPointerCapture === 'function') {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // jsdom / detached element: capture is an optimization only.
      }
    }
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    const { domain, setBrush } = optionsRef.current;
    if (drag === null || domain === null || e.pointerId !== drag.pointerId) return;
    const value = xToDomainValue(e.clientX, e.currentTarget.getBoundingClientRect(), domain);
    setBrush(
      value < drag.startValue
        ? { min: value, max: drag.startValue }
        : { min: drag.startValue, max: value },
    );
  }, []);

  const endDrag = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    if (dragRef.current === null || dragRef.current.pointerId !== e.pointerId) return;
    dragRef.current = null;
    const el = e.currentTarget;
    if (typeof el.releasePointerCapture === 'function') {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // Capture may never have been established.
      }
    }
  }, []);

  const onDoubleClick = useCallback((): void => {
    optionsRef.current.setBrush(null);
  }, []);

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLElement>): void => {
    const { domain, binCount, brush, setBrush } = optionsRef.current;
    if (e.key === 'Escape') {
      if (brush !== null) setBrush(null);
      e.preventDefault();
      return;
    }
    if (domain === null || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    const next = nudgeRangeBrush(brush, domain, binCount, e.key === 'ArrowLeft' ? -1 : 1);
    if (next !== brush) setBrush(next);
    e.preventDefault();
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onDoubleClick,
    onKeyDown,
  };
}

/** aria-valuenow for a brush "slider": the window's center (or domain min). */
export function sliderValueNow(brush: BrushState, domain: RangeDomain | undefined): number {
  if (domain === undefined) return 0;
  if (brush !== null && 'min' in brush) return (brush.min + brush.max) / 2;
  return domain.min;
}

/** aria-valuetext: human-readable brush window (or 'no filter'). */
export function sliderValueText(brush: BrushState, domain: RangeDomain | undefined): string {
  if (domain === undefined || brush === null || !('min' in brush)) return 'no filter';
  return `filtering ${brush.min} to ${brush.max}`;
}
