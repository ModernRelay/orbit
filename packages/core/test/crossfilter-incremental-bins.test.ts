/**
 * wave 3 — live-maintained filtered layers vs the O(rows) recompute
 * oracle. Twin crossfilters over identical fixtures: one summarizes every
 * dimension after every operation (live layers maintained inline by the
 * flip hook), the twin is forced through the full recompute for every
 * read (fresh instance per read = always the oracle). Their summaries must
 * agree across randomized brush sequences on numeric/temporal/categorical
 * dimensions, with and without the external mask, and across the
 * de-materializing events (mask change, append, replaceAll).
 */

import { describe, expect, it } from 'vitest';

import { TypedColumnCrossfilter } from '../src/crossfilter';
import type { BrushState, DimensionSpec, GraphNode } from '../src/types';

interface Attrs {
  score: number;
  when: number;
  group: string;
  [key: string]: unknown;
}
type Node = GraphNode<Attrs>;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const EPOCH0 = Date.UTC(2024, 0, 1);
const GROUPS = ['g0', 'g1', 'g2', 'g3', 'g4'];

const SPECS: readonly DimensionSpec<Attrs>[] = [
  { key: 'score', kind: 'numeric', get: (n) => n.attrs?.score, bins: 8 },
  { key: 'when', kind: 'temporal', get: (n) => n.attrs?.when, bins: 6 },
  { key: 'group', kind: 'categorical', get: (n) => n.attrs?.group },
];

function makeNodes(count: number, rand: () => number, idOffset = 0): Node[] {
  const nodes: Node[] = [];
  for (let i = 0; i < count; i += 1) {
    nodes.push({
      id: `n${idOffset + i}`,
      attrs: {
        score: Math.floor(rand() * 1000),
        when: EPOCH0 + Math.floor(rand() * 30) * DAY,
        group: GROUPS[Math.floor(rand() * GROUPS.length)]!,
      },
    });
  }
  return nodes;
}

/** Oracle: a FRESH crossfilter rebuilt from scratch — its first summarize is
 * always the full O(rows) recompute over identical state. */
function oracleSummaries(
  nodes: readonly Node[],
  brushes: ReadonlyMap<string, BrushState>,
  mask: Uint8Array | null,
): Record<string, unknown> {
  const xf = new TypedColumnCrossfilter<Attrs>();
  xf.build(nodes, SPECS);
  for (const [key, brush] of brushes) xf.setBrush(key, brush);
  if (mask !== null) xf.setExternalMask(mask);
  const out: Record<string, unknown> = {};
  for (const spec of SPECS) out[spec.key] = xf.summarize(spec.key);
  return out;
}

function liveSummaries(xf: TypedColumnCrossfilter<Attrs>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of SPECS) out[spec.key] = xf.summarize(spec.key);
  return out;
}

function randomBrush(rand: () => number, key: string): BrushState {
  if (key === 'group') {
    const excluded = GROUPS.filter(() => rand() < 0.3);
    return rand() < 0.15 ? null : { excluded };
  }
  if (rand() < 0.12) return null;
  if (key === 'when') {
    const a = EPOCH0 + Math.floor(rand() * 30) * DAY;
    const b = a + Math.floor(rand() * 10) * DAY;
    return { min: a, max: b };
  }
  const min = Math.floor(rand() * 900);
  return { min, max: min + Math.floor(rand() * 300) };
}

describe('live filtered layers ≡ the recompute oracle (property)', () => {
  it('randomized brush sequences agree across all three dimension kinds', () => {
    const rand = rng(0xf3ed);
    const nodes = makeNodes(300, rand);
    const live = new TypedColumnCrossfilter<Attrs>();
    live.build(nodes, SPECS);
    const brushes = new Map<string, BrushState>();

    // Materialize all layers, then scrub: summaries after EVERY step must
    // match a from-scratch oracle, with zero further full recomputes.
    liveSummaries(live);
    live.resetStats();

    for (let step = 0; step < 120; step += 1) {
      const key = SPECS[Math.floor(rand() * SPECS.length)]!.key;
      const brush = randomBrush(rand, key);
      brushes.set(key, brush);
      live.setBrush(key, brush);
      expect(liveSummaries(live)).toEqual(oracleSummaries(nodes, brushes, null));
    }
    expect(live.stats.filteredRecomputes).toBe(0); // the claim
    expect(live.stats.binUpdates).toBeGreaterThan(0);
  });

  it('the external mask de-materializes; layers re-materialize and stay correct', () => {
    const rand = rng(0xa5c);
    const nodes = makeNodes(200, rand);
    const live = new TypedColumnCrossfilter<Attrs>();
    live.build(nodes, SPECS);
    const brushes = new Map<string, BrushState>();
    liveSummaries(live);

    const mask = new Uint8Array(nodes.length);
    for (let s = 0; s < mask.length; s += 1) mask[s] = rand() < 0.7 ? 1 : 0;
    live.setExternalMask(mask);

    // First reads re-materialize (recomputes happen)…
    live.resetStats();
    expect(liveSummaries(live)).toEqual(oracleSummaries(nodes, brushes, mask));
    expect(live.stats.filteredRecomputes).toBe(SPECS.length);

    // …then the hook keeps them correct through more scrubbing, mask fixed.
    live.resetStats();
    for (let step = 0; step < 40; step += 1) {
      const key = SPECS[Math.floor(rand() * SPECS.length)]!.key;
      const brush = randomBrush(rand, key);
      brushes.set(key, brush);
      live.setBrush(key, brush);
      expect(liveSummaries(live)).toEqual(oracleSummaries(nodes, brushes, mask));
    }
    expect(live.stats.filteredRecomputes).toBe(0);
  });

  it('appendRows and replaceAll de-materialize and re-baseline correctly', () => {
    const rand = rng(0xadd);
    let nodes = makeNodes(150, rand);
    const live = new TypedColumnCrossfilter<Attrs>();
    live.build(nodes, SPECS);
    const brushes = new Map<string, BrushState>();
    brushes.set('score', { min: 100, max: 700 });
    live.setBrush('score', brushes.get('score')!);
    liveSummaries(live);

    const extra = makeNodes(60, rand, nodes.length);
    nodes = [...nodes, ...extra];
    live.appendRows(extra);
    expect(liveSummaries(live)).toEqual(oracleSummaries(nodes, brushes, null));

    // Scrub after re-materialization: hook is live again.
    live.resetStats();
    brushes.set('score', { min: 120, max: 720 });
    live.setBrush('score', brushes.get('score')!);
    expect(liveSummaries(live)).toEqual(oracleSummaries(nodes, brushes, null));
    expect(live.stats.filteredRecomputes).toBe(0);

    // replaceAll preserves brushes by key and de-materializes.
    const fresh = makeNodes(180, rand, 1000);
    live.replaceAll(fresh);
    expect(liveSummaries(live)).toEqual(oracleSummaries(fresh, brushes, null));
  });

  it('a brush cleared to null (the O(n − window) path) keeps live layers exact', () => {
    const rand = rng(0xc1ea);
    const nodes = makeNodes(120, rand);
    const live = new TypedColumnCrossfilter<Attrs>();
    live.build(nodes, SPECS);
    const brushes = new Map<string, BrushState>();
    brushes.set('score', { min: 0, max: 200 });
    brushes.set('group', { excluded: ['g1', 'g3'] });
    live.setBrush('score', brushes.get('score')!);
    live.setBrush('group', brushes.get('group')!);
    liveSummaries(live);

    live.resetStats();
    brushes.set('score', null);
    live.setBrush('score', null);
    expect(liveSummaries(live)).toEqual(oracleSummaries(nodes, brushes, null));
    expect(live.stats.filteredRecomputes).toBe(0);
  });
});
