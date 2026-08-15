/**
 * Internal crossfilter subscription: shared by the public
 * useGraphCrossfilter hook and the packaged Histogram and Timeline
 * components.
 *
 * Subscribes to the SESSION (session.subscribe) and re-reads
 * summarize/getBrush on notify. The session resolves lazily — null until the
 * `crossfilter` prop has built dimensions over an accepted base — polled via
 * a store subscription (the store publishes when dimensions build). A
 * dimension rebuild swaps the underlying engine WITHOUT changing the session
 * facade identity (and clears the old engine's subscribers), so every store
 * publication re-attaches the session callback; snapshots are structurally
 * cached, making the extra notifications free.
 */

import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { BrushState, DimensionSummary } from '@modernrelay/orbit-core';
import type { AnyGraphInstance } from '../../GraphProvider';

export interface CrossfilterSnapshot {
  /** Null until the dimension exists (no session yet / unknown key). */
  summary: DimensionSummary | null;
  brush: BrushState;
}

const EMPTY_SNAPSHOT: CrossfilterSnapshot = { summary: null, brush: null };

/** Structural brush equality (brushes are tiny). */
export function sameBrush(a: BrushState, b: BrushState): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if ('excluded' in a) {
    return (
      'excluded' in b &&
      a.excluded.length === b.excluded.length &&
      a.excluded.every((k, i) => k === b.excluded[i])
    );
  }
  return !('excluded' in b) && a.min === b.min && a.max === b.max;
}

function sameSummary(a: DimensionSummary | null, b: DimensionSummary | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.key !== b.key || a.kind !== b.kind || a.excludedRows !== b.excludedRows) return false;
  if (a.domain?.min !== b.domain?.min || a.domain?.max !== b.domain?.max) return false;
  if (a.bins.length !== b.bins.length || a.categories.length !== b.categories.length) {
    return false;
  }
  for (let i = 0; i < a.bins.length; i++) {
    const x = a.bins[i]!;
    const y = b.bins[i]!;
    if (x.x0 !== y.x0 || x.x1 !== y.x1 || x.total !== y.total || x.filtered !== y.filtered) {
      return false;
    }
  }
  for (let i = 0; i < a.categories.length; i++) {
    const x = a.categories[i]!;
    const y = b.categories[i]!;
    if (
      x.key !== y.key ||
      x.total !== y.total ||
      x.filtered !== y.filtered ||
      x.excluded !== y.excluded
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Live {summary, brush} for one dimension key on an explicit instance.
 * Returns a referentially stable snapshot until the content actually changes.
 */
export function useCrossfilterDimension(
  instance: AnyGraphInstance,
  key: string,
): CrossfilterSnapshot {
  const subscribe = useCallback(
    (onChange: () => void) => {
      let sessionUnsub: (() => void) | null = null;
      const attach = (): void => {
        sessionUnsub?.();
        sessionUnsub = null;
        const session = instance.getCrossfilterSession();
        if (session !== null) sessionUnsub = session.subscribe(onChange);
      };
      attach();
      const storeUnsub = instance.store.subscribe(() => {
        attach();
        onChange();
      });
      return () => {
        storeUnsub();
        sessionUnsub?.();
        sessionUnsub = null;
      };
    },
    [instance],
  );

  const cacheRef = useRef<{ key: string; value: CrossfilterSnapshot } | null>(null);
  const getSnapshot = useCallback((): CrossfilterSnapshot => {
    const session = instance.getCrossfilterSession();
    let next = EMPTY_SNAPSHOT;
    if (session !== null) {
      try {
        next = { summary: session.summarize(key), brush: session.getBrush(key) };
      } catch {
        // Unknown key / dimension mid-rebuild: absent, never a crash.
        next = EMPTY_SNAPSHOT;
      }
    }
    const cache = cacheRef.current;
    if (
      cache !== null &&
      cache.key === key &&
      sameSummary(cache.value.summary, next.summary) &&
      sameBrush(cache.value.brush, next.brush)
    ) {
      return cache.value;
    }
    cacheRef.current = { key, value: next };
    return next;
  }, [instance, key]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Stable setter routing through the session (no-op until it exists). */
export function useSessionSetBrush(
  instance: AnyGraphInstance,
  key: string,
): (brush: BrushState) => void {
  return useCallback(
    (brush: BrushState): void => {
      const session = instance.getCrossfilterSession();
      if (session === null) return;
      // Rejections only occur on teardown races (destroyed instance).
      void session.setBrush(key, brush).catch(() => undefined);
    },
    [instance, key],
  );
}
