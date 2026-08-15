/**
 * parity.object-columnar: for each generator
 * family (clustered / sparse / powerlaw — the same edge-selection logic as
 * the harness families), a seeded graph built in BOTH input forms lands
 * IDENTICAL through the instance: scene roster, structure bytes, channel
 * buffer BYTES under a numeric color scale, visible counts, and attr reads.
 * Byte-exact is the bar — Buffer-level equality, not approximate.
 */

import { describe, expect, it } from 'vitest';

import type { ColumnarGraphSnapshot, GraphSnapshot } from '../src/types';
import { container, makeInstance } from './helpers';
import type { EAttrs, NAttrs } from './helpers';

/** mulberry32 — the same deterministic PRNG the demo generators use. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Family = 'clustered' | 'sparse' | 'powerlaw';
const FAMILIES: readonly Family[] = ['clustered', 'sparse', 'powerlaw'];
const CLUSTERS = 6;
const INTER_PROB = 0.12;

interface TwinGraph {
  object: GraphSnapshot<NAttrs, EAttrs>;
  columnar: ColumnarGraphSnapshot<NAttrs, EAttrs>;
}

/** One logical graph, two input forms, built from a single PRNG stream so
 * the twins are the same graph BY CONSTRUCTION. */
function twinGraph(seed: number, family: Family, nodeCount: number, edgeCount: number): TwinGraph {
  const rng = mulberry32(seed);

  const ids: string[] = new Array(nodeCount);
  const scores = new Float64Array(nodeCount);
  const clusterCodes = new Uint32Array(nodeCount);
  const clusterNames = Array.from({ length: CLUSTERS }, (_, i) => `c${i}`);
  for (let i = 0; i < nodeCount; i++) {
    ids[i] = `n${i}`;
    scores[i] = Math.round(rng() * 1000) / 10;
    clusterCodes[i] = i % CLUSTERS;
  }

  const source = new Uint32Array(edgeCount);
  const target = new Uint32Array(edgeCount);
  for (let e = 0; e < edgeCount; e++) {
    const t = 1 + Math.floor(rng() * (nodeCount - 1));
    let s: number;
    if (family === 'sparse') {
      s = Math.floor(rng() * t);
    } else if (family === 'powerlaw') {
      s = Math.floor(rng() * rng() * t);
    } else {
      const earlierPeers = Math.floor(t / CLUSTERS);
      const intra = earlierPeers > 0 && rng() >= INTER_PROB;
      s = intra ? t - CLUSTERS * (1 + Math.floor(rng() * earlierPeers)) : Math.floor(rng() * t);
    }
    source[e] = s;
    target[e] = t;
  }

  const object = {
    datasetKey: `parity-${family}`,
    sourceRevision: seed,
    nodes: ids.map((id, i) => ({
      id,
      attrs: { score: scores[i], cluster: clusterNames[clusterCodes[i]!]! },
    })),
    edges: Array.from({ length: edgeCount }, (_, e) => ({
      id: `e${e}`,
      source: ids[source[e]!]!,
      target: ids[target[e]!]!,
      attrs: {},
    })),
  } as unknown as GraphSnapshot<NAttrs, EAttrs>;

  const columnar = {
    kind: 'columnar',
    datasetKey: `parity-${family}`,
    sourceRevision: seed,
    nodes: {
      ids: {
        kind: 'string',
        dictionary: ids,
        codes: Uint32Array.from({ length: nodeCount }, (_, i) => i),
      },
      columns: {
        score: { kind: 'f64', data: scores },
        cluster: { kind: 'string', dictionary: clusterNames, codes: clusterCodes },
      },
      length: nodeCount,
    },
    edges: {
      ids: {
        kind: 'string',
        dictionary: Array.from({ length: edgeCount }, (_, e) => `e${e}`),
        codes: Uint32Array.from({ length: edgeCount }, (_, e) => e),
      },
      source,
      target,
      columns: {},
      length: edgeCount,
    },
  } as unknown as ColumnarGraphSnapshot<NAttrs, EAttrs>;

  return { object, columnar };
}

async function ingest(data: GraphSnapshot<NAttrsX, EAttrsX> | ColumnarGraphSnapshot<NAttrsX, EAttrsX>) {
  const h = makeInstance({ fitViewOnFirstData: false });
  await h.instance.attach(container);
  h.instance.applyHostUpdate({
    data: data as never,
    // A numeric scale over the columnar-carried attr — the channel-bytes
    // witness runs through domains, palette interpolation, and projection.
    nodeColor: {
      kind: 'sequential',
      by: 'score',
      palette: ['#101010', '#f0f0f0'],
    } as never,
    linkColor: 'blue',
  });
  return h;
}
type NAttrsX = NAttrs;
type EAttrsX = EAttrs;

const SIZES: Record<Family, { nodes: number; edges: number }> = {
  clustered: { nodes: 1500, edges: 3600 },
  sparse: { nodes: 1500, edges: 3600 },
  powerlaw: { nodes: 1500, edges: 3600 },
};

describe.each(FAMILIES)('parity.object-columnar — %s family (seeded)', (family) => {
  it.each([1337, 2026])('seed %d: twins land byte-identical', async (seed) => {
    const { nodes, edges } = SIZES[family];
    const twins = twinGraph(seed, family, nodes, edges);
    const objectSide = await ingest(twins.object);
    const columnarSide = await ingest(twins.columnar);

    const io = objectSide.instance;
    const ic = columnarSide.instance;

    // Roster and counts.
    expect(ic.getSceneNodeIds()).toEqual(io.getSceneNodeIds());
    expect(ic.store.getState().visible).toEqual(io.store.getState().visible);
    expect(ic.store.getState().diagnostics).toEqual(io.store.getState().diagnostics);

    // Structure bytes (links index buffer).
    const structO = objectSide.engines[0]!.commits.find((c) => c.structure !== undefined)!
      .structure!;
    const structC = columnarSide.engines[0]!.commits.find((c) => c.structure !== undefined)!
      .structure!;
    expect(structC.pointCount).toBe(structO.pointCount);
    expect(Buffer.compare(Buffer.from(structC.links.buffer), Buffer.from(structO.links.buffer))).toBe(0);

    // Channel BYTES under the score scale (D2: byte-exact, not approximate).
    const colorO = objectSide.engines[0]!.lastBuffer('pointColor')!;
    const colorC = columnarSide.engines[0]!.lastBuffer('pointColor')!;
    expect(colorC.length).toBe(colorO.length);
    expect(
      Buffer.compare(
        Buffer.from(colorC.buffer, colorC.byteOffset, colorC.byteLength),
        Buffer.from(colorO.buffer, colorO.byteOffset, colorO.byteLength),
      ),
    ).toBe(0);

    // Attr reads through the public getter (the events/inspector lane).
    for (const probe of [0, Math.floor(nodes / 2), nodes - 1]) {
      const id = `n${probe}`;
      expect(ic.getNode(id)?.attrs).toEqual(io.getNode(id)?.attrs);
    }
  });
});
