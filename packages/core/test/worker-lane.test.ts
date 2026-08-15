/**
 * Worker lane end to end WITHOUT a thread: the in-process
 * double drives the REAL runtime through the REAL codec with REAL transfer
 * semantics (structuredClone + transfer lists — a wrong transfer set
 * detaches what the sender still needs and fails here, not in production).
 * Pins: derive-columnar round trip equals the direct call, transferred
 * buffers detach sender-side, throttled supersession rejects promptly,
 * boot failure reports worker-unavailable exactly once, and error replies
 * are DATA (malformed/unknown ops never kill the lane).
 */

import { describe, expect, it, vi } from 'vitest';

import { acceptColumnar } from '../src/columnarValidate';
import { WorkerLane } from '../src/worker/lane';
import type { DeriveColumnarRequest, DeriveColumnarResult } from '../src/worker/runtime';
import { collectTransfers, encodeStringTable } from '../src/workerProtocol';
import { createWorkerDouble } from '../src/testing/workerDouble';
import type { ColumnarGraphSnapshot } from '../src/types';

function fixture(): ColumnarGraphSnapshot {
  return {
    kind: 'columnar',
    datasetKey: 'wl',
    sourceRevision: 1,
    nodes: {
      ids: {
        kind: 'string',
        dictionary: ['a', 'b', 'c', 'a'], // row 3 duplicates 'a' via equal string
        codes: Uint32Array.of(0, 1, 2, 3),
      },
      columns: {},
      length: 4,
    },
    edges: {
      ids: { kind: 'string', dictionary: ['e1', 'e2', 'e3'], codes: Uint32Array.of(0, 1, 2) },
      source: Uint32Array.of(0, 1, 3), // e3 sources the dropped duplicate row
      target: Uint32Array.of(1, 2, 2),
      columns: {},
      length: 3,
    },
  };
}

/** Build the wire request the instance will build in W3 — COPIES of the
 * acceptance inputs (borrowed ownership: caller buffers must stay usable). */
function wireRequest(snapshot: ColumnarGraphSnapshot): {
  payload: DeriveColumnarRequest;
  transfers: ArrayBuffer[];
} {
  const payload: DeriveColumnarRequest = {
    nodeIdTable: encodeStringTable(snapshot.nodes.ids.dictionary),
    nodeIdCodes: snapshot.nodes.ids.codes.slice(),
    nodeCount: snapshot.nodes.length,
    edgeIdTable: encodeStringTable(snapshot.edges.ids.dictionary),
    edgeIdCodes: snapshot.edges.ids.codes.slice(),
    edgeSource: snapshot.edges.source.slice(),
    edgeTarget: snapshot.edges.target.slice(),
    edgeCount: snapshot.edges.length,
  };
  const transfers = collectTransfers([
    payload.nodeIdTable.offsets,
    payload.nodeIdTable.bytes,
    payload.nodeIdCodes,
    payload.edgeIdTable.offsets,
    payload.edgeIdTable.bytes,
    payload.edgeIdCodes,
    payload.edgeSource,
    payload.edgeTarget,
  ]);
  return { payload, transfers };
}

describe('derive-columnar through the lane (the real runtime, microtask-async)', () => {
  it('round trip equals the direct acceptColumnar call; request buffers DETACH', async () => {
    const lane = new WorkerLane({ transport: createWorkerDouble() });
    const snapshot = fixture();
    const direct = acceptColumnar(snapshot);

    const { payload, transfers } = wireRequest(snapshot);
    const reply = await lane.request(1, 'scene', 'derive-columnar', payload, transfers, 'guaranteed', 'derive');

    expect(reply.op).toBe('result');
    expect(reply.epoch).toBe(1);
    const result = reply.payload as DeriveColumnarResult;
    expect(result.acceptedNodeCount).toBe(direct.acceptedNodeCount);
    expect(result.acceptedEdgeCount).toBe(direct.acceptedEdgeCount);
    expect([...result.keepNodes]).toEqual([...direct.keepNodes]);
    expect([...result.links]).toEqual([...direct.links]);
    expect(result.diagnostics).toEqual(direct.diagnostics);

    // The declared transfers really left: the wire copies are detached,
    // and the CALLER's original snapshot buffers are untouched (borrowed).
    expect(payload.nodeIdCodes.length).toBe(0);
    expect(payload.edgeSource.length).toBe(0);
    expect(snapshot.nodes.ids.codes.length).toBe(4);
    expect(snapshot.edges.source.length).toBe(3);
  });

  it('throttled supersession rejects the FIRST request promptly; the second resolves', async () => {
    const lane = new WorkerLane({ transport: createWorkerDouble() });
    const a = wireRequest(fixture());
    const b = wireRequest(fixture());

    const first = lane.request(1, 'nodes', 'derive-columnar', a.payload, a.transfers, 'throttled', 'derive');
    const second = lane.request(1, 'nodes', 'derive-columnar', b.payload, b.transfers, 'throttled', 'derive');

    await expect(first).rejects.toThrow('superseded');
    const reply = await second;
    expect(reply.op).toBe('result');
  });

  it('guaranteed requests on one lane all complete, in reply order', async () => {
    const lane = new WorkerLane({ transport: createWorkerDouble() });
    const a = wireRequest(fixture());
    const b = wireRequest(fixture());
    const [ra, rb] = await Promise.all([
      lane.request(1, 'scene', 'derive-columnar', a.payload, a.transfers, 'guaranteed', 'derive'),
      lane.request(1, 'scene', 'derive-columnar', b.payload, b.transfers, 'guaranteed', 'derive'),
    ]);
    expect(ra.op).toBe('result');
    expect(rb.op).toBe('result');
    expect(ra.inReplyTo).not.toBe(rb.inReplyTo);
  });

  it('abortAll rejects everything in flight', async () => {
    const lane = new WorkerLane({ transport: createWorkerDouble() });
    const a = wireRequest(fixture());
    const pending = lane.request(1, 'scene', 'derive-columnar', a.payload, a.transfers, 'guaranteed', 'derive');
    lane.abortAll();
    await expect(pending).rejects.toThrow(/aborted|superseded/);
  });

  it('an unknown op is an ERROR REPLY (data), and the lane keeps serving', async () => {
    const lane = new WorkerLane({ transport: createWorkerDouble() });
    const bad = await lane.request(1, 'scene', 'no-such-op', {}, [], 'guaranteed', 'x');
    expect(bad.op).toBe('error');
    expect((bad.payload as { message: string }).message).toContain('no-such-op');

    const a = wireRequest(fixture());
    const good = await lane.request(1, 'scene', 'derive-columnar', a.payload, a.transfers, 'guaranteed', 'derive');
    expect(good.op).toBe('result');
  });

  it('a malformed derive payload is an error reply, never a dead worker', async () => {
    const lane = new WorkerLane({ transport: createWorkerDouble() });
    const bad = await lane.request(
      1,
      'scene',
      'derive-columnar',
      { nodeCount: 'junk' },
      [],
      'guaranteed',
      'derive',
    );
    expect(bad.op).toBe('error');
  });
});

describe('boot failure → fall back to main', () => {
  it('a throwing factory reports worker-unavailable ONCE and rejects every request', async () => {
    const onUnavailable = vi.fn();
    const lane = new WorkerLane({
      factory: {
        create: () => {
          throw new Error('CSP: no workers here');
        },
      },
      onUnavailable,
    });
    await expect(lane.request(1, 'scene', 'derive-columnar', {}, [], 'guaranteed', 'd')).rejects.toThrow(
      'worker-unavailable',
    );
    await expect(lane.request(1, 'scene', 'derive-columnar', {}, [], 'guaranteed', 'd')).rejects.toThrow(
      'worker-unavailable',
    );
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledWith('CSP: no workers here');
    expect(lane.available()).toBe(false);
  });

  it('jsdom has no Worker global: the DEFAULT factory path degrades, never crashes', async () => {
    const onUnavailable = vi.fn();
    const lane = new WorkerLane({ onUnavailable });
    await expect(lane.request(1, 'scene', 'derive-columnar', {}, [], 'guaranteed', 'd')).rejects.toThrow(
      'worker-unavailable',
    );
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });
});
