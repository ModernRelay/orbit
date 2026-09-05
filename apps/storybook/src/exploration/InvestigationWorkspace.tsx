import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactElement, RefObject } from 'react';
import { canonicalJson, createInvestigationSession, GRAPH_THEME_DARK } from '@modernrelay/orbit-core';
import type { ExpansionOptions, GraphInstance, InvestigationSession, SearchResult, SearchUnavailableReason } from '@modernrelay/orbit-core';
import { Graph } from '@modernrelay/orbit-react';
import type { GraphHandle } from '@modernrelay/orbit-react';
import { GraphExplorer } from '@modernrelay/orbit-react/components/Explorer';
import { cosmosEngine } from '../fixtures/engines';
import { colorOf, delay, labels, seedSnapshot, sourceReference } from './supplyChain';
import type { Entity, Relationship } from './supplyChain';
import { createSupplyChainServices, loadCatalogEntity } from './supplyChainServices';
import type { ServiceEvent } from './supplyChainServices';

export type Workflow = 'find' | 'expand' | 'stable' | 'inspect' | 'paths' | 'save' | 'async';
type Instance = GraphInstance<Entity, Relationship>;
const expansion: ExpansionOptions = {
  direction: 'incoming', relationshipTypes: ['SUPPLIES'], relationshipTypeField: 'type',
  hops: 1, limit: 2, preserveLayout: true,
};
const tableDimension = [{ key: 'table', kind: 'categorical' as const, get: (node: { id: string }) => node.id }];
const entityColumns = [{ key: 'label', label: 'Entity' }, { key: 'type', label: 'Type' }, { key: 'status', label: 'Status' }];
const storageKey = 'orbit:storybook:supplier-investigations:v1';
const button: CSSProperties = {
  border: '1px solid #415572', borderRadius: 5, background: '#18283e', color: '#edf4ff',
  padding: '7px 11px', font: 'inherit', cursor: 'pointer',
};

const instructions: Record<Workflow, { title: string; steps: string }> = {
  find: {
    title: 'Find an entity without losing the investigation',
    steps: 'Search “Harbor” (hidden), “Cedar” (outside an isolation), or “Ember” (not loaded). Activate the hit, then use the explicit recovery action. Selection and inspection stay beside the graph.',
  },
  expand: {
    title: 'Explore one relationship type, two neighbors at a time',
    steps: 'Load incoming SUPPLIES for Atlas. The first page contains two already-loaded suppliers; Load more fetches Ember and Lumen. A final page reaches Northstar. Retract removes only this expansion’s contribution.',
  },
  stable: {
    title: 'Keep the current map while the investigation grows',
    steps: 'Pan or zoom, then load supplier pages. preserveLayout holds established nodes and cancels settle-camera follow. Use Fit all when you want a wider view; resume layout to let unpinned established nodes move again.',
  },
  inspect: {
    title: 'Inspect evidence and compare entities',
    steps: 'Inspect Harbor → Atlas to read its relationship type, confidence, date, and evidence. Then compare Harbor and Cedar. Follow endpoint and related-entity actions without closing the inspector.',
  },
  paths: {
    title: 'Explain a connection in traversal order',
    steps: 'Harbor starts hidden. The visible graph cannot connect the report to the bicycle; the loaded graph can. Find the loaded path, inspect its ordered steps, then reveal Harbor. This is a path through loaded data, not proof about the entire remote catalog.',
  },
  save: {
    title: 'Save and reopen a named investigation',
    steps: 'Load supplier pages, add a title and note in the explorer, then save a checkpoint. Retract or start a fresh canvas and reopen it. This story saves up to eight exported checkpoints in this browser; refresh the page to verify reopening.',
  },
  async: {
    title: 'See bounded asynchronous requests and cancellation',
    steps: 'Start a supplier page and immediately cancel it. The service waits, then emits two bounded batches; Orbit publishes the expansion atomically. Watch the request log, then retry. Type a different search while the first is pending to supersede it.',
  },
};

export function InvestigationWorkspace({ workflow }: { workflow: Workflow }): ReactElement {
  const graph = useRef<GraphHandle<Entity, Relationship>>(null);
  const [investigation, setInvestigation] = useState<InvestigationSession<Entity, Relationship> | null>(null);
  useEffect(() => {
    const owned = createInvestigationSession<Entity, Relationship>(() => graph.current?.instance ?? null, {
      async loadSource(source, { signal }) {
        // This self-contained host serves exactly one version of one catalog.
        if (source.datasetKey !== seedSnapshot.datasetKey || source.sourceRevision !== seedSnapshot.sourceRevision ||
          canonicalJson(source.dataRef) !== canonicalJson(sourceReference)) {
          throw new Error('This example cannot load that source revision. The current graph is unchanged.');
        }
        await delay(200, signal);
        const current = graph.current?.instance;
        if (current === undefined) throw new Error('Wait for the graph to mount.');
        current.applyHostUpdate({ data: seedSnapshot, dataRef: sourceReference });
      },
    });
    setInvestigation(owned);
    return () => owned.destroy();
  }, []);
  return investigation === null ? <p>Preparing investigation…</p>
    : <InvestigationWorkspaceContent workflow={workflow} graph={graph} investigation={investigation} />;
}

function InvestigationWorkspaceContent({ workflow, graph, investigation }: {
  workflow: Workflow;
  graph: RefObject<GraphHandle<Entity, Relationship>>;
  investigation: InvestigationSession<Entity, Relationship>;
}): ReactElement {
  const [instance, setInstance] = useState<Instance | null>(null);
  const [canvasKey, setCanvasKey] = useState(0);
  const [events, setEvents] = useState<ServiceEvent[]>([]);
  const [notice, setNotice] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [pagingStarted, setPagingStarted] = useState(false);
  const recoveries = useRef(new Set<AbortController>());
  const log = useCallback((event: ServiceEvent) => setEvents((old) => [...old.slice(-11), event]), []);
  const services = useMemo(() => createSupplyChainServices(log), [log]);
  const session = useSyncExternalStore(investigation.store.subscribe, investigation.store.getState, investigation.store.getState);
  const subscribeGraph = useCallback((listener: () => void) => instance?.store.subscribe(listener) ?? (() => undefined), [instance]);
  const readGraph = useCallback(() => instance?.store.getState() ?? null, [instance]);
  const state = useSyncExternalStore(subscribeGraph, readGraph, readGraph);
  const pending = state?.pendingExpansions.has('atlas') ?? false;
  const usable = instance !== null && session.status === 'idle';

  const priorRestoreStatus = useRef(session.status);
  useEffect(() => {
    if (priorRestoreStatus.current === 'restoring' && session.status === 'idle') {
      setCursor(undefined);
      setPagingStarted(false);
    }
    priorRestoreStatus.current = session.status;
  }, [session.status]);

  useEffect(() => {
    investigation.setTitle('Atlas supplier disruption');
    investigation.setNotes('Hypothesis: the port delay affects battery deliveries. Verify the bulletin before changing suppliers.');
    if (workflow !== 'save') return;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      if (!Array.isArray(saved)) throw new Error('Saved checkpoint list is invalid.');
      for (const raw of saved.slice(-8)) investigation.importCheckpoint(raw);
    } catch (error) {
      setNotice(`Could not read saved checkpoints: ${String(error)}`);
    }
    let previous = investigation.store.getState().checkpoints;
    return investigation.store.subscribe((next) => {
      if (next.checkpoints === previous) return;
      previous = next.checkpoints;
      try {
        localStorage.setItem(storageKey, JSON.stringify(next.checkpoints.slice(-8).map((c) => JSON.parse(investigation.exportCheckpoint(c)))));
      } catch (error) {
        setNotice(`Could not save in this browser: ${String(error)}`);
      }
    });
  }, [investigation, workflow]);

  useEffect(() => () => {
    for (const controller of recoveries.current) controller.abort();
  }, []);

  function ready(): void {
    const current = graph.current?.instance;
    if (current === undefined) return;
    setInstance(current);
    if (workflow === 'find' || workflow === 'paths') current.hideNodes(['harbor']);
    if (workflow === 'inspect') current.selectEdges(['harbor-atlas']);
    else current.selectNodes(['atlas']);
  }

  const recover = async (result: SearchResult, reason: SearchUnavailableReason): Promise<void> => {
    const current = graph.current?.instance;
    if (current === undefined) return;
    if (reason === 'not-loaded') {
      const controller = new AbortController();
      recoveries.current.add(controller);
      try { await loadCatalogEntity(current, result.id, controller.signal); }
      finally { recoveries.current.delete(controller); }
    } else if (reason === 'out-of-scope') current.resetIsolation();
    else current.showNodes([result.id]);
  };

  function run(action: () => void | Promise<void>): void {
    setNotice('');
    void Promise.resolve().then(action).catch((error: unknown) => setNotice(error instanceof Error ? error.message : String(error)));
  }

  async function loadPage(): Promise<void> {
    const result = await investigation.expandNode('atlas', { ...expansion, ...(cursor === undefined ? {} : { cursor }) });
    if ('page' in result) {
      setCursor(result.page?.nextCursor);
      setPagingStarted(true);
      setNotice(result.page?.nextCursor === undefined ? 'All supplier pages loaded.' : 'Page complete. More suppliers are available.');
    }
  }

  async function findPath(universe: 'visible' | 'loaded'): Promise<void> {
    if (instance === null) return;
    const options = { direction: 'outgoing' as const, universe, maxHops: 6 };
    const result = await instance.findPathDetailed('report', 'bike', options);
    if (result.status === 'found') {
      investigation.savePath({ title: `${universe} report → bicycle`, sourceId: 'report', targetId: 'bike', options, path: result.path });
      setNotice(`${universe}: ${result.path.nodeIds.join(' → ')}. Saved to the path list.`);
    } else setNotice(`${universe}: ${result.status}. No path was added.`);
  }

  const showExpansion = ['expand', 'stable', 'save', 'async'].includes(workflow);
  return (
    <section style={{ fontFamily: 'system-ui, sans-serif', color: '#e4edfb', background: '#0b1422', padding: 18, borderRadius: 10 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 22 }}>{instructions[workflow].title}</h2>
      <p style={{ color: '#b6c6dc', lineHeight: 1.55, maxWidth: 1000, margin: '0 0 14px' }}>{instructions[workflow].steps}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {workflow === 'find' && <>
          <button style={button} disabled={!usable} onClick={() => instance?.hideNodes(['harbor'])}>Hide Harbor</button>
          <button style={button} disabled={!usable} onClick={() => { instance?.selectNodes(['atlas']); instance?.isolateSelection(); }}>Isolate Atlas</button>
          <button style={button} disabled={!usable} onClick={() => instance?.resetIsolation()}>Clear isolation</button>
        </>}
        {showExpansion && <>
          <button style={button} disabled={!usable || pending || (pagingStarted && cursor === undefined)} onClick={() => run(loadPage)}>{pagingStarted ? 'Load more suppliers' : 'Load 2 suppliers'}</button>
          <button style={button} disabled={!pending} onClick={() => instance?.cancelExpansion('atlas')}>Cancel request</button>
          <button style={button} disabled={!usable || pending} onClick={() => { investigation.retractExpansion('atlas'); setCursor(undefined); setPagingStarted(false); setNotice('Last Atlas page retracted. Base suppliers remain.'); }}>Retract last supplier page</button>
        </>}
        {workflow === 'stable' && <>
          <button style={button} disabled={!usable} onClick={() => instance?.focusNode('atlas')}>Focus Atlas</button>
          <button style={button} disabled={!usable} onClick={() => instance?.resumeSimulation()}>Resume full layout</button>
        </>}
        {workflow === 'inspect' && <>
          <button style={button} disabled={!usable} onClick={() => { instance?.clearSelection(); instance?.selectEdges(['harbor-atlas']); }}>Inspect Harbor → Atlas</button>
          <button style={button} disabled={!usable} onClick={() => { instance?.clearSelection(); instance?.selectNodes(['harbor', 'cedar']); }}>Compare Harbor and Cedar</button>
        </>}
        {workflow === 'paths' && <>
          <button style={button} disabled={!usable} onClick={() => run(() => findPath('visible'))}>Find visible path</button>
          <button style={button} disabled={!usable} onClick={() => run(() => findPath('loaded'))}>Find loaded path</button>
          <button style={button} disabled={!usable} onClick={() => instance?.showNodes(['harbor'])}>Reveal Harbor</button>
        </>}
        {workflow === 'save' && <>
          <button style={button} disabled={!usable || pending} onClick={() => { for (const controller of recoveries.current) controller.abort(); setInstance(null); setCanvasKey((old) => old + 1); setCursor(undefined); setPagingStarted(false); setNotice('Fresh canvas. Reopen a named checkpoint in the explorer.'); }}>Fresh canvas</button>
          <button style={button} disabled={session.checkpoints.length === 0} onClick={() => run(async () => {
            const checkpoint = session.checkpoints[0];
            if (checkpoint !== undefined) await investigation.restoreCheckpoint({ ...checkpoint,
              source: { ...checkpoint.source, sourceRevision: 'unavailable-fixture-revision' } });
          })}>Try unavailable source</button>
          <button style={button} onClick={() => { for (const c of session.checkpoints) investigation.removeCheckpoint(c.id); localStorage.removeItem(storageKey); setNotice('This story’s browser checkpoints cleared.'); }}>Clear saved examples</button>
        </>}
        <button style={button} disabled={!usable} onClick={() => instance?.fitView()}>Fit all</button>
      </div>
      <p aria-live="polite" style={{ minHeight: 20, color: '#e7c582', margin: '0 0 10px' }}>{notice}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'stretch' }}>
        <div style={{ flex: '1 1 380px', minWidth: 280, height: 640, position: 'relative', border: '1px solid #273a54', borderRadius: 8, overflow: 'hidden' }}>
          <Graph<Entity, Relationship>
            key={canvasKey} ref={graph} engine={cosmosEngine} data={seedSnapshot} dataRef={sourceReference}
            services={services} crossfilter={tableDimension} layout={workflow === 'stable' ? 'force' : 'fixed'} fitViewOnSettle={false}
            nodeColor={colorOf} nodeSize={8} linkColor="#647c9e" linkWidth={2} edgeArrows labels={labels}
            theme={GRAPH_THEME_DARK} onReady={ready} onError={({ error }) => setNotice(error.message)}
            accessibility={{ label: 'Fictional Atlas Mobility supply chain' }}
          />
          <div style={{ position: 'absolute', left: 12, bottom: 12, pointerEvents: 'none', fontSize: 12, background: '#0b1422dd', padding: 8, borderRadius: 4 }}>
            {state?.nodeCount ?? 0} loaded nodes · {instance?.getVisibleNodeIds().length ?? 0} visible · {state?.pinnedNodeIds.size ?? 0} user pins
          </div>
        </div>
        <div style={{ flex: '1 1 560px', minWidth: 280, height: 640, overflow: 'auto' }}>
          {instance !== null && <GraphExplorer instance={instance} investigation={investigation} layout="panel" height={640} title="Supplier investigation" columns={entityColumns} typeField="type" onRecoverSearchResult={recover} />}
        </div>
      </div>
      <p style={{ color: '#90a7c5', fontSize: 12 }}>Fictional source: supplier catalog · revision {sourceReference.revision}. Six entities are initially loaded; the backend catalog contains twelve. No network or credentials required.</p>
      {workflow === 'async' && <details open>
        <summary>Latest service lifecycle events (maximum 12)</summary>
        <ol aria-live="polite" style={{ fontFamily: 'monospace', fontSize: 12 }}>{events.map((event, i) => <li key={`${event.request}:${event.status}:${i}`}>{event.status}: {event.operation} [{event.request}]</li>)}</ol>
      </details>}
    </section>
  );
}
