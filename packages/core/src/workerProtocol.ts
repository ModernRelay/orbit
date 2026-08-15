/**
 * Worker-lane wire protocol: envelope codec, epoch guards,
 * consolidated transfer lists, and request-class bookkeeping
 * (guaranteed-vs-throttled). Pure functions and one small class; no Worker
 * construction here — the runtime that OWNS a thread imports this, and the
 * parity suite drives the same codec in-process (the codec is the unit
 * under test; a live thread adds scheduling, not semantics).
 *
 * Contract invariants (each pinned by test):
 * - `msgId` is monotonic PER DIRECTION; a reply names the request it answers
 * via `inReplyTo`.
 * - Every envelope carries the model acceptance `epoch` it derived from
 * (I1 discipline: references do not cross threads — epochs replace them).
 * Results for a superseded epoch are dropped AT THE BOUNDARY, before the
 * acceptance queue ever sees them.
 * - Transfers are CONSOLIDATED: one ArrayBuffer per channel per message,
 * deduplicated (two views over one buffer transfer once).
 * - Request classes: 'guaranteed' requests all complete (structural
 * derivation); 'throttled' requests coalesce LATEST-WINS per lane key
 * (styling reprojection) — superseding a pending throttled request aborts
 * the old one.
 */

export type WorkerEntity = 'nodes' | 'edges' | 'scene';

export interface WorkerEnvelope {
  msgId: number;
  /** The request this envelope answers (results/errors only). */
  inReplyTo?: number;
  /** Model acceptance epoch the payload derives from. */
  epoch: number;
  entity: WorkerEntity;
  op: string;
  payload: unknown;
}

/** One direction of the channel: monotonic ids + epoch stamping. */
export class EnvelopeSequencer {
  private nextId = 1;

  make(
    epoch: number,
    entity: WorkerEntity,
    op: string,
    payload: unknown,
    inReplyTo?: number,
  ): WorkerEnvelope {
    const envelope: WorkerEnvelope = { msgId: this.nextId, epoch, entity, op, payload };
    this.nextId += 1;
    if (inReplyTo !== undefined) envelope.inReplyTo = inReplyTo;
    return envelope;
  }
}

/**
 * Boundary guard: does an arriving envelope still apply? Stale epochs are
 * dropped silently (superseded work is EXPECTED under latest-wins, not an
 * error); a FUTURE epoch is a protocol violation (the other side cannot
 * know an epoch this side has not yet issued).
 */
export type EpochVerdict = 'accept' | 'stale' | 'protocol-violation';

export function judgeEpoch(envelope: WorkerEnvelope, currentEpoch: number): EpochVerdict {
  if (envelope.epoch === currentEpoch) return 'accept';
  if (envelope.epoch < currentEpoch) return 'stale';
  return 'protocol-violation';
}

/**
 * Consolidated transfer list: every DISTINCT underlying ArrayBuffer behind
 * the given views, in first-seen order. Two views over one buffer yield one
 * entry (transferring twice throws in every engine). SharedArrayBuffer is
 * excluded by construction — the D3 contract never requires shared memory.
 */
export function collectTransfers(views: readonly ArrayBufferView[]): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  const out: ArrayBuffer[] = [];
  for (const view of views) {
    const buffer = view.buffer;
    if (!(buffer instanceof ArrayBuffer)) continue; // SAB stays shared
    if (seen.has(buffer)) continue;
    seen.add(buffer);
    out.push(buffer);
  }
  return out;
}

/** Request classes (Mosaic split): 'guaranteed' all complete; 'throttled'
 * coalesces latest-wins per lane. */
export type RequestClass = 'guaranteed' | 'throttled';

interface PendingRequest {
  envelope: WorkerEnvelope;
  klass: RequestClass;
  /** Lane key for throttled coalescing (e.g. 'project:pointColor'). */
  lane: string;
  controller: AbortController;
}

/**
 * Main-side request ledger. Owns AbortControllers and the latest-wins rule;
 * transport (postMessage or the in-process double) is injected by the
 * caller, so the ledger is testable without a thread.
 */
export class RequestLedger {
  private readonly pending = new Map<number, PendingRequest>();

  /** Register an outbound request. A throttled request SUPERSEDES any
   * pending request on the same lane: the old one is aborted and forgotten
   * (its eventual reply will be dropped as unmatched). Returns the signal
   * the transport should honor. */
  track(envelope: WorkerEnvelope, klass: RequestClass, lane: string): AbortSignal {
    if (klass === 'throttled') {
      for (const [id, entry] of this.pending) {
        if (entry.klass === 'throttled' && entry.lane === lane) {
          entry.controller.abort();
          this.pending.delete(id);
        }
      }
    }
    const controller = new AbortController();
    this.pending.set(envelope.msgId, { envelope, klass, lane, controller });
    return controller.signal;
  }

  /** Match an arriving reply to its request. Returns the original request
   * envelope, or null when the request was superseded/aborted (drop the
   * reply — it answers work nobody wants anymore). */
  settle(reply: WorkerEnvelope): WorkerEnvelope | null {
    if (reply.inReplyTo === undefined) return null;
    const entry = this.pending.get(reply.inReplyTo);
    if (entry === undefined) return null;
    this.pending.delete(reply.inReplyTo);
    if (entry.controller.signal.aborted) return null;
    return entry.envelope;
  }

  /** Abort EVERYTHING (epoch advance / detach / dataset swap). */
  abortAll(): number {
    let aborted = 0;
    for (const entry of this.pending.values()) {
      entry.controller.abort();
      aborted += 1;
    }
    this.pending.clear();
    return aborted;
  }

  pendingCount(): number {
    return this.pending.size;
  }
}

/**
 * UTF-8 string tables — dictionaries cross the boundary as TRANSFERABLES,
 * never as structured-clone string arrays (cloning 1M strings serializes on
 * the SENDING thread — the exact main-thread tax this lane exists to
 * remove; the mapbox pattern). Layout: byte offsets (Uint32Array, length
 * n+1) + concatenated UTF-8 bytes.
 */
export interface EncodedStringTable {
  offsets: Uint32Array;
  bytes: Uint8Array;
}

export function encodeStringTable(strings: readonly string[]): EncodedStringTable {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = new Array(strings.length);
  const offsets = new Uint32Array(strings.length + 1);
  let total = 0;
  for (let i = 0; i < strings.length; i++) {
    const chunk = encoder.encode(strings[i]!);
    chunks[i] = chunk;
    total += chunk.length;
    offsets[i + 1] = total;
  }
  const bytes = new Uint8Array(total);
  for (let i = 0; i < strings.length; i++) bytes.set(chunks[i]!, offsets[i]!);
  return { offsets, bytes };
}

export function decodeStringTable(table: EncodedStringTable): string[] {
  const decoder = new TextDecoder();
  const n = table.offsets.length - 1;
  const out: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = decoder.decode(table.bytes.subarray(table.offsets[i]!, table.offsets[i + 1]!));
  }
  return out;
}

/**
 * Structural envelope check for the RECEIVING side — a malformed message is
 * a protocol violation, never an exception path (the worker boundary is a
 * trust boundary within one page, but versions can skew during upgrades).
 */
export function isWellFormedEnvelope(value: unknown): value is WorkerEnvelope {
  if (value === null || typeof value !== 'object') return false;
  const e = value as Partial<WorkerEnvelope>;
  return (
    typeof e.msgId === 'number' &&
    Number.isInteger(e.msgId) &&
    e.msgId > 0 &&
    typeof e.epoch === 'number' &&
    Number.isInteger(e.epoch) &&
    e.epoch >= 0 &&
    (e.entity === 'nodes' || e.entity === 'edges' || e.entity === 'scene') &&
    typeof e.op === 'string' &&
    e.op.length > 0 &&
    (e.inReplyTo === undefined || (Number.isInteger(e.inReplyTo) && (e.inReplyTo as number) > 0))
  );
}
