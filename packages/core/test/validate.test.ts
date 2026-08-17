import { describe, expect, it } from 'vitest';
import { validateSnapshot } from '../src/validate';
import { DIAGNOSTIC_SAMPLE_CAP } from '../src/types';
import type {
  DiagnosticCode,
  GraphDiagnostic,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
} from '../src/types';

function snap(
  nodes: readonly unknown[],
  edges: readonly unknown[] = [],
): GraphSnapshot<Record<string, unknown>, Record<string, unknown>> {
  return {
    datasetKey: 'ds',
    sourceRevision: 1,
    nodes: nodes as readonly GraphNode[],
    edges: edges as readonly GraphEdge[],
  };
}

function diag(
  diagnostics: readonly GraphDiagnostic[],
  code: DiagnosticCode,
): GraphDiagnostic | undefined {
  return diagnostics.find((d) => d.code === code);
}

describe('validateSnapshot — nodes', () => {
  it('drops rows without a string id with a batched invalid-node error', () => {
    const result = validateSnapshot(
      snap([{ id: 'a' }, { id: 42 }, {}, null, 'not-an-object', { id: 'b' }]),
    );
    expect(result.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    const d = diag(result.diagnostics, 'invalid-node');
    expect(d).toBeDefined();
    expect(d!.severity).toBe('error');
    expect(d!.count).toBe(4);
    expect(result.diagnostics.filter((x) => x.code === 'invalid-node')).toHaveLength(1);
  });

  it('dedupes duplicate ids first-wins, keeping the FIRST occurrence attrs', () => {
    const result = validateSnapshot(
      snap([
        { id: 'a', attrs: { v: 'first' } },
        { id: 'b' },
        { id: 'a', attrs: { v: 'second' } },
        { id: 'a', attrs: { v: 'third' } },
      ]),
    );
    expect(result.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(result.nodes[0]!.attrs).toEqual({ v: 'first' });
    const d = diag(result.diagnostics, 'duplicate-node-id');
    expect(d).toMatchObject({ severity: 'warning', count: 2 });
    expect(d!.sampleIds).toEqual(['a', 'a']);
  });

  it('builds nodeIndex mapping id → position in accepted first-occurrence order', () => {
    const result = validateSnapshot(snap([{ id: 'x' }, { id: 'y' }, { id: 'x' }, { id: 'z' }]));
    expect(result.nodes.map((n) => n.id)).toEqual(['x', 'y', 'z']);
    expect(result.nodeIndex.get('x')).toBe(0);
    expect(result.nodeIndex.get('y')).toBe(1);
    expect(result.nodeIndex.get('z')).toBe(2);
    expect(result.nodeIndex.size).toBe(3);
  });
});

describe('validateSnapshot — edges', () => {
  const ab = [{ id: 'a' }, { id: 'b' }];

  it('drops rows without string source/target with a batched invalid-edge error', () => {
    const result = validateSnapshot(
      snap(ab, [
        { source: 'a', target: 'b' },
        { source: 'a' },
        { target: 'b' },
        { source: 1, target: 'b' },
        null,
        'nope',
      ]),
    );
    expect(result.edges).toHaveLength(1);
    const d = diag(result.diagnostics, 'invalid-edge');
    expect(d).toMatchObject({ severity: 'error', count: 5 });
  });

  it('drops explicit edge ids in the reserved NUL meta-edge namespace', () => {
    const reserved = '\u0000["meta-edge","a","b"]';
    const result = validateSnapshot(
      snap(ab, [
        { id: reserved, source: 'a', target: 'b' },
        { id: 'safe', source: 'a', target: 'b' },
      ]),
    );

    expect(result.edges.map((edge) => edge.id)).toEqual(['safe']);
    expect(diag(result.diagnostics, 'invalid-edge')).toMatchObject({
      severity: 'error',
      count: 1,
      sampleIds: ['[0]'],
    });
  });

  it('drops edges whose endpoint is not in the accepted node set', () => {
    const result = validateSnapshot(
      snap(ab, [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'missing' },
        { source: 'ghost', target: 'b' },
      ]),
    );
    expect(result.edges.map((e) => e.id)).toEqual(['a→b#0']);
    const d = diag(result.diagnostics, 'dangling-edge-endpoint');
    expect(d).toMatchObject({ severity: 'warning', count: 2 });
    expect(d!.sampleIds).toEqual(['missing', 'ghost']);
  });

  it('retains self-loops and reports them as info', () => {
    const result = validateSnapshot(
      snap(ab, [
        { source: 'a', target: 'a' },
        { source: 'a', target: 'b' },
        { id: 'loop-b', source: 'b', target: 'b' },
      ]),
    );
    expect(result.edges.map((e) => e.id)).toEqual(['a→a#0', 'a→b#0', 'loop-b']);
    const d = diag(result.diagnostics, 'self-loop-retained');
    expect(d).toMatchObject({ severity: 'info', count: 2 });
    expect(d!.sampleIds).toEqual(['a', 'b']);
  });

  it('dedupes explicit edge ids first-wins, keeping the FIRST occurrence attrs', () => {
    const result = validateSnapshot(
      snap(ab, [
        { id: 'e1', source: 'a', target: 'b', attrs: { v: 'first' } },
        { id: 'e1', source: 'b', target: 'a', attrs: { v: 'second' } },
      ]),
    );
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]!.attrs).toEqual({ v: 'first' });
    expect(result.edges[0]!.source).toBe('a');
    const d = diag(result.diagnostics, 'duplicate-edge-id');
    expect(d).toMatchObject({ severity: 'warning', count: 1, sampleIds: ['e1'] });
  });

  it('synthesizes parallel-edge ids per ordered pair in first-occurrence order', () => {
    const result = validateSnapshot(
      snap(ab, [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
      ]),
    );
    expect(result.edges.map((e) => e.id)).toEqual(['a→b#0', 'a→b#1', 'b→a#0']);
  });

  it('synthesizes distinct ids for endpoint tuples containing framing characters', () => {
    const result = validateSnapshot(
      snap(
        [{ id: 'a→b' }, { id: 'c' }, { id: 'a' }, { id: 'b→c' }],
        [
          { source: 'a→b', target: 'c' },
          { source: 'a', target: 'b→c' },
        ],
      ),
    );

    expect(result.edges.map((e) => e.id)).toEqual(['a\\→b→c#0', 'a→b\\→c#0']);
    expect(diag(result.diagnostics, 'duplicate-edge-id')).toBeUndefined();
  });

  it('applies first-wins with a duplicate diagnostic when a synthesized id collides with an accepted explicit id', () => {
    const result = validateSnapshot(
      snap(ab, [
        { id: 'a→b#0', source: 'a', target: 'b', attrs: { v: 'explicit' } },
        { source: 'a', target: 'b' }, // synthesizes a→b#0 → collision → dropped
        { source: 'a', target: 'b' }, // k advanced deterministically → a→b#1
      ]),
    );
    expect(result.edges.map((e) => e.id)).toEqual(['a→b#0', 'a→b#1']);
    expect(result.edges[0]!.attrs).toEqual({ v: 'explicit' });
    const d = diag(result.diagnostics, 'duplicate-edge-id');
    expect(d).toMatchObject({ severity: 'warning', count: 1, sampleIds: ['a→b#0'] });
  });
});

describe('validateSnapshot — diagnostics batching', () => {
  it('caps sampleIds at DIAGNOSTIC_SAMPLE_CAP while count reflects the total', () => {
    const total = DIAGNOSTIC_SAMPLE_CAP + 7;
    const badNodes = Array.from({ length: total }, () => ({ id: 123 }));
    const result = validateSnapshot(snap([{ id: 'a' }, ...badNodes]));
    const d = diag(result.diagnostics, 'invalid-node');
    expect(d!.count).toBe(total);
    expect(d!.sampleIds).toHaveLength(DIAGNOSTIC_SAMPLE_CAP);
  });

  it('emits at most one diagnostic per code', () => {
    const result = validateSnapshot(
      snap(
        [{ id: 'a' }, { id: 'a' }, { id: 'a' }, {}, {}],
        [
          { source: 'a', target: 'nope' },
          { source: 'a', target: 'nope' },
          { id: 'e', source: 'a', target: 'a' },
          { id: 'e', source: 'a', target: 'a' },
          {},
          {},
        ],
      ),
    );
    const codes = result.diagnostics.map((d) => d.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('validateSnapshot — purity and determinism', () => {
  it('returns structurally identical output for two calls on the same input', () => {
    const input = snap(
      [{ id: 'a', attrs: { n: 1 } }, { id: 'b' }, { id: 'a' }, { id: 7 }],
      [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'b' },
        { id: 'x', source: 'b', target: 'a' },
        { id: 'x', source: 'a', target: 'b' },
        { source: 'a', target: 'a' },
        { source: 'a', target: 'gone' },
        { source: 'a' },
      ],
    );
    const first = validateSnapshot(input);
    const second = validateSnapshot(input);
    expect(second).toEqual(first);
  });

  it('does not mutate the input snapshot', () => {
    const nodes = [{ id: 'a' }, { id: 'a' }];
    const edges = [{ source: 'a', target: 'a' }];
    const nodesCopy = structuredClone(nodes);
    const edgesCopy = structuredClone(edges);
    validateSnapshot(snap(nodes, edges));
    expect(nodes).toEqual(nodesCopy);
    expect(edges).toEqual(edgesCopy);
  });

  it('never throws on grossly malformed input', () => {
    expect(() =>
      validateSnapshot({
        datasetKey: 'ds',
        sourceRevision: 0,
        nodes: null as never,
        edges: undefined as never,
      }),
    ).not.toThrow();
    expect(() =>
      validateSnapshot(snap([NaN, [], () => {}, Symbol('x')], [42, true, [], { id: {} }])),
    ).not.toThrow();
  });
});

describe('validateSnapshot — adversarial scale', () => {
  it('handles a 10k-row mix fast with exactly one diagnostic per code', () => {
    const nodes: unknown[] = [];
    const edges: unknown[] = [];
    for (let i = 0; i < 5000; i++) {
      switch (i % 4) {
        case 0:
          nodes.push({ id: `n${i}` });
          break;
        case 1:
          nodes.push({ id: i }); // invalid-node
          break;
        case 2:
          nodes.push({ id: `n${i - 2}` }); // duplicate-node-id
          break;
        default:
          nodes.push({ id: `n${i}` });
      }
    }
    for (let i = 0; i < 5000; i++) {
      switch (i % 5) {
        case 0:
          edges.push({ source: 'n0', target: 'n4' });
          break;
        case 1:
          edges.push({ source: 'n0' }); // invalid-edge
          break;
        case 2:
          edges.push({ source: 'n0', target: `missing${i}` }); // dangling
          break;
        case 3:
          edges.push({ id: 'dup', source: 'n0', target: 'n4' }); // duplicate after first
          break;
        default:
          edges.push({ source: 'n0', target: 'n0' }); // self-loop
      }
    }

    const start = performance.now();
    const result = validateSnapshot(snap(nodes, edges));
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);

    const codes = result.diagnostics.map((d) => d.code).sort();
    expect(codes).toEqual(
      [
        'invalid-node',
        'duplicate-node-id',
        'invalid-edge',
        'dangling-edge-endpoint',
        'duplicate-edge-id',
        'self-loop-retained',
      ].sort(),
    );
    for (const d of result.diagnostics) {
      expect(d.sampleIds.length).toBeLessThanOrEqual(DIAGNOSTIC_SAMPLE_CAP);
      expect(d.count).toBeGreaterThan(0);
    }
    // Spot-check totals: 1250 invalid nodes, 1250 duplicate node ids.
    expect(diag(result.diagnostics, 'invalid-node')!.count).toBe(1250);
    expect(diag(result.diagnostics, 'duplicate-node-id')!.count).toBe(1250);
    // 999 duplicate-edge-id: every 'dup' after the first.
    expect(diag(result.diagnostics, 'duplicate-edge-id')!.count).toBe(999);
  });
});
