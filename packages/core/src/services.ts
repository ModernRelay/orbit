/**
 * revision-aware services — pure sequencing/admission/caching helpers
 * plus the built-in local expansion service.
 *
 * The correctness gate is `admitServiceResult`: a result is admitted only if
 * every revision dimension the service DECLARED is unchanged since the call
 * was issued; undeclared dimensions never invalidate (so e.g. the local
 * expansion service, declaring only 'source', survives unrelated model/scope
 * advances from other overlay publications). Abort is an optimization
 * admission is the gate.
 *
 * Cache keys include service identity, canonical-JSON request parameters,
 * `datasetKey`, and EXACTLY the declared revision dimensions' current values.
 *
 * Nothing here touches the engine, the store, or the DOM; the instance wires
 * these primitives to its acceptance queue.
 */

import { OrbitOperationError } from './errors';
import { resolveScope } from './scope';
import type { Adjacency } from './adjacency';
import type {
  AcceptedGraph,
  ExpansionResponse,
  ExpansionService,
  NodeId,
  RequestContext,
  RevisionDimension,
} from './types';

// ---------------------------------------------------------------------------
// Request contexts
// ---------------------------------------------------------------------------

/** Current value of each revision dimension (a Revisions subset). */
export interface RevisionSnapshot {
  source: number | string | null;
  model: number;
  scope: number;
}

/** Canonical dimension order — makes cache keys independent of declaration order. */
const DIMENSION_ORDER: readonly RevisionDimension[] = ['source', 'model', 'scope'];

let requestSeq = 0;

/** Monotonic instance-process-unique request id (deterministic prefix for tests). */
export function nextRequestId(prefix = 'req'): string {
  requestSeq += 1;
  return `${prefix}-${requestSeq}`;
}

export interface CreateRequestContextArgs {
  datasetKey: string;
  /** Revision values current at issue time (snapshotted into the context). */
  revisions: RevisionSnapshot;
  /** Explicit id (e.g. for coalescing bookkeeping); generated when omitted. */
  requestId?: string;
  /** Chain an upstream signal (e.g. instance teardown) into this request. */
  parentSignal?: AbortSignal;
}

/** A `RequestContext` plus its owning abort handle. */
export interface RequestContextHandle {
  readonly context: RequestContext;
  readonly controller: AbortController;
  abort(reason?: unknown): void;
}

/**
 * Builds the `RequestContext` a service call receives: dataset,
 * the three revision dimensions at issue time, a request id, and a
 * cancellation signal owned by the returned controller.
 */
export function createRequestContext(args: CreateRequestContextArgs): RequestContextHandle {
  const controller = new AbortController();
  const { parentSignal } = args;
  if (parentSignal !== undefined) {
    if (parentSignal.aborted) controller.abort(parentSignal.reason);
    else parentSignal.addEventListener('abort', () => controller.abort(parentSignal.reason), { once: true });
  }
  const context: RequestContext = {
    datasetKey: args.datasetKey,
    sourceRevision: args.revisions.source,
    modelRevision: args.revisions.model,
    scopeRevision: args.revisions.scope,
    requestId: args.requestId ?? nextRequestId(),
    signal: controller.signal,
  };
  return {
    context,
    controller,
    abort: (reason?: unknown) => controller.abort(reason),
  };
}

// ---------------------------------------------------------------------------
// Admission gate
// ---------------------------------------------------------------------------

export interface AdmitServiceResultArgs {
  /** The service's `revisionDependencies`. */
  declared: readonly RevisionDimension[];
  /** Revision values when the request was issued. */
  at: RevisionSnapshot;
  /** Revision values at admission time. */
  now: RevisionSnapshot;
}

/**
 * stale-result rule: admit a service result iff EVERY declared revision
 * dimension is unchanged between issue and admission. Undeclared dimensions
 * never invalidate. Declaring nothing means the result is admissible under
 * any drift; declaring all three restores strict point-in-model semantics.
 */
export function admitServiceResult(args: AdmitServiceResultArgs): boolean {
  for (const dimension of args.declared) {
    if (args.at[dimension] !== args.now[dimension]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Cache keys
// ---------------------------------------------------------------------------

/**
 * Canonical JSON: object keys sorted recursively, `undefined`-valued keys
 * omitted (as in JSON.stringify), non-finite numbers serialized as null.
 * Array order is significant (it is data).
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ',';
      out += canonicalJson(value[i]);
    }
    return out + ']';
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    let out = '{';
    let first = true;
    for (const key of keys) {
      const entry = record[key];
      if (entry === undefined) continue;
      if (!first) out += ',';
      first = false;
      out += `${JSON.stringify(key)}:${canonicalJson(entry)}`;
    }
    return out + '}';
  }
  throw new TypeError(`serviceCacheKey: unsupported params value of type ${typeof value}`);
}

export interface ServiceCacheKeyArgs {
  serviceId: string;
  /** Request parameters (JSON-shaped); key order is canonicalized away. */
  params: unknown;
  datasetKey: string;
  /** The service's declared revision dependencies. */
  declared: readonly RevisionDimension[];
  /** Current revision values; only declared dimensions enter the key. */
  revisions: RevisionSnapshot;
}

/**
 * cache-key rule: service identity + canonical-JSON params +
 * `datasetKey` + EXACTLY the declared revision dimensions' current values.
 * Declaration-list order and params key order do not affect the key;
 * undeclared revision drift never changes it.
 */
export function serviceCacheKey(args: ServiceCacheKeyArgs): string {
  const declared = new Set(args.declared);
  const revisionPart: Partial<Record<RevisionDimension, number | string | null>> = {};
  for (const dimension of DIMENSION_ORDER) {
    if (declared.has(dimension)) revisionPart[dimension] = args.revisions[dimension];
  }
  return canonicalJson([args.serviceId, args.datasetKey, args.params ?? null, revisionPart]);
}

// ---------------------------------------------------------------------------
// Built-in local expansion service
// ---------------------------------------------------------------------------

/** Accepted-base view the local service walks (thunked for lazy wiring). */
export interface LocalExpansionBase<N = Record<string, unknown>, E = Record<string, unknown>> {
  accepted: AcceptedGraph<N, E>;
  /** The CSR adjacency of `accepted` (see buildAcceptedAdjacency). */
  adjacency: Adjacency;
}

function abortReasonOf(signal: AbortSignal): unknown {
  return (signal as { reason?: unknown }).reason;
}

function throwAborted(signal: AbortSignal): never {
  const reason = abortReasonOf(signal);
  throw new OrbitOperationError(
    reason === undefined ? { code: 'aborted' } : { code: 'aborted', cause: reason },
  );
}

/**
 * The built-in expansion service: walks the core's accepted-base
 * adjacency — INCLUDING currently out-of-scope nodes (it reads the base, not
 * the scene) — with zero config and zero network. Declares
 * `revisionDependencies: ['source']`, so unrelated model/scope advances
 * (e.g. other overlay publications) never invalidate its results.
 *
 * `getBase` is a thunk so the instance can wire the service before data
 * arrives; it is re-read on every call. The returned promise is async but
 * effectively synchronous (resolves without I/O). `ctx.signal` is honored:
 * an aborted call rejects with `OrbitOperationError { code: 'aborted' }`
 * instead of returning a result (abort is still only an optimization — the
 * admission gate is authoritative).
 *
 * The response is the CLOSED N-hop neighborhood (seeds included, plus every
 * edge between returned nodes); the overlay merger dedupes rows
 * that already exist, so returning already-known seeds is correct.
 */
export function createLocalExpansionService<N = Record<string, unknown>, E = Record<string, unknown>>(
  getBase: () => LocalExpansionBase<N, E>,
): ExpansionService<N, E> {
  return {
    revisionDependencies: ['source'],
    async neighbors(
      seedIds: readonly NodeId[],
      hops: number,
      ctx: RequestContext,
    ): Promise<ExpansionResponse<N, E>> {
      if (ctx.signal.aborted) throwAborted(ctx.signal);
      const { accepted, adjacency } = getBase();
      const resolved = resolveScope(accepted, { seedIds, hops }, adjacency);
      if (ctx.signal.aborted) throwAborted(ctx.signal);
      return { nodes: resolved.nodes, edges: resolved.edges };
    },
  };
}

// ---------------------------------------------------------------------------
// Expansion coalescing bookkeeping
// ---------------------------------------------------------------------------

export type RegisterExpansionResult =
  | { kind: 'new' }
  /** A same-id expansion is already in flight; its result serves both. */
  | { kind: 'coalesced'; onto: string };

/**
 * Pure in-flight-expansion ledger: within one valid scope revision a
 * second `expandNode(id)` while one is in flight coalesces into the pending
 * call; expansions of DISTINCT ids run (and complete) concurrently and
 * independently. `retractExpansion(id)` uses `abort(id)` to drop that id's
 * pending expansion. Holds no timers, promises, or engine state — the
 * instance owns the actual requests.
 */
export class PendingExpansions {
  private readonly inFlight = new Map<NodeId, string>();

  /**
   * Registers an expansion of `id` under `requestId`. Returns
   * `{ kind: 'coalesced', onto }` when a same-id expansion is already in
   * flight (the caller must NOT issue a new request; `onto` is the request
   * id whose result serves both), else records the id and returns
   * `{ kind: 'new' }`.
   */
  register(id: NodeId, requestId: string): RegisterExpansionResult {
    const existing = this.inFlight.get(id);
    if (existing !== undefined) return { kind: 'coalesced', onto: existing };
    this.inFlight.set(id, requestId);
    return { kind: 'new' };
  }

  /**
   * Marks `id`'s expansion complete. When `requestId` is given, clears only
   * if it still owns the slot (a stale completion after abort + re-expand
   * must not clear the newer request). Returns whether the slot was cleared.
   */
  resolve(id: NodeId, requestId?: string): boolean {
    if (requestId !== undefined && this.inFlight.get(id) !== requestId) return false;
    return this.inFlight.delete(id);
  }

  /**
   * Drops `id`'s pending expansion (retractExpansion path). Returns the aborted
   * request id so the caller can cancel its controller, or null when nothing
   * was in flight.
   */
  abort(id: NodeId): string | null {
    const requestId = this.inFlight.get(id);
    if (requestId === undefined) return null;
    this.inFlight.delete(id);
    return requestId;
  }

  /** Request id currently serving `id`, if any. */
  requestIdFor(id: NodeId): string | undefined {
    return this.inFlight.get(id);
  }

  has(id: NodeId): boolean {
    return this.inFlight.has(id);
  }

  get size(): number {
    return this.inFlight.size;
  }

  /** Snapshot of pending ids (store's `pendingExpansions` shape). */
  ids(): ReadonlySet<NodeId> {
    return new Set(this.inFlight.keys());
  }
}
