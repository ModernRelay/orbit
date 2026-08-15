import { describe, expect, it } from 'vitest';
import { buildAdjacency } from '../src/adjacency';
import { MetricStore } from '../src/metrics';
import type { MetricModelInput } from '../src/metrics';
import type { GraphNode, MetricColumn } from '../src/types';

/** Deterministic PRNG (mulberry32) so property runs are reproducible. */
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

function linksOf(pairs: ReadonlyArray<readonly [number, number]>): Uint32Array {
  const out = new Uint32Array(pairs.length * 2);
  for (let i = 0; i < pairs.length; i++) {
    out[i * 2] = pairs[i]![0];
    out[i * 2 + 1] = pairs[i]![1];
  }
  return out;
}

function nodesOf(n: number): GraphNode[] {
  return Array.from({ length: n }, (_, i) => ({ id: `n${i}` }));
}

function modelOf(
  n: number,
  pairs: ReadonlyArray<readonly [number, number]>,
  modelRevision = 1,
): MetricModelInput {
  const links = linksOf(pairs);
  return {
    nodes: nodesOf(n),
    adjacency: buildAdjacency(links, n),
    links,
    datasetRevision: 'ds-1',
    modelRevision,
  };
}

function indexOf(n: number): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < n; i++) map.set(`n${i}`, i);
  return map;
}

/**
 * Naive oracle. Self-loop semantics, as documented in metrics.ts:
 * a self-loop (a, a) contributes exactly 1 to each of degree / inDegree /
 * outDegree of `a` — NOT 2 to degree, even though the CSR adjacency lists
 * the loop twice under its point.
 */
function oracle(n: number, pairs: ReadonlyArray<readonly [number, number]>) {
  const degree = new Array<number>(n).fill(0);
  const inDegree = new Array<number>(n).fill(0);
  const outDegree = new Array<number>(n).fill(0);
  for (const [s, t] of pairs) {
    outDegree[s] = outDegree[s]! + 1;
    inDegree[t] = inDegree[t]! + 1;
    if (s === t) {
      degree[s] = degree[s]! + 1;
    } else {
      degree[s] = degree[s]! + 1;
      degree[t] = degree[t]! + 1;
    }
  }
  return { degree, inDegree, outDegree };
}

describe('MetricStore — degree family', () => {
  it('computes degree/inDegree/outDegree on a small directed graph', () => {
    // n0 → n1, n0 → n2, n2 → n1
    const store = new MetricStore();
    store.setModel(modelOf(3, [[0, 1], [0, 2], [2, 1]]));
    expect(store.getMetricValue('degree', 0)).toBe(2);
    expect(store.getMetricValue('degree', 1)).toBe(2);
    expect(store.getMetricValue('degree', 2)).toBe(2);
    expect(store.getMetricValue('outDegree', 0)).toBe(2);
    expect(store.getMetricValue('inDegree', 0)).toBe(0);
    expect(store.getMetricValue('inDegree', 1)).toBe(2);
    expect(store.getMetricValue('outDegree', 1)).toBe(0);
    expect(store.getMetricValue('inDegree', 2)).toBe(1);
    expect(store.getMetricValue('outDegree', 2)).toBe(1);
  });

  it('a self-loop contributes exactly 1 to each of degree/in/out', () => {
    const store = new MetricStore();
    store.setModel(modelOf(2, [[0, 0]]));
    expect(store.getMetricValue('degree', 0)).toBe(1);
    expect(store.getMetricValue('inDegree', 0)).toBe(1);
    expect(store.getMetricValue('outDegree', 0)).toBe(1);
    expect(store.getMetricValue('degree', 1)).toBe(0);
  });

  it('counts parallel edges once per occurrence', () => {
    const store = new MetricStore();
    store.setModel(modelOf(2, [[0, 1], [0, 1]]));
    expect(store.getMetricValue('degree', 0)).toBe(2);
    expect(store.getMetricValue('degree', 1)).toBe(2);
    expect(store.getMetricValue('outDegree', 0)).toBe(2);
    expect(store.getMetricValue('inDegree', 1)).toBe(2);
  });

  it('matches the naive oracle on random graphs including self-loops', () => {
    const rand = mulberry32(0x5eed);
    for (let run = 0; run < 25; run++) {
      const n = 1 + Math.floor(rand() * 30);
      const linkCount = Math.floor(rand() * 60);
      const pairs: Array<readonly [number, number]> = [];
      for (let l = 0; l < linkCount; l++) {
        const s = Math.floor(rand() * n);
        // ~15% forced self-loops so every run exercises the correction.
        const t = rand() < 0.15 ? s : Math.floor(rand() * n);
        pairs.push([s, t]);
      }
      const store = new MetricStore();
      store.setModel(modelOf(n, pairs, run + 1));
      const expected = oracle(n, pairs);
      for (let i = 0; i < n; i++) {
        expect(store.getMetricValue('degree', i)).toBe(expected.degree[i]);
        expect(store.getMetricValue('inDegree', i)).toBe(expected.inDegree[i]);
        expect(store.getMetricValue('outDegree', i)).toBe(expected.outDegree[i]);
      }
    }
  });

  it('computes the family lazily, exactly once per model revision', () => {
    const store = new MetricStore();
    store.setModel(modelOf(3, [[0, 1], [1, 2]]));
    expect(store.degreeComputePasses).toBe(0);

    store.getMetricValue('degree', 0);
    expect(store.degreeComputePasses).toBe(1);

    // Repeated reads across the whole family reuse the same pass.
    store.getMetricValue('inDegree', 1);
    store.getMetricValue('outDegree', 2);
    store.metricValues('degree');
    expect(store.degreeComputePasses).toBe(1);

    // Same-revision re-set keeps the cache.
    store.setModel(modelOf(3, [[0, 1], [1, 2]]));
    store.getMetricValue('degree', 0);
    expect(store.degreeComputePasses).toBe(1);

    // New revision recomputes — once.
    store.setModel(modelOf(3, [[0, 1], [1, 2], [2, 0]], 2));
    expect(store.degreeComputePasses).toBe(1);
    store.getMetricValue('degree', 0);
    store.getMetricValue('inDegree', 0);
    expect(store.degreeComputePasses).toBe(2);
  });

  it('hasMetric never triggers a compute pass', () => {
    const store = new MetricStore();
    store.setModel(modelOf(2, [[0, 1]]));
    expect(store.hasMetric('degree')).toBe(true);
    expect(store.hasMetric('inDegree')).toBe(true);
    expect(store.hasMetric('outDegree')).toBe(true);
    expect(store.hasMetric('pagerank')).toBe(false);
    expect(store.degreeComputePasses).toBe(0);
  });

  it('returns null before any model is set and for out-of-range indices', () => {
    const store = new MetricStore();
    expect(store.getMetricValue('degree', 0)).toBeNull();
    expect(store.metricValues('degree')).toBeNull();
    expect(store.hasMetric('degree')).toBe(false);

    store.setModel(modelOf(2, [[0, 1]]));
    expect(store.getMetricValue('degree', -1)).toBeNull();
    expect(store.getMetricValue('degree', 2)).toBeNull();
    expect(store.getMetricValue('nope', 0)).toBeNull();
  });
});

describe('MetricStore — admitColumns, index align', () => {
  it('admits a length-matched column and coerces values through hygiene', () => {
    const store = new MetricStore();
    const column: MetricColumn = {
      metric: 'pagerank',
      forModelRevision: 1,
      align: 'index',
      // Adversarial payloads a JSON transport can smuggle through.
      values: [0.5, null, 'NaN' as unknown as number, '2.5' as unknown as number],
    };
    const { admitted, diagnostics } = store.admitColumns([column], {
      nodeIndex: indexOf(4),
      count: 4,
      modelRevision: 1,
    });
    expect(admitted).toEqual(['pagerank']);
    expect(diagnostics).toEqual([]);
    expect(store.hasMetric('pagerank')).toBe(true);
    expect(store.getMetricValue('pagerank', 0)).toBe(0.5);
    expect(store.getMetricValue('pagerank', 1)).toBeNull();
    expect(store.getMetricValue('pagerank', 2)).toBeNull();
    expect(store.getMetricValue('pagerank', 3)).toBe(2.5);

    const raw = store.metricValues('pagerank')!;
    expect(raw).toBeInstanceOf(Float64Array);
    expect(Number.isNaN(raw[1]!)).toBe(true);
    expect(Number.isNaN(raw[2]!)).toBe(true);
  });

  it('rejects a length-mismatched column with ONE metric-column-error', () => {
    const store = new MetricStore();
    const { admitted, diagnostics } = store.admitColumns(
      [{ metric: 'pagerank', forModelRevision: 1, align: 'index', values: [1, 2, 3] }],
      { nodeIndex: indexOf(4), count: 4, modelRevision: 1 },
    );
    expect(admitted).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe('metric-column-error');
    expect(diagnostics[0]!.severity).toBe('warning');
    expect(store.hasMetric('pagerank')).toBe(false);
  });
});

describe('MetricStore — admitColumns, ids align', () => {
  it('joins by id: unknown skipped, duplicate last-wins, missing rows null', () => {
    const store = new MetricStore();
    const column: MetricColumn = {
      metric: 'score',
      forModelRevision: 7,
      align: 'ids',
      ids: ['n0', 'ghost', 'n1', 'n1', 'phantom'],
      values: [1, 99, 2, 3, 98],
    };
    const { admitted, diagnostics } = store.admitColumns([column], {
      nodeIndex: indexOf(4),
      count: 4,
      modelRevision: 7,
    });

    expect(admitted).toEqual(['score']);
    expect(store.getMetricValue('score', 0)).toBe(1);
    expect(store.getMetricValue('score', 1)).toBe(3); // duplicate: last wins
    expect(store.getMetricValue('score', 2)).toBeNull(); // missing row
    expect(store.getMetricValue('score', 3)).toBeNull(); // missing row

    // Exactly ONE diagnostic per kind, each with count + samples.
    expect(diagnostics).toHaveLength(2);
    const unknown = diagnostics.find((d) => d.message.includes('not in the accepted model'))!;
    expect(unknown.code).toBe('metric-column-error');
    expect(unknown.count).toBe(2);
    expect(unknown.sampleIds).toEqual(['ghost', 'phantom']);
    const duplicate = diagnostics.find((d) => d.message.includes('duplicate'))!;
    expect(duplicate.code).toBe('metric-column-error');
    expect(duplicate.count).toBe(1);
    expect(duplicate.sampleIds).toEqual(['n1']);
  });

  it('rejects when the ids array is absent', () => {
    const store = new MetricStore();
    const { admitted, diagnostics } = store.admitColumns(
      [{ metric: 'score', forModelRevision: 1, align: 'ids', values: [1, 2] }],
      { nodeIndex: indexOf(2), count: 2, modelRevision: 1 },
    );
    expect(admitted).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe('metric-column-error');
    expect(store.hasMetric('score')).toBe(false);
  });

  it('rejects when ids and values lengths differ', () => {
    const store = new MetricStore();
    const { admitted, diagnostics } = store.admitColumns(
      [{ metric: 'score', forModelRevision: 1, align: 'ids', ids: ['n0'], values: [1, 2] }],
      { nodeIndex: indexOf(2), count: 2, modelRevision: 1 },
    );
    expect(admitted).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe('metric-column-error');
  });

  it('routes ids-aligned values through hygiene', () => {
    const store = new MetricStore();
    store.admitColumns(
      [{
        metric: 'score', forModelRevision: 1,
        align: 'ids',
        ids: ['n0', 'n1'],
        values: ['Infinity' as unknown as number, ' 4 ' as unknown as number],
      }],
      { nodeIndex: indexOf(2), count: 2, modelRevision: 1 },
    );
    expect(store.getMetricValue('score', 0)).toBeNull();
    expect(store.getMetricValue('score', 1)).toBe(4);
  });
});

describe('MetricStore — revision gating', () => {
  it('discards a stale-revision batch with a diagnostic and no admission', () => {
    const store = new MetricStore();
    const { admitted, diagnostics } = store.admitColumns(
      [{ metric: 'pagerank', forModelRevision: 4, align: 'index', values: [1, 2] }],
      { nodeIndex: indexOf(2), count: 2, modelRevision: 5 },
    );
    expect(admitted).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe('metric-column-error');
    expect(diagnostics[0]!.severity).toBe('info');
    expect(diagnostics[0]!.message).toContain('revision');
    expect(store.hasMetric('pagerank')).toBe(false);
  });

  it('emits one discard diagnostic per stale column', () => {
    const store = new MetricStore();
    const { admitted, diagnostics } = store.admitColumns(
      [
        { metric: 'a', forModelRevision: 1, align: 'index', values: [1] },
        { metric: 'b', forModelRevision: 1, align: 'index', values: [2] },
      ],
      { nodeIndex: indexOf(1), count: 1, modelRevision: 2 },
    );
    expect(admitted).toEqual([]);
    expect(diagnostics).toHaveLength(2);
  });

  it('drops admitted columns when the model revision advances', () => {
    const store = new MetricStore();
    store.setModel(modelOf(2, [[0, 1]], 1));
    store.admitColumns(
      [{ metric: 'pagerank', forModelRevision: 1, align: 'index', values: [0.1, 0.9] }],
      { nodeIndex: indexOf(2), count: 2, modelRevision: 1 },
    );
    expect(store.hasMetric('pagerank')).toBe(true);

    store.setModel(modelOf(2, [[0, 1]], 2));
    expect(store.hasMetric('pagerank')).toBe(false);
    expect(store.getMetricValue('pagerank', 0)).toBeNull();
    // Degree family survives as a lazily recomputable built-in.
    expect(store.hasMetric('degree')).toBe(true);
  });

  it('an admitted column shadows the built-in of the same name', () => {
    const store = new MetricStore();
    store.setModel(modelOf(2, [[0, 1]], 1));
    store.admitColumns(
      [{ metric: 'degree', forModelRevision: 1, align: 'index', values: [100, 200] }],
      { nodeIndex: indexOf(2), count: 2, modelRevision: 1 },
    );
    expect(store.getMetricValue('degree', 0)).toBe(100);
    expect(store.getMetricValue('degree', 1)).toBe(200);
    // The precomputed column resolved without a topology pass.
    expect(store.degreeComputePasses).toBe(0);
  });
});
