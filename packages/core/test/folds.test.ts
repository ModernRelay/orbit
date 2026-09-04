/**
 * node folds — an EXISTING node standing for its own neighbourhood.
 *
 * Where a collapsed group hides its members behind a SYNTHETIC super-node, a
 * fold keeps the anchor's physical row and hides its members behind it. Both
 * run through the one representative forest, so these cases pin what a REAL
 * representative adds on top of `groups-rewrite.test.ts`: the anchor
 * survives, its edges to its own members drop instead of becoming self-loops,
 * members' outside edges reroute onto the anchor as counted meta-edges, folds
 * nest under collapsed groups, and the whole thing is a history
 * dimension.
 *
 * Structural claims are asserted at the PURE rewrite level (the scene-groups
 * descriptor is internal); the API, commit shape, history, and pruning are
 * asserted through the instance.
 */

import { describe, expect, it } from 'vitest';

import type { GraphInstance } from '../src/instance';
import { buildRepForest, metaEdgePublicId, rewriteGroups } from '../src/groups';
import { validateSnapshot } from '../src/validate';
import { container, makeInstance, snap } from './helpers';
import type { EAttrs, NAttrs } from './helpers';

type Instance = GraphInstance<NAttrs, EAttrs>;

/**
 * A hub with two private satellites and one shared neighbour:
 *
 * s1 ── hub ── s2 satellites touch nothing but the hub
 * │
 * other ── far `other` keeps its own outside edge
 *
 * Folding `hub` hides s1/s2/other, drops hub→s1, hub→s2 and hub→other (all
 * three land on the hub at BOTH ends), and reroutes other→far into ONE
 * meta-edge hub→far.
 */
const IDS = ['hub', 's1', 's2', 'other', 'far'] as const;
const LINKS: ReadonlyArray<readonly [string, string]> = [
  ['hub', 's1'],
  ['hub', 's2'],
  ['hub', 'other'],
  ['other', 'far'],
];

const MODEL = validateSnapshot<NAttrs, EAttrs>(snap(1, [...IDS], LINKS));

async function ready() {
  const h = makeInstance({ fitViewOnFirstData: false });
  await h.instance.attach(container);
  h.instance.applyHostUpdate({ data: snap(1, [...IDS], LINKS) });
  return { ...h, engine: h.engines[0]! };
}

function drawn(instance: Instance): readonly string[] {
  return instance.getSceneNodeIds();
}

// ---------------------------------------------------------------------------
// Pure rewrite — the structural contract.
// ---------------------------------------------------------------------------

describe('fold rewrite: a real representative', () => {
  const FOLD_HUB = [{ anchorId: 'hub', memberIds: ['s1', 's2', 'other'] }];

  it('keeps the anchor drawn, hides its members, and mints NO synthetic row', () => {
    const rewrite = rewriteGroups(MODEL, buildRepForest([], FOLD_HUB))!;

    // The anchor SURVIVES — the whole difference from group collapse, where
    // the clicked node vanishes into a synthetic bubble.
    expect(rewrite.graph.nodes.map((n) => n.id)).toEqual(['hub', 'far']);
    expect(rewrite.physicalNodeCount).toBe(2);
    expect(rewrite.superNodes).toHaveLength(0);
    expect(rewrite.folds).toEqual([{ anchorId: 'hub', hiddenCount: 3 }]);
    expect([...rewrite.hiddenOwner]).toEqual([
      ['s1', 'hub'],
      ['s2', 'hub'],
      ['other', 'hub'],
    ]);
  });

  it('drops anchor↔member edges instead of emitting a self-loop', () => {
    const rewrite = rewriteGroups(MODEL, buildRepForest([], FOLD_HUB))!;

    // hub→s1, hub→s2 and hub→other resolve to `hub` on BOTH ends.
    expect(rewrite.physicalEdges).toHaveLength(0);
    expect(rewrite.metaEdges.map((m) => m.metaEdge)).toEqual([
      {
        id: metaEdgePublicId('node', 'hub', 'node', 'far'),
        source: 'hub',
        target: 'far',
        count: 1,
      },
    ]);
    // No row anywhere has equal endpoints.
    for (const edge of rewrite.graph.edges) expect(edge.source).not.toBe(edge.target);
  });

  it('aggregates several rerouted edges into one counted meta-edge', () => {
    const model = validateSnapshot<NAttrs, EAttrs>(snap(2, [...IDS], [...LINKS, ['s1', 'far']]));
    const rewrite = rewriteGroups(model, buildRepForest([], FOLD_HUB))!;

    expect(rewrite.metaEdges[0]!.metaEdge.count).toBe(2);
    expect(rewrite.metaEdges[0]!.underlying).toEqual([3, 4]);
  });

  it('nests under a collapsed group: the subtree hides and edges route to the bubble', () => {
    const forest = buildRepForest(
      [{ id: 'g', memberIds: ['hub'], collapsed: true, derived: false }],
      FOLD_HUB,
    );
    const rewrite = rewriteGroups(MODEL, forest)!;

    // Only `far` stays physical; the group is the sole synthetic row.
    expect(rewrite.physicalNodes.map((n) => n.id)).toEqual(['far']);
    expect(rewrite.superNodes.map((s) => s.group.id)).toEqual(['g']);
    // presentMemberIds is TRANSITIVE — the anchor plus everything under it.
    expect([...rewrite.superNodes[0]!.presentMemberIds].sort()).toEqual([
      'hub',
      'other',
      's1',
      's2',
    ]);
    // The fold no longer draws, because its anchor is itself hidden.
    expect(rewrite.folds).toEqual([]);
    // other→far now routes from the OUTER bubble, not from the anchor.
    expect(rewrite.metaEdges.map((m) => m.metaEdge)).toEqual([
      { id: metaEdgePublicId('group', 'g', 'node', 'far'), source: 'g', target: 'far', count: 1 },
    ]);
  });

  it('an anchor with no present members is not a fold row', () => {
    const rewrite = rewriteGroups(MODEL, buildRepForest([], [{ anchorId: 'hub', memberIds: [] }]));
    expect(rewrite).toBeNull(); // nothing hidden ⇒ pass-through scene
  });
});

// ---------------------------------------------------------------------------
// Instance surface — API, commit shape, history, hygiene.
// ---------------------------------------------------------------------------

describe('fold ops on the instance', () => {
  it('one fold is ONE structural commit; the anchor keeps its row', async () => {
    const { instance, engine } = await ready();
    const commitsBefore = engine.commits.length;

    instance.foldNode('hub');

    // E1: one publish, one commit for the whole fold.
    expect(engine.commits.length).toBe(commitsBefore + 1);
    const structure = engine.lastCommit!.structure!;
    expect(structure.pointCount).toBe(2); // hub + far, no synthetic
    // Slot 0 = hub, slot 1 = far; the single link is the rerouted meta-edge.
    expect(Array.from(structure.links)).toEqual([0, 1]);
    expect(drawn(instance)).toEqual(['hub', 'far']);
    expect(instance.getFold('hub')).toEqual({ memberIds: ['s1', 's2', 'other'] });
  });

  it('a fold advances scope, never model', async () => {
    const { instance } = await ready();
    const before = instance.getRevisions();
    instance.foldNode('hub');
    const after = instance.getRevisions();
    expect(after.model).toBe(before.model);
    expect(after.scope).toBe(before.scope + 1);
  });

  it('unfold restores the scene exactly', async () => {
    const { instance } = await ready();
    const before = [...drawn(instance)];

    instance.foldNode('hub');
    expect(drawn(instance)).not.toEqual(before);

    instance.unfoldNode('hub');
    expect(drawn(instance)).toEqual(before);
    expect(instance.getFold('hub')).toBeNull();
  });

  it('unfolding a node that is not folded is an exact no-op', async () => {
    const { instance, engine } = await ready();
    const commitsBefore = engine.commits.length;
    const revisionsBefore = instance.getRevisions();

    instance.unfoldNode('hub');
    instance.unfoldNode('nope');

    expect(engine.commits.length).toBe(commitsBefore);
    expect(instance.getRevisions()).toEqual(revisionsBefore);
  });

  it('a second fold never steals an already-claimed neighbour (first claim wins)', async () => {
    const { instance } = await ready();
    instance.foldNode('hub'); // claims s1, s2, other
    expect(instance.getFold('hub')!.memberIds).toEqual(['s1', 's2', 'other']);

    // `other` is hidden inside hub's fold, so it cannot become an anchor.
    instance.foldNode('other');
    expect(instance.getFold('other')).toBeNull();
    expect(drawn(instance)).toEqual(['hub', 'far']);
  });

  it('an explicit member set folds only what was named; unknown ids drop', async () => {
    const { instance } = await ready();
    instance.foldNode('hub', { memberIds: ['s1', 'nope'] });

    expect(instance.getFold('hub')).toEqual({ memberIds: ['s1'] });
    expect(drawn(instance)).toEqual(['hub', 's2', 'other', 'far']);
  });

  it('undo/redo round-trips a fold through the history', async () => {
    const { instance, engine } = await ready();
    const before = [...drawn(instance)];

    instance.foldNode('hub');
    expect(drawn(instance)).toEqual(['hub', 'far']);
    expect(instance.store.getState().folds.get('hub')).toBe(3);

    let publications = 0;
    const unsubscribe = instance.store.subscribe(() => { publications++; });
    const commits = engine.commits.length;

    instance.undo();
    expect(drawn(instance)).toEqual(before);
    expect(instance.getFold('hub')).toBeNull();
    expect(instance.store.getState().folds.size).toBe(0);
    expect(publications).toBe(1);
    expect(engine.commits.length - commits).toBe(1);

    instance.redo();
    expect(drawn(instance)).toEqual(['hub', 'far']);
    expect(instance.getFold('hub')).toEqual({ memberIds: ['s1', 's2', 'other'] });
    expect(instance.store.getState().folds.get('hub')).toBe(3);
    expect(publications).toBe(2);
    expect(engine.commits.length - commits).toBe(2);
    unsubscribe();
  });

  it('view-state fold restores publish the current count in the same scene update', async () => {
    const { instance, engine } = await ready();
    try {
      const expanded = instance.getViewState();
      instance.foldNode('hub');
      const folded = instance.getViewState();
      let publications = 0;
      const unsubscribe = instance.store.subscribe(() => { publications++; });
      const commits = engine.commits.length;
      await instance.setViewState(expanded);
      expect(instance.store.getState().folds.size).toBe(0);
      expect(publications).toBe(1);
      expect(engine.commits.length - commits).toBe(1);
      await instance.setViewState(folded);
      expect(instance.store.getState().folds.get('hub')).toBe(3);
      expect(publications).toBe(2);
      expect(engine.commits.length - commits).toBe(2);
      unsubscribe();
    } finally {
      instance.destroy();
    }
  });

  it('nests under a collapsed group at the instance level', async () => {
    const { instance } = await ready();
    instance.foldNode('hub');
    expect(drawn(instance)).toEqual(['hub', 'far']);

    instance.applyHostUpdate({ groups: [{ id: 'g', memberIds: ['hub'], collapsed: true }] });

    // The anchor now has a collapsed ancestor, so it hides with its subtree.
    expect(drawn(instance)).toEqual(['far']);
    expect(instance.store.getState().groups[0]!.memberIds).toEqual(['hub']);
  });

  it('publishes store.folds so a fold is observable', async () => {
    const { instance } = await ready();
    expect(instance.store.getState().folds.size).toBe(0);

    let publications = 0;
    const unsubscribe = instance.store.subscribe(() => {
      publications++;
    });
    try {
      instance.foldNode('hub');
      // E1: the slice rides the op's SINGLE publication.
      expect(publications).toBe(1);
      // A fold changes no id and no label text, so this slice is the only
      // signal a subscriber gets that fold-derived chrome went stale.
      expect([...instance.store.getState().folds]).toEqual([['hub', 3]]);

      instance.unfoldNode('hub');
      expect(publications).toBe(2);
      expect(instance.store.getState().folds.size).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  it('republishes store.folds when pruning shrinks a fold', async () => {
    const { instance } = await ready();
    instance.foldNode('hub');
    expect(instance.store.getState().folds.get('hub')).toBe(3);

    instance.applyHostUpdate({
      data: snap(2, ['hub', 's2', 'other', 'far'], [
        ['hub', 's2'],
        ['hub', 'other'],
        ['other', 'far'],
      ]),
    });
    expect(instance.store.getState().folds.get('hub')).toBe(2);
  });

  it('prunes a departed member, then a departed anchor', async () => {
    const { instance } = await ready();
    instance.foldNode('hub');
    expect(instance.getFold('hub')!.memberIds).toEqual(['s1', 's2', 'other']);

    // s1 leaves: the fold survives without it.
    instance.applyHostUpdate({
      data: snap(2, ['hub', 's2', 'other', 'far'], [
        ['hub', 's2'],
        ['hub', 'other'],
        ['other', 'far'],
      ]),
    });
    expect(instance.getFold('hub')!.memberIds).toEqual(['s2', 'other']);

    // The anchor itself leaves: the fold goes with it.
    instance.applyHostUpdate({ data: snap(3, ['s2', 'other', 'far'], [['other', 'far']]) });
    expect(instance.getFold('hub')).toBeNull();
  });
});
