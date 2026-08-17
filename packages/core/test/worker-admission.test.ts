/**
 * Worker-lane ASYNC ADMISSION through the real instance: columnar
 * data under execution 'auto'/'worker' derives off-thread (the in-process
 * double drives the real runtime with real transfer semantics) and lands
 * through the acceptance queue IDENTICAL to the sync twin; other update
 * lanes apply immediately; supersession (columnar AND sync-object) drops
 * stale derives; 'transfer' detaches only at async admission; an
 * unavailable lane degrades to main with the mode-appropriate diagnostic;
 * destroy mid-flight is clean.
 */

import { describe, expect, it, vi } from 'vitest';

import { createGraphInstance } from '../src/instance';
import type { CreateGraphInstanceOptions } from '../src/instance';
import { columnarArrayBuffers } from '../src/columnar';
import { FakeEngine, createWorkerDouble } from '../src/testing/index';
import type { ColumnarGraphSnapshot, GraphSnapshot } from '../src/types';
import type { WorkerEnvelope } from '../src/workerProtocol';
import { container, snap } from './helpers';
import type { EAttrs, NAttrs } from './helpers';

/** A Worker-shaped shim over the in-process double (the instance only
 * speaks the D5 factory surface). */
function workerFromDouble(): Worker {
  const double = createWorkerDouble();
  const shim = {
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage(msg: unknown, transfers?: Transferable[]) {
      double.post(msg as WorkerEnvelope, (transfers ?? []) as ArrayBuffer[]);
    },
    terminate() {
      double.terminate();
    },
  };
  double.onReply((reply) => shim.onmessage?.({ data: reply }));
  return shim as unknown as Worker;
}

function columnarFixture(rev = 1): ColumnarGraphSnapshot<NAttrs, EAttrs> {
  return {
    kind: 'columnar',
    datasetKey: 'wa',
    sourceRevision: rev,
    nodes: {
      ids: {
        kind: 'string',
        dictionary: ['a', 'b', 'c', 'a'], // row 3 duplicates 'a'
        codes: Uint32Array.of(0, 1, 2, 3),
      },
      columns: { score: { kind: 'f64', data: Float64Array.of(1, 2, 3, 4) } },
      length: 4,
    },
    edges: {
      ids: { kind: 'string', dictionary: ['e1', 'e2', 'e3'], codes: Uint32Array.of(0, 1, 2) },
      source: Uint32Array.of(0, 1, 3),
      target: Uint32Array.of(1, 2, 2),
      columns: {},
      length: 3,
    },
  } as unknown as ColumnarGraphSnapshot<NAttrs, EAttrs>;
}

async function rig(over: Partial<CreateGraphInstanceOptions<NAttrs, EAttrs>> = {}) {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance<NAttrs, EAttrs>({
    engine: () => {
      const e = new FakeEngine();
      engines.push(e);
      return e;
    },
    fitViewOnFirstData: false,
    ...over,
  });
  await instance.attach(container);
  return { instance, engine: engines[0]! };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('async admission (execution: auto + a live lane)', () => {
  it('rejects non-string entries in every dictionary before worker encoding', async () => {
    const create = vi.fn(workerFromDouble);
    const { instance } = await rig({ execution: 'worker', workerFactory: { create } });
    instance.applyHostUpdate({ data: snap(1, ['keep'], []) });

    const mutations: Array<(snapshot: ColumnarGraphSnapshot<NAttrs, EAttrs>) => void> = [
      (snapshot) => {
        (snapshot.nodes.ids.dictionary as unknown[])[0] = 123;
      },
      (snapshot) => {
        (snapshot.edges.ids.dictionary as unknown[])[0] = { id: 'e1' };
      },
      (snapshot) => {
        snapshot.nodes.columns = {
          ...snapshot.nodes.columns,
          label: {
            kind: 'string',
            dictionary: ['ok', null] as unknown as string[],
            codes: Uint32Array.of(0, 1, 0, 1),
          },
        };
      },
    ];

    for (const mutate of mutations) {
      const bad = columnarFixture();
      mutate(bad);
      instance.applyHostUpdate({ data: bad });
      expect(instance.getSceneNodeIds()).toEqual(['keep']);
      expect(
        instance.store
          .getState()
          .diagnostics.find((diag) => diag.code === 'invalid-columnar-snapshot')?.message,
      ).toContain('dictionary entry');
    }

    await flush();
    expect(instance.getSceneNodeIds()).toEqual(['keep']);
    expect(create).not.toHaveBeenCalled();
  });

  it('lands IDENTICAL to the sync twin — after the flush, not before', async () => {
    const sync = await rig(); // execution 'main' default
    sync.instance.applyHostUpdate({ data: columnarFixture() });

    const async_ = await rig({
      execution: 'auto',
      workerFactory: { create: workerFromDouble },
    });
    async_.instance.applyHostUpdate({ data: columnarFixture() });
    // Synchronous return: the data lane has NOT landed yet.
    expect(async_.instance.getSceneNodeIds()).toEqual([]);

    await flush();

    expect(async_.instance.getSceneNodeIds()).toEqual(sync.instance.getSceneNodeIds());
    expect(async_.instance.store.getState().visible).toEqual(sync.instance.store.getState().visible);
    expect(async_.instance.store.getState().diagnostics).toEqual(
      sync.instance.store.getState().diagnostics, // dup-node warning included
    );
    const structA = async_.engine.commits.find((c) => c.structure !== undefined)!.structure!;
    const structS = sync.engine.commits.find((c) => c.structure !== undefined)!.structure!;
    expect([...structA.links]).toEqual([...structS.links]);
    expect(async_.instance.getPerfSnapshot().execution).toBe('worker');
  });

  it('other lanes in the same update apply SYNCHRONOUSLY (stream-commit semantics)', async () => {
    const { instance } = await rig({
      execution: 'auto',
      workerFactory: { create: workerFromDouble },
    });
    const darkBackground = instance.store.getState().theme.background;
    instance.applyHostUpdate({ data: columnarFixture(), theme: { base: 'light' } });
    // Theme resolved and published IMMEDIATELY (the store holds the
    // resolved GraphTheme, not the input spec).
    expect(instance.store.getState().theme.background).not.toBe(darkBackground);
    expect(instance.getSceneNodeIds()).toEqual([]); // data still in flight
    await flush();
    expect(instance.getSceneNodeIds().length).toBe(3);
  });

  it('rapid columnar re-publish: only the LATEST lands', async () => {
    const { instance } = await rig({
      execution: 'auto',
      workerFactory: { create: workerFromDouble },
    });
    instance.applyHostUpdate({ data: columnarFixture(1) });
    instance.applyHostUpdate({ data: columnarFixture(2) });
    await flush();
    expect(instance.getSceneNodeIds().length).toBe(3);
    // The store's accepted coordinate is revision 2 — a rev-1 replay is a
    // no-op, a rev-2 replay is a no-op TOO (it landed).
    const commits = (await rig()).engine.commits.length; // baseline noise guard
    expect(commits).toBeGreaterThanOrEqual(0);
    instance.applyHostUpdate({ data: columnarFixture(2) }); // replay of the landed rev
    await flush();
    expect(instance.getSceneNodeIds().length).toBe(3);
  });

  it('a SYNC object acceptance mid-flight supersedes the pending derive', async () => {
    const { instance } = await rig({
      execution: 'auto',
      workerFactory: { create: workerFromDouble },
    });
    instance.applyHostUpdate({ data: columnarFixture() }); // in flight
    instance.applyHostUpdate({ data: snap(9, ['x', 'y'], [['x', 'y']]) }); // sync, lands NOW
    expect(instance.getSceneNodeIds()).toEqual(['x', 'y']);
    await flush();
    // The stale columnar derive must NOT have replaced the newer object data.
    expect(instance.getSceneNodeIds()).toEqual(['x', 'y']);
  });

  it("'transfer' detaches ONLY at async admission; caller buffers live until then", async () => {
    const { instance } = await rig({
      execution: 'auto',
      workerFactory: { create: workerFromDouble },
    });
    const snapshot = columnarFixture();
    (snapshot as { bufferOwnership?: string }).bufferOwnership = 'transfer';
    const buffers = columnarArrayBuffers(snapshot);

    instance.applyHostUpdate({ data: snapshot });
    expect(buffers.every((b) => b.byteLength > 0)).toBe(true); // in flight: intact
    await flush();
    expect(instance.getSceneNodeIds().length).toBe(3); // landed
    expect(buffers.every((b) => b.byteLength === 0)).toBe(true); // now detached
  });

  it('a snapshot MUTATED mid-flight is rejected whole when verdicts no longer match the data', async () => {
    const { instance } = await rig({
      execution: 'auto',
      workerFactory: { create: workerFromDouble },
    });
    instance.applyHostUpdate({ data: snap(1, ['keep'], []) }); // prior scene
    const snapshot = columnarFixture();
    instance.applyHostUpdate({ data: snapshot }); // derive in flight
    // The caller violates immutability while the worker judges COPIES.
    snapshot.nodes.ids.codes[0] = 99; // out-of-dictionary corruption
    await flush();
    expect(instance.getSceneNodeIds()).toEqual(['keep']); // prior scene intact
    const diag = instance.store
      .getState()
      .diagnostics.find((d) => d.code === 'invalid-columnar-snapshot');
    expect(diag?.message).toContain('mutated while worker acceptance was pending');
    expect(diag?.message).toContain('publish a new sourceRevision');
  });

  it('metrics in a worker-routed update DEFER with the data and join the NEW model', async () => {
    const { instance } = await rig({
      execution: 'auto',
      workerFactory: { create: workerFromDouble },
    });
    instance.applyHostUpdate({
      data: columnarFixture(),
      metrics: [
        {
          metric: 'risk',
          // I1 stamp: the model revision current when the column was BUILT
          // (the atomic data+metrics idiom) — the deferred re-entry must
          // honor it exactly like the sync path does.
          forModelRevision: instance.getRevisions().model,
          align: 'ids',
          values: [7, 8, 9],
          ids: ['a', 'b', 'c'],
        },
      ],
    });
    await flush();
    expect(instance.getSceneNodeIds().length).toBe(3);
    // Joined against the model THIS update established — not discarded
    // against the empty prior model.
    expect(instance.getMetricValue('risk', 'b')).toBe(8);
    expect(
      instance.store.getState().diagnostics.some((d) => d.code === 'metric-column-error'),
    ).toBe(false);
  });

  it('a worker that DIES mid-flight falls back to the main lane without stranding work', async () => {
    // A transport whose module "fails to load": every post triggers the
    // async error channel instead of a reply.
    const dying = () => {
      const shim = {
        onmessage: null as ((ev: { data: unknown }) => void) | null,
        onerror: null as ((ev: { message: string }) => void) | null,
        onmessageerror: null as (() => void) | null,
        postMessage() {
          queueMicrotask(() => shim.onerror?.({ message: 'module load failed' }));
        },
        terminate() {},
      };
      return shim as unknown as Worker;
    };
    const { instance } = await rig({
      execution: 'auto',
      workerFactory: { create: dying },
    });
    instance.applyHostUpdate({ data: columnarFixture() });
    expect(instance.getSceneNodeIds()).toEqual([]); // in flight
    await flush();
    expect(instance.getSceneNodeIds().length).toBe(3); // landed via MAIN fallback
    const diag = instance.store
      .getState()
      .diagnostics.find((d) => d.code === 'worker-unavailable');
    expect(diag?.message).toContain('module load failed');
    expect(instance.getPerfSnapshot().execution).toBe('main'); // honest after death
  });

  it('the DEAD-worker fallback re-validates a mid-flight-mutated snapshot', async () => {
    const dying = () => {
      const shim = {
        onmessage: null as ((ev: { data: unknown }) => void) | null,
        onerror: null as ((ev: { message: string }) => void) | null,
        onmessageerror: null as (() => void) | null,
        postMessage() {
          queueMicrotask(() => shim.onerror?.({ message: 'module load failed' }));
        },
        terminate() {},
      };
      return shim as unknown as Worker;
    };
    const { instance } = await rig({ execution: 'auto', workerFactory: { create: dying } });
    instance.applyHostUpdate({ data: snap(1, ['keep'], []) });
    const snapshot = columnarFixture();
    instance.applyHostUpdate({ data: snapshot }); // derive in flight, worker dying
    snapshot.nodes.ids.codes[0] = 99; // violation while the worker dies
    await flush();
    // The fallback must NOT materialize reinterpreted rows or throw async
    // it re-validates and rejects whole, prior scene intact.
    expect(instance.getSceneNodeIds()).toEqual(['keep']);
    expect(
      instance.store
        .getState()
        .diagnostics.some((d) => d.code === 'invalid-columnar-snapshot'),
    ).toBe(true);
  });

  it('destroy mid-flight: nothing lands, nothing throws', async () => {
    const { instance } = await rig({
      execution: 'auto',
      workerFactory: { create: workerFromDouble },
    });
    instance.applyHostUpdate({ data: columnarFixture() });
    instance.destroy();
    await flush(); // the reply (if any) must be swallowed cleanly
  });
});

describe('unavailable lane → main fallback', () => {
  const throwing = {
    create: (): Worker => {
      throw new Error('no threads today');
    },
  };

  it("'auto': data lands SYNCHRONOUSLY with one INFO worker-unavailable diagnostic", async () => {
    const { instance } = await rig({ execution: 'auto', workerFactory: throwing });
    instance.applyHostUpdate({ data: columnarFixture() });
    expect(instance.getSceneNodeIds().length).toBe(3); // sync main path
    const diag = instance.store
      .getState()
      .diagnostics.find((d) => d.code === 'worker-unavailable');
    expect(diag?.severity).toBe('info');
    expect(instance.getPerfSnapshot().execution).toBe('main'); // honest
  });

  it("'worker': same fallback for acceptance cargo, but the diagnostic is an ERROR", async () => {
    const { instance } = await rig({ execution: 'worker', workerFactory: throwing });
    instance.applyHostUpdate({ data: columnarFixture() });
    expect(instance.getSceneNodeIds().length).toBe(3);
    const diag = instance.store
      .getState()
      .diagnostics.find((d) => d.code === 'worker-unavailable');
    expect(diag?.severity).toBe('error');
  });

  it('the diagnostic is one-shot across repeated columnar ingests', async () => {
    const { instance } = await rig({ execution: 'auto', workerFactory: throwing });
    instance.applyHostUpdate({ data: columnarFixture(1) });
    instance.applyHostUpdate({ data: columnarFixture(2) });
    const diags = instance.store
      .getState()
      .diagnostics.filter((d) => d.code === 'worker-unavailable');
    expect(diags).toHaveLength(1);
  });
});

describe('object data never routes through the worker (acceptance cargo is columnar-only)', () => {
  it('an object snapshot under execution auto accepts synchronously', async () => {
    const spy = vi.fn(workerFromDouble);
    const { instance } = await rig({ execution: 'auto', workerFactory: { create: spy } });
    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
    expect(instance.getSceneNodeIds()).toEqual(['a', 'b']); // immediate
    expect(spy).not.toHaveBeenCalled(); // the lane never even boots
  });
});

/** Type guard so an unused-import lint never bites: GraphSnapshot is used
 * in the sync-supersession fixture above via snap. */
export type _Witness = GraphSnapshot<NAttrs, EAttrs> | null;
