/**
 * LiveRegion — screen-reader announcements.
 *
 * A visually-hidden `aria-live="polite"` region adjacent to the canvas. It
 * subscribes to the STORE (never the frame clock, so simulation frames can
 * never announce) and speaks a coalesced summary — node/edge counts,
 * selection count, status — at most once every 800ms and only when the
 * summary STRING changes. Trailing-edge coalescing: a burst of store changes
 * lands as ONE announcement carrying the freshest state.
 *
 * Gated off entirely when `accessibility.announcements === false`.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { GraphStoreState } from '@modernrelay/orbit-core';
import { useAmbientGraphInstance } from './GraphProvider';
import { visuallyHiddenStyle } from './components/shared';

export const ANNOUNCE_INTERVAL_MS = 800;

export interface LiveRegionProps {
  /** `accessibility.announcements`; false gates all announcements. Default true. */
  announcements?: boolean | undefined;
}

function summarize(s: GraphStoreState): string {
  const selected = s.selection.nodeIds.length + s.selection.edgeIds.length;
  return `Graph ${s.status}. ${s.nodeCount} nodes, ${s.edgeCount} edges. ${selected} selected.`;
}

/** Internal to <Graph>; reads the ambient instance so hosts composing
 * GraphProvider directly can reuse it. */
export function LiveRegion(props: LiveRegionProps): ReactElement {
  const instance = useAmbientGraphInstance('LiveRegion');
  const enabled = props.announcements !== false;
  const [message, setMessage] = useState('');
  /** Last ANNOUNCED summary; seeded at subscribe time so the initial state
   * (already conveyed by the container's aria-label) is never announced. */
  const lastAnnouncedRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    const store = instance.store;
    lastAnnouncedRef.current = summarize(store.getState());

    const fire = (): void => {
      timerRef.current = null;
      const next = summarize(store.getState());
      if (next === lastAnnouncedRef.current) return;
      lastAnnouncedRef.current = next;
      setMessage(next);
    };

    const unsubscribe = store.subscribe(() => {
      if (timerRef.current !== null) return; // window open — coalesce
      if (summarize(store.getState()) === lastAnnouncedRef.current) return;
      timerRef.current = setTimeout(fire, ANNOUNCE_INTERVAL_MS);
    });

    return () => {
      unsubscribe();
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [instance, enabled]);

  return (
    <div
      data-orbit-live-region=""
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={visuallyHiddenStyle}
    >
      {message}
    </div>
  );
}
