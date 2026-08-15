/**
 * Inline worker entry, built as its own asset inside
 * core (dist/worker/entry.js). All semantics live in runtime.ts (shared
 * with the in-process double — D2's one-implementation rule); this file is
 * ONLY the thread glue.
 */

import { EnvelopeSequencer } from '../workerProtocol';
import { handleWorkerRequest } from './runtime';

const sequencer = new EnvelopeSequencer();
const scope = self as unknown as {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage: (message: unknown, transfer: Transferable[]) => void;
};

scope.onmessage = (ev: MessageEvent) => {
  const { reply, transfers } = handleWorkerRequest(ev.data, sequencer);
  scope.postMessage(reply, [...transfers]);
};
