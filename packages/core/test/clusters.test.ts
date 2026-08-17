/**
 * stage-4 clusters: pure derivation + deterministic force
 * centers, the capability-gated engine mapping, and the stage-4 dirty
 * discipline.
 *
 * Clusters PRESERVE the scene — they synthesize nothing and coexist with the
 * stage-3 group rewrite — and their generated centers are a
 * pure function of the ordered keys plus the layout seed.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LAYOUT_SEED,
  clusterCentroids,
  deriveClusters,
  generateClusterCenters,
  resolveClusterCenters,
} from '../src/clusters';
import { clusterProbe, resetClusterProbe } from '../src/testing/index';
import { createGraphInstance } from '../src/instance';
import type { GraphInstance } from '../src/instance';
import { FakeEngine } from '../src/testing/index';
import type { ClusterSpec, GraphNode, GraphSnapshot } from '../src/types';

type NA = { team: string };
type EA = Record<string, never>;

const container = {} as unknown as HTMLElement;

function node(id: string, team: string): GraphNode<NA> {
  return { id, attrs: { team } };
}

/** a/b in 'red', c in 'blue', d unclustered; one edge per pair. */
function teamSnap(rev = 1): GraphSnapshot<NA, EA> {
  return {
    datasetKey: 'ds',
    sourceRevision: rev,
    nodes: [
      { id: 'a', attrs: { team: 'red' } },
      { id: 'b', attrs: { team: 'red' } },
      { id: 'c', attrs: { team: 'blue' } },
      { id: 'd' },
    ],
    edges: [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'd' },
    ],
  };
}

const BY = (n: GraphNode<NA>): string | null => n.attrs?.team ?? null;

async function rig(engineOptions: ConstructorParameters<typeof FakeEngine>[0] = {}): Promise<{
  instance: GraphInstance<NA, EA>;
  engine: FakeEngine;
}> {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance<NA, EA>({
    engine: () => {
      const e = new FakeEngine(engineOptions);
      engines.push(e);
      return e;
    },
    fitViewOnFirstData: false,
  });
  await instance.attach(container);
  return { instance, engine: engines[0]! };
}

function lastClusterConfig(engine: FakeEngine): unknown {
  for (let i = engine.commits.length - 1; i >= 0; i--) {
    const cluster = engine.commits[i]!.config?.cluster;
    if (cluster !== undefined) return cluster;
  }
  return undefined;
}

// ---------------------------------------------------------------------------

describe('deterministic force centers', () => {
  const keys = ['red', 'blue', 'green', 'chartreuse'];

  it('identical ordered keys + seed reproduce BIT-IDENTICAL centers', () => {
    const a = generateClusterCenters(keys, 7);
    const b = generateClusterCenters([...keys], 7);
    expect(Array.from(a)).toEqual(Array.from(b));
    // Bit-level, not just numeric: compare the raw buffers.
    expect(new Uint8Array(a.buffer)).toEqual(new Uint8Array(b.buffer));
    expect(a.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('a DIFFERENT seed changes every center', () => {
    const a = generateClusterCenters(keys, 7);
    const b = generateClusterCenters(keys, 8);
    for (let i = 0; i < a.length; i++) expect(a[i]).not.toBe(b[i]);
  });

  it('key ORDER and key TEXT both participate', () => {
    const base = generateClusterCenters(keys, DEFAULT_LAYOUT_SEED);
    const reordered = generateClusterCenters([...keys].reverse(), DEFAULT_LAYOUT_SEED);
    expect(Array.from(base)).not.toEqual(Array.from(reordered));
    const renamed = generateClusterCenters(['red', 'blue', 'green', 'teal'], DEFAULT_LAYOUT_SEED);
    expect(renamed[6]).not.toBe(base[6]);
  });

  it('resolveClusterCenters generates ONLY the missing keys', () => {
    const explicit = new Map<string, readonly [number, number]>([['blue', [11, 22]]]);
    const generated = generateClusterCenters(keys, DEFAULT_LAYOUT_SEED);
    const resolved = resolveClusterCenters(keys, explicit, DEFAULT_LAYOUT_SEED);
    expect(resolved[2]).toBe(11);
    expect(resolved[3]).toBe(22);
    expect(resolved[0]).toBe(generated[0]); // 'red' still generated
    expect(resolved[4]).toBe(generated[4]);
  });

  it('a non-finite explicit center is treated as missing (D4 hygiene)', () => {
    const explicit = new Map<string, readonly [number, number]>([['red', [NaN, 5]]]);
    const resolved = resolveClusterCenters(keys, explicit, DEFAULT_LAYOUT_SEED);
    expect(Number.isFinite(resolved[0]!)).toBe(true);
    expect(resolved[0]).toBe(generateClusterCenters(keys, DEFAULT_LAYOUT_SEED)[0]);
  });
});

describe('pure derivation', () => {
  it('buckets by first-encounter key order; null/non-string is unclustered (NaN)', () => {
    const d = deriveClusters(
      [node('a', 'red'), node('b', 'blue'), node('c', 'red'), { id: 'd' }],
      BY,
    );
    expect(d.keys).toEqual(['red', 'blue']);
    expect(d.membersByKey.get('red')).toEqual(['a', 'c']);
    expect(d.membersByKey.get('blue')).toEqual(['b']);
    expect(Array.from(d.slotOrdinals.slice(0, 3))).toEqual([0, 1, 0]);
    expect(Number.isNaN(d.slotOrdinals[3]!)).toBe(true);
  });

  it('the synthetic suffix is always unclustered (sceneCount > physical rows)', () => {
    const d = deriveClusters([node('a', 'red')], BY, 3);
    expect(d.slotOrdinals).toHaveLength(3);
    expect(Number.isNaN(d.slotOrdinals[1]!)).toBe(true);
    expect(Number.isNaN(d.slotOrdinals[2]!)).toBe(true);
  });

  it('a throwing accessor yields ONE aggregated warning, never silent loss (I3)', () => {
    const d = deriveClusters([node('a', 'red'), node('b', 'blue')], (n) => {
      if (n.id === 'b') throw new Error('boom');
      return n.attrs?.team ?? null;
    });
    expect(d.keys).toEqual(['red']);
    expect(d.diagnostic?.code).toBe('accessor-error');
    expect(d.diagnostic?.count).toBe(1);
    expect(d.diagnostic?.sampleIds).toEqual(['b']);
  });

  it('clusterCentroids averages placed members and falls back to the force center', () => {
    const ordinals = Float32Array.from([0, 0, 1, NaN]);
    const positions = Float32Array.from([0, 0, 10, 20, NaN, NaN, 99, 99]);
    const fallback = Float32Array.from([-1, -2, -3, -4]);
    const out = clusterCentroids(ordinals, positions, 2, fallback);
    expect(Array.from(out.slice(0, 2))).toEqual([5, 10]);
    // Cluster 1's only member has no known position → its fallback holds.
    expect(Array.from(out.slice(2))).toEqual([-3, -4]);
  });
});

describe('clusters preserve the scene', () => {
  it('over a scene with a COLLAPSED group: identical counts, zero synthetics added', async () => {
    const { instance, engine } = await rig({ capabilities: { clusterForce: true } });
    instance.applyHostUpdate({
      data: teamSnap(),
      groups: [{ id: 'g1', memberIds: ['a', 'b'], collapsed: true }],
    });
    const beforeCommit = engine.lastCommit!;
    const beforePoints = beforeCommit.structure!.pointCount;
    const beforeLinks = beforeCommit.structure!.links.length / 2;
    const beforeCommits = engine.commits.length;

    instance.applyHostUpdate({ clusters: { by: BY, strength: 0.4 } });

    // The cluster commit is CONFIG-ONLY: no structure, no buffers.
    expect(engine.commits.length).toBe(beforeCommits + 1);
    const clusterCommit = engine.lastCommit!;
    expect(clusterCommit.structure).toBeUndefined();
    expect(clusterCommit.buffers).toBeUndefined();
    expect(clusterCommit.config?.cluster).toBeDefined();

    // The roster the engine holds is unchanged, and the synthetic suffix
    // descriptor is untouched (one super-node, no new meta-entities).
    instance.applyHostUpdate({ showLinks: false }); // force any pending structure out
    const after = engine.commits.filter((c) => c.structure !== undefined).pop()!;
    expect(after.structure!.pointCount).toBe(beforePoints);
    expect(after.structure!.links.length / 2).toBe(beforeLinks);

    // Collapsed members have no physical slot, so they are not cluster
    // members; 'c' (blue) still is.
    const clusters = instance.getClusters();
    expect(clusters.map((c) => c.key)).toEqual(['blue']);
    expect(clusters[0]!.memberIds).toEqual(['c']);
  });

  it('expanding the group returns its members to the derivation', async () => {
    const { instance } = await rig();
    instance.applyHostUpdate({
      data: teamSnap(),
      groups: [{ id: 'g1', memberIds: ['a', 'b'], collapsed: true }],
      clusters: { by: BY },
    });
    expect(instance.getClusters().map((c) => c.key)).toEqual(['blue']);

    // The `groups` PROP latched the slice controlled, so the host
    // reflects the expansion back instead of calling setGroupCollapsed.
    instance.applyHostUpdate({ groups: [{ id: 'g1', memberIds: ['a', 'b'], collapsed: false }] });
    const clusters = instance.getClusters();
    expect(clusters.map((c) => c.key)).toEqual(['red', 'blue']);
    expect(clusters[0]!.memberIds).toEqual(['a', 'b']);
  });
});

describe('capability gating', () => {
  it('clusterForce:false → exactly ONE degradation diagnostic and layout proceeds', async () => {
    const { instance, engine } = await rig(); // FakeEngine declares no clusterForce
    instance.applyHostUpdate({ data: teamSnap() });
    instance.applyHostUpdate({ clusters: { by: BY, strength: 0.5 } });
    instance.applyHostUpdate({ clusters: { by: BY, strength: 0.9 } }); // still one

    const degradations = instance
      .getDiagnostics()
      .filter((d) => d.code === 'engine:capability-degraded');
    expect(degradations).toHaveLength(1);
    expect(degradations[0]!.message).toContain('clusters');
    expect(degradations[0]!.severity).toBe('warning');

    // The incapable adapter never sees the payload…
    for (const commit of engine.commits) {
      expect(commit.config === undefined || !('cluster' in commit.config)).toBe(true);
    }
    // …while membership, centers, and the layout keep working.
    expect(instance.getClusters().map((c) => c.key)).toEqual(['red', 'blue']);
    expect(instance.store.getState().simulationRunning).toBe(true);
  });

  it('a spec present BEFORE mount degrades exactly once too (mount policy path)', async () => {
    const engines: FakeEngine[] = [];
    const instance = createGraphInstance<NA, EA>({
      engine: () => {
        const e = new FakeEngine();
        engines.push(e);
        return e;
      },
      fitViewOnFirstData: false,
    });
    instance.applyHostUpdate({ data: teamSnap(), clusters: { by: BY } });
    await instance.attach(container);
    instance.applyHostUpdate({ clusters: { by: BY, strength: 0.2 } });
    expect(
      instance.getDiagnostics().filter((d) => d.code === 'engine:capability-degraded'),
    ).toHaveLength(1);
  });

  it('clusterForce:true → the commit config carries pointClusters, centers, strength', async () => {
    const { instance, engine } = await rig({ capabilities: { clusterForce: true } });
    const centers = new Map<string, readonly [number, number]>([['blue', [100, 200]]]);
    instance.applyHostUpdate({
      data: teamSnap(),
      clusters: { by: BY, strength: 0.75, centers },
    });

    expect(
      instance.getDiagnostics().filter((d) => d.code === 'engine:capability-degraded'),
    ).toHaveLength(0);

    const cluster = lastClusterConfig(engine) as {
      pointClusters: Float32Array;
      centers: Float32Array;
      strength: number;
    };
    expect(cluster.strength).toBe(0.75);
    // a,b → 0 (red); c → 1 (blue); d unclustered (NaN).
    expect(Array.from(cluster.pointClusters.slice(0, 3))).toEqual([0, 0, 1]);
    expect(Number.isNaN(cluster.pointClusters[3]!)).toBe(true);
    // 'blue' is ordinal 1 and used the EXPLICIT center.
    expect(cluster.centers[2]).toBe(100);
    expect(cluster.centers[3]).toBe(200);
  });

  it('clusters: null clears the engine force (D2 explicit reset)', async () => {
    const { instance, engine } = await rig({ capabilities: { clusterForce: true } });
    instance.applyHostUpdate({ data: teamSnap(), clusters: { by: BY } });
    expect(lastClusterConfig(engine)).not.toBeNull();

    instance.applyHostUpdate({ clusters: null });
    expect(engine.lastCommit!.config!.cluster).toBeNull();
    expect(instance.getClusters()).toEqual([]);
  });

  it('a structural commit carries the matching-length mapping in the SAME commit (I2)', async () => {
    const { instance, engine } = await rig({ capabilities: { clusterForce: true } });
    instance.applyHostUpdate({ data: teamSnap(), clusters: { by: BY } });
    instance.applyHostUpdate({
      data: { ...teamSnap(2), nodes: [...teamSnap(2).nodes, { id: 'e', attrs: { team: 'red' } }] },
    });
    const commit = engine.lastCommit!;
    expect(commit.structure!.pointCount).toBe(5);
    expect(commit.config!.cluster!.pointClusters).toHaveLength(5);
  });

  it('scope history keeps pointClusters aligned across isolate undo/redo (I2)', async () => {
    const { instance, engine } = await rig({ capabilities: { clusterForce: true } });
    instance.applyHostUpdate({ data: teamSnap(), clusters: { by: BY } });
    instance.selectNodes(['a', 'c']);
    instance.isolateSelection();

    expect(instance.undo()).toBe(true);
    const restored = engine.lastCommit!;
    expect(restored.structure!.pointCount).toBe(4);
    expect(Array.from(restored.config!.cluster!.pointClusters)).toEqual([0, 0, 1, NaN]);

    expect(instance.redo()).toBe(true);
    const isolated = engine.lastCommit!;
    expect(isolated.structure!.pointCount).toBe(2);
    expect(Array.from(isolated.config!.cluster!.pointClusters)).toEqual([0, 1]);
  });

  it('fold history keeps pointClusters aligned across undo/redo (I2)', async () => {
    const { instance, engine } = await rig({ capabilities: { clusterForce: true } });
    instance.applyHostUpdate({ data: teamSnap(), clusters: { by: BY } });
    instance.foldNode('a', { memberIds: ['b'] });

    expect(instance.undo()).toBe(true);
    const restored = engine.lastCommit!;
    expect(restored.structure!.pointCount).toBe(4);
    expect(Array.from(restored.config!.cluster!.pointClusters)).toEqual([0, 0, 1, NaN]);

    expect(instance.redo()).toBe(true);
    const folded = engine.lastCommit!;
    expect(folded.structure!.pointCount).toBe(3);
    expect(Array.from(folded.config!.cluster!.pointClusters)).toEqual([0, 1, NaN]);
  });
});

describe('stage-4 dirty discipline', () => {
  async function derivedRig(): Promise<{ instance: GraphInstance<NA, EA>; engine: FakeEngine }> {
    const r = await rig({ capabilities: { clusterForce: true } });
    r.instance.applyHostUpdate({ data: teamSnap(), clusters: { by: BY } });
    return r;
  }

  it('a stage-5 soft-mask change does NOT re-derive', async () => {
    const { instance } = await derivedRig();
    resetClusterProbe();

    instance.applyHostUpdate({ filter: { nodes: { field: 'team', op: 'eq', value: 'red' } } });
    instance.applyHostUpdate({ filter: { nodes: { field: 'team', op: 'eq', value: 'blue' } } });
    instance.hideNodes(['c']);
    instance.applyHostUpdate({ filter: null });

    expect(clusterProbe.derivations).toBe(0);
    expect(clusterProbe.memberVisits).toBe(0);
    // Membership survived every mask change untouched.
    expect(instance.getClusters().map((c) => c.key)).toEqual(['red', 'blue']);
  });

  it('a `by` accessor IDENTITY change re-derives', async () => {
    const { instance } = await derivedRig();
    resetClusterProbe();

    // Same shape, new lambda → new identity.
    instance.applyHostUpdate({ clusters: { by: (n) => n.attrs?.team ?? null } });
    expect(clusterProbe.derivations).toBe(1);

    // Same lambda reference again → no re-derivation.
    const stable: ClusterSpec<NA> = { by: BY };
    instance.applyHostUpdate({ clusters: stable });
    const after = clusterProbe.derivations;
    instance.applyHostUpdate({ clusters: { by: BY } });
    expect(clusterProbe.derivations).toBe(after);
  });

  it('a strength/centers-only change re-maps WITHOUT re-deriving membership', async () => {
    const { instance, engine } = await derivedRig();
    resetClusterProbe();

    instance.applyHostUpdate({ clusters: { by: BY, strength: 0.3 } });
    expect(clusterProbe.derivations).toBe(0);
    expect((lastClusterConfig(engine) as { strength: number }).strength).toBe(0.3);
  });

  it('an upstream TOPOLOGY change re-derives', async () => {
    const { instance } = await derivedRig();
    resetClusterProbe();

    instance.applyHostUpdate({
      data: { ...teamSnap(2), nodes: [...teamSnap(2).nodes, { id: 'e', attrs: { team: 'green' } }] },
    });
    expect(clusterProbe.derivations).toBeGreaterThan(0);
    expect(instance.getClusters().map((c) => c.key)).toEqual(['red', 'blue', 'green']);
  });
});
