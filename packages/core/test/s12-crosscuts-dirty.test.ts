/**
 * dirty-flag budget with LIVE stage-3 groups (stage
 * ordering).
 *
 * The two budgets the plan names:
 * - a BRUSH touches stages 5–6 only: no reconcile, no stage-4
 * re-derivation (pinned via `clusterProbe.derivations`), exactly ONE
 * buffers-only commit, zero structure, model revision frozen;
 * - a GROUP COLLAPSE touches stages 3–6 and exactly ONE structural diff:
 * one commit, carrying structure, and exactly one stage-4 re-derivation.
 *
 * `clusterProbe.derivations` is the reconcile probe: with a cluster spec live
 * and no spec change in the step, stage 4 re-derives from `reconcileScene`
 * and nowhere else (instance.ts `reconcileScene` / `deriveClusterState`), so
 * "derivations did not move" IS "the scene was not reconciled".
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { createGraphInstance } from '../src/instance';
import type { GraphInstance } from '../src/instance';
import { FakeEngine, clusterProbe, resetClusterProbe } from '../src/testing/index';
import type { EngineCommit } from '../src/engine/index';
import type {
  ClusterSpec,
  CrossfilterSession,
  DimensionSpec,
  GraphNode,
  GraphSnapshot,
  GroupSpec,
  Revisions,
} from '../src/types';

type NA = { team: string; v: number };
type EA = Record<string, never>;

const container = {} as unknown as HTMLElement;

/** 8 nodes in 2 teams, v = 0..7; a ring so every collapse reroutes edges. */
function snapshot(): GraphSnapshot<NA, EA> {
  const nodes: GraphNode<NA>[] = Array.from({ length: 8 }, (_, i) => ({
    id: `n${String(i)}`,
    attrs: { team: i % 2 === 0 ? 'even' : 'odd', v: i },
  }));
  const edges = Array.from({ length: 8 }, (_, i) => ({
    source: `n${String(i)}`,
    target: `n${String((i + 1) % 8)}`,
  }));
  return { datasetKey: 'dirty', sourceRevision: 1, nodes, edges };
}

const V_DIM: DimensionSpec<NA> = { key: 'v', kind: 'numeric', get: (n) => n.attrs?.v };
const CLUSTERS: ClusterSpec<NA> = { by: (n) => n.attrs?.team ?? null };
const GROUP: GroupSpec = { id: 'G', memberIds: ['n1', 'n2', 'n3'], collapsed: false };

interface Rig {
  instance: GraphInstance<NA, EA>;
  engine: FakeEngine;
  session: CrossfilterSession;
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
  instance.applyHostUpdate({
    data: snapshot(),
    nodeColor: 'red',
    linkColor: 'blue',
    crossfilter: [V_DIM],
    clusters: CLUSTERS,
  });
  // Groups arrive through the OP path so the lane stays uncontrolled and
  // setGroupCollapsed writes directly.
  instance.groupNodes(GROUP);
  return { instance, engine: engines[0]!, session: instance.getCrossfilterSession()! };
}

/** Commits recorded since `from`. */
function commitsSince(engine: FakeEngine, from: number): readonly EngineCommit[] {
  return engine.commits.slice(from);
}

function revisionsOf(instance: GraphInstance<NA, EA>): Revisions {
  return { ...instance.getRevisions() };
}

describe('dirty-flag budget: a brush with groups active touches stages 5–6 only', () => {
  beforeEach(() => {
    resetClusterProbe();
  });

  it('collapsed group + brush: ZERO reconciles, ZERO stage-4 derivations, exactly ONE buffers-only commit', async () => {
    const r = await rig();
    try {
      r.instance.setGroupCollapsed('G', true);
      const sceneBefore = [...r.instance.getSceneNodeIds()];
      const superNodesBefore = r.instance.store.getState().groups.filter((g) => g.collapsed).length;
      expect(superNodesBefore).toBe(1);

      const commitsAt = r.engine.commits.length;
      const revisionsBefore = revisionsOf(r.instance);
      resetClusterProbe();

      await r.session.setBrush('v', { min: 0, max: 3 });

      // Stage 4 never ran ⇒ the scene was never reconciled.
      expect(clusterProbe.derivations).toBe(0);

      const commits = commitsSince(r.engine, commitsAt);
      expect(commits).toHaveLength(1);
      const commit = commits[0]!;
      expect(commit.structure).toBeUndefined();
      expect(commit.restart).toBeUndefined();
      expect(commit.config).toBeUndefined();
      expect(commit.buffers?.pointColor).toBeDefined();

      // Scene and group rewrite untouched; masks advance scope+render,
      // never model.
      expect(r.instance.getSceneNodeIds()).toEqual(sceneBefore);
      expect(r.instance.store.getState().groups.filter((g) => g.collapsed)).toHaveLength(1);
      const after = revisionsOf(r.instance);
      expect(after.model).toBe(revisionsBefore.model);
      expect(after.scope).toBe(revisionsBefore.scope + 1);
      expect(after.render).toBe(revisionsBefore.render + 1);

      // The brush actually bit (otherwise the budget is vacuous).
      expect(r.instance.store.getState().visible.nodes).toBeLessThan(
        r.instance.store.getState().nodeCount,
      );
    } finally {
      r.instance.destroy();
    }
  });

  it('a 12-step brush scrub over a collapsed group is 12 buffers-only commits and still zero derivations', async () => {
    const r = await rig();
    try {
      r.instance.setGroupCollapsed('G', true);
      const commitsAt = r.engine.commits.length;
      resetClusterProbe();

      for (let i = 0; i < 12; i++) {
        await r.session.setBrush('v', { min: i % 5, max: (i % 5) + 3 });
      }

      expect(clusterProbe.derivations).toBe(0);
      const commits = commitsSince(r.engine, commitsAt);
      expect(commits).toHaveLength(12);
      for (const c of commits) {
        expect(c.structure).toBeUndefined();
        expect(c.restart).toBeUndefined();
      }
    } finally {
      r.instance.destroy();
    }
  });

  it('the sibling stage-5 lanes (filter, hiddenNodeIds) are equally reconcile-free with groups live', async () => {
    const r = await rig();
    try {
      r.instance.setGroupCollapsed('G', true);
      const sceneBefore = [...r.instance.getSceneNodeIds()];
      resetClusterProbe();
      let at = r.engine.commits.length;

      r.instance.applyHostUpdate({
        filter: { nodes: (n: GraphNode<NA>) => (n.attrs?.v ?? 0) > 2, mode: 'hide' },
      });
      expect(clusterProbe.derivations).toBe(0);
      let commits = commitsSince(r.engine, at);
      expect(commits).toHaveLength(1);
      expect(commits[0]!.structure).toBeUndefined();

      at = r.engine.commits.length;
      r.instance.hideNodes(['n5']);
      expect(clusterProbe.derivations).toBe(0);
      commits = commitsSince(r.engine, at);
      expect(commits).toHaveLength(1);
      expect(commits[0]!.structure).toBeUndefined();

      expect(r.instance.getSceneNodeIds()).toEqual(sceneBefore);
    } finally {
      r.instance.destroy();
    }
  });
});

describe('dirty-flag budget: a group collapse touches stages 3–6 with EXACTLY ONE structural diff', () => {
  beforeEach(() => {
    resetClusterProbe();
  });

  it('collapse: one commit, it carries structure, and stage 4 re-derives exactly once', async () => {
    const r = await rig();
    try {
      const sceneBefore = [...r.instance.getSceneNodeIds()];
      const commitsAt = r.engine.commits.length;
      const revisionsBefore = revisionsOf(r.instance);
      resetClusterProbe();

      r.instance.setGroupCollapsed('G', true);

      const commits = commitsSince(r.engine, commitsAt);
      expect(commits).toHaveLength(1); // ONE structural diff, not a reload
      const commit = commits[0]!;
      expect(commit.structure).toBeDefined();
      // Members left, one super-node arrived: stage 3 ran.
      expect(commit.structure!.pointCount).toBe(sceneBefore.length - GROUP.memberIds.length + 1);
      // Stage 6 re-projected the new roster in the SAME commit.
      expect(commit.buffers?.pointColor?.length).toBe(4 * commit.structure!.pointCount);
      // Stage 4 re-derived over the new physical prefix — exactly once.
      expect(clusterProbe.derivations).toBe(1);
      expect(commit.config?.cluster?.pointClusters.length).toBe(commit.structure!.pointCount);

      // a collapse is a SCOPE-driven publication — model never moves.
      const after = revisionsOf(r.instance);
      expect(after.model).toBe(revisionsBefore.model);
      expect(after.scope).toBe(revisionsBefore.scope + 1);
      expect(after.render).toBe(revisionsBefore.render + 1);
    } finally {
      r.instance.destroy();
    }
  });

  it('expand: symmetric — one structural commit, one stage-4 re-derivation, members return', async () => {
    const r = await rig();
    try {
      r.instance.setGroupCollapsed('G', true);
      const collapsedScene = [...r.instance.getSceneNodeIds()];
      const commitsAt = r.engine.commits.length;
      resetClusterProbe();

      r.instance.setGroupCollapsed('G', false);

      const commits = commitsSince(r.engine, commitsAt);
      expect(commits).toHaveLength(1);
      expect(commits[0]!.structure).toBeDefined();
      expect(clusterProbe.derivations).toBe(1);
      expect(r.instance.getSceneNodeIds().length).toBe(
        collapsedScene.length + GROUP.memberIds.length,
      );
      for (const id of GROUP.memberIds) expect(r.instance.getSceneNodeIds()).toContain(id);
    } finally {
      r.instance.destroy();
    }
  });

  it('an UNCOLLAPSED group definition change is stage-3 inert: zero commits, zero derivations', async () => {
    const r = await rig();
    try {
      const commitsAt = r.engine.commits.length;
      resetClusterProbe();

      r.instance.groupNodes({ id: 'H', memberIds: ['n5', 'n6'] });

      expect(r.instance.store.getState().groups.map((g) => g.id)).toEqual(['G', 'H']);
      expect(commitsSince(r.engine, commitsAt)).toHaveLength(0);
      expect(clusterProbe.derivations).toBe(0);
    } finally {
      r.instance.destroy();
    }
  });

  it('a stage-4 spec change re-derives WITHOUT a structural diff (stage 3 untouched)', async () => {
    const r = await rig();
    try {
      r.instance.setGroupCollapsed('G', true);
      const sceneBefore = [...r.instance.getSceneNodeIds()];
      const commitsAt = r.engine.commits.length;
      resetClusterProbe();

      // A NEW `by` identity is the stage-4 dirty flag.
      r.instance.applyHostUpdate({ clusters: { by: (n: GraphNode<NA>) => n.attrs?.team ?? null } });

      expect(clusterProbe.derivations).toBe(1);
      const commits = commitsSince(r.engine, commitsAt);
      expect(commits).toHaveLength(1);
      expect(commits[0]!.structure).toBeUndefined(); // config-only
      expect(commits[0]!.config?.cluster).toBeDefined();
      expect(r.instance.getSceneNodeIds()).toEqual(sceneBefore);
    } finally {
      r.instance.destroy();
    }
  });
});
