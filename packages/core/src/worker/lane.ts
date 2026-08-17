/**
 * Main-side worker lane: transport ownership, the request
 * ledger (guaranteed/throttled), and the tri-option factory with the
 * fall-back-to-main contract (`worker-unavailable`, never a crash).
 *
 * The lane is TRANSPORT-agnostic: a real `Worker` and the in-process test
 * double implement the same three-method surface, so every ordering and
 * supersession behavior is pinned without a thread. Epoch judgment stays
 * with the CALLER (the instance owns the acceptance epoch); the lane owns
 * delivery, matching, and cancellation.
 */

import { EnvelopeSequencer, RequestLedger } from '../workerProtocol';
import type { RequestClass, WorkerEntity, WorkerEnvelope } from '../workerProtocol';
import { createDefaultWorker } from '../workerAsset';

export interface WorkerTransport {
  post(envelope: WorkerEnvelope, transfers: readonly ArrayBuffer[]): void;
  onReply(cb: (reply: WorkerEnvelope) => void): void;
  /** Async death channel: module-load failure, uncaught worker error,
   * messageerror. A transport that cannot fail may omit it. */
  onError?(cb: (reason: string) => void): void;
  terminate(): void;
}

/** D5 tri-option: consumer URL, full construction control, or the inline
 * default (a `Worker` over the built entry asset). */
export type WorkerFactoryOption =
  | { url: URL | string }
  | { create: () => Worker }
  | undefined;

function transportFromWorker(worker: Worker): WorkerTransport {
  return {
    post: (envelope, transfers) => worker.postMessage(envelope, [...transfers]),
    onReply: (cb) => {
      worker.onmessage = (ev: MessageEvent) => cb(ev.data as WorkerEnvelope);
    },
    onError: (cb) => {
      // Construction succeeding proves NOTHING about the module loading
      // the inline URL 404s in a mis-bundled app, CSP can kill execution,
      // and an uncaught throw ends the thread. All three surface here.
      worker.onerror = (ev: ErrorEvent) => cb(ev.message !== '' ? ev.message : 'worker error');
      worker.onmessageerror = () => cb('worker messageerror (unclonable reply)');
    },
    terminate: () => worker.terminate(),
  };
}

export interface WorkerLaneOptions {
  factory?: WorkerFactoryOption;
  /** Testing seam: bypass Worker construction entirely. */
  transport?: WorkerTransport;
  /** Called ONCE when the lane cannot boot — the caller falls back to the
   * main lane and reports `worker-unavailable`. */
  onUnavailable?: (reason: string) => void;
}

interface Pending {
  resolve: (reply: WorkerEnvelope) => void;
  reject: (err: Error) => void;
}

export class WorkerLane {
  private readonly options: WorkerLaneOptions;
  private readonly sequencer = new EnvelopeSequencer();
  private readonly ledger = new RequestLedger();
  private readonly pending = new Map<number, Pending>();
  private transport: WorkerTransport | null = null;
  /** null = not yet booted; false = boot failed (permanent for this lane). */
  private availableState: boolean | null = null;

  constructor(options: WorkerLaneOptions = {}) {
    this.options = options;
  }

  available(): boolean | null {
    return this.availableState;
  }

  /** Synchronous boot probe for callers that must pick a lane NOW (the
   * instance's sync applyHostUpdate cannot await a rejected request). */
  ensureBooted(): boolean {
    return this.boot();
  }

  /** Boot lazily on first use. A throwing factory (no Worker global, CSP,
   * missing asset) marks the lane unavailable FOREVER — one diagnostic,
   * then the caller's main path owns every subsequent request. */
  private boot(): boolean {
    if (this.availableState !== null) return this.availableState;
    try {
      let transport = this.options.transport ?? null;
      if (transport === null) {
        const factory = this.options.factory;
        const worker =
          factory !== undefined && 'create' in factory
            ? factory.create()
            : factory !== undefined && 'url' in factory
              ? new Worker(factory.url, { type: 'module' })
              : createDefaultWorker();
        transport = transportFromWorker(worker);
      }
      transport.onReply((reply) => this.settle(reply));
      transport.onError?.((reason) => this.fail(reason));
      this.transport = transport;
      this.availableState = true;
    } catch (err) {
      this.availableState = false;
      this.options.onUnavailable?.(err instanceof Error ? err.message : String(err));
    }
    return this.availableState;
  }

  /** A constructed-but-dead worker must strand NOTHING: every pending
   * request rejects as 'worker-failed' so callers
   * run their main-lane fallback, the lane goes permanently unavailable,
   * and the unavailability callback fires (the instance one-shots it). */
  private fail(reason: string): void {
    if (this.availableState === false) return;
    this.availableState = false;
    this.options.onUnavailable?.(reason);
    // Sweep pending BEFORE aborting the ledger: the controllers' abort
    // listeners reject as 'superseded' (a silent drop) — a dead worker must
    // reject as 'worker-failed' so callers run their main-lane fallback.
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.reject(new Error('worker-failed'));
    }
    this.ledger.abortAll();
    this.transport?.terminate();
    this.transport = null;
  }

  private settle(reply: WorkerEnvelope): void {
    const original = this.ledger.settle(reply);
    if (reply.inReplyTo === undefined) return; // unsolicited — drop
    const entry = this.pending.get(reply.inReplyTo);
    this.pending.delete(reply.inReplyTo);
    if (entry === undefined) return;
    if (original === null) {
      // Superseded/aborted before the reply landed — the work is unwanted.
      entry.reject(new Error('superseded'));
      return;
    }
    entry.resolve(reply);
  }

  /**
   * Send one request. Resolves with the reply envelope (op 'result' or
   * 'error' — protocol errors are DATA to the caller, not exceptions);
   * rejects only on supersession/abort/unavailability.
   */
  request(
    epoch: number,
    entity: WorkerEntity,
    op: string,
    payload: unknown,
    transfers: readonly ArrayBuffer[],
    klass: RequestClass,
    lane: string,
  ): Promise<WorkerEnvelope> {
    if (!this.boot()) {
      return Promise.reject(new Error('worker-unavailable'));
    }
    const envelope = this.sequencer.make(epoch, entity, op, payload);
    const signal = this.ledger.track(envelope, klass, lane);
    return new Promise<WorkerEnvelope>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('superseded'));
        return;
      }
      // Supersession/abortAll rejects PROMPTLY through the signal — a
      // superseded caller never waits for the stale reply to come home.
      signal.addEventListener(
        'abort',
        () => {
          if (this.pending.delete(envelope.msgId)) reject(new Error('superseded'));
        },
        { once: true },
      );
      this.pending.set(envelope.msgId, { resolve, reject });
      this.transport!.post(envelope, transfers);
    });
  }

  /** Abort everything in flight (epoch advance / detach / dataset swap).
   * The ledger's controllers fire each pending promise's abort listener;
   * the sweep below catches anything tracked before a listener attached
   * rejects stay idempotent through the delete guard. */
  abortAll(): void {
    this.ledger.abortAll();
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.reject(new Error('aborted'));
    }
  }

  terminate(): void {
    this.abortAll();
    this.transport?.terminate();
    this.transport = null;
    this.availableState = null; // a fresh boot may follow (recovery)
  }
}
