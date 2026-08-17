/**
 * the columnar snapshot lane: structural validation
 * rejects WHOLE (prior scene intact, one error diagnostic), a valid columnar
 * snapshot lands byte-identical to its object-form twin through the shared
 * pipeline (the first parity seed), transfer ownership detaches ONLY after
 * validation succeeds, and a consumed transfer snapshot is structurally
 * single-use.
 */

import { describe, expect, it } from 'vitest';

import {
  columnarArrayBuffers,
  detachColumnarBuffers,
  materializeColumnarSnapshot,
  validateColumnarStructure,
} from '../src/columnar';
import type { ColumnarGraphSnapshot, GraphSnapshot } from '../src/types';
import { container, makeInstance, snap } from './helpers';
import type { EAttrs, NAttrs } from './helpers';

type Fixture = ColumnarGraphSnapshot<NAttrs, EAttrs>;

/** 3 nodes / 2 edges with one column per kind and a null hole. The __attrs
 * witness is compile-time-only, so the demo columns brand freely. */
function fixture(over?: Partial<Fixture>): Fixture {
  return {
    kind: 'columnar',
    datasetKey: 'col-demo',
    sourceRevision: 1,
    nodes: {
      ids: { kind: 'string', dictionary: ['a', 'b', 'c'], codes: Uint32Array.of(0, 1, 2) },
      columns: {
        score: { kind: 'f64', data: Float64Array.of(1.5, 2.5, 3.5), nulls: Uint8Array.of(0, 0, 1) },
        cluster: {
          kind: 'string',
          dictionary: ['alpha', 'beta'],
          codes: Uint32Array.of(0, 1, 0),
        },
        active: { kind: 'bool', data: Uint8Array.of(1, 0, 1) },
      },
      length: 3,
    },
    edges: {
      ids: { kind: 'string', dictionary: ['e1', 'e2'], codes: Uint32Array.of(0, 1) },
      source: Uint32Array.of(0, 1),
      target: Uint32Array.of(1, 2),
      columns: {
        weight: { kind: 'i32', data: Int32Array.of(7, 9) },
      },
      length: 2,
    },
    ...over,
  };
}

/** The same logical graph in object form. The harness pins NAttrs/EAttrs to
 * its own demo shape — the columnar fixtures carry different attrs, so both
 * sides brand through one cast (runtime shapes are what the test compares). */
const OBJECT_TWIN = {
  datasetKey: 'col-demo',
  sourceRevision: 1,
  nodes: [
    { id: 'a', attrs: { score: 1.5, cluster: 'alpha', active: true } },
    { id: 'b', attrs: { score: 2.5, cluster: 'beta', active: false } },
    { id: 'c', attrs: { score: null, cluster: 'alpha', active: true } },
  ],
  edges: [
    { id: 'e1', source: 'a', target: 'b', attrs: { weight: 7 } },
    { id: 'e2', source: 'b', target: 'c', attrs: { weight: 9 } },
  ],
} as unknown as GraphSnapshot<NAttrs, EAttrs>;

describe('structural validation (reject WHOLE, O(cols+rows))', () => {
  it('a sound snapshot has zero issues', () => {
    expect(validateColumnarStructure(fixture())).toEqual([]);
  });

  it('catches length mismatch, code bounds, endpoint bounds, and null ids', () => {
    const short = fixture();
    (short.nodes.columns as Record<string, unknown>).score = {
      kind: 'f64',
      data: Float64Array.of(1),
    };
    expect(validateColumnarStructure(short).map((i) => i.problem)).toContain('length-mismatch');

    const badCode = fixture();
    badCode.nodes.ids.codes[2] = 99; // beyond the dictionary
    expect(validateColumnarStructure(badCode).map((i) => i.problem)).toContain(
      'code-out-of-range',
    );

    const badEndpoint = fixture();
    badEndpoint.edges.target[1] = 7; // only 3 nodes exist
    expect(validateColumnarStructure(badEndpoint).map((i) => i.problem)).toContain(
      'endpoint-out-of-range',
    );

    const nullId = fixture();
    nullId.nodes.ids.nulls = Uint8Array.of(0, 1, 0);
    expect(validateColumnarStructure(nullId).map((i) => i.problem)).toContain('null-id');

    const junkKind = fixture();
    (junkKind.edges.columns as Record<string, unknown>).weight = {
      kind: 'f16',
      data: Int32Array.of(1, 2),
    };
    expect(validateColumnarStructure(junkKind).map((i) => i.problem)).toContain(
      'bad-column-kind',
    );
  });

  it('rejects non-string dictionary entries before main or worker admission', () => {
    for (const mutate of [
      (snapshot: Fixture) => {
        (snapshot.nodes.ids.dictionary as unknown[])[1] = 42;
      },
      (snapshot: Fixture) => {
        (snapshot.edges.ids.dictionary as unknown[])[0] = { id: 'e1' };
      },
      (snapshot: Fixture) => {
        const cluster = snapshot.nodes.columns!.cluster!;
        if (cluster.kind === 'string') (cluster.dictionary as unknown[])[0] = null;
      },
    ]) {
      const snapshot = fixture();
      mutate(snapshot);
      expect(validateColumnarStructure(snapshot)).toContainEqual(
        expect.objectContaining({
          problem: 'not-a-string-column',
          detail: expect.stringContaining('dictionary entry'),
        }),
      );
    }
  });
});

describe('ingestion through the instance (the shared pipeline)', () => {
  async function rig() {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    return { ...h, engine: h.engines[0]! };
  }

  it('a columnar snapshot lands IDENTICAL to its object twin (parity seed)', async () => {
    const a = await rig();
    a.instance.applyHostUpdate({ data: fixture() });
    const b = await rig();
    b.instance.applyHostUpdate({ data: OBJECT_TWIN });

    expect(a.instance.getSceneNodeIds()).toEqual(b.instance.getSceneNodeIds());
    expect(a.instance.store.getState().visible).toEqual(b.instance.store.getState().visible);
    // The engine-facing structure is the byte-level witness.
    const structA = a.engine.commits.find((c) => c.structure !== undefined)!.structure!;
    const structB = b.engine.commits.find((c) => c.structure !== undefined)!.structure!;
    expect(structA.pointCount).toBe(structB.pointCount);
    expect([...structA.links]).toEqual([...structB.links]);
    // Attr access parity (null hole included): drive a crossfilter dim over
    // the materialized attrs.
    const attrsOf = (inst: typeof a.instance) =>
      inst.getSceneNodeIds().map((id) => inst.getNode(id)?.attrs);
    expect(attrsOf(a.instance)).toEqual(attrsOf(b.instance));
  });

  it('rejects a corrupt snapshot WHOLE: prior scene intact + one error diagnostic', async () => {
    const { instance } = await rig();
    instance.applyHostUpdate({ data: snap(1, ['keep'], []) });
    expect(instance.getSceneNodeIds()).toEqual(['keep']);

    const bad = fixture();
    bad.edges.source[0] = 42; // endpoint corruption
    instance.applyHostUpdate({ data: bad });

    expect(instance.getSceneNodeIds()).toEqual(['keep']); // prior scene survives
    const diag = instance.store
      .getState()
      .diagnostics.find((d) => d.code === 'invalid-columnar-snapshot');
    expect(diag).toBeDefined();
    expect(diag!.severity).toBe('error');

    // A later successful acceptance clears the rejection diagnostic.
    instance.applyHostUpdate({ data: fixture() });
    expect(
      instance.store.getState().diagnostics.some((d) => d.code === 'invalid-columnar-snapshot'),
    ).toBe(false);
    expect(instance.getSceneNodeIds()).toEqual(['a', 'b', 'c']);
  });

  it('rejects a non-string id dictionary WHOLE instead of materializing non-string ids', async () => {
    const { instance } = await rig();
    instance.applyHostUpdate({ data: snap(1, ['keep'], []) });
    const bad = fixture();
    (bad.nodes.ids.dictionary as unknown[])[0] = 7;

    instance.applyHostUpdate({ data: bad });

    expect(instance.getSceneNodeIds()).toEqual(['keep']);
    expect(
      instance.store
        .getState()
        .diagnostics.find((diag) => diag.code === 'invalid-columnar-snapshot')?.message,
    ).toContain('dictionary entry 0 is not a string');
  });

  it('duplicate ids and self-loops flow through the OBJECT-lane rules (one place)', async () => {
    const { instance } = await rig();
    const dup = fixture();
    dup.nodes.ids.codes[2] = 0; // 'a' appears twice; row 2 dropped first-wins
    // Row 2's duplicate drop makes edge e2 (b -> node 2) target the FIRST 'a'.
    instance.applyHostUpdate({ data: dup });
    expect(instance.getSceneNodeIds()).toEqual(['a', 'b']);
    expect(
      instance.store.getState().diagnostics.some((d) => d.code === 'duplicate-node-id'),
    ).toBe(true);
  });

  it('a replay (same datasetKey+sourceRevision) is a no-op that never touches buffers', async () => {
    const { instance, engine } = await rig();
    const first = fixture({ bufferOwnership: 'transfer' });
    instance.applyHostUpdate({ data: first });
    const commitsAfterFirst = engine.commits.length;

    const replay = fixture({ bufferOwnership: 'transfer' }); // fresh buffers, same coordinate
    instance.applyHostUpdate({ data: replay });
    expect(engine.commits.length).toBe(commitsAfterFirst); // no reconcile
    // Replay buffers stay UNDETACHED — nothing was admitted.
    expect(columnarArrayBuffers(replay).every((b) => b.byteLength > 0)).toBe(true);
  });
});

describe("bufferOwnership: 'transfer'", () => {
  async function rig() {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    return h;
  }

  it('detaches every buffer AFTER a successful ingest (byteLength 0 both entities)', async () => {
    const { instance } = await rig();
    const snapIn = fixture({ bufferOwnership: 'transfer' });
    const buffers = columnarArrayBuffers(snapIn);
    expect(buffers.length).toBeGreaterThan(5);
    expect(buffers.every((b) => b.byteLength > 0)).toBe(true);

    instance.applyHostUpdate({ data: snapIn });

    expect(instance.getSceneNodeIds()).toEqual(['a', 'b', 'c']);
    expect(buffers.every((b) => b.byteLength === 0)).toBe(true); // all detached
  });

  it('a REJECTED snapshot leaves every caller buffer intact (reject-before-detach)', async () => {
    const { instance } = await rig();
    const bad = fixture({ bufferOwnership: 'transfer' });
    bad.edges.source[0] = 42;
    const buffers = columnarArrayBuffers(bad);

    instance.applyHostUpdate({ data: bad });

    expect(buffers.every((b) => b.byteLength > 0)).toBe(true); // untouched
  });

  it("'borrowed' (default) leaves caller buffers usable after ingest", async () => {
    const { instance } = await rig();
    const snapIn = fixture();
    instance.applyHostUpdate({ data: snapIn });
    expect(columnarArrayBuffers(snapIn).every((b) => b.byteLength > 0)).toBe(true);
  });

  it('a consumed transfer snapshot is STRUCTURALLY single-use (detached views fail validation)', async () => {
    const { instance } = await rig();
    const snapIn = fixture({ bufferOwnership: 'transfer' });
    instance.applyHostUpdate({ data: snapIn });

    // Reuse under a NEW sourceRevision (not a replay): the detached views
    // fail structural validation — no WeakSet bookkeeping required.
    const reused = { ...snapIn, sourceRevision: 2 };
    const issues = validateColumnarStructure(reused);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.detail).toContain('DETACHED');

    instance.applyHostUpdate({ data: reused });
    expect(instance.getSceneNodeIds()).toEqual(['a', 'b', 'c']); // prior scene intact
    expect(
      instance.store.getState().diagnostics.some((d) => d.code === 'invalid-columnar-snapshot'),
    ).toBe(true);
  });

  it('detachColumnarBuffers is idempotent and counts distinct buffers once', () => {
    const snapIn = fixture();
    const n = detachColumnarBuffers(snapIn);
    expect(n).toBe(columnarArrayBuffers(fixture()).length);
    expect(detachColumnarBuffers(snapIn)).toBe(0); // second pass: nothing left
  });
});

describe('materialization semantics', () => {
  it('decodes dictionaries, bools, and null holes as JSON-ish values', () => {
    const out = materializeColumnarSnapshot(fixture());
    expect(out.nodes[0]).toEqual({ id: 'a', attrs: { score: 1.5, cluster: 'alpha', active: true } });
    expect(out.nodes[2]!.attrs).toEqual({ score: null, cluster: 'alpha', active: true });
    expect(out.edges[1]).toEqual({ id: 'e2', source: 'b', target: 'c', attrs: { weight: 9 } });
  });
});
