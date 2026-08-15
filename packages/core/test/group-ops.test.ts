/**
 * Group operations, id namespace, typed events, and isolate-as-unit behavior.
 *
 * Covers: groupNodes/ungroup/setGroupCollapsed through the ownership
 * contract (uncontrolled writes = diff-scale commits + 'groupsChange'
 * results; controlled = intents, no writes), the event namespace
 * (super-node hits fire typed group events with ResolvedGroup payloads,
 * meta-edge hits fire MetaEdge payloads, and physical hits keep caller types),
 * the selectGroups algebra + removed-definition pruning through
 * the ownership path in BOTH selection modes, and collapsed-group isolate-as-unit
 * (seedIds naming a collapsed group id resolve to memberIds).
 */

import { describe, expect, it } from 'vitest';

import type { GraphInstance } from '../src/instance';
import { metaEdgePublicId } from '../src/groups';
import type { FakeEngine } from '../src/testing/index';
import type { GraphDiagnostic, GroupSpec, MetaEdge, ResolvedGroup } from '../src/types';
import { container, makeInstance, snap } from './helpers';
import type { EAttrs, NAttrs } from './helpers';

type Instance = GraphInstance<NAttrs, EAttrs>;

/** a—b—c—d—e plus a second a→c edge. Collapsing {b,c}
 * yields scene points [a, d, e, super@3] and links [d→e@0, meta a→G@1
 * (count 2), meta G→d@2 (count 1)]. */
const FIXTURE_IDS = ['a', 'b', 'c', 'd', 'e'] as const;
const FIXTURE_LINKS: ReadonlyArray<readonly [string, string]> = [
  ['a', 'b'],
  ['a', 'c'],
  ['b', 'c'],
  ['c', 'd'],
  ['d', 'e'],
];
const GROUP_BC: GroupSpec = { id: 'g', memberIds: ['b', 'c'], collapsed: true };

async function readyFixture() {
  const h = makeInstance({ fitViewOnFirstData: false });
  await h.instance.attach(container);
  h.instance.applyHostUpdate({ data: snap(1, [...FIXTURE_IDS], FIXTURE_LINKS) });
  return { ...h, engine: h.engines[0]! };
}

function configErrors(instance: Instance): readonly GraphDiagnostic[] {
  return instance.store.getState().diagnostics.filter((d) => d.code === 'config-error');
}

/** Engine-visible position of a PHYSICAL node id (scene prefix order). */
function posOf(engine: FakeEngine, instance: Instance, id: string): readonly [number, number] {
  const idx = instance.getSceneNodeIds().indexOf(id);
  expect(idx).toBeGreaterThanOrEqual(0);
  const pos = engine.getPositions()!;
  return [pos[2 * idx]!, pos[2 * idx + 1]!];
}

function nanSlots(positions: Float32Array): number {
  let n = 0;
  for (let i = 0; i < positions.length; i += 2) {
    if (Number.isNaN(positions[i]!)) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// event namespace: typed group/meta-edge events, distinct id spaces.
// ---------------------------------------------------------------------------

describe('event namespace: group and meta-edge hits fire typed callbacks', () => {
  it("node id 'g1' and group id 'g1': each click fires the correctly-typed callback and both ids coexist in SelectionState namespaces", async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    h.instance.applyHostUpdate({ data: snap(1, ['g1', 'x', 'y'], [['g1', 'x']]) });
    const engine = h.engines[0]!;
    h.instance.applyHostUpdate({
      groups: [{ id: 'g1', memberIds: ['x', 'y'], collapsed: true }],
    });
    expect(configErrors(h.instance)).toHaveLength(0);
    // Scene: physical [g1] + super@1; the only edge rerouted to a meta-edge.
    expect(h.instance.getSceneNodeIds()).toEqual(['g1']);

    const nodeClicks: string[] = [];
    const groupClicks: ResolvedGroup[] = [];
    h.instance.on('nodeClick', (p) => nodeClicks.push(p.node.id));
    h.instance.on('groupClick', (p) => groupClicks.push(p.group));

    engine.injectPointClick(0); // the physical NODE g1
    expect(nodeClicks).toEqual(['g1']);
    expect(groupClicks).toEqual([]);
    expect(h.instance.store.getState().selection.nodeIds).toEqual(['g1']);

    engine.injectPointClick(1); // the super-node of GROUP g1
    expect(nodeClicks).toEqual(['g1']); // node callback NOT re-fired
    expect(groupClicks).toHaveLength(1);
    expect(groupClicks[0]!.id).toBe('g1');
    expect(groupClicks[0]!.memberIds).toEqual(['x', 'y']);
    expect(groupClicks[0]!.derived).toBe(false);

    // Both ids coexist across namespaces without collision.
    const sel = h.instance.store.getState().selection;
    expect(sel.nodeIds).toEqual(['g1']);
    expect(sel.groupIds).toEqual(['g1']);
  });

  it('meta-edge hits fire onMetaEdgeClick with the MetaEdge payload; physical edge hits keep the typed edge callback', async () => {
    const { instance, engine } = await readyFixture();
    instance.applyHostUpdate({ groups: [GROUP_BC] });

    const edgeClicks: string[] = [];
    const metaClicks: MetaEdge[] = [];
    instance.on('edgeClick', (p) => edgeClicks.push(p.edge.id));
    instance.on('metaEdgeClick', (p) => metaClicks.push(p.metaEdge));

    engine.injectLinkClick(0); // physical d→e
    expect(edgeClicks).toEqual(['d→e#0']);
    expect(metaClicks).toEqual([]);

    engine.injectLinkClick(1); // meta a→G (underlying a→b, a→c)
    expect(edgeClicks).toEqual(['d→e#0']);
    expect(metaClicks).toEqual([
      { id: metaEdgePublicId('node', 'a', 'group', 'g'), source: 'a', target: 'g', count: 2 },
    ]);
  });

  it('group click follow-up selects the group id (plain replaces, meta toggles); preventDefault cancels it', async () => {
    const { instance, engine } = await readyFixture();
    instance.applyHostUpdate({ groups: [GROUP_BC] });

    engine.injectPointClick(3); // super slot
    expect(instance.store.getState().selection.groupIds).toEqual(['g']);

    // Meta-click toggles the id off; node/edge namespaces untouched.
    engine.injectPointClick(3, { metaKey: true, shiftKey: false });
    expect(instance.store.getState().selection.groupIds).toEqual([]);

    const off = instance.on('groupClick', (_p, control) => control.preventDefault());
    engine.injectPointClick(3);
    expect(instance.store.getState().selection.groupIds).toEqual([]); // cancelled
    off();
  });

  it('the engine highlight channel includes the selected super-node slot', async () => {
    const { instance, engine } = await readyFixture();
    instance.applyHostUpdate({ groups: [GROUP_BC] });
    engine.injectPointClick(3);
    const pushes = engine.calls.filter((c) => c.method === 'setSelectedIndices');
    expect(pushes[pushes.length - 1]!.args[0]).toEqual([3]);
  });
});

// ---------------------------------------------------------------------------
// selectGroups algebra + removed-definition pruning (ownership path).
// ---------------------------------------------------------------------------

describe('group selection algebra and pruning', () => {
  it('selectGroups validates against the resolved groups and stores groups-array order', async () => {
    const { instance } = await readyFixture();
    instance.applyHostUpdate({
      groups: [
        { id: 'g2', memberIds: ['d', 'e'] },
        { id: 'g1', memberIds: ['b', 'c'] },
      ],
    });
    instance.selectGroups(['g1', 'nope', 'g2', 'g1']);
    const sel = instance.store.getState().selection;
    expect(sel.groupIds).toEqual(['g2', 'g1']); // groups-array order, deduped
    expect(sel.nodeIds).toEqual([]);
    expect(sel.edgeIds).toEqual([]);
  });

  it('removing a group definition prunes its id from selection — uncontrolled mode', async () => {
    const { instance, engine } = await readyFixture();
    instance.applyHostUpdate({ groups: [GROUP_BC] });
    engine.injectPointClick(3); // select the group by clicking its super-node
    expect(instance.store.getState().selection.groupIds).toEqual(['g']);

    instance.applyHostUpdate({ groups: null });
    expect(instance.store.getState().selection.groupIds).toEqual([]);
  });

  it('removing a group definition prunes its id from selection — controlled (node) mode, host nodeIds untouched', async () => {
    const { instance } = await readyFixture();
    instance.applyHostUpdate({ selection: ['a'] }); // flips node namespace controlled
    instance.applyHostUpdate({ groups: [GROUP_BC] });
    instance.selectGroups(['g']); // group namespace stays instance-owned
    expect(instance.store.getState().selection.groupIds).toEqual(['g']);

    instance.applyHostUpdate({ groups: null });
    const sel = instance.store.getState().selection;
    expect(sel.groupIds).toEqual([]);
    expect(sel.nodeIds).toEqual(['a']); // host-owned namespace untouched
  });

  it('ungroup prunes exactly the removed id and keeps sibling group selections', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    h.instance.applyHostUpdate({ data: snap(1, [...FIXTURE_IDS], FIXTURE_LINKS) });
    h.instance.groupNodes({ id: 'g1', memberIds: ['b', 'c'] });
    h.instance.groupNodes({ id: 'g2', memberIds: ['d', 'e'] });
    h.instance.selectGroups(['g1', 'g2']);

    h.instance.ungroup('g1');
    expect(h.instance.store.getState().selection.groupIds).toEqual(['g2']);
    expect(h.instance.store.getState().groups.map((g) => g.id)).toEqual(['g2']);
  });
});

// ---------------------------------------------------------------------------
// ops: uncontrolled writes, controlled intents, validation, no-ops.
// ---------------------------------------------------------------------------

describe('group operations through the ownership contract', () => {
  it('groupNodes/ungroup round-trip: diff-scale commits and onGroupsChange payloads matching the store', async () => {
    const { instance, engine } = await readyFixture();
    const b0 = posOf(engine, instance, 'b');
    const c0 = posOf(engine, instance, 'c');
    const events: (readonly ResolvedGroup[])[] = [];
    instance.on('groupsChange', (p) => events.push(p.groups));

    // --- groupNodes (uncontrolled write): ONE diff-scale commit. ---
    const commitsBefore = engine.commits.length;
    instance.groupNodes(GROUP_BC);
    expect(engine.commits.length).toBe(commitsBefore + 1);
    const collapseCommit = engine.lastCommit!;
    expect(collapseCommit.structure!.pointCount).toBe(4);
    // O(delta) seeding: exactly the ONE new super-node — never a reload.
    expect(nanSlots(collapseCommit.structure!.positions)).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toBe(instance.store.getState().groups); // the store array
    expect(instance.store.getState().groups).toEqual([
      { id: 'g', memberIds: ['b', 'c'], collapsed: true, derived: false },
    ]);

    // --- ungroup: ONE commit; members return at cached positions. ---
    const commitsAfterCollapse = engine.commits.length;
    instance.ungroup('g');
    expect(engine.commits.length).toBe(commitsAfterCollapse + 1);
    expect(nanSlots(engine.lastCommit!.structure!.positions)).toBe(0);
    expect(instance.getSceneNodeIds()).toEqual([...FIXTURE_IDS]);
    expect(posOf(engine, instance, 'b')).toEqual(b0);
    expect(posOf(engine, instance, 'c')).toEqual(c0);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual([]);
    expect(instance.store.getState().groups).toEqual([]);
    // Ops never touch the model revision.
    expect(instance.getRevisions().model).toBe(1);
  });

  it('an uncontrolled op is exactly one store publication (E1)', async () => {
    const { instance } = await readyFixture();
    let publishes = 0;
    const unsub = instance.store.subscribe(() => publishes++);
    instance.groupNodes(GROUP_BC);
    unsub();
    expect(publishes).toBe(1);
  });

  it('groupNodes with a violating spec: ONE config-error, zero commits, state untouched', async () => {
    const { instance, engine } = await readyFixture();
    const commitsBefore = engine.commits.length;
    const groupsBefore = instance.store.getState().groups;

    instance.groupNodes({ id: 'g', memberIds: ['b', 'b'] }); // duplicate membership
    expect(configErrors(instance)).toHaveLength(1);
    expect(engine.commits.length).toBe(commitsBefore);
    expect(instance.store.getState().groups).toBe(groupsBefore);

    // The next applied write clears the stale verdict.
    instance.groupNodes(GROUP_BC);
    expect(configErrors(instance)).toHaveLength(0);
  });

  it('setGroupCollapsed toggles collapse as a structural diff; a same-value call is an exact no-op', async () => {
    const { instance, engine } = await readyFixture();
    instance.groupNodes({ id: 'g', memberIds: ['b', 'c'] }); // uncollapsed: no commit
    const commitsBefore = engine.commits.length;

    instance.setGroupCollapsed('g', true);
    expect(engine.commits.length).toBe(commitsBefore + 1);
    expect(instance.store.getState().groups[0]!.collapsed).toBe(true);

    let publishes = 0;
    const unsub = instance.store.subscribe(() => publishes++);
    instance.setGroupCollapsed('g', true); // same value: zero publishes/commits
    unsub();
    expect(publishes).toBe(0);
    expect(engine.commits.length).toBe(commitsBefore + 1);

    instance.setGroupCollapsed('g', false);
    expect(engine.commits.length).toBe(commitsBefore + 2);
    expect(instance.getSceneNodeIds()).toEqual([...FIXTURE_IDS]);
  });

  it('controlled mode (groups prop provided): ops fire the groupsChange INTENT and never write', async () => {
    const { instance, engine } = await readyFixture();
    instance.applyHostUpdate({ groups: [GROUP_BC] }); // flips the slice controlled
    const events: (readonly ResolvedGroup[])[] = [];
    instance.on('groupsChange', (p) => events.push(p.groups));
    const commitsBefore = engine.commits.length;
    const groupsBefore = instance.store.getState().groups;

    instance.setGroupCollapsed('g', false);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual([
      { id: 'g', memberIds: ['b', 'c'], collapsed: false, derived: false },
    ]);
    // Intent only: no store write, no commit — the host reflects it back.
    expect(instance.store.getState().groups).toBe(groupsBefore);
    expect(engine.commits.length).toBe(commitsBefore);

    // The host reflecting the intent through the prop applies it.
    instance.applyHostUpdate({ groups: [{ id: 'g', memberIds: ['b', 'c'], collapsed: false }] });
    expect(instance.store.getState().groups[0]!.collapsed).toBe(false);
    expect(engine.commits.length).toBe(commitsBefore + 1);
  });

  it('ungroup of an unknown id: dev warning diagnostic, no-op', async () => {
    const { instance, engine } = await readyFixture();
    const commitsBefore = engine.commits.length;
    instance.ungroup('nope');
    const errs = configErrors(instance);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.severity).toBe('warning');
    expect(engine.commits.length).toBe(commitsBefore);
  });
});

// ---------------------------------------------------------------------------
// Stage-2 isolate-as-unit.
// ---------------------------------------------------------------------------

describe('isolate-as-unit: collapsed groups isolate to their members', () => {
  it('isolateSelection with a selected collapsed group hard-scopes to memberIds, renders the super-node as a unit, and reset restores', async () => {
    const { instance, engine } = await readyFixture();
    instance.applyHostUpdate({ groups: [GROUP_BC] });
    instance.selectNodes(['a']);
    instance.selectGroups(['g']);

    instance.isolateSelection();
    // Scope resolved to {a} ∪ members{b,c}: physical [a] + the super-node.
    expect(instance.store.getState().scope).toEqual({ seedIds: ['a', 'b', 'c'] });
    expect(instance.getSceneNodeIds()).toEqual(['a']);
    const commit = engine.lastCommit!;
    expect(commit.structure!.pointCount).toBe(2);
    // ONE meta-edge a→G (underlying a→b, a→c); nothing dangles out of scope.
    expect(Array.from(commit.structure!.links)).toEqual([0, 1]);

    instance.resetIsolation();
    expect(instance.getSceneNodeIds()).toEqual(['a', 'd', 'e']); // still collapsed
    expect(engine.lastCommit!.structure!.pointCount).toBe(4);
  });

  it('SubgraphSpec.seedIds naming a collapsed group id resolve to its memberIds during scope resolution; the stored spec keeps the group id', async () => {
    const { instance, engine } = await readyFixture();
    instance.applyHostUpdate({ groups: [GROUP_BC] });

    instance.applyHostUpdate({ subgraph: { seedIds: ['g'] } });
    // Scope = members {b,c}; every physical node is a member → the scene is
    // the super-node alone; the internal b→c edge dropped (no dangling).
    expect(instance.getSceneNodeIds()).toEqual([]);
    const commit = engine.lastCommit!;
    expect(commit.structure!.pointCount).toBe(1);
    expect(commit.structure!.links.length).toBe(0);
    expect(instance.store.getState().scope).toEqual({ seedIds: ['g'] }); // unexpanded spec

    instance.applyHostUpdate({ subgraph: null });
    expect(instance.getSceneNodeIds()).toEqual(['a', 'd', 'e']);
  });

  it('on a node/group id collision the NODE namespace wins for raw seedIds', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    h.instance.applyHostUpdate({ data: snap(1, ['g1', 'x', 'y'], [['g1', 'x']]) });
    h.instance.applyHostUpdate({
      groups: [{ id: 'g1', memberIds: ['x', 'y'], collapsed: true }],
    });

    h.instance.applyHostUpdate({ subgraph: { seedIds: ['g1'] } });
    // The seed resolved to the NODE g1 — members x,y stay out of scope, so
    // no rewrite materializes and the scene is the single physical node.
    expect(h.instance.getSceneNodeIds()).toEqual(['g1']);
    expect(h.engines[0]!.lastCommit!.structure!.pointCount).toBe(1);
  });

  it('an uncollapsed selected group still isolates to its members (documented isolate rule)', async () => {
    const { instance } = await readyFixture();
    instance.applyHostUpdate({ groups: [{ id: 'g', memberIds: ['b', 'c'] }] });
    instance.selectGroups(['g']);
    instance.isolateSelection();
    expect(instance.store.getState().scope).toEqual({ seedIds: ['b', 'c'] });
    expect(instance.getSceneNodeIds()).toEqual(['b', 'c']);
  });
});
