/**
 * Durable investigation state above a graph instance. Checkpoints contain
 * source coordinates and replayable requests, never internal overlay IDs or
 * revision-bound pagination cursors. Storage and source loading belong to the
 * host; this module has no browser, filesystem, or network side effects.
 */
import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import type { ExpandNodeResult, GraphInstance } from './instance';
import type { ExpansionOptions, JsonValue, PathOptions, PathResult } from './types';
import { canonicalJson, validateViewState } from './viewState';
import type { GraphViewState } from './viewState';

export interface InvestigationSource {
  datasetKey: string;
  sourceRevision: number | string | null;
  dataRef?: JsonValue;
}

export type InvestigationExpansionOptions = Omit<ExpansionOptions, 'cursor' | 'onProgress'>;

export interface InvestigationExpansion {
  seedId: string;
  options: InvestigationExpansionOptions;
  /** Resume the preceding page for the same seed/query using its fresh cursor. */
  continuation: boolean;
}

export interface SavedInvestigationPath {
  id: string;
  title: string;
  sourceId: string;
  targetId: string;
  options: PathOptions;
  path: PathResult;
}

export interface GraphInvestigation {
  v: 1;
  id: string;
  title: string;
  notes: string;
  createdAt: string;
  source: InvestigationSource;
  view: GraphViewState;
  searchQuery: string;
  tableQuery?: string;
  expansions: readonly InvestigationExpansion[];
  paths: readonly SavedInvestigationPath[];
  /** JSON-owned filters, query parameters, and other host-specific intent. */
  hostState?: JsonValue;
}

export interface InvestigationSessionState {
  title: string;
  notes: string;
  searchQuery: string;
  tableQuery: string;
  paths: readonly SavedInvestigationPath[];
  expansions: readonly InvestigationExpansion[];
  checkpoints: readonly GraphInvestigation[];
  activeCheckpointId: string | null;
  status: 'idle' | 'restoring';
  error: string | null;
}

export interface InvestigationSessionOptions {
  /** Load the exact requested source and resolve after the instance accepts it. */
  loadSource?: (source: InvestigationSource, context: { signal: AbortSignal }) => Promise<void>;
  captureHostState?: () => JsonValue;
  /** Resolve after the host has reflected its state into graph props. */
  restoreHostState?: (state: JsonValue, context: { signal: AbortSignal }) => void | Promise<void>;
  now?: () => Date;
}

export interface InvestigationSession<N = Record<string, unknown>, E = Record<string, unknown>> {
  readonly store: StoreApi<InvestigationSessionState>;
  setTitle(title: string): void;
  setNotes(notes: string): void;
  setSearchQuery(query: string): void;
  setTableQuery(query: string): void;
  expandNode(id: string, options?: ExpansionOptions): Promise<ExpandNodeResult>;
  retractExpansion(id: string): void;
  savePath(path: Omit<SavedInvestigationPath, 'id' | 'title' | 'options'> & {
    title?: string;
    options?: PathOptions;
  }): SavedInvestigationPath;
  removePath(id: string): void;
  checkpoint(title?: string, options?: { includePositions?: boolean }): Promise<GraphInvestigation>;
  restoreCheckpoint(checkpoint: GraphInvestigation | string, options?: { signal?: AbortSignal }): Promise<void>;
  importCheckpoint(raw: unknown): GraphInvestigation;
  exportCheckpoint(checkpoint: GraphInvestigation | string): string;
  removeCheckpoint(id: string): void;
  /** Rebind a getter-backed session after the host replaces its instance. */
  refreshSource(): void;
  destroy(): void;
  /** Type-only association for consumers using an explicitly typed instance. */
  readonly graphTypes?: { node: N; edge: E };
}

export class InvestigationError extends Error {
  override readonly name = 'InvestigationError';
  constructor(
    readonly code: 'invalid-investigation' | 'source-mismatch' | 'graph-unavailable' |
      'restore-failed' | 'restore-pending' | 'aborted' | 'untracked-cursor' | 'untracked-expansion',
    message: string,
  ) { super(message); }
}

function invalid(message: string): never {
  throw new InvestigationError('invalid-investigation', message);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, nonempty = false): string {
  if (typeof value !== 'string' || (nonempty && value.length === 0)) invalid(`${name} must be ${nonempty ? 'a nonempty string' : 'a string'}`);
  return value;
}

/** Reject silent JSON coercion, accessors, parser objects, and cyclic state. */
function jsonCopy<T>(value: T): T {
  const seen = new Set<object>();
  const walk = (item: unknown, depth: number): void => {
    if (depth > 64) invalid('Investigation nesting exceeds 64 levels');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object') invalid('Investigation values must be finite JSON data');
    if (seen.has(item)) invalid('Investigation values must not contain cycles');
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) invalid('Investigation values must be plain JSON objects');
    seen.add(item);
    for (const key of Object.keys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!('value' in descriptor)) invalid('Investigation values must not contain accessors');
      // Optional object properties use standard JSON omission semantics.
      if (descriptor.value === undefined && !Array.isArray(item)) continue;
      walk(descriptor.value, depth + 1);
    }
    seen.delete(item);
  };
  walk(value, 0);
  const text = JSON.stringify(value);
  if (text.length > 16 * 1024 * 1024) invalid('Investigation exceeds the 16 MiB JSON limit');
  return JSON.parse(text) as T;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function relationshipOptions(value: unknown, name: string, path = false): Record<string, unknown> {
  const opts = object(value, name);
  const allowed = new Set(path
    ? ['direction', 'relationshipTypes', 'relationshipTypeField', 'universe', 'maxHops']
    : ['direction', 'relationshipTypes', 'relationshipTypeField', 'hops', 'limit', 'edgeLimit', 'preserveLayout']);
  for (const key of Object.keys(opts)) if (!allowed.has(key)) invalid(`${name}.${key} is not replayable`);
  if (opts.direction !== undefined && !['incoming', 'outgoing', 'either'].includes(String(opts.direction))) invalid(`${name}.direction is invalid`);
  if (opts.relationshipTypeField !== undefined) string(opts.relationshipTypeField, `${name}.relationshipTypeField`, true);
  if (opts.relationshipTypes !== undefined) {
    if (!Array.isArray(opts.relationshipTypes) || !opts.relationshipTypes.every((v) => typeof v === 'string')) invalid(`${name}.relationshipTypes must be strings`);
  }
  for (const [key, max] of [['hops', 1000], ['maxHops', 1000], ['limit', 1000], ['edgeLimit', 10000]] as const) {
    const n = opts[key];
    if (n !== undefined && (typeof n !== 'number' || !Number.isInteger(n) || n < (key === 'maxHops' ? 0 : 1) || n > max)) invalid(`${name}.${key} is outside its supported bounds`);
  }
  if (opts.preserveLayout !== undefined && typeof opts.preserveLayout !== 'boolean') invalid(`${name}.preserveLayout must be boolean`);
  if (opts.universe !== undefined && opts.universe !== 'loaded' && opts.universe !== 'visible') invalid(`${name}.universe is invalid`);
  return opts;
}

function validatePath(value: unknown): SavedInvestigationPath {
  const p = object(value, 'path');
  for (const key of ['id', 'title', 'sourceId', 'targetId']) string(p[key], `path.${key}`, key !== 'title');
  relationshipOptions(p.options, 'path.options', true);
  const result = object(p.path, 'path.path');
  for (const key of ['nodeIds', 'edgeIds']) {
    if (!Array.isArray(result[key]) || !(result[key] as unknown[]).every((id) => typeof id === 'string')) invalid(`path.path.${key} must be strings`);
  }
  const nodes = result.nodeIds as string[];
  const edges = result.edgeIds as string[];
  if (nodes.length === 0 || nodes[0] !== p.sourceId || nodes.at(-1) !== p.targetId || edges.length !== nodes.length - 1) invalid('Saved path endpoints and ordered steps do not agree');
  return p as unknown as SavedInvestigationPath;
}

/** Validate the complete envelope before source loading or graph mutation. */
export function parseInvestigation(raw: unknown): GraphInvestigation {
  let input = raw;
  if (typeof raw === 'string') {
    if (raw.length > 16 * 1024 * 1024) invalid('Investigation exceeds the 16 MiB JSON limit');
    try { input = JSON.parse(raw); } catch { invalid('Investigation is not valid JSON'); }
  }
  const value = object(jsonCopy(input), 'investigation');
  if (value.v !== 1) invalid('Unsupported investigation version');
  for (const key of ['id', 'title', 'notes', 'createdAt', 'searchQuery']) string(value[key], key, key === 'id');
  value.tableQuery = value.tableQuery === undefined ? '' : string(value.tableQuery, 'tableQuery');
  if (!Number.isFinite(Date.parse(value.createdAt as string))) invalid('createdAt must be an ISO date');
  const source = object(value.source, 'source');
  string(source.datasetKey, 'source.datasetKey', true);
  const revision = source.sourceRevision;
  if (revision !== null && typeof revision !== 'string' && !(typeof revision === 'number' && Number.isFinite(revision))) invalid('source.sourceRevision must be a string, finite number, or null');
  const view = validateViewState(value.view);
  if (!view.ok) invalid(view.problems.join('; '));
  if (canonicalJson(source.dataRef as JsonValue | undefined) !== canonicalJson(view.state.dataRef)) invalid('Source reference and view reference must agree');
  if (!Array.isArray(value.expansions) || value.expansions.length > 10000) invalid('expansions must contain at most 10000 requests');
  const priorQueries = new Set<string>();
  for (const entry of value.expansions) {
    const action = object(entry, 'expansion');
    string(action.seedId, 'expansion.seedId', true);
    relationshipOptions(action.options, 'expansion.options');
    if (typeof action.continuation !== 'boolean') invalid('expansion.continuation must be boolean');
    const key = queryKey(action.seedId as string, action.options as InvestigationExpansionOptions);
    if (action.continuation && !priorQueries.has(key)) invalid('An expansion continuation needs a preceding page');
    priorQueries.add(key);
  }
  if (!Array.isArray(value.paths) || value.paths.length > 10000) invalid('paths must contain at most 10000 results');
  const ids = new Set<string>();
  for (const path of value.paths) {
    const parsed = validatePath(path);
    if (ids.has(parsed.id)) invalid('Saved path IDs must be unique');
    ids.add(parsed.id);
  }
  return freeze(value as unknown as GraphInvestigation);
}

export function serializeInvestigation(value: GraphInvestigation): string {
  return JSON.stringify(parseInvestigation(value), null, 2);
}

function queryKey(seedId: string, options: InvestigationExpansionOptions): string {
  return canonicalJson([seedId, options] as unknown as JsonValue)!;
}

function replayOptions(options: ExpansionOptions): InvestigationExpansionOptions {
  const { cursor: _cursor, onProgress: _onProgress, ...serializable } = options;
  relationshipOptions(serializable, 'expansion.options');
  return jsonCopy(serializable);
}

/**
 * Route durable expansion/path actions through this controller. Operations
 * performed directly on the instance remain ordinary session-local actions.
 * A getter supports hosts that replace their graph instance when loading a
 * different source. `loadSource` must honor its signal and resolve only once
 * the requested source is accepted by the getter's current instance.
 */
export function createInvestigationSession<N = Record<string, unknown>, E = Record<string, unknown>>(
  target: GraphInstance<N, E> | (() => GraphInstance<N, E> | null),
  options: InvestigationSessionOptions = {},
): InvestigationSession<N, E> {
  const store = createStore<InvestigationSessionState>(() => ({
    title: 'Untitled investigation', notes: '', searchQuery: '', tableQuery: '', paths: [], expansions: [],
    checkpoints: [], activeCheckpointId: null, status: 'idle', error: null,
  }));
  const get = typeof target === 'function' ? target : () => target;
  let disposed = false;
  let sequence = 0;
  let restoreFlight: AbortController | null = null;
  let trackedSource: string | null = null;
  let bound: GraphInstance<N, E> | null = null;
  let unsubscribe: (() => void) | null = null;
  const cursors = new Map<string, string>();
  // Query recipes include no-op pages needed to regenerate continuations.
  // Only actual admitted contributions may be retracted from the instance.
  const ownedActions = new WeakSet<InvestigationExpansion>();
  const recordIds = new WeakMap<InvestigationExpansion, string>();
  let actionCatalog: InvestigationExpansion[] = [];
  const pendingSeeds = new Set<string>();
  const now = options.now ?? (() => new Date());
  const nextId = (kind: string) => `${kind}-${now().getTime()}-${++sequence}`;
  const graph = (): GraphInstance<N, E> => {
    const instance = get();
    if (disposed || instance === null || instance.store.getState().status === 'destroyed') throw new InvestigationError('graph-unavailable', 'The investigation graph is unavailable');
    return instance;
  };
  const sourceOf = (instance: GraphInstance<N, E>): InvestigationSource => {
    const source = instance.getSource();
    if (source === null) throw new InvestigationError('graph-unavailable', 'Load a graph before saving or restoring an investigation');
    const dataRef = instance.getViewState().dataRef;
    return { ...source, ...(dataRef === undefined ? {} : { dataRef }) };
  };
  const sourceKey = (source: InvestigationSource) => canonicalJson(source as unknown as JsonValue)!;
  const syncSource = (instance: GraphInstance<N, E>) => {
    const key = sourceKey(sourceOf(instance));
    if (trackedSource !== null && trackedSource !== key) {
      cursors.clear();
      actionCatalog = [];
      store.setState({ expansions: [], paths: [], activeCheckpointId: null });
    }
    trackedSource = key;
    return key;
  };
  const reconcileHistory = (instance: GraphInstance<N, E>) => {
    const live = new Set(instance.getExpansionRecords().map((record) => record.overlayId));
    const queries = new Set<string>();
    const active = actionCatalog.filter((action) => {
      const id = recordIds.get(action);
      const key = queryKey(action.seedId, action.options);
      if ((id !== undefined && !live.has(id)) || (action.continuation && !queries.has(key))) return false;
      queries.add(key);
      return true;
    });
    const previous = store.getState().expansions;
    if (active.length !== previous.length || active.some((action, index) => action !== previous[index])) {
      if (previous.some((action) => !active.includes(action))) cursors.clear();
      store.setState({ expansions: freeze(active), activeCheckpointId: null });
    }
  };
  const trackAction = (instance: GraphInstance<N, E>, action: InvestigationExpansion, result: ExpandNodeResult) => {
    if ('added' in result) {
      ownedActions.add(action);
      const record = instance.getExpansionRecords().filter((item) => item.expandedId === action.seedId).at(-1);
      if (record?.overlayId != null) recordIds.set(action, record.overlayId);
    }
    actionCatalog.push(action);
  };
  const assertRetractable = (instance: GraphInstance<N, E>, actions: readonly InvestigationExpansion[]) => {
    const records = [...instance.getExpansionRecords()];
    for (const action of actions) {
      if (!ownedActions.has(action)) continue;
      let index = records.length - 1;
      while (index >= 0 && records[index]!.expandedId !== action.seedId) index--;
      if (index < 0 || records[index]!.overlayId !== recordIds.get(action)) {
        throw new InvestigationError('untracked-expansion', `An expansion of '${action.seedId}' changed outside this investigation; reconcile it before retracting or restoring`);
      }
      records.splice(index, 1);
    }
  };
  const refreshSource = () => {
    if (disposed) return;
    const instance = get();
    if (instance !== bound) {
      unsubscribe?.();
      bound = instance;
      unsubscribe = instance?.store.subscribe((next, previous) => {
        if (!disposed && instance.getSource() !== null && (next.revisions.model !== previous.revisions.model || next.revisions.scope !== previous.revisions.scope || next.history !== previous.history)) {
          syncSource(instance);
          if (restoreFlight === null) reconcileHistory(instance);
        }
      }) ?? null;
    }
    if (instance !== null && instance.getSource() !== null) { syncSource(instance); reconcileHistory(instance); }
  };
  const editable = () => {
    if (disposed) throw new InvestigationError('graph-unavailable', 'The investigation session was destroyed');
    if (restoreFlight !== null) throw new InvestigationError('restore-pending', 'Wait for the investigation restore to finish');
  };
  const checkAbort = (signal: AbortSignal) => {
    if (disposed || signal.aborted) throw new InvestigationError('aborted', 'Investigation restore was cancelled');
  };
  const resolveCheckpoint = (value: GraphInvestigation | string): GraphInvestigation => {
    if (typeof value !== 'string') return parseInvestigation(value);
    const result = store.getState().checkpoints.find((item) => item.id === value);
    if (result === undefined) invalid(`Unknown checkpoint: ${value}`);
    return result;
  };
  const remember = (checkpoint: GraphInvestigation) => {
    const prior = store.getState().checkpoints;
    store.setState({ checkpoints: freeze([...prior.filter((v) => v.id !== checkpoint.id), checkpoint]) });
  };
  const recordPage = (seedId: string, opts: InvestigationExpansionOptions, result: ExpandNodeResult) => {
    const key = queryKey(seedId, opts);
    const cursor = result.page?.nextCursor;
    if (cursor === undefined) cursors.delete(key);
    else cursors.set(key, cursor);
  };

  const api: InvestigationSession<N, E> = {
    store,
    refreshSource,
    setTitle(title) { editable(); store.setState({ title: string(title, 'title') }); },
    setNotes(notes) { editable(); store.setState({ notes: string(notes, 'notes') }); },
    setSearchQuery(searchQuery) { editable(); store.setState({ searchQuery: string(searchQuery, 'searchQuery') }); },
    setTableQuery(tableQuery) { editable(); store.setState({ tableQuery: string(tableQuery, 'tableQuery') }); },
    async expandNode(id, expandOptions = {}) {
      editable();
      const instance = graph();
      const source = syncSource(instance);
      const serializable = replayOptions(expandOptions);
      const key = queryKey(id, serializable);
      if (expandOptions.cursor !== undefined && cursors.get(key) !== expandOptions.cursor) throw new InvestigationError('untracked-cursor', 'Load the preceding page through this investigation before continuing');
      if (pendingSeeds.has(id)) throw new InvestigationError('restore-pending', 'This entity already has an expansion in progress');
      pendingSeeds.add(id);
      try {
        const result = await instance.expandNode(id, expandOptions);
        if (disposed || get() !== instance || sourceKey(sourceOf(instance)) !== source) throw new InvestigationError('source-mismatch', 'The graph source changed during expansion');
        recordPage(id, serializable, result);
        const action = freeze({ seedId: id, options: serializable, continuation: expandOptions.cursor !== undefined });
        trackAction(instance, action, result);
        store.setState({ expansions: freeze([...store.getState().expansions, action]), activeCheckpointId: null, error: null });
        return result;
      } finally { pendingSeeds.delete(id); }
    },
    retractExpansion(id) {
      editable();
      if (pendingSeeds.has(id)) { graph().cancelExpansion(id); return; }
      const instance = graph();
      syncSource(instance);
      const actions = [...store.getState().expansions];
      let index = actions.length - 1;
      while (index >= 0 && actions[index]!.seedId !== id) index--;
      if (index < 0) return;
      const [removed] = actions.splice(index, 1);
      assertRetractable(instance, [removed!]);
      if (ownedActions.has(removed!)) instance.retractExpansion(id);
      else actionCatalog = actionCatalog.filter((action) => action !== removed);
      cursors.delete(queryKey(id, removed!.options));
      store.setState({ expansions: freeze(actions), activeCheckpointId: null });
    },
    savePath(input) {
      editable();
      syncSource(graph());
      const path = freeze(jsonCopy(validatePath({ ...input, id: nextId('path'), title: input.title ?? `${input.sourceId} → ${input.targetId}`, options: input.options ?? {} })));
      store.setState({ paths: freeze([...store.getState().paths, path]), activeCheckpointId: null });
      return path;
    },
    removePath(id) { editable(); store.setState({ paths: store.getState().paths.filter((p) => p.id !== id), activeCheckpointId: null }); },
    async checkpoint(title, captureOptions = {}) {
      editable();
      if (pendingSeeds.size > 0) throw new InvestigationError('restore-pending', 'Wait for pending expansions before saving a checkpoint');
      const instance = graph();
      const key = syncSource(instance);
      const state = store.getState();
      const revision = instance.getRevisions();
      const source = sourceOf(instance);
      const view = captureOptions.includePositions === false
        ? instance.getViewState()
        : await instance.getViewState({ includePositions: true });
      const after = instance.getRevisions();
      if (disposed || get() !== instance || sourceKey(sourceOf(instance)) !== key || after.model !== revision.model || after.scope !== revision.scope || pendingSeeds.size > 0) throw new InvestigationError('source-mismatch', 'The graph changed while saving; save a new checkpoint');
      const checkpoint = parseInvestigation({
        v: 1, id: nextId('checkpoint'), title: title ?? state.title, notes: state.notes,
        createdAt: now().toISOString(), source, view, searchQuery: state.searchQuery, tableQuery: state.tableQuery,
        expansions: state.expansions, paths: state.paths,
        ...(options.captureHostState === undefined ? {} : { hostState: options.captureHostState() }),
      });
      remember(checkpoint);
      store.setState({ activeCheckpointId: checkpoint.id, title: checkpoint.title, error: null });
      return checkpoint;
    },
    async restoreCheckpoint(value, restoreOptions = {}) {
      editable();
      if (pendingSeeds.size > 0) throw new InvestigationError('restore-pending', 'Cancel pending expansions before restoring');
      const checkpoint = resolveCheckpoint(value);
      if (checkpoint.hostState !== undefined && options.restoreHostState === undefined) throw new InvestigationError('restore-failed', 'This checkpoint requires a host-state restore callback');
      const current = graph();
      const currentSource = sourceOf(current);
      const mismatch = sourceKey(currentSource) !== sourceKey(checkpoint.source);
      if (mismatch && options.loadSource === undefined) throw new InvestigationError('source-mismatch', 'Load the checkpoint source before restoring this investigation');
      const flight = new AbortController();
      const upstream = restoreOptions.signal;
      const abort = () => flight.abort();
      if (upstream?.aborted) abort();
      else upstream?.addEventListener('abort', abort, { once: true });
      checkAbort(flight.signal);
      restoreFlight = flight;
      store.setState({ status: 'restoring', error: null });
      const applied: InvestigationExpansion[] = [];
      let replayStarted = false;
      let instance = current;
      try {
        if (mismatch) {
          await options.loadSource!(checkpoint.source, { signal: flight.signal });
          checkAbort(flight.signal);
          instance = graph();
        }
        if (sourceKey(sourceOf(instance)) !== sourceKey(checkpoint.source)) throw new InvestigationError('source-mismatch', 'The loaded source does not match this checkpoint');
        if (!mismatch && trackedSource === sourceKey(currentSource)) {
          const retract = [...store.getState().expansions].reverse();
          assertRetractable(instance, retract);
          replayStarted = true;
          for (const action of retract) {
            if (ownedActions.has(action)) instance.retractExpansion(action.seedId);
          }
        }
        replayStarted = true;
        cursors.clear();
        trackedSource = sourceKey(checkpoint.source);
        const replayed: InvestigationExpansion[] = [];
        actionCatalog = [];
        store.setState({ expansions: [], paths: [], activeCheckpointId: null });
        for (const action of checkpoint.expansions) {
          checkAbort(flight.signal);
          if (get() !== instance || sourceKey(sourceOf(instance)) !== trackedSource) throw new InvestigationError('source-mismatch', 'The source changed during investigation restore');
          const cursor = action.continuation ? cursors.get(queryKey(action.seedId, action.options)) : undefined;
          if (action.continuation && cursor === undefined) throw new InvestigationError('restore-failed', 'An expansion no longer has the saved continuation page');
          const cancel = () => instance.cancelExpansion(action.seedId);
          flight.signal.addEventListener('abort', cancel, { once: true });
          let result: ExpandNodeResult;
          try { result = await instance.expandNode(action.seedId, { ...action.options, ...(cursor === undefined ? {} : { cursor }) }); }
          finally { flight.signal.removeEventListener('abort', cancel); }
          if ('added' in result) applied.push(action);
          trackAction(instance, action, result);
          checkAbort(flight.signal);
          recordPage(action.seedId, action.options, result);
          replayed.push(action);
        }
        if (checkpoint.hostState !== undefined) await options.restoreHostState!(checkpoint.hostState, { signal: flight.signal });
        checkAbort(flight.signal);
        if (get() !== instance || sourceKey(sourceOf(instance)) !== trackedSource) throw new InvestigationError('source-mismatch', 'The source changed before restoring the saved view');
        const result = await instance.setViewState(checkpoint.view);
        checkAbort(flight.signal);
        if (result.status !== 'applied') throw new InvestigationError('restore-failed', result.status === 'mismatch' ? 'The view source reference changed' : result.problems.join('; '));
        remember(checkpoint);
        store.setState({ title: checkpoint.title, notes: checkpoint.notes, searchQuery: checkpoint.searchQuery, tableQuery: checkpoint.tableQuery ?? '',
          expansions: freeze(replayed), paths: checkpoint.paths, activeCheckpointId: checkpoint.id });
      } catch (error) {
        // Roll back only expansion contributions admitted by this restore.
        if (!disposed && get() === instance && instance.getSource() !== null && instance.store.getState().status !== 'destroyed' && sourceKey(sourceOf(instance)) === trackedSource) {
          for (const action of applied.reverse()) {
            // A concurrent host action must never be removed as our rollback.
            try { assertRetractable(instance, [action]); }
            catch { continue; }
            instance.retractExpansion(action.seedId);
          }
        }
        if (replayStarted) { cursors.clear(); actionCatalog = []; }
        if (!disposed) store.setState({ ...(replayStarted ? { expansions: [] } : {}), error: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        upstream?.removeEventListener('abort', abort);
        restoreFlight = null;
        if (!disposed) store.setState({ status: 'idle' });
      }
    },
    importCheckpoint(raw) { editable(); const checkpoint = parseInvestigation(raw); remember(checkpoint); return checkpoint; },
    exportCheckpoint(value) { return serializeInvestigation(resolveCheckpoint(value)); },
    removeCheckpoint(id) {
      editable();
      store.setState({ checkpoints: store.getState().checkpoints.filter((c) => c.id !== id),
        ...(store.getState().activeCheckpointId === id ? { activeCheckpointId: null } : {}) });
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      restoreFlight?.abort();
      const instance = get();
      for (const seed of pendingSeeds) instance?.cancelExpansion(seed);
      pendingSeeds.clear();
      cursors.clear();
    },
  };
  refreshSource();
  return api;
}
