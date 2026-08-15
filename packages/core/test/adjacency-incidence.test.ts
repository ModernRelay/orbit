/**
 * wave 2 — the CSR incidence index (point → incident EDGE SLOTS) and
 * the O(incident-edges) delta cascade, both against brute-force oracles on
 * random graphs.
 */

import { describe, expect, it } from 'vitest';

import { buildIncidence, incidentEdgesOf } from '../src/adjacency';
import { SoftMask } from '../src/mask';
import type { MaskCrossings } from '../src/mask';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomLinks(rand: () => number, points: number, edges: number): Uint32Array {
  const links = new Uint32Array(edges * 2);
  for (let i = 0; i < edges; i++) {
    links[i * 2] = Math.floor(rand() * points);
    links[i * 2 + 1] = Math.floor(rand() * points);
  }
  return links;
}

describe('buildIncidence', () => {
  it('matches the brute-force incident-edge scan on random graphs', () => {
    const rand = mulberry32(0x1c1de);
    for (let round = 0; round < 20; round += 1) {
      const points = 2 + Math.floor(rand() * 30);
      const edges = Math.floor(rand() * 60);
      const links = randomLinks(rand, points, edges);
      const inc = buildIncidence(links, points);

      for (let p = 0; p < points; p += 1) {
        const naive: number[] = [];
        for (let e = 0; e < edges; e += 1) {
          if (links[e * 2] === p) naive.push(e);
          if (links[e * 2 + 1] === p) naive.push(e); // self-loop → twice
        }
        const got = [...incidentEdgesOf(inc, p)].sort((a, b) => a - b);
        expect(got).toEqual(naive.sort((a, b) => a - b));
      }
    }
  });

  it('lists a self-loop edge twice under its point; views are zero-copy', () => {
    const links = Uint32Array.of(0, 0, 0, 1);
    const inc = buildIncidence(links, 2);
    expect([...incidentEdgesOf(inc, 0)].sort()).toEqual([0, 0, 1]);
    expect([...incidentEdgesOf(inc, 1)]).toEqual([1]);
    expect(incidentEdgesOf(inc, 0).buffer).toBe(inc.edgeSlots.buffer);
  });

  it('validates inputs like buildAdjacency', () => {
    expect(() => buildIncidence(Uint32Array.of(0), 1)).toThrow(RangeError);
    expect(() => buildIncidence(Uint32Array.of(0, 5), 2)).toThrow(RangeError);
    expect(() => incidentEdgesOf(buildIncidence(new Uint32Array(0), 1), 4)).toThrow(RangeError);
  });
});

describe('applyNodeCascadeToEdgesDelta ≡ the O(E) cascade oracle', () => {
  it('random hide sequences produce identical edge lanes via either cascade', () => {
    const rand = mulberry32(0xca5cade);
    for (let round = 0; round < 10; round += 1) {
      const points = 4 + Math.floor(rand() * 20);
      const edges = 4 + Math.floor(rand() * 40);
      const links = randomLinks(rand, points, edges);
      const inc = buildIncidence(links, points);

      const deltaMask = new SoftMask(points, edges);
      const oracleMask = new SoftMask(points, edges);
      const deltaSrc = deltaMask.acquire('hide');
      const oracleSrc = oracleMask.acquire('hide');
      const model = new Set<number>();
      const x: MaskCrossings = { becameFailing: [], becameClear: [] };

      for (let step = 0; step < 60; step += 1) {
        const add: number[] = [];
        const remove: number[] = [];
        for (let k = 0; k < 3; k += 1) {
          const slot = Math.floor(rand() * points);
          if (rand() < 0.5) add.push(slot);
          else remove.push(slot);
        }
        for (const s of add) model.add(s);
        for (const s of remove) model.delete(s);

        // Delta path: membership delta + incident-edge cascade on crossings.
        deltaSrc.updateNodeFailures(add, remove, x);
        deltaMask.applyNodeCascadeToEdgesDelta(
          links,
          inc,
          [...x.becameFailing, ...x.becameClear],
        );

        // Oracle path: full replace + full O(E) cascade.
        oracleSrc.setNodeFailures([...model]);
        oracleMask.applyNodeCascadeToEdges(links);

        expect(Array.from(deltaMask.edgeHideFailures)).toEqual(
          Array.from(oracleMask.edgeHideFailures),
        );
        expect(deltaMask.visibleEdgeCount()).toBe(oracleMask.visibleEdgeCount());
      }
    }
  });

  it('the two cascade forms COMPOSE: a full re-baseline after deltas stays balanced', () => {
    const links = Uint32Array.of(0, 1, 1, 2, 2, 3);
    const inc = buildIncidence(links, 4);
    const mask = new SoftMask(4, 3);
    const src = mask.acquire('hide');
    const x: MaskCrossings = { becameFailing: [], becameClear: [] };

    src.updateNodeFailures([1], null, x);
    mask.applyNodeCascadeToEdgesDelta(links, inc, x.becameFailing);
    expect(mask.isEdgeVisible(0)).toBe(false);
    expect(mask.isEdgeVisible(1)).toBe(false);
    expect(mask.isEdgeVisible(2)).toBe(true);

    // Full cascade re-baseline over the same state agrees and stays clean.
    mask.applyNodeCascadeToEdges(links);
    expect(mask.isEdgeVisible(0)).toBe(false);
    expect(mask.isEdgeVisible(2)).toBe(true);

    src.updateNodeFailures(null, [1], x);
    mask.applyNodeCascadeToEdgesDelta(links, inc, x.becameClear);
    expect(mask.visibleEdgeCount()).toBe(3);
    src.release(); // balanced-books DEBUG assert
  });

  it('cascade visits are bounded by incident edges of the crossed nodes', () => {
    const rand = mulberry32(0xb07bd);
    const points = 40;
    const edges = 120;
    const links = randomLinks(rand, points, edges);
    const inc = buildIncidence(links, points);
    const mask = new SoftMask(points, edges);
    const src = mask.acquire('hide');
    const x: MaskCrossings = { becameFailing: [], becameClear: [] };

    src.updateNodeFailures([7], null, x);
    mask.resetStats();
    mask.applyNodeCascadeToEdgesDelta(links, inc, x.becameFailing);
    expect(mask.stats.cascadeEdgesVisited).toBe(incidentEdgesOf(inc, 7).length);
    expect(mask.stats.cascadeEdgesVisited).toBeLessThan(edges);
    src.release();
  });
});
