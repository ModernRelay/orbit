/**
 * Inline worker entry, built as its own asset inside
 * core (dist/worker/entry.js). All semantics live in runtime.ts (shared
 * with the in-process double — D2's one-implementation rule); this file is
 * ONLY the thread glue.
 */

import { EnvelopeSequencer } from '../workerProtocol';
import { handleWorkerRequest } from './runtime';

export interface WorkerEntryScope {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage: (message: unknown, transfer: Transferable[]) => void;
}

/** Install the thread glue. The .js bootstrap calls this in both workspace
 * Vite builds and the self-contained published worker bundle. */
export function installWorkerEntry(scope: WorkerEntryScope): void {
  const sequencer = new EnvelopeSequencer();
  scope.onmessage = (ev: MessageEvent) => {
    const { reply, transfers } = handleWorkerRequest(ev.data, sequencer);
    scope.postMessage(reply, [...transfers]);
  };
}
