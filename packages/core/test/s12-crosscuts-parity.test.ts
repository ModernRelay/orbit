/**
 * parity: object/columnar snapshots must produce identical
 * groupBy/cluster derivations, scene identity, and diagnostics.
 *
 * STATUS — UNBLOCKED: the columnar lane landed
 * (`ColumnarGraphSnapshot` accepted by `data`, validated whole, materialized
 * through the one shared pipeline). The object-lane determinism assertions
 * below were written as the future parity oracle — the final describe now
 * APPLIES that oracle: the same logical graph fed columnar derives identical
 * groups, clusters, scene identity, engine payloads and diagnostics.
 * (Channel-byte parity across generator families lives in
 * parity-object-columnar.test.ts.)
 */

import { describe, expect, it } from 'vitest';

import * as coreApi from '../src/index';
import {
  DEFAULT_LAYOUT_SEED,
  deriveClusters,
  generateClusterCenters,
  resolveClusterCenters,
} from '../src/clusters';
import { deriveGroupsByKey, groupByDerivedId } from '../src/groups';
import { createGraphInstance } from '../src/instance';
import type { GraphInstance } from '../src/instance';
import { FakeEngine } from '../src/testing/index';
import type {
  ClusterSpec,
  ColumnarGraphSnapshot,
  GraphDiagnostic,
  GraphNode,
  GraphSnapshot,
  GroupBySpec,
} from '../src/types';

type NA = { team: string | null; rank: number };
type EA = Record<string, never>;

const container = {} as unknown as HTMLElement;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Adversarial keys: quotes/brackets/NUL-adjacent text and a key that spells
 * a derived id, so the codec is exercised, not just alphanumerics. */
const TEAMS: readonly (string | null)[] = [
  'red',
  'blue',
  '"quoted"',
  '["group","red"]',
  ']bracket[',
  null,
  'red',
];

/** Builds the SAME logical snapshot with FRESH row objects every call — the
 * identity-independence a columnar lane gets for free and an object lane must
 * not accidentally rely on. */
function buildSnapshot(seed: number, size = 60): GraphSnapshot<NA, EA> {
  const rng = mulberry32(seed);
  const nodes: GraphNode<NA>[] = [];
  for (let i = 0; i < size; i++) {
    nodes.push({ id: `n${String(i)}`, attrs: { team: TEAMS[i % TEAMS.length]!, rank: i % 9 } });
  }
  const edges: { source: string; target: string }[] = [];
  for (let e = 0; e < size; e++) {
    const a = Math.floor(rng() * size);
    const b = (a + 1 + Math.floor(rng() * (size - 1))) % size;
    edges.push({ source: `n${String(a)}`, target: `n${String(b)}` });
  }
  return { datasetKey: 'parity', sourceRevision: 1, nodes, edges };
}

const BY_TEAM = (n: GraphNode<NA>): string | null => n.attrs?.team ?? null;
/** Throws on one deterministic subset — the aggregated-diagnostic lane. */
const BY_TEAM_THROWING = (n: GraphNode<NA>): string | null => {
  if ((n.attrs?.rank ?? 0) === 7) throw new Error('accessor blew up');
  return n.attrs?.team ?? null;
};

interface Rig {
  instance: GraphInstance<NA, EA>;
  engine: FakeEngine;
}

async function rig(): Promise<Rig> {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance<NA, EA>({
    engine: () => {
      const e = new FakeEngine({ capabilities: { clusterForce: true } });
      engines.push(e);
      return e;
    },
    fitViewOnFirstData: false,
  });
  await instance.attach(container);
  return { instance, engine: engines[0]! };
}

/** Everything a parity claim must cover: derivations, scene identity, the
 * engine's index-addressed payloads, and diagnostics. */
interface ParitySnapshot {
  groups: ReadonlyArray<{ id: string; label: string | null; collapsed: boolean; members: string }>;
  clusters: ReadonlyArray<{ key: string; members: string; forceCenter: readonly number[] }>;
  sceneNodeIds: readonly string[];
  pointCount: number;
  links: readonly number[];
  pointClusters: readonly number[];
  centers: readonly number[];
  diagnostics: ReadonlyArray<{ code: string; severity: string; count: number; message: string }>;
}

function captureParity(rig: Rig): ParitySnapshot {
  const state = rig.instance.store.getState();
  const structure = rig.engine.lastStructure ?? null;
  let cluster: { pointClusters: Float32Array; centers?: Float32Array } | null = null;
  for (const commit of rig.engine.commits) {
    const c = commit.config?.cluster;
    if (c !== undefined && c !== null) cluster = c;
  }
  return {
    groups: state.groups.map((g) => ({
      id: g.id,
      label: g.label ?? null,
      collapsed: g.collapsed,
      members: g.memberIds.join('|'),
    })),
    clusters: rig.instance.getClusters().map((c) => ({
      key: c.key,
      members: c.memberIds.join('|'),
      forceCenter: [...c.forceCenter],
    })),
    sceneNodeIds: [...rig.instance.getSceneNodeIds()],
    pointCount: structure?.pointCount ?? -1,
    links: structure === null ? [] : Array.from(structure.links),
    pointClusters: cluster === null ? [] : Array.from(cluster.pointClusters),
    centers: cluster?.centers === undefined ? [] : Array.from(cluster.centers),
    diagnostics: state.diagnostics.map((d: GraphDiagnostic) => ({
      code: d.code,
      severity: d.severity,
      count: d.count,
      message: d.message,
    })),
  };
}

const CLUSTERS: ClusterSpec<NA> = { by: BY_TEAM, strength: 0.4 };
const GROUP_BY: GroupBySpec<NA> = { by: BY_TEAM };

// ---------------------------------------------------------------------------

describe('object-lane determinism (the columnar parity oracle)', () => {
  it('two independent instances over freshly-built equal snapshots derive identical groups, clusters, scene, payloads and diagnostics', async () => {
    const a = await rig();
    const b = await rig();
    try {
      for (const r of [a, b]) {
        r.instance.applyHostUpdate({
          data: buildSnapshot(0x51_25_01),
          nodeColor: 'red',
          linkColor: 'blue',
          groupBy: GROUP_BY,
          clusters: CLUSTERS,
        });
        r.instance.setGroupCollapsed(groupByDerivedId('red'), true);
      }
      const pa = captureParity(a);
      const pb = captureParity(b);
      expect(pb).toEqual(pa);
      // Non-vacuous: the run derived real groups, a real rewrite and real
      // cluster payloads.
      expect(pa.groups.length).toBeGreaterThan(3);
      expect(pa.clusters.length).toBeGreaterThan(3);
      expect(pa.pointClusters.length).toBe(pa.pointCount);
      expect(pa.sceneNodeIds.length).toBeLessThan(pa.pointCount); // super-node present
    } finally {
      a.instance.destroy();
      b.instance.destroy();
    }
  });

  it('an accessor that throws yields the identical single aggregated diagnostic in both instances', async () => {
    const a = await rig();
    const b = await rig();
    try {
      for (const r of [a, b]) {
        r.instance.applyHostUpdate({
          data: buildSnapshot(0x51_25_02),
          groupBy: { by: BY_TEAM_THROWING },
          clusters: { by: BY_TEAM_THROWING },
        });
      }
      const pa = captureParity(a);
      const pb = captureParity(b);
      expect(pb.diagnostics).toEqual(pa.diagnostics);
      const accessorErrors = pa.diagnostics.filter((d) => d.code === 'accessor-error');
      // ONE per lane (groupBy + clusters), never one per offending node.
      expect(accessorErrors).toHaveLength(2);
      for (const d of accessorErrors) expect(d.count).toBeGreaterThan(1);
    } finally {
      a.instance.destroy();
      b.instance.destroy();
    }
  });

  it('pure derivations are row-identity independent: equal values through different objects derive identically', () => {
    const left = buildSnapshot(0x51_25_03).nodes;
    const right = buildSnapshot(0x51_25_03).nodes;
    expect(left[0]).not.toBe(right[0]); // genuinely distinct objects

    const gl = deriveGroupsByKey(left, BY_TEAM, () => false);
    const gr = deriveGroupsByKey(right, BY_TEAM, () => false);
    expect(gr.groups).toEqual(gl.groups);
    expect([...gr.keyById.entries()]).toEqual([...gl.keyById.entries()]);
    expect(gr.diagnostic).toEqual(gl.diagnostic);

    const cl = deriveClusters(left, BY_TEAM);
    const cr = deriveClusters(right, BY_TEAM);
    expect(cr.keys).toEqual(cl.keys);
    expect(Array.from(cr.slotOrdinals)).toEqual(Array.from(cl.slotOrdinals));
    expect([...cr.membersByKey.entries()]).toEqual([...cl.membersByKey.entries()]);

    // Generated centers are a pure function of ordered keys + seed, so both
    // lanes must land on bit-identical Float32 values.
    const centersL = generateClusterCenters(cl.keys, DEFAULT_LAYOUT_SEED);
    const centersR = generateClusterCenters(cr.keys, DEFAULT_LAYOUT_SEED);
    expect(Array.from(centersR)).toEqual(Array.from(centersL));
    expect(Array.from(resolveClusterCenters(cr.keys, undefined))).toEqual(Array.from(centersL));
  });

  it('derived group ids are lane-independent and never collide with a node id, including adversarial keys', () => {
    const nodes = buildSnapshot(0x51_25_04).nodes;
    const ids = new Set(nodes.map((n) => n.id));
    const derived = deriveGroupsByKey(nodes, BY_TEAM, () => false);
    const seen = new Set<string>();
    for (const group of derived.groups) {
      expect(group.id).toBe(groupByDerivedId(group.label!));
      expect(ids.has(group.id)).toBe(false);
      expect(seen.has(group.id)).toBe(false);
      seen.add(group.id);
    }
    // Includes the key that literally spells a derived id — the codec must
    // still separate it from the group whose key is 'red'.
    expect(seen.has(groupByDerivedId('["group","red"]'))).toBe(true);
    expect(groupByDerivedId('["group","red"]')).not.toBe(groupByDerivedId('red'));
  });
});

describe('columnar parity: the oracle is applied', () => {
  /** Dictionary-encode the OBJECT snapshot into its columnar twin — same
   * logical graph by construction, adversarial team keys and the null team
   * included (null rides the nulls byte column). */
  function columnarTwin(snapshot: GraphSnapshot<NA, EA>): ColumnarGraphSnapshot<NA, EA> {
    const nodes = snapshot.nodes;
    const idDict = nodes.map((n) => n.id);
    const teamDict: string[] = [];
    const teamIndex = new Map<string, number>();
    const teamCodes = new Uint32Array(nodes.length);
    const teamNulls = new Uint8Array(nodes.length);
    const ranks = new Int32Array(nodes.length);
    nodes.forEach((n, i) => {
      const team = n.attrs?.team ?? null;
      if (team === null) {
        teamNulls[i] = 1;
      } else {
        let code = teamIndex.get(team);
        if (code === undefined) {
          code = teamDict.length;
          teamDict.push(team);
          teamIndex.set(team, code);
        }
        teamCodes[i] = code;
      }
      ranks[i] = n.attrs?.rank ?? 0;
    });
    const nodePos = new Map(idDict.map((id, i) => [id, i] as const));
    return {
      kind: 'columnar',
      datasetKey: snapshot.datasetKey,
      sourceRevision: snapshot.sourceRevision,
      nodes: {
        ids: {
          kind: 'string',
          dictionary: idDict,
          codes: Uint32Array.from(idDict, (_, i) => i),
        },
        columns: {
          team: { kind: 'string', dictionary: teamDict, codes: teamCodes, nulls: teamNulls },
          rank: { kind: 'i32', data: ranks },
        },
        length: nodes.length,
      },
      edges: {
        ids: {
          kind: 'string',
          dictionary: snapshot.edges.map((_, e) => `e${String(e)}`),
          codes: Uint32Array.from(snapshot.edges, (_, e) => e),
        },
        source: Uint32Array.from(snapshot.edges, (e) => nodePos.get(e.source)!),
        target: Uint32Array.from(snapshot.edges, (e) => nodePos.get(e.target)!),
        columns: {},
        length: snapshot.edges.length,
      },
    };
  }

  it('a columnar snapshot derives identical groups, clusters, scene, payloads and diagnostics', async () => {
    const a = await rig();
    const b = await rig();
    try {
      a.instance.applyHostUpdate({
        data: buildSnapshot(0x51_25_05),
        nodeColor: 'red',
        linkColor: 'blue',
        groupBy: GROUP_BY,
        clusters: CLUSTERS,
      });
      a.instance.setGroupCollapsed(groupByDerivedId('red'), true);
      b.instance.applyHostUpdate({
        data: columnarTwin(buildSnapshot(0x51_25_05)),
        nodeColor: 'red',
        linkColor: 'blue',
        groupBy: GROUP_BY,
        clusters: CLUSTERS,
      });
      b.instance.setGroupCollapsed(groupByDerivedId('red'), true);

      const pa = captureParity(a);
      const pb = captureParity(b);
      expect(pb).toEqual(pa);
      // Non-vacuous, same bars as the object-lane oracle.
      expect(pa.groups.length).toBeGreaterThan(3);
      expect(pa.clusters.length).toBeGreaterThan(3);
      expect(pa.sceneNodeIds.length).toBeLessThan(pa.pointCount);
    } finally {
      a.instance.destroy();
      b.instance.destroy();
    }
  });

  it('the columnar lane is on the public surface (the v0.10 block is lifted)', () => {
    const exported = Object.keys(coreApi);
    for (const symbol of [
      'isColumnarSnapshot',
      'validateColumnarStructure',
      'materializeColumnarSnapshot',
      'columnarArrayBuffers',
      'detachColumnarBuffers',
    ]) {
      expect(exported).toContain(symbol);
    }
    expect(exported).toContain('validateSnapshot'); // still the ONE shared pipeline
  });
});
