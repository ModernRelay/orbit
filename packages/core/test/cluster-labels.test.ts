/**
 * cluster-label overlays on the overlay lane.
 *
 * Anchor contract: while the simulation is HOT labels anchor to
 * the cluster's forceCenter and the lane performs ZERO per-member iteration
 * per frame; on the settle event centroids recompute from the single
 * permitted readback and labels re-anchor; a FIXED layout computes
 * centroids directly at commit. `label.maxZoom` hands the lane between the
 * cluster band and node-label LOD, and activating a cluster label resolves to
 * its MEMBER node ids.
 */

import { describe, expect, it } from 'vitest';

import { createGraphInstance } from '../src/instance';
import type { GraphInstance } from '../src/instance';
import { FakeEngine, clusterProbe, resetClusterProbe } from '../src/testing/index';
import type { GraphNode, GraphSnapshot, LabelConfig, LabelPlacement } from '../src/types';

type NA = { team: string };
type EA = Record<string, never>;

const container = {} as unknown as HTMLElement;
const BY = (n: GraphNode<NA>): string | null => n.attrs?.team ?? null;

/**
 * Two clusters with DECLARED positions, so a fixed-layout commit and a
 * settle readback both produce exact centroids:
 * red = {a(0,0), b(10,20)} → centroid (5, 10)
 * blue = {c(100,100), d(200,200)} → centroid (150, 150)
 */
function teamSnap(rev = 1): GraphSnapshot<NA, EA> {
  return {
    datasetKey: 'ds',
    sourceRevision: rev,
    nodes: [
      { id: 'a', x: 0, y: 0, attrs: { team: 'red' } },
      { id: 'b', x: 10, y: 20, attrs: { team: 'red' } },
      { id: 'c', x: 100, y: 100, attrs: { team: 'blue' } },
      { id: 'd', x: 200, y: 200, attrs: { team: 'blue' } },
    ],
    edges: [{ source: 'a', target: 'c' }],
  };
}

/** Explicit force centers keep the "hot" expectations exact. */
const CENTERS = new Map<string, readonly [number, number]>([
  ['red', [-500, -500]],
  ['blue', [500, 500]],
]);

interface Rig {
  instance: GraphInstance<NA, EA>;
  engine: FakeEngine;
  /** Copy of the current candidate set (cluster labels first). */
  placements: () => LabelPlacement[];
}

// overlap: 'allow' — these tests pin the LOD hand-off, not declutter
// (FakeEngine's 10px seed grid would otherwise cull stacked fixtures).
async function rig(labels: LabelConfig<NA> = { minZoom: 0, overlap: 'allow' }): Promise<Rig> {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance<NA, EA>({
    engine: () => {
      const e = new FakeEngine();
      engines.push(e);
      return e;
    },
    fitViewOnFirstData: false,
  });
  await instance.attach(container);
  instance.applyHostUpdate({
    data: teamSnap(),
    labels,
    clusters: { by: BY, centers: CENTERS },
  });
  let current: readonly LabelPlacement[] = [];
  instance.labels.subscribeCandidates((list) => {
    current = list.map((p) => ({ ...p }));
  });
  instance.labels.subscribePositions((list) => {
    current = list.map((p) => ({ ...p }));
  });
  return { instance, engine: engines[0]!, placements: () => current.map((p) => ({ ...p })) };
}

function clusterLabels(list: readonly LabelPlacement[]): LabelPlacement[] {
  return list.filter((p) => p.kind === 'cluster');
}

function nodeLabels(list: readonly LabelPlacement[]): LabelPlacement[] {
  return list.filter((p) => p.kind !== 'cluster');
}

// ---------------------------------------------------------------------------

describe('cluster-label anchoring', () => {
  it('while HOT labels sit on the forceCenter and frames scan ZERO members', async () => {
    const { instance, engine, placements } = await rig();
    expect(instance.store.getState().simulationRunning).toBe(true);

    const hot = clusterLabels(placements());
    expect(hot.map((p) => p.id)).toEqual(['red', 'blue']);
    // FakeEngine's spaceToScreen is the identity, so screen == force center.
    expect([hot[0]!.x, hot[0]!.y]).toEqual([-500, -500]);
    expect([hot[1]!.x, hot[1]!.y]).toEqual([500, 500]);
    expect(instance.getClusters()[0]!.centroid).toBeNull(); // nothing settled yet

    // A burst of frame ticks (the overlay scheduler's per-frame fan-out) must
    // not iterate a single cluster member.
    resetClusterProbe();
    for (let t = 0; t < 20; t++) {
      engine.nudgePositions(1, 1);
      engine.emitFrame(t * 16);
    }
    expect(clusterProbe.memberVisits).toBe(0);
    expect(clusterProbe.derivations).toBe(0);
    // …and the anchors did not drift with the members.
    expect(clusterLabels(placements()).map((p) => [p.x, p.y])).toEqual([
      [-500, -500],
      [500, 500],
    ]);
  });

  it('on SETTLE centroids recompute from the readback and labels re-anchor', async () => {
    const { instance, engine, placements } = await rig();
    resetClusterProbe();

    engine.injectSimulationEnd();

    // Exactly one member scan — the settle pass over the permitted readback.
    expect(clusterProbe.memberVisits).toBe(4);
    expect(clusterProbe.derivations).toBe(0);

    const clusters = instance.getClusters();
    expect(clusters[0]!.centroid).toEqual([5, 10]);
    expect(clusters[1]!.centroid).toEqual([150, 150]);
    expect(clusterLabels(placements()).map((p) => [p.x, p.y])).toEqual([
      [5, 10],
      [150, 150],
    ]);
    // The force centers themselves are unchanged — only the anchor moved.
    expect(clusters[0]!.forceCenter).toEqual([-500, -500]);
  });

  it('a FIXED layout computes centroids at commit (no settle event needed)', async () => {
    const { instance } = await rig();
    resetClusterProbe();

    instance.applyHostUpdate({ layout: 'fixed' });
    // The layout freeze re-reconciles, so exactly one derivation + one
    // centroid pass ran; both are commit-time, not per-frame.
    const clusters = instance.getClusters();
    expect(clusters[0]!.centroid).toEqual([5, 10]);
    expect(clusters[1]!.centroid).toEqual([150, 150]);
    expect(instance.store.getState().simulationRunning).toBe(false);
  });

  it('a re-derivation drops back to forceCenter anchoring until the next settle', async () => {
    const { instance, engine } = await rig();
    engine.injectSimulationEnd();
    expect(instance.getClusters()[0]!.centroid).toEqual([5, 10]);

    instance.applyHostUpdate({ data: { ...teamSnap(2) } });
    expect(instance.getClusters()[0]!.centroid).toBeNull();
  });
});

describe('label.maxZoom LOD hand-off', () => {
  it('at/below maxZoom cluster labels show and node labels are suppressed', async () => {
    const { placements } = await rig({ minZoom: 0, maxZoom: 2 });
    // The FakeEngine viewport starts at zoom 1 (<= 2) → cluster band.
    const list = placements();
    expect(clusterLabels(list).map((p) => p.id)).toEqual(['red', 'blue']);
    expect(nodeLabels(list)).toEqual([]);
  });

  it('above maxZoom node-label LOD takes over and cluster labels stop', async () => {
    const { instance, engine, placements } = await rig({ minZoom: 0, maxZoom: 2 });
    engine.injectViewportChange({ x: 0, y: 0, zoom: 5 });
    // Force the throttled re-rank synchronously through a labels-config write.
    instance.applyHostUpdate({ labels: { minZoom: 0, maxZoom: 2, overlap: 'allow' } });

    const list = placements();
    expect(clusterLabels(list)).toEqual([]);
    expect(nodeLabels(list).map((p) => p.id)).toEqual(['a', 'c', 'b', 'd']); // degree rank
  });

  it('without maxZoom the two bands coexist, each on its own gate', async () => {
    const { placements } = await rig({ minZoom: 0, overlap: 'allow' });
    const list = placements();
    expect(clusterLabels(list).map((p) => p.id)).toEqual(['red', 'blue']);
    expect(nodeLabels(list).map((p) => p.id)).toEqual(['a', 'c', 'b', 'd']); // degree rank
  });

  it('cluster labels lead the emitted order (coarse layer first)', async () => {
    const { placements } = await rig({ minZoom: 0, overlap: 'allow' });
    expect(placements().map((p) => p.kind ?? 'node')).toEqual([
      'cluster',
      'cluster',
      'node',
      'node',
      'node',
      'node',
    ]);
  });
});

describe('cluster-label selection', () => {
  it('activating a cluster label puts exactly its MEMBER node ids in nodeIds', async () => {
    const { instance } = await rig();
    instance.selectCluster('red');
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'b']);
    expect(instance.store.getState().selection.groupIds).toEqual([]);

    instance.selectCluster('blue');
    expect(instance.store.getState().selection.nodeIds).toEqual(['c', 'd']);

    instance.selectCluster('red', { additive: true });
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'b', 'c', 'd']);
  });

  it('an unknown cluster key is an exact no-op', async () => {
    const { instance } = await rig();
    instance.selectNodes(['a']);
    instance.selectCluster('chartreuse');
    expect(instance.store.getState().selection.nodeIds).toEqual(['a']);
  });
});
