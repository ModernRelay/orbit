/**
 * Regression coverage for v0.13.6 fixes:
 * - initially-fixed mounts pause the engine (probe fixed-drift: cosmos
 * HOLDS without start, 0.00px/2.5s — the pause is state-alignment
 * insurance, and the flag now matches force→fixed transitions);
 * - setViewState APPLIES the serialized layout kind;
 * - exportDataStream output is PINNED at capture (a filter change between
 * obtaining and consuming must not alter it);
 * - a columnar snapshot with a MISSING ids column rejects whole, never
 * throws;
 * - NUL-containing node ids reject in BOTH lanes (scene-key codec
 * collision) with oracle-equal diagnostics.
 * (The dead-worker fallback revalidation lives in worker-admission.test.ts,
 * next to its rig.)
 */

import { describe, expect, it } from 'vitest';

import { createGraphInstance } from '../src/instance';
import { acceptColumnar } from '../src/columnarValidate';
import {
  materializeColumnarSnapshot,
  validateColumnarStructure,
} from '../src/columnar';
import { validateSnapshot } from '../src/validate';
import { FakeEngine } from '../src/testing/index';
import type { ColumnarGraphSnapshot, GraphSnapshot } from '../src/types';
import { container, makeInstance, snap } from './helpers';
import type { EAttrs, NAttrs } from './helpers';

describe('initially-fixed layout pauses the engine after the fixed-drift probe', () => {
  it('a fixed-layout mount issues pause() on ready; a force mount does not', async () => {
    const engines: FakeEngine[] = [];
    const instance = createGraphInstance<NAttrs, EAttrs>({
      engine: () => {
        const e = new FakeEngine();
        engines.push(e);
        return e;
      },
      fitViewOnFirstData: false,
    });
    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]), layout: 'fixed' });
    await instance.attach(container);
    expect(engines[0]!.calls.some((c) => c.method === 'pause')).toBe(true);
    expect(instance.store.getState().simulationRunning).toBe(false);
    instance.destroy();

    const h = makeInstance({ fitViewOnFirstData: false });
    h.instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
    await h.instance.attach(container);
    expect(h.engines[0]!.calls.some((c) => c.method === 'pause')).toBe(false);
  });
});

describe('setViewState applies the serialized layout', () => {
  it('restoring a FIXED state into a force instance actually fixes the layout', async () => {
    // Author instance: fixed layout, capture.
    const a = makeInstance({ fitViewOnFirstData: false });
    await a.instance.attach(container);
    a.instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]), layout: 'fixed' });
    const state = a.instance.getViewState();
    expect(state.layout.kind).toBe('fixed');

    // Restore into a FORCE instance with the same data.
    const b = makeInstance({ fitViewOnFirstData: false });
    await b.instance.attach(container);
    b.instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
    expect(b.instance.getViewState().layout.kind).toBe('force');

    const result = await b.instance.setViewState(state);
    expect(result.status).toBe('applied');
    expect(b.instance.getViewState().layout.kind).toBe('fixed'); // was force forever
    expect(b.engines[0]!.calls.some((c) => c.method === 'pause')).toBe(true);
  });
});

describe('export streams are PINNED at capture', () => {
  it('a filter change between obtaining and consuming does not alter the stream', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    h.instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c'], [['a', 'b']]) });

    const stream = h.instance.exportDataStream('visible'); // pin captured HERE
    h.instance.hideNodes(['b', 'c']); // the mask mutates after capture

    const lines: string[] = [];
    for await (const line of stream) lines.push(line);
    const nodeIds = lines
      .map((l) => JSON.parse(l) as { kind: string; value: { id?: string } })
      .filter((r) => r.kind === 'node')
      .map((r) => r.value.id);
    expect(nodeIds).toEqual(['a', 'b', 'c']); // capture-time visibility
  });
});

describe('malformed columnar objects reject whole — never throw', () => {
  it('a missing ids column is a rejection issue, not a TypeError', () => {
    const noIds = {
      kind: 'columnar',
      datasetKey: 'x',
      sourceRevision: 1,
      nodes: { columns: {}, length: 2 }, // ids MISSING
      edges: {
        ids: { kind: 'string', dictionary: [], codes: new Uint32Array(0) },
        source: new Uint32Array(0),
        target: new Uint32Array(0),
        columns: {},
        length: 0,
      },
    } as unknown as ColumnarGraphSnapshot;
    const issues = validateColumnarStructure(noIds);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.problem).toBe('not-a-string-column');
  });

  it('missing lanes and junk columns reject too', () => {
    const noEdges = {
      kind: 'columnar',
      datasetKey: 'x',
      sourceRevision: 1,
      nodes: {
        ids: { kind: 'string', dictionary: ['a'], codes: Uint32Array.of(0) },
        columns: { junk: 42 },
        length: 1,
      },
    } as unknown as ColumnarGraphSnapshot;
    expect(() => validateColumnarStructure(noEdges)).not.toThrow();
    expect(validateColumnarStructure(noEdges).length).toBeGreaterThan(0);
  });

  it('the instance path stays reject-whole for the same input', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    h.instance.applyHostUpdate({ data: snap(1, ['keep'], []) });
    h.instance.applyHostUpdate({
      data: {
        kind: 'columnar',
        datasetKey: 'x',
        sourceRevision: 2,
        nodes: { columns: {}, length: 1 },
        edges: { columns: {}, length: 0 },
      } as never,
    });
    expect(h.instance.getSceneNodeIds()).toEqual(['keep']);
    expect(
      h.instance.store
        .getState()
        .diagnostics.some((d) => d.code === 'invalid-columnar-snapshot'),
    ).toBe(true);
  });
});

describe('NUL-containing node ids reject in both lanes to protect the scene-key codec', () => {
  const NUL_ID = '\u0000[\"group\",\"g\"]';

  it('object lane: the id drops as invalid-node; edges to it dangle', async () => {
    const accepted = validateSnapshot({
      datasetKey: 'n',
      sourceRevision: 1,
      nodes: [{ id: 'a' }, { id: NUL_ID }],
      edges: [{ source: 'a', target: NUL_ID }],
    } as GraphSnapshot);
    expect(accepted.nodes.map((n) => n.id)).toEqual(['a']);
    expect(accepted.edges).toEqual([]);
    expect(accepted.diagnostics.map((d) => d.code).sort()).toEqual([
      'dangling-edge-endpoint',
      'invalid-node',
    ]);
  });

  it('columnar lane agrees with the object oracle, diagnostics included', () => {
    const snapshot = {
      kind: 'columnar',
      datasetKey: 'n',
      sourceRevision: 1,
      nodes: {
        ids: { kind: 'string', dictionary: ['a', NUL_ID], codes: Uint32Array.of(0, 1) },
        columns: {},
        length: 2,
      },
      edges: {
        ids: { kind: 'string', dictionary: ['e1'], codes: Uint32Array.of(0) },
        source: Uint32Array.of(0),
        target: Uint32Array.of(1),
        columns: {},
        length: 1,
      },
    } as unknown as ColumnarGraphSnapshot;
    const native = acceptColumnar(snapshot);
    const oracle = validateSnapshot(materializeColumnarSnapshot(snapshot));
    expect(native.acceptedNodeCount).toBe(oracle.nodes.length);
    expect(native.acceptedEdgeCount).toBe(oracle.edges.length);
    expect(native.diagnostics).toEqual(oracle.diagnostics);
  });
});
