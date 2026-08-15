/**
 * Worker-side request handler, implemented as a PURE function over the
 * codec so the real thread entry (worker/entry.ts) and the in-process test
 * double drive IDENTICAL code (D2: one implementation, never duplicated).
 *
 * First cargo: `derive-columnar` — the acceptance rules over
 * transferred acceptance inputs. Dictionaries arrive as UTF-8 string tables
 * (transferables, decoded off-main); results leave as keep bitmaps, the
 * survivor remap, resolved links, and object-lane-identical diagnostics
 * every heavy field a transferable.
 *
 * No thread machinery here: input envelope in, reply envelope + transfer
 * list out. Unknown ops and malformed payloads reply with an 'error' op
 * (never throw — a worker that dies on one bad message kills every pending
 * request behind it).
 */

import { acceptColumnar } from '../columnarValidate';
import type { ColumnarGraphSnapshot, GraphDiagnostic } from '../types';
import {
  EnvelopeSequencer,
  collectTransfers,
  decodeStringTable,
  isWellFormedEnvelope,
} from '../workerProtocol';
import type { EncodedStringTable, WorkerEnvelope } from '../workerProtocol';

/** Wire payload for 'derive-columnar' — the acceptance inputs ONLY (attr
 * columns never cross; materialization stays main-side this slice). */
export interface DeriveColumnarRequest {
  nodeIdTable: EncodedStringTable;
  nodeIdCodes: Uint32Array;
  nodeCount: number;
  edgeIdTable: EncodedStringTable;
  edgeIdCodes: Uint32Array;
  edgeSource: Uint32Array;
  edgeTarget: Uint32Array;
  edgeCount: number;
}

export interface DeriveColumnarResult {
  keepNodes: Uint8Array;
  keepEdges: Uint8Array;
  acceptedNodeCount: number;
  acceptedEdgeCount: number;
  nodeAcceptedIndex: Int32Array;
  links: Uint32Array;
  diagnostics: GraphDiagnostic[];
}

export interface HandledReply {
  reply: WorkerEnvelope;
  transfers: ArrayBuffer[];
}

/** Handle ONE request envelope. The sequencer is the worker's own outbound
 * direction (per-direction monotonic ids). */
export function handleWorkerRequest(
  request: unknown,
  sequencer: EnvelopeSequencer,
): HandledReply {
  if (!isWellFormedEnvelope(request)) {
    const reply = sequencer.make(0, 'scene', 'error', {
      message: 'malformed envelope (protocol violation)',
    });
    return { reply, transfers: [] };
  }

  if (request.op === 'derive-columnar') {
    try {
      const p = request.payload as DeriveColumnarRequest;
      // Rebuild the snapshot SHAPE acceptColumnar expects — same module the
      // main lane uses (D2), fed decoded-off-main dictionaries.
      const snapshot: ColumnarGraphSnapshot<unknown, unknown> = {
        kind: 'columnar',
        datasetKey: 'worker', // acceptance rules never read the coordinate
        sourceRevision: 0,
        nodes: {
          ids: {
            kind: 'string',
            dictionary: decodeStringTable(p.nodeIdTable),
            codes: p.nodeIdCodes,
          },
          columns: {},
          length: p.nodeCount,
        },
        edges: {
          ids: {
            kind: 'string',
            dictionary: decodeStringTable(p.edgeIdTable),
            codes: p.edgeIdCodes,
          },
          source: p.edgeSource,
          target: p.edgeTarget,
          columns: {},
          length: p.edgeCount,
        },
      };
      const acceptance = acceptColumnar(snapshot);
      const result: DeriveColumnarResult = {
        keepNodes: acceptance.keepNodes,
        keepEdges: acceptance.keepEdges,
        acceptedNodeCount: acceptance.acceptedNodeCount,
        acceptedEdgeCount: acceptance.acceptedEdgeCount,
        nodeAcceptedIndex: acceptance.nodeAcceptedIndex,
        links: acceptance.links,
        diagnostics: acceptance.diagnostics,
      };
      const reply = sequencer.make(
        request.epoch,
        request.entity,
        'result',
        result,
        request.msgId,
      );
      return {
        reply,
        transfers: collectTransfers([
          result.keepNodes,
          result.keepEdges,
          result.nodeAcceptedIndex,
          result.links,
        ]),
      };
    } catch (err) {
      const reply = sequencer.make(
        request.epoch,
        request.entity,
        'error',
        { message: err instanceof Error ? err.message : String(err) },
        request.msgId,
      );
      return { reply, transfers: [] };
    }
  }

  const reply = sequencer.make(
    request.epoch,
    request.entity,
    'error',
    { message: `unknown op '${request.op}'` },
    request.msgId,
  );
  return { reply, transfers: [] };
}
