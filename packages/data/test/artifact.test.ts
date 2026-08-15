/**
 * Artifact round-trip: serializePrepared → loadPrepared preserves
 * everything; a matching expected fingerprint SKIPS revalidation (pinned via
 * a spy on the validator seam); a mismatch throws with both fingerprints.
 */

import { describe, expect, it, vi } from 'vitest';
import { _internals } from '../src/artifact';
import { loadPrepared, prepareGraphData, serializePrepared } from '../src/index';
import {
  PARITY_EDGE_ROWS,
  PARITY_MAPPING,
  PARITY_NODE_ROWS,
  PARITY_OPTIONS,
} from './helpers';

async function makePrepared() {
  return prepareGraphData(
    { nodes: PARITY_NODE_ROWS, edges: PARITY_EDGE_ROWS },
    PARITY_MAPPING,
    PARITY_OPTIONS,
  );
}

describe('prepared-artifact round-trip', () => {
  it('preserves snapshot, summaries, and fingerprint byte-for-byte', async () => {
    const prepared = await makePrepared();
    const bytes = serializePrepared(prepared);
    expect(bytes).toBeInstanceOf(Uint8Array);
    const loaded = loadPrepared(bytes);
    expect(loaded).toEqual(prepared);
    // Round-trip is stable: serialize(load(x)) === serialize(x).
    expect(serializePrepared(loaded)).toEqual(bytes);
  });

  it('skips revalidation on a fingerprint match (fast path)', async () => {
    const prepared = await makePrepared();
    const bytes = serializePrepared(prepared);
    const spy = vi.spyOn(_internals, 'validate');
    try {
      const loaded = loadPrepared(bytes, {
        expectedMappingFingerprint: prepared.mappingFingerprint,
      });
      expect(loaded.snapshot).toEqual(prepared.snapshot);
      expect(spy).not.toHaveBeenCalled();

      loadPrepared(bytes); // no expectation → full revalidation
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a stale artifact when a late-appearing field moved the fingerprint (I4)', async () => {
    const stale = await makePrepared();
    const bytes = serializePrepared(stale);
    // The source gained a field on its LAST row only — the admitted union
    // (and thus the fingerprint) moves, so the cached artifact must reparse.
    const fresh = await prepareGraphData(
      {
        nodes: [...PARITY_NODE_ROWS.slice(0, 2), { ...PARITY_NODE_ROWS[2], risk: 0.9 }],
        edges: PARITY_EDGE_ROWS,
      },
      PARITY_MAPPING,
      PARITY_OPTIONS,
    );
    expect(fresh.mappingFingerprint).not.toBe(stale.mappingFingerprint);
    expect(() =>
      loadPrepared(bytes, { expectedMappingFingerprint: fresh.mappingFingerprint }),
    ).toThrow(/mapping fingerprint mismatch/);
  });

  it('throws with BOTH fingerprints on a mismatch', async () => {
    const prepared = await makePrepared();
    const bytes = serializePrepared(prepared);
    const attempt = () => loadPrepared(bytes, { expectedMappingFingerprint: 'deadbeefdeadbeef' });
    expect(attempt).toThrow(/mapping fingerprint mismatch/);
    expect(attempt).toThrow(new RegExp(`deadbeefdeadbeef[\\s\\S]*${prepared.mappingFingerprint}`));
  });

  it('revalidates structurally when no fingerprint is expected', async () => {
    const prepared = await makePrepared();
    const envelope = JSON.parse(new TextDecoder().decode(serializePrepared(prepared)));
    envelope.snapshot.edges[1] = { target: 'c' }; // drop the source endpoint
    const corrupted = new TextEncoder().encode(JSON.stringify(envelope));
    expect(() => loadPrepared(corrupted)).toThrow(/edge 1 lacks string endpoints/);
    //...but the (dishonest) fast path would admit it — that is the contract.
    expect(() =>
      loadPrepared(corrupted, { expectedMappingFingerprint: prepared.mappingFingerprint }),
    ).not.toThrow();
  });

  it('rejects foreign or future envelopes', async () => {
    expect(() => loadPrepared(new TextEncoder().encode('not json'))).toThrow(/not valid JSON/);
    expect(() => loadPrepared(new TextEncoder().encode('[1,2]'))).toThrow(/JSON object envelope/);
    const prepared = await makePrepared();
    const envelope = JSON.parse(new TextDecoder().decode(serializePrepared(prepared)));
    envelope.formatVersion = 2;
    expect(() => loadPrepared(new TextEncoder().encode(JSON.stringify(envelope)))).toThrow(
      /unsupported artifact formatVersion 2/,
    );
  });
});
