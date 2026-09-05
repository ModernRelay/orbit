/** Optional exploration workspace. Source loading and host-owned filters stay
 * explicit callbacks; the graph remains the owner of graph state, and an
 * investigation session owns durable notes, paths, and checkpoints. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { createInvestigationSession } from '@modernrelay/orbit-core';
import type {
  ExpansionPage, GraphStoreState, InvestigationSession, InvestigationExpansion, PathOptions,
  SearchResult, SearchUnavailableReason,
} from '@modernrelay/orbit-core';
import type { AnyGraphInstance } from '../../GraphProvider';
import { mergeStyle, useResolvedInstance } from '../shared';
import { GraphSearch } from '../Search';
import { GraphTable } from '../Table';
import type { GraphTableHandle, GraphTableProps } from '../Table';
import { cellText } from '../Table/model';
import { GraphInspector } from '../Inspector';
import type { GraphInspectionSubject } from '../Inspector';

export interface GraphExplorerConstraint {
  id: string;
  label: string;
  /** Explicit host-controlled transition; put reversible host state in the
   * investigation session's captureHostState/restoreHostState hooks. */
  onClear(): void | Promise<void>;
}

export interface GraphExplorerProps {
  instance?: AnyGraphInstance;
  /** External sessions can survive graph remounts and persist checkpoints.
   * Omission creates an in-memory session owned by this component. */
  investigation?: InvestigationSession<any, any>;
  typeField?: string;
  onRecoverSearchResult?: (result: SearchResult, reason: SearchUnavailableReason) => void | Promise<void>;
  constraints?: readonly GraphExplorerConstraint[];
  columns?: GraphTableProps['columns'];
  title?: string;
  layout?: 'dock' | 'panel';
  height?: number | string;
  className?: string;
  style?: CSSProperties;
}

const box: CSSProperties = { padding: 10, border: '1px solid #48505d', borderRadius: 8, minWidth: 0 };
const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 };
const input: CSSProperties = { minWidth: 0, maxWidth: '100%', padding: '5px 7px', boxSizing: 'border-box' };
const sectionTitle: CSSProperties = { margin: '0 0 8px', fontSize: 14 };
const EMPTY_CONSTRAINTS: readonly GraphExplorerConstraint[] = [];
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function nodeLabel(instance: AnyGraphInstance, id: string): string {
  return cellText(instance.getNode(id)?.attrs?.label ?? id);
}
function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Subscribe only to exploration state: viewport animation never rerenders
 * the table, relationship lists, or checkpoint controls. */
function useExplorationState(instance: AnyGraphInstance): GraphStoreState {
  const cached = useRef<GraphStoreState | null>(null);
  const subscribe = useCallback((onChange: () => void) => instance.store.subscribe(onChange), [instance]);
  const snapshot = useCallback(() => {
    const next = instance.store.getState();
    const old = cached.current;
    if (old !== null && old.revisions.model === next.revisions.model && old.revisions.scope === next.revisions.scope &&
      old.selection === next.selection && old.hiddenNodeIds === next.hiddenNodeIds && old.scope === next.scope &&
      old.history === next.history && old.pendingExpansions === next.pendingExpansions && old.folds === next.folds &&
      old.groups === next.groups && old.pinnedNodeIds === next.pinnedNodeIds && old.theme === next.theme && old.status === next.status) return old;
    cached.current = next;
    return next;
  }, [instance]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function GraphExplorer(props: GraphExplorerProps): ReactElement {
  const instance = useResolvedInstance(props.instance, '<GraphExplorer>');
  const [owned, setOwned] = useState<{ instance: AnyGraphInstance; session: InvestigationSession<any, any> } | null>(null);
  const activeOwned = useRef<InvestigationSession<any, any> | null>(null);
  useEffect(() => {
    if (props.investigation !== undefined) return undefined;
    const session = createInvestigationSession(instance);
    activeOwned.current = session;
    setOwned({ instance, session });
    return () => { if (activeOwned.current === session) activeOwned.current = null; session.destroy(); };
  }, [instance, props.investigation]);
  const investigation = props.investigation ?? (owned?.instance === instance && activeOwned.current === owned.session ? owned.session : null);
  if (investigation === null) return <div role="status">Preparing exploration…</div>;
  return <ExplorerContent {...props} instance={instance} investigation={investigation} />;
}

function ExplorerContent(props: GraphExplorerProps & { instance: AnyGraphInstance; investigation: InvestigationSession<any, any> }): ReactElement {
  const { instance, investigation } = props;
  const state = useExplorationState(instance);
  const subscribe = useCallback((onChange: () => void) => investigation.store.subscribe(onChange), [investigation]);
  const snapshot = useCallback(() => investigation.store.getState(), [investigation]);
  const saved = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [subject, setSubject] = useState<GraphInspectionSubject>(null);
  const tableQuery = saved.tableQuery;
  const setTableQuery = (query: string): void => investigation.setTableQuery(query);
  const [unavailable, setUnavailable] = useState<{ result: SearchResult; reason: SearchUnavailableReason } | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const epoch = useRef(0);
  const pathEpoch = useRef(0);
  const tableRef = useRef<GraphTableHandle>(null);
  const [direction, setDirection] = useState<NonNullable<PathOptions['direction']>>('either');
  const [relationshipType, setRelationshipType] = useState('');
  const [limit, setLimit] = useState(25);
  const [expansion, setExpansion] = useState<{ seed: string; key: string; recipes: readonly InvestigationExpansion[]; page?: ExpansionPage } | null>(null);
  const [pathFrom, setPathFrom] = useState('');
  const [pathTo, setPathTo] = useState('');
  const [pathDirection, setPathDirection] = useState<NonNullable<PathOptions['direction']>>('either');
  const [pathUniverse, setPathUniverse] = useState<'visible' | 'loaded'>('visible');
  const [pathHops, setPathHops] = useState(6);
  const [pathType, setPathType] = useState('');
  const [pathBusy, setPathBusy] = useState(false);
  const queryRef = useRef(saved.searchQuery);
  queryRef.current = saved.searchQuery;
  const typeField = props.typeField ?? 'type';
  const sourceKey = JSON.stringify(instance.getSource());
  const seed = subject?.kind === 'node' ? subject.id : state.selection.nodeIds[0];
  const neighborhood = useMemo(() => seed === undefined ? null : instance.getNeighborhood(seed, {
    direction, relationshipTypeField: typeField, limit: 1, edgeLimit: 1,
    ...(relationshipType === '' ? {} : { relationshipTypes: [relationshipType] }),
  }), [instance, seed, direction, typeField, relationshipType, state.revisions.model, state.revisions.scope]);
  const expansionKey = JSON.stringify([seed, direction, relationshipType, typeField, limit]);
  const expansionPage = expansion?.key === expansionKey && expansion.recipes === saved.expansions ? expansion.page : undefined;
  const expansionBusy = seed !== undefined && state.pendingExpansions.has(seed);

  useEffect(() => { investigation.refreshSource(); }, [instance, investigation]);

  useEffect(() => {
    epoch.current += 1;
    pathEpoch.current += 1;
    setSubject(null); setUnavailable(null); setError(null); setNotice(''); setExpansion(null);
    setPathFrom(''); setPathTo(''); setBusy(null); setPathBusy(false);
    return () => { epoch.current += 1; pathEpoch.current += 1; };
  }, [instance, investigation, sourceKey]);
  useEffect(() => {
    const selected = state.selection;
    if (selected.edgeIds.length === 1 && selected.nodeIds.length === 0) setSubject({ kind: 'edge', id: selected.edgeIds[0]! });
    else if (selected.nodeIds.length === 1) setSubject({ kind: 'node', id: selected.nodeIds[0]! });
    else if (selected.nodeIds.length > 1) setSubject({ kind: 'selection', nodeIds: selected.nodeIds });
  }, [state.selection]);
  useEffect(() => {
    const offNode = instance.on('nodeClick', ({ node }) => setSubject({ kind: 'node', id: node.id }));
    const offEdge = instance.on('edgeClick', ({ edge }) => setSubject({ kind: 'edge', id: edge.id }));
    return () => { offNode(); offEdge(); };
  }, [instance]);
  useEffect(() => { setUnavailable(null); }, [saved.searchQuery]);

  const run = async (label: string, action: () => void | Promise<unknown>): Promise<void> => {
    const issued = epoch.current;
    setBusy(label); setError(null);
    try { await action(); }
    catch (cause) { if (issued === epoch.current) setError(message(cause)); }
    finally { if (issued === epoch.current) setBusy(null); }
  };
  const recover = (): void => {
    if (unavailable === null || props.onRecoverSearchResult === undefined) return;
    const target = unavailable;
    const issued = epoch.current;
    const issuedQuery = saved.searchQuery;
    void run('Recover search result', async () => {
      await props.onRecoverSearchResult!(target.result, target.reason);
      if (issued !== epoch.current || issuedQuery !== queryRef.current) return;
      const outcome = instance.activateSearchResult(target.result);
      if (outcome.status === 'focused') {
        setSubject({ kind: 'node', id: target.result.id }); setUnavailable(null);
      } else setUnavailable({ result: target.result, reason: outcome.reason });
    });
  };
  const expand = (cursor?: string): void => {
    if (seed === undefined) return;
    const issued = epoch.current;
    const id = seed;
    void run('Expand relationships', async () => {
      const result = await investigation.expandNode(id, {
        hops: 1, limit, edgeLimit: 1000, direction, relationshipTypeField: typeField, preserveLayout: true,
        ...(relationshipType === '' ? {} : { relationshipTypes: [relationshipType] }),
        ...(cursor === undefined ? {} : { cursor }),
        onProgress: (progress) => {
          if (issued === epoch.current) setNotice(`Loading ${progress.receivedNodes} nodes · ${progress.receivedEdges} relationships`);
        },
      });
      if (issued !== epoch.current) return;
      const page = 'page' in result ? result.page : undefined;
      setExpansion({ seed: id, key: expansionKey, recipes: investigation.store.getState().expansions, ...(page === undefined ? {} : { page }) });
      setNotice(page === undefined ? 'Expansion complete.' : `Added page: ${page.returnedNodes} nodes · ${page.returnedEdges} relationships${page.truncated ? ' · more may be available' : ''}`);
    });
  };
  const findPath = (): void => {
    if (pathFrom.trim() === '' || pathTo.trim() === '') return;
    const issued = ++pathEpoch.current;
    const sourceId = pathFrom.trim(); const targetId = pathTo.trim();
    const options: PathOptions = {
      direction: pathDirection, universe: pathUniverse, maxHops: pathHops,
      relationshipTypeField: typeField,
      ...(pathType === '' ? {} : { relationshipTypes: [pathType] }),
    };
    setPathBusy(true); setError(null); setNotice('Finding connection…');
    void instance.findPathDetailed(sourceId, targetId, options).then((outcome) => {
      if (issued !== pathEpoch.current) return;
      if (outcome.status !== 'found') {
        setNotice(outcome.status === 'not-loaded' ? `Load the missing endpoints: ${outcome.nodeIds.join(', ')}`
          : outcome.status === 'filtered' ? `Connection blocked by hidden or out-of-scope entities: ${outcome.nodeIds.join(', ')}. Choose loaded graph or reveal them.`
            : outcome.status === 'hop-limit' ? `No connection within ${pathHops} hops. Increase the hop limit to continue.`
              : 'No path found in the current graph.');
        return;
      }
      investigation.savePath({ title: `${nodeLabel(instance, sourceId)} → ${nodeLabel(instance, targetId)}`, sourceId, targetId, options, path: outcome.path });
      setNotice(`Connection saved: ${outcome.path.edgeIds.length} relationships.`);
    }).catch((cause: unknown) => {
      if (issued === pathEpoch.current) setError(message(cause));
    }).finally(() => { if (issued === pathEpoch.current) setPathBusy(false); });
  };

  const constraints: GraphExplorerConstraint[] = [...(props.constraints ?? EMPTY_CONSTRAINTS)];
  if (state.scope !== null) constraints.push({ id: 'scope', label: `Around ${state.scope.seedIds.map((id) => nodeLabel(instance, id)).slice(0, 3).join(', ')} · ${state.scope.hops ?? 0} hops`, onClear: () => instance.resetIsolation() });
  if (state.hiddenNodeIds.size > 0) constraints.push({ id: 'hidden', label: `${state.hiddenNodeIds.size} manually hidden`, onClear: () => instance.showAll() });
  if (tableQuery !== '') constraints.push({ id: 'table-query', label: `Table: ${tableQuery}`, onClear: () => setTableQuery('') });
  for (const [id, count] of state.folds) constraints.push({ id: `fold:${id}`, label: `${nodeLabel(instance, id)} · ${count} folded`, onClear: () => instance.unfoldNode(id) });
  for (const group of state.groups) if (group.collapsed) constraints.push({ id: `group:${group.id}`, label: `Collapsed: ${group.label ?? group.id}`, onClear: () => instance.setGroupCollapsed(group.id, false) });
  const view = useMemo(() => instance.getViewState(), [instance, state]);
  for (const brush of view.crossfilter) {
    if (brush.key === 'table' && tableQuery !== '') continue;
    const description = brush.state.kind === 'categorical' ? `${brush.state.excluded.length} excluded` : brush.state.range.join(' – ');
    constraints.push({ id: `brush:${brush.key}`, label: `${brush.key}: ${description}`, onClear: async () => { await instance.getCrossfilterSession()?.setBrush(brush.key, null); } });
  }
  const rootStyle: CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 12, padding: 12, boxSizing: 'border-box',
    overflow: 'auto', colorScheme: 'dark', background: '#10131a', color: '#e8eaf0', borderRadius: 10,
    font: '13px/1.5 system-ui, sans-serif', pointerEvents: 'auto', minWidth: 0,
    ...(props.layout === 'panel' ? { position: 'relative', width: '100%' } : {
      position: 'absolute', top: 12, right: 12, bottom: 12, width: 'min(720px, calc(100% - 24px))', zIndex: 2,
    }),
    ...(props.height === undefined ? {} : { height: props.height, bottom: 'auto' }),
  };
  return <section data-orbit-explorer="" aria-label={props.title ?? 'Graph exploration'} className={props.className} style={mergeStyle(rootStyle, props.style)}>
    <h2 style={{ margin: 0, fontSize: 17 }}>{props.title ?? 'Graph exploration'}</h2>
    <fieldset disabled={saved.status === 'restoring'} aria-busy={saved.status === 'restoring'}
      onClickCapture={(event) => { if (saved.status === 'restoring') { event.preventDefault(); event.stopPropagation(); } }}
      onKeyDownCapture={(event) => { if (saved.status === 'restoring' && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); } }}
      style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'contents' }}>
    <GraphSearch instance={instance} value={saved.searchQuery} onValueChange={(value) => investigation.setSearchQuery(value)}
      placeholder="Find an entity…" style={{ maxWidth: '100%' }}
      onResultActivate={(result) => { setSubject({ kind: 'node', id: result.id }); setUnavailable(null); }}
      onResultUnavailable={(result, reason) => setUnavailable({ result, reason })} />
    {unavailable !== null ? <div role="status" style={box}>
      {unavailable.result.label ?? unavailable.result.id}: {unavailable.reason === 'not-loaded' ? 'not loaded' : unavailable.reason === 'filtered' ? 'hidden by active filters' : 'outside the current scope'}.
      {props.onRecoverSearchResult !== undefined ? <button type="button" disabled={busy !== null} onClick={recover} style={{ marginLeft: 8 }}>
        {unavailable.reason === 'not-loaded' ? 'Load entity' : unavailable.reason === 'filtered' ? 'Reveal filtered entity' : 'Include in scope'}
      </button> : <span> Adjust the source or active constraints to reveal this entity.</span>}
    </div> : null}
    <section aria-label="Active constraints" style={box}>
      <h3 style={sectionTitle}>Current view · {state.visible.nodes} nodes · {state.visible.edges} relationships</h3>
      <div style={row}>{constraints.length === 0 ? <span>No active constraints</span> : constraints.map((constraint) => <button type="button" key={constraint.id}
        aria-label={`Clear ${constraint.label}`} disabled={busy !== null} onClick={() => void run(`Clear ${constraint.label}`, constraint.onClear)}>{constraint.label} ×</button>)}</div>
      <div style={{ ...row, marginTop: 8 }}>
        <button type="button" disabled={state.history.undoDepth === 0 || saved.status === 'restoring'} onClick={() => void run('Undo', () => { instance.undo(); })}>Undo last graph change</button>
        <button type="button" disabled={state.history.redoDepth === 0 || saved.status === 'restoring'} onClick={() => void run('Redo', () => { instance.redo(); })}>Redo graph change</button>
        <button type="button" disabled={state.selection.nodeIds.length === 0} onClick={() => instance.hideNodes(state.selection.nodeIds)}>Hide selected</button>
        <button type="button" disabled={state.selection.nodeIds.length === 0} onClick={() => instance.isolateSelection()}>Isolate selected</button>
        <button type="button" disabled={state.selection.nodeIds.length === 0} onClick={() => setSubject({ kind: 'selection', nodeIds: state.selection.nodeIds })}>Compare selection</button>
      </div>
    </section>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'stretch' }}>
      <section aria-label="Entity table" style={{ ...box, flex: '1 1 300px', overflow: 'hidden' }}>
        <h3 style={sectionTitle}>Entities</h3>
        <GraphTable ref={tableRef} instance={instance} {...(props.columns === undefined ? {} : { columns: props.columns })}
          height={230} filterText={tableQuery} onFilterTextChange={setTableQuery} label="Exploration table"
          onRowActivate={(entry) => { if (entry.id !== null) setSubject({ kind: entry.edge === undefined ? 'node' : 'edge', id: entry.id }); }}
          style={{ padding: 0, border: 0, maxWidth: '100%', overflowX: 'auto' }} />
        <button type="button" onClick={() => void run('Export CSV', () => download('orbit-entities.csv', tableRef.current?.exportCsv() ?? '', 'text/csv'))}>Download table CSV</button>
      </section>
      <GraphInspector instance={instance} subject={subject} onInspect={setSubject} layout="panel" typeField={typeField}
        style={{ ...box, flex: '1 1 260px', maxHeight: 440 }} />
    </div>
    <section aria-label="Explore relationships" style={box}>
      <h3 style={sectionTitle}>Expand {seed === undefined ? 'an entity' : nodeLabel(instance, seed)}</h3>
      <p>{neighborhood === null ? 'Inspect an entity or select a node to begin.' : `${neighborhood.totalNeighbors} matching neighbors already loaded. Expansion queries the configured source.`}</p>
      <div style={row}>
        <label>Direction <select aria-label="Expansion direction" value={direction} onChange={(event) => { setDirection(event.target.value as typeof direction); setExpansion(null); }}>
          <option value="either">Either direction</option><option value="outgoing">Outgoing</option><option value="incoming">Incoming</option>
        </select></label>
        <label>Relationship type <input aria-label="Relationship type" style={input} value={relationshipType} placeholder="All types"
          onChange={(event) => { setRelationshipType(event.target.value); setExpansion(null); }} /></label>
        <label>Page size <input type="number" aria-label="Expansion page size" min={1} max={1000} value={limit} style={{ ...input, width: 70 }}
          onChange={(event) => { setLimit(Math.max(1, Math.min(1000, Number(event.target.value) || 1))); setExpansion(null); }} /></label>
      </div>
      {neighborhood !== null && neighborhood.relationshipTypes.length > 0 ? <p>Loaded types: {neighborhood.relationshipTypes.map((entry) => `${entry.type || '(untyped)'} (${entry.count})`).join(', ')}</p> : null}
      <div style={{ ...row, marginTop: 8 }}>
        <button type="button" disabled={seed === undefined || expansionBusy || busy !== null} onClick={() => expand()}>Load relationships</button>
        {expansionPage?.nextCursor !== undefined ? <button type="button" disabled={expansionBusy || busy !== null} onClick={() => expand(expansionPage.nextCursor)}>Load next page</button> : null}
        {expansionBusy ? <button type="button" onClick={() => { if (seed !== undefined) instance.cancelExpansion(seed); }}>Cancel expansion</button> : null}
        <button type="button" disabled={seed === undefined} onClick={() => void run('Retract last page', () => { if (seed !== undefined) investigation.retractExpansion(seed); setExpansion(null); })}>Retract last page</button>
        <button type="button" disabled={seed === undefined} onClick={() => { if (seed !== undefined) instance.focusNode(seed); }}>Focus on graph</button>
      </div>
    </section>
    <section aria-label="Connection explanations" style={box}>
      <h3 style={sectionTitle}>Explain a connection</h3>
      <form onSubmit={(event) => { event.preventDefault(); findPath(); }} style={row}>
        <label>From <input style={input} aria-label="Path source" value={pathFrom} onChange={(event) => setPathFrom(event.target.value)} placeholder="Entity ID" /></label>
        <label>To <input style={input} aria-label="Path target" value={pathTo} onChange={(event) => setPathTo(event.target.value)} placeholder="Entity ID" /></label>
        <label>Direction <select aria-label="Path direction" value={pathDirection} onChange={(event) => setPathDirection(event.target.value as typeof pathDirection)}>
          <option value="either">Either direction</option><option value="outgoing">Outgoing</option><option value="incoming">Incoming</option>
        </select></label>
        <label>Graph <select aria-label="Path graph" value={pathUniverse} onChange={(event) => setPathUniverse(event.target.value as typeof pathUniverse)}>
          <option value="visible">Visible graph</option><option value="loaded">All loaded entities</option>
        </select></label>
        <label>Max hops <input aria-label="Path hop limit" type="number" min={0} max={1000} value={pathHops} style={{ ...input, width: 70 }}
          onChange={(event) => setPathHops(Math.max(0, Math.min(1000, Number(event.target.value) || 0)))} /></label>
        <label>Relationship type <input aria-label="Path relationship type" value={pathType} style={input} placeholder="All types" onChange={(event) => setPathType(event.target.value)} /></label>
        <button type="submit" disabled={pathBusy || pathFrom.trim() === '' || pathTo.trim() === ''}>{pathBusy ? 'Finding…' : 'Find connection'}</button>
        <button type="button" disabled={state.selection.nodeIds.length !== 2} onClick={() => { setPathFrom(state.selection.nodeIds[0]!); setPathTo(state.selection.nodeIds[1]!); }}>Use two selected nodes</button>
      </form>
      {saved.paths.map((entry) => <article key={entry.id} style={{ marginTop: 12 }} data-orbit-saved-path={entry.id}>
        <h4 style={sectionTitle}>{entry.title}</h4>
        <ol>{entry.path.nodeIds.map((id, index) => <li key={`${index}:${id}`}>
          <button type="button" onClick={() => setSubject({ kind: 'node', id })}>{nodeLabel(instance, id)}</button>
          {entry.path.edgeIds[index] !== undefined ? <>
            {' → '}<button type="button" onClick={() => setSubject({ kind: 'edge', id: entry.path.edgeIds[index]! })}>
              {cellText(instance.getEdge(entry.path.edgeIds[index]!)?.attrs?.[typeField]) || entry.path.edgeIds[index]}
            </button>
          </> : null}
        </li>)}</ol>
        <button type="button" onClick={() => void run('Highlight connection', async () => {
          const path = await instance.findPath(entry.sourceId, entry.targetId, entry.options);
          setNotice(path === null ? 'This connection is no longer available.' : 'Connection highlighted on graph.');
        })}>Highlight connection</button>{' '}
        <button type="button" onClick={() => investigation.removePath(entry.id)}>Remove explanation</button>
      </article>)}
    </section>
    <section aria-label="Investigation checkpoints" style={box}>
      <h3 style={sectionTitle}>Investigation</h3>
      <label style={{ display: 'block' }}>Title <input aria-label="Investigation title" style={{ ...input, width: '100%' }} value={saved.title} onChange={(event) => investigation.setTitle(event.target.value)} /></label>
      <label style={{ display: 'block', marginTop: 8 }}>Notes <textarea aria-label="Investigation notes" rows={3} style={{ ...input, width: '100%' }} value={saved.notes} onChange={(event) => investigation.setNotes(event.target.value)} /></label>
      <div style={{ ...row, marginTop: 8 }}>
        <button type="button" disabled={busy !== null || saved.status === 'restoring'} onClick={() => void run('Save checkpoint', async () => { await investigation.checkpoint(undefined, { includePositions: true }); setNotice('Checkpoint saved with source identity and view.'); })}>Save checkpoint</button>
        <label>Import checkpoint <input type="file" accept="application/json,.json" aria-label="Import checkpoint" disabled={saved.status === 'restoring'} onChange={(event) => {
          const file = event.target.files?.[0]; event.target.value = '';
          if (file !== undefined) void run('Import checkpoint', async () => {
            if (file.size > 16 * 1024 * 1024) throw new Error('Checkpoint exceeds the 16 MiB limit.');
            const issued = epoch.current;
            const raw: unknown = JSON.parse(await file.text());
            if (issued !== epoch.current) return;
            investigation.importCheckpoint(raw); setNotice('Checkpoint imported. Choose Restore to open it.');
          });
        }} /></label>
      </div>
      <ul>{saved.checkpoints.map((checkpoint) => <li key={checkpoint.id} style={{ marginTop: 8 }}>
        <strong>{checkpoint.title}</strong>{' · '}{checkpoint.source.datasetKey}{' @ '}{String(checkpoint.source.sourceRevision)}{' '}
        <button type="button" disabled={saved.status === 'restoring' || busy !== null} onClick={() => void run('Restore checkpoint', async () => { await investigation.restoreCheckpoint(checkpoint.id); setNotice('Checkpoint restored.'); })}>Restore {checkpoint.title}</button>{' '}
        <button type="button" onClick={() => void run('Export checkpoint', () => download('orbit-investigation.json', investigation.exportCheckpoint(checkpoint.id), 'application/json'))}>Export {checkpoint.title}</button>{' '}
        <button type="button" disabled={saved.status === 'restoring'} onClick={() => investigation.removeCheckpoint(checkpoint.id)}>Delete {checkpoint.title}</button>
      </li>)}</ul>
      <p>Checkpoints retain source identity. Restoring different data requires a host source loader.</p>
    </section>
    </fieldset>
    {(error ?? saved.error) !== null ? <div role="alert">{error ?? saved.error}</div> : null}
    <div role="status" aria-live="polite">{saved.status === 'restoring' ? 'Restoring investigation…' : busy === null ? notice : `${busy}…`}</div>
  </section>;
}
