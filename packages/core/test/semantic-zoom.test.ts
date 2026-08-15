/**
 * semantic zoom: hysteresis band tracking from
 * viewport events.
 *
 * Crossing below `collapseBelow` collapses every derived group; crossing
 * above `expandAbove` expands ONLY the groups intersecting the viewport; a
 * zoom strictly between the thresholds retains the current band. A band flip
 * is a plain structural diff over already-derived membership — no engine
 * entry points beyond the existing `spaceToScreen` projection.
 */

import { describe, expect, it } from 'vitest';

import { createGraphInstance } from '../src/instance';
import type { GraphInstance } from '../src/instance';
import { FakeEngine } from '../src/testing/index';
import type { GraphSnapshot, GroupBySpec } from '../src/types';

type NA = { cluster: string; x: number; y: number };
type EA = Record<string, never>;

/** Two clusters: 'near' at space (10,10)-ish, 'far' at (900,900)-ish. With a
 * 100x100 container and FakeEngine's identity spaceToScreen, only 'near'
 * intersects the viewport. */
function clusterSnap(rev: number): GraphSnapshot<NA, EA> {
  return {
    datasetKey: 'ds',
    sourceRevision: rev,
    nodes: [
      { id: 'n1', x: 10, y: 10, attrs: { cluster: 'near', x: 10, y: 10 } },
      { id: 'n2', x: 20, y: 20, attrs: { cluster: 'near', x: 20, y: 20 } },
      { id: 'f1', x: 900, y: 900, attrs: { cluster: 'far', x: 900, y: 900 } },
      { id: 'f2', x: 910, y: 910, attrs: { cluster: 'far', x: 910, y: 910 } },
    ],
    edges: [],
  };
}

const BY: GroupBySpec<NA> = {
  by: (n) => n.attrs?.cluster ?? null,
  semanticZoom: { collapseBelow: 0.5, expandAbove: 2 },
};

/** Container the cull rect can measure (the default test container is
 * unsized, which degrades the in-view test to "everything is in view"). */
function sizedContainer(): HTMLElement {
  return { clientWidth: 100, clientHeight: 100 } as unknown as HTMLElement;
}

async function rig(spec: GroupBySpec<NA> = BY, container = sizedContainer()) {
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
  instance.applyHostUpdate({ data: clusterSnap(1), groupBy: spec });
  return { instance, engine: engines[0]! };
}

/** Collapsed state of each derived group, keyed by label. */
function collapsedByLabel(instance: GraphInstance<NA, EA>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const g of instance.store.getState().groups) out[g.label ?? g.id] = g.collapsed;
  return out;
}

describe('semantic zoom band tracking', () => {
  it('crossing BELOW collapseBelow collapses every derived group', async () => {
    const { instance, engine } = await rig();
    expect(collapsedByLabel(instance)).toEqual({ near: false, far: false });

    engine.injectViewportChange({ x: 0, y: 0, zoom: 0.25 });
    expect(collapsedByLabel(instance)).toEqual({ near: true, far: true });
  });

  it('crossing ABOVE expandAbove expands ONLY groups intersecting the viewport', async () => {
    // A 5x5 cull rect: once the engine places the two super-nodes at its
    // seed coordinates (slot 0 → (0,0), slot 1 → (10,0)), the 'near' group's
    // super-node is inside the rect and the 'far' one is not.
    const { instance, engine } = await rig(BY, {
      clientWidth: 5,
      clientHeight: 5,
    } as unknown as HTMLElement);

    engine.injectViewportChange({ x: 0, y: 0, zoom: 0.25 }); // collapse all
    expect(collapsedByLabel(instance)).toEqual({ near: true, far: true });

    // The engine places the freshly seeded super-nodes; settle banks those
    // positions into the core's cache.
    engine.injectSimulationEnd();

    engine.injectViewportChange({ x: 0, y: 0, zoom: 4 }); // expand in-view only
    expect(collapsedByLabel(instance)).toEqual({ near: false, far: true });
  });

  it('an unplaced (NaN) super-node fails OPEN — a group is never stranded collapsed', async () => {
    // Same 5x5 rect, but WITHOUT the settle: no super-node position is known
    // yet, so neither group can be proven off-screen and both expand.
    const { instance, engine } = await rig(BY, {
      clientWidth: 5,
      clientHeight: 5,
    } as unknown as HTMLElement);
    engine.injectViewportChange({ x: 0, y: 0, zoom: 0.25 });
    engine.injectViewportChange({ x: 0, y: 0, zoom: 4 });
    expect(collapsedByLabel(instance)).toEqual({ near: false, far: false });
  });

  it('a band flip is a structural diff — no new engine entry points', async () => {
    const { instance, engine } = await rig();
    const before = engine.commits.length;
    engine.injectViewportChange({ x: 0, y: 0, zoom: 0.25 });

    expect(engine.commits.length).toBe(before + 1); // ONE commit
    const commit = engine.lastCommit!;
    expect(commit.structure).toBeDefined(); // a structural diff…
    // …carried by the standard commit surface only.
    const methods = new Set(
      engine.calls.map((c) => c.method).filter((m) => !m.startsWith('inject')),
    );
    for (const m of methods) {
      expect([
        'mount',
        'commit',
        'appliedRevision',
        'getPositions',
        'spaceToScreen',
        'screenToSpace',
        'setSelectedIndices',
        'setFocusedIndex',
        'setPinnedIndices',
        'getViewport',
        'setViewport',
        'fitView',
        'start',
        'stop',
        'pointsInRect',
        'pointsInPolygon',
        'destroy',
      ]).toContain(m);
    }
    expect(instance.store.getState().groups.every((g) => g.collapsed)).toBe(true);
  });

  it('property: any zoom sequence strictly inside the corridor flips NOTHING', async () => {
    const { instance, engine } = await rig();
    const commitsBefore = engine.commits.length;
    const stateBefore = collapsedByLabel(instance);

    // Deterministic oscillation strictly between 0.5 and 2.
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let i = 0; i < 200; i++) {
      const zoom = 0.5 + rand() * (2 - 0.5); // (0.5, 2) exclusive-ish
      if (zoom <= 0.5 || zoom >= 2) continue;
      engine.injectViewportChange({ x: 0, y: 0, zoom });
    }
    expect(engine.commits.length).toBe(commitsBefore); // zero band flips
    expect(collapsedByLabel(instance)).toEqual(stateBefore);
  });

  it('hysteresis holds ACROSS the corridor after a crossing', async () => {
    const { instance, engine } = await rig();
    engine.injectViewportChange({ x: 0, y: 0, zoom: 0.25 }); // collapsed band
    const commits = engine.commits.length;

    // Wander the corridor: the collapsed band must persist.
    for (const zoom of [0.6, 1, 1.9, 1.2, 0.7]) {
      engine.injectViewportChange({ x: 0, y: 0, zoom });
    }
    expect(engine.commits.length).toBe(commits);
    expect(collapsedByLabel(instance)).toEqual({ near: true, far: true });

    // Re-crossing the SAME threshold is also a no-op (band unchanged).
    engine.injectViewportChange({ x: 0, y: 0, zoom: 0.1 });
    expect(engine.commits.length).toBe(commits);
  });

  it('collapseBelow >= expandAbove is rejected at the boundary — the lane never activates', async () => {
    const { instance, engine } = await rig({
      by: (n) => n.attrs?.cluster ?? null,
      semanticZoom: { collapseBelow: 3, expandAbove: 1 },
    });
    const diags = instance.store.getState().diagnostics.filter((d) => d.code === 'config-error');
    expect(diags.length).toBeGreaterThan(0);

    // The rejected spec never landed, so no derivation and no band flips.
    const before = engine.commits.length;
    engine.injectViewportChange({ x: 0, y: 0, zoom: 0.1 });
    expect(engine.commits.length).toBe(before);
  });

  it('without semanticZoom, viewport events never touch the collapsed residue', async () => {
    const { instance, engine } = await rig({ by: (n) => n.attrs?.cluster ?? null });
    const before = engine.commits.length;
    engine.injectViewportChange({ x: 0, y: 0, zoom: 0.01 });
    engine.injectViewportChange({ x: 0, y: 0, zoom: 100 });
    expect(engine.commits.length).toBe(before);
    expect(collapsedByLabel(instance)).toEqual({ near: false, far: false });
  });

  it('an unsized container degrades to plain band expansion (documented)', async () => {
    // The default headless container reports no size: the in-view test
    // cannot run, so every group expands with the band.
    const { instance, engine } = await rig(BY, {} as unknown as HTMLElement);
    engine.injectViewportChange({ x: 0, y: 0, zoom: 0.25 });
    expect(collapsedByLabel(instance)).toEqual({ near: true, far: true });
    engine.injectViewportChange({ x: 0, y: 0, zoom: 4 });
    expect(collapsedByLabel(instance)).toEqual({ near: false, far: false });
  });
});
