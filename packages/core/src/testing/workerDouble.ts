/**
 * In-process worker transport double — drives the REAL
 * runtime module through the REAL codec, asynchronously (microtask), with
 * REAL transfer semantics: payloads round through `structuredClone` with
 * the declared transfer list, so a wrong transfer set detaches something
 * the sender still needs and fails the suite loudly — exactly what a live
 * thread would do, minus the scheduling.
 */

import { EnvelopeSequencer } from '../workerProtocol';
import type { WorkerEnvelope } from '../workerProtocol';
import { handleWorkerRequest } from '../worker/runtime';
import type { WorkerTransport } from '../worker/lane';

export interface WorkerDouble extends WorkerTransport {
  /** Requests handled so far (post-clone shapes, in arrival order). */
  readonly handled: WorkerEnvelope[];
}

export function createWorkerDouble(): WorkerDouble {
  const sequencer = new EnvelopeSequencer();
  const handled: WorkerEnvelope[] = [];
  let deliver: ((reply: WorkerEnvelope) => void) | null = null;
  return {
    handled,
    post(envelope, transfers) {
      // REAL transfer semantics: the sender's views detach here.
      const received = structuredClone(envelope, {
        transfer: [...transfers],
      }) as WorkerEnvelope;
      queueMicrotask(() => {
        handled.push(received);
        const { reply, transfers: replyTransfers } = handleWorkerRequest(received, sequencer);
        const delivered = structuredClone(reply, {
          transfer: [...replyTransfers],
        }) as WorkerEnvelope;
        deliver?.(delivered);
      });
    },
    onReply(cb) {
      deliver = cb;
    },
    terminate() {
      deliver = null;
    },
  };
}
