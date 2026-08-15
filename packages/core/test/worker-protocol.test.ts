/**
 * Worker-lane wire contract, pinned without a thread:
 * per-direction monotonic ids, epoch guards at the boundary (stale drops
 * silently, future is a protocol violation), consolidated deduplicated
 * transfer lists (SAB excluded), and the guaranteed-vs-throttled ledger
 * (latest-wins supersession aborts; settled/aborted replies drop).
 */

import { describe, expect, it } from 'vitest';

import {
  EnvelopeSequencer,
  RequestLedger,
  collectTransfers,
  isWellFormedEnvelope,
  judgeEpoch,
} from '../src/workerProtocol';

const seq = () => new EnvelopeSequencer();

describe('envelope sequencing', () => {
  it('ids are monotonic per direction and replies name their request', () => {
    const s = seq();
    const a = s.make(1, 'nodes', 'derive', {});
    const b = s.make(1, 'edges', 'derive', {});
    expect(a.msgId).toBe(1);
    expect(b.msgId).toBe(2);
    const reply = s.make(1, 'nodes', 'result', {}, a.msgId);
    expect(reply.inReplyTo).toBe(1);
    expect(reply.msgId).toBe(3);
  });

  it('well-formedness rejects junk without throwing', () => {
    expect(isWellFormedEnvelope(seq().make(0, 'scene', 'derive', null))).toBe(true);
    expect(isWellFormedEnvelope(null)).toBe(false);
    expect(isWellFormedEnvelope({ msgId: 1 })).toBe(false);
    expect(isWellFormedEnvelope({ msgId: 0, epoch: 0, entity: 'nodes', op: 'x' })).toBe(false);
    expect(isWellFormedEnvelope({ msgId: 1, epoch: -1, entity: 'nodes', op: 'x' })).toBe(false);
    expect(isWellFormedEnvelope({ msgId: 1, epoch: 0, entity: 'points', op: 'x' })).toBe(false);
    expect(isWellFormedEnvelope({ msgId: 1, epoch: 0, entity: 'nodes', op: '' })).toBe(false);
  });
});

describe('epoch guards (references never cross threads)', () => {
  it('current accepts, past drops as stale, future is a protocol violation', () => {
    const e = seq().make(5, 'nodes', 'result', {});
    expect(judgeEpoch(e, 5)).toBe('accept');
    expect(judgeEpoch(e, 6)).toBe('stale');
    expect(judgeEpoch(e, 4)).toBe('protocol-violation');
  });
});

describe('consolidated transfers', () => {
  it('two views over ONE buffer transfer once, order is first-seen', () => {
    const shared = new ArrayBuffer(64);
    const a = new Float32Array(shared, 0, 8);
    const b = new Uint32Array(shared, 32, 8);
    const own = new Float64Array(4);
    const out = collectTransfers([a, own, b]);
    expect(out).toEqual([shared, own.buffer]);
  });

  it('empty input yields an empty list', () => {
    expect(collectTransfers([])).toEqual([]);
  });
});

describe('request ledger (guaranteed vs throttled)', () => {
  it('a throttled request SUPERSEDES the pending one on its lane — abort + dropped reply', () => {
    const s = seq();
    const ledger = new RequestLedger();
    const first = s.make(1, 'nodes', 'project', { channel: 'pointColor' });
    const signal1 = ledger.track(first, 'throttled', 'project:pointColor');
    const second = s.make(1, 'nodes', 'project', { channel: 'pointColor' });
    ledger.track(second, 'throttled', 'project:pointColor');

    expect(signal1.aborted).toBe(true); // superseded
    expect(ledger.pendingCount()).toBe(1);

    // The stale reply (answering the aborted request) drops.
    const staleReply = s.make(1, 'nodes', 'result', {}, first.msgId);
    expect(ledger.settle(staleReply)).toBeNull();
    // The live reply matches.
    const liveReply = s.make(1, 'nodes', 'result', {}, second.msgId);
    expect(ledger.settle(liveReply)).toBe(second);
    expect(ledger.pendingCount()).toBe(0);
  });

  it('guaranteed requests NEVER supersede each other, even on one lane', () => {
    const s = seq();
    const ledger = new RequestLedger();
    const a = s.make(1, 'scene', 'derive', {});
    const b = s.make(1, 'scene', 'derive', {});
    const sigA = ledger.track(a, 'guaranteed', 'derive');
    ledger.track(b, 'guaranteed', 'derive');
    expect(sigA.aborted).toBe(false);
    expect(ledger.pendingCount()).toBe(2);
  });

  it('throttled lanes are independent — pointColor never aborts pointSize', () => {
    const s = seq();
    const ledger = new RequestLedger();
    const color = ledger.track(
      s.make(1, 'nodes', 'project', {}),
      'throttled',
      'project:pointColor',
    );
    ledger.track(s.make(1, 'nodes', 'project', {}), 'throttled', 'project:pointSize');
    expect(color.aborted).toBe(false);
    expect(ledger.pendingCount()).toBe(2);
  });

  it('abortAll (epoch advance / detach) aborts everything; late replies all drop', () => {
    const s = seq();
    const ledger = new RequestLedger();
    const a = s.make(1, 'nodes', 'derive', {});
    const b = s.make(1, 'edges', 'derive', {});
    ledger.track(a, 'guaranteed', 'derive');
    ledger.track(b, 'guaranteed', 'derive');
    expect(ledger.abortAll()).toBe(2);
    expect(ledger.pendingCount()).toBe(0);
    expect(ledger.settle(s.make(1, 'nodes', 'result', {}, a.msgId))).toBeNull();
    expect(ledger.settle(s.make(1, 'edges', 'result', {}, b.msgId))).toBeNull();
  });

  it('a reply with no inReplyTo or an unknown id drops (never throws)', () => {
    const ledger = new RequestLedger();
    expect(ledger.settle(seq().make(1, 'nodes', 'result', {}))).toBeNull();
    expect(ledger.settle(seq().make(1, 'nodes', 'result', {}, 99))).toBeNull();
  });
});
