import { useEffect, useRef, useState } from 'react';
import { createInvestigationSession } from '@modernrelay/orbit-core';
import type { InvestigationSession, JsonValue } from '@modernrelay/orbit-core';
import { useGraphInstance } from '@modernrelay/orbit-react';
import { GraphExplorer } from '@modernrelay/orbit-react/components/Explorer';

const STORAGE_KEY = 'orbit-demo-investigations-v1';

/** Demo-owned storage and predicate filters; neither belongs in the library. */
export function ExplorationWorkspace(props: {
  open: boolean;
  typeField: string;
  filters: JsonValue;
  filterLabels: readonly string[];
  restoreFilters: (filters: JsonValue) => void;
  clearFilters: () => void;
}) {
  const instance = useGraphInstance();
  const latest = useRef(props);
  latest.current = props;
  const [session, setSession] = useState<InvestigationSession | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  useEffect(() => {
    const investigation = createInvestigationSession(instance, {
      captureHostState: () => latest.current.filters,
      restoreHostState: (filters) => latest.current.restoreFilters(filters),
    });
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored !== null) {
        const saved: unknown = JSON.parse(stored);
        if (!Array.isArray(saved)) throw new Error('Saved investigations must be a list');
        for (const checkpoint of saved) investigation.importCheckpoint(checkpoint);
      }
    } catch (error) { setStorageError(`Could not open saved investigations: ${String(error)}`); }
    const unsubscribe = investigation.store.subscribe((next, previous) => {
      if (next.checkpoints === previous.checkpoints) return;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next.checkpoints));
        setStorageError(null);
      } catch (error) { setStorageError(`Browser storage failed; export your checkpoint: ${String(error)}`); }
    });
    setSession(investigation);
    return () => { unsubscribe(); investigation.destroy(); };
  }, [instance]);

  if (session === null || !props.open) return null;
  return <aside className="demo-exploration-panel" hidden={!props.open}>
    {storageError !== null && <p role="alert">{storageError}</p>}
    <GraphExplorer
      investigation={session}
      layout="panel"
      typeField={props.typeField}
      height="100%"
      constraints={props.filterLabels.map((label) => ({ id: label, label, onClear: props.clearFilters }))}
      onRecoverSearchResult={async (result, reason) => {
        if (reason === 'not-loaded') throw new Error('Load this entity using the Data controls, then search again.');
        if (reason === 'out-of-scope') {
          const scope = instance.store.getState().scope;
          if (scope !== null) instance.applyHostUpdate({ subgraph: { ...scope, seedIds: [...scope.seedIds, result.id], reflow: false } });
        } else {
          props.clearFilters();
          instance.showNodes([result.id]);
          const crossfilter = instance.getCrossfilterSession();
          for (const { key } of instance.getViewState().crossfilter) await crossfilter?.setBrush(key, null);
          session.setTableQuery('');
        }
      }}
    />
  </aside>;
}

export const EXPLORATION_CSS = `
  .demo-exploration-panel { position: fixed; right: 12px; top: 12px; bottom: 12px; width: 620px; z-index: 30; }
  .demo-exploration-panel[hidden] { display: none; }
  [data-exploring="true"] > .demo-graph { width: calc(100% - 644px) !important; }
  .demo-exploration-nav { position: fixed; top: 14px; left: 14px; right: 658px; z-index: 40; display: flex; flex-wrap: wrap; gap: 8px; }
  @media (max-width: 1000px) {
    [data-exploring="true"] > .demo-graph { width: 100% !important; height: 45% !important; }
    .demo-exploration-panel { left: 8px; right: 8px; top: 46%; bottom: 8px; width: auto; }
    .demo-exploration-nav { right: 14px; }
  }
`;
