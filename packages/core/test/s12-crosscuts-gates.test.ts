/**
 * Cross-cut gate cases — three obligations that become testable once group
 * rewrites are live:
 *
 * 1. COLLAPSE case: selected
 * members of a collapsed group survive in SelectionState as temporarily
 * non-visible entries and re-highlight when the group expands.
 * 2. domain freeze: inferred scale domains stay
 * frozen across group collapse/expand within a dataset revision — a
 * collapse is not a new dataset revision, so what a color MEANS cannot
 * change underneath the viewer.
 * 3. Meta-entity pass rules with live group rewrites (completes
 * the synthetic-fixture assertion): a super-node passes iff ANY member
 * passes, a meta-edge iff ANY underlying edge passes — asserted here
 * through the BRUSH lane and brush∩hidden composition, which the
 * existing unit covers only for the filter and hiddenNodeIds lanes.
 */

import { describe, expect, it } from 'vitest';

import { createGraphInstance } from '../src/instance';
import type { GraphInstance } from '../src/instance';
import { FakeEngine } from '../src/testing/index';
import type {
  CrossfilterSession,
  DimensionSpec,
  GraphSnapshot,
  GroupSpec,
  Scale,
} from '../src/types';

const container = {} as unknown as HTMLElement;

// ---------------------------------------------------------------------------
// 1. Selection survival across collapse/expand.
// ---------------------------------------------------------------------------

type SelNA = Record<string, never>;
type SelEA = Record<string, never>;

/** a—b—c—d with b,c grouped: collapsing G leaves physical [a, d]. */
function selectionSnapshot(): GraphSnapshot<SelNA, SelEA> {
  return {
    datasetKey: 'sel',
    sourceRevision: 1,
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    edges: [
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'bc', source: 'b', target: 'c' },
      { id: 'cd', source: 'c', target: 'd' },
    ],
  };
}

const SEL_GROUP: GroupSpec = { id: 'G', memberIds: ['b', 'c'], collapsed: false };

async function selectionRig(): Promise<{
  instance: GraphInstance<SelNA, SelEA>;
  engine: FakeEngine;
}> {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance<SelNA, SelEA>({
    engine: () => {
      const e = new FakeEngine();
      engines.push(e);
      return e;
    },
    fitViewOnFirstData: false,
  });
  await instance.attach(container);
  instance.applyHostUpdate({ data: selectionSnapshot(), nodeColor: 'red', linkColor: 'blue' });
  instance.groupNodes(SEL_GROUP);
  return { instance, engine: engines[0]! };
}

/** The highlight the engine currently holds, sorted (null → []). */
function highlighted(engine: FakeEngine): readonly number[] {
  const indices = engine.selectedIndices;
  return indices === null ? [] : [...indices].sort((x, y) => x - y);
}

describe('collapse case — selected members survive as temporarily non-visible', () => {
  it('collapsing a group keeps its selected members in SelectionState and off the highlight, then re-highlights them on expand', async () => {
    const { instance, engine } = await selectionRig();
    instance.selectNodes(['a', 'b', 'c']);
    const slotsBefore = instance.getSceneNodeIds();
    expect(slotsBefore).toEqual(['a', 'b', 'c', 'd']);
    expect(highlighted(engine)).toEqual([0, 1, 2]);

    instance.setGroupCollapsed('G', true);

    // SURVIVAL: the ids are still selected — collapse is a view operation,
    // not a selection mutation.
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'b', 'c']);
    // TEMPORARILY NON-VISIBLE: no scene slot at all while collapsed.
    expect(instance.getSceneNodeIds()).toEqual(['a', 'd']);
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'd']);
    // The engine highlight carries only resolvable slots — never a dead slot,
    // and never the super-node (the group id was not selected).
    expect(highlighted(engine)).toEqual([0]);
    const pointCount = engine.lastCommit!.structure!.pointCount;
    for (const idx of highlighted(engine)) expect(idx).toBeLessThan(pointCount);

    // RE-HIGHLIGHT ON EXPAND: the same ids light up again, no re-selection.
    instance.setGroupCollapsed('G', false);
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'b', 'c']);
    expect(instance.getSceneNodeIds()).toEqual(['a', 'b', 'c', 'd']);
    expect(highlighted(engine)).toEqual([0, 1, 2]);
  });

  it('selecting the GROUP id highlights the super-node slot and survives the expand back into member-less form', async () => {
    const { instance, engine } = await selectionRig();
    instance.setGroupCollapsed('G', true);
    instance.selectNodes(['a']);
    instance.selectGroups(['G']);

    // Physical 'a' at slot 0 plus the super-node at the suffix slot.
    const physical = instance.getSceneNodeIds().length;
    expect(highlighted(engine)).toEqual([0, physical]);
    expect(instance.store.getState().selection.groupIds).toEqual(['G']);

    instance.setGroupCollapsed('G', false);
    // The group id stays selected (the definition still exists) but there is
    // no super-node slot to highlight any more.
    expect(instance.store.getState().selection.groupIds).toEqual(['G']);
    expect(highlighted(engine)).toEqual([0]);
  });

  it('a selected member that is ALSO mask-hidden survives both lanes and returns on expand', async () => {
    const { instance, engine } = await selectionRig();
    instance.selectNodes(['b', 'c']);
    instance.hideNodes(['b']);
    expect(instance.store.getState().selection.nodeIds).toEqual(['b', 'c']);

    instance.setGroupCollapsed('G', true);
    expect(instance.store.getState().selection.nodeIds).toEqual(['b', 'c']);
    expect(instance.store.getState().hiddenNodeIds).toEqual(new Set(['b']));
    expect(highlighted(engine)).toEqual([]);

    instance.setGroupCollapsed('G', false);
    expect(instance.store.getState().selection.nodeIds).toEqual(['b', 'c']);
    // Both are selected again; 'b' is still mask-hidden but stays highlighted
    // (selection survival — the engine greys it out, core does not drop
    // it from the push).
    const scene = instance.getSceneNodeIds();
    expect(highlighted(engine)).toEqual([scene.indexOf('b'), scene.indexOf('c')].sort((x, y) => x - y));
  });
});

// ---------------------------------------------------------------------------
// 2. Domain freeze across collapse/expand.
// ---------------------------------------------------------------------------

type DomNA = Record<string, never>;
type DomEA = Record<string, never>;

/** hub with degree 5, five leaves with degree 1, and an isolated node with
 * degree 0. Grouping {hub, iso} makes a collapse REMOVE both extremes from
 * the physical scene, so any recomputation would visibly shrink the domain. */
function degreeSnapshot(): GraphSnapshot<DomNA, DomEA> {
  const leaves = ['l0', 'l1', 'l2', 'l3', 'l4'];
  return {
    datasetKey: 'dom',
    sourceRevision: 1,
    nodes: [{ id: 'hub' }, ...leaves.map((id) => ({ id })), { id: 'iso' }],
    edges: leaves.map((id) => ({ id: `hub-${id}`, source: 'hub', target: id })),
  };
}

const DEGREE_GROUP: GroupSpec = { id: 'GD', memberIds: ['hub', 'iso'], collapsed: false };

async function domainRig(scale: Scale<string, DomNA>): Promise<{
  instance: GraphInstance<DomNA, DomEA>;
  engine: FakeEngine;
}> {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance<DomNA, DomEA>({
    engine: () => {
      const e = new FakeEngine();
      engines.push(e);
      return e;
    },
    fitViewOnFirstData: false,
  });
  await instance.attach(container);
  instance.applyHostUpdate({ data: degreeSnapshot(), nodeColor: scale, linkColor: 'blue' });
  instance.groupNodes(DEGREE_GROUP);
  return { instance, engine: engines[0]! };
}

/** RGBA of a physical node id from the latest committed pointColor buffer. */
function colorOf(
  engine: FakeEngine,
  instance: GraphInstance<DomNA, DomEA>,
  id: string,
): readonly number[] {
  const idx = instance.getSceneNodeIds().indexOf(id);
  expect(idx).toBeGreaterThanOrEqual(0);
  const buf = engine.lastBuffer('pointColor');
  if (buf === undefined) throw new Error('no pointColor buffer committed');
  return [buf[4 * idx]!, buf[4 * idx + 1]!, buf[4 * idx + 2]!, buf[4 * idx + 3]!];
}

describe('gate: inferred scale domains stay FROZEN across group collapse/expand', () => {
  const SEQUENTIAL: Scale<string, DomNA> = {
    kind: 'sequential',
    metric: 'degree',
    range: ['#000000', '#ffffff'],
  };

  it("default ('dataset') domain and the projected colors are identical before, during and after a collapse", async () => {
    const { instance, engine } = await domainRig(SEQUENTIAL);
    const before = instance.getScaleInfo('nodeColor')!.domain;
    expect(before).toEqual([0, 5]);
    const leafBefore = colorOf(engine, instance, 'l0');

    instance.setGroupCollapsed('GD', true);
    expect(instance.getScaleInfo('nodeColor')!.domain).toEqual(before);
    expect(colorOf(engine, instance, 'l0')).toEqual(leafBefore);

    instance.setGroupCollapsed('GD', false);
    expect(instance.getScaleInfo('nodeColor')!.domain).toEqual(before);
    expect(colorOf(engine, instance, 'l0')).toEqual(leafBefore);
    expect(instance.getRevisions().model).toBe(1); // one dataset revision throughout
  });

  it("a 'hard-scope' domain stays frozen too: collapsing away BOTH extremes does not shrink it", async () => {
    const { instance, engine } = await domainRig({
      kind: 'sequential',
      metric: 'degree',
      range: ['#000000', '#ffffff'],
      domain: { scope: 'hard-scope' },
    });
    const before = instance.getScaleInfo('nodeColor')!.domain;
    expect(before).toEqual([0, 5]); // iso=0 … hub=5
    const leafBefore = colorOf(engine, instance, 'l0');

    instance.setGroupCollapsed('GD', true);
    // Physically only the five degree-1 leaves remain; a recomputation would
    // give [1,1] and repaint every leaf. The freeze coordinate is the DATASET
    // revision, and a collapse is not one.
    expect(instance.getSceneNodeIds()).toEqual(['l0', 'l1', 'l2', 'l3', 'l4']);
    expect(instance.getScaleInfo('nodeColor')!.domain).toEqual([0, 5]);
    expect(colorOf(engine, instance, 'l0')).toEqual(leafBefore);

    instance.setGroupCollapsed('GD', false);
    expect(instance.getScaleInfo('nodeColor')!.domain).toEqual([0, 5]);
    expect(colorOf(engine, instance, 'l0')).toEqual(leafBefore);
  });

  it('a new dataset revision DOES re-infer — the freeze is per-revision, not permanent', async () => {
    const { instance } = await domainRig(SEQUENTIAL);
    expect(instance.getScaleInfo('nodeColor')!.domain).toEqual([0, 5]);
    instance.applyHostUpdate({
      data: {
        datasetKey: 'dom',
        sourceRevision: 2,
        nodes: [{ id: 'hub' }, { id: 'l0' }, { id: 'l1' }],
        edges: [
          { id: 'hub-l0', source: 'hub', target: 'l0' },
          { id: 'hub-l1', source: 'hub', target: 'l1' },
        ],
      },
    });
    expect(instance.getScaleInfo('nodeColor')!.domain).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// 3. Stage-5 meta-entity pass rules under the brush lane.
// ---------------------------------------------------------------------------

type MaskNA = { v: number };
type MaskEA = Record<string, never>;

/**
 * o1→m1, o1→m2, m1→m2 (internal), m1→o2, o2→o3, with G={m1,m2} collapsed.
 * Post-rewrite scene: points [o1, o2, o3, G@3]; links [o2→o3 @0,
 * meta(o1→G) @1 (underlying o1→m1, o1→m2), meta(G→o2) @2 (underlying m1→o2)].
 */
function maskSnapshot(): GraphSnapshot<MaskNA, MaskEA> {
  return {
    datasetKey: 'mask',
    sourceRevision: 1,
    nodes: [
      { id: 'o1', attrs: { v: 10 } },
      { id: 'm1', attrs: { v: 1 } },
      { id: 'm2', attrs: { v: 2 } },
      { id: 'o2', attrs: { v: 20 } },
      { id: 'o3', attrs: { v: 30 } },
    ],
    edges: [
      { id: 'o1-m1', source: 'o1', target: 'm1' },
      { id: 'o1-m2', source: 'o1', target: 'm2' },
      { id: 'm1-m2', source: 'm1', target: 'm2' },
      { id: 'm1-o2', source: 'm1', target: 'o2' },
      { id: 'o2-o3', source: 'o2', target: 'o3' },
    ],
  };
}

const V_DIM: DimensionSpec<MaskNA> = { key: 'v', kind: 'numeric', get: (n) => n.attrs?.v };
const MASK_GROUP: GroupSpec = { id: 'G', memberIds: ['m1', 'm2'], collapsed: true };

const SUPER_SLOT = 3;
const META_TO_GROUP = 1; // o1 → G, underlying {o1-m1, o1-m2}
const META_FROM_GROUP = 2; // G → o2, underlying {m1-o2}

async function maskRig(): Promise<{
  instance: GraphInstance<MaskNA, MaskEA>;
  engine: FakeEngine;
  session: CrossfilterSession;
}> {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance<MaskNA, MaskEA>({
    engine: () => {
      const e = new FakeEngine();
      engines.push(e);
      return e;
    },
    fitViewOnFirstData: false,
  });
  await instance.attach(container);
  instance.applyHostUpdate({
    data: maskSnapshot(),
    nodeColor: 'red',
    linkColor: 'blue',
    crossfilter: [V_DIM],
  });
  instance.groupNodes(MASK_GROUP);
  return { instance, engine: engines[0]!, session: instance.getCrossfilterSession()! };
}

/**
 * Slot alphas of the latest committed buffer for `channel`.
 *
 * A meta-edge's UNMASKED alpha is the theme `edgeDefault` alpha (0.15 in
 * the dark base), NOT 1: synthetics are styled through the aggregate channels,
 * never the caller's `linkColor`. Mask composition is
 * multiplicative (`composeEdgeAlphaBuffer`), so "passes" means "equals the
 * unmasked baseline" (a dim would be baseline x mutedAlpha) — comparing
 * against the captured baseline keeps these rule assertions theme-independent.
 */
function alphasOf(engine: FakeEngine, channel: 'pointColor' | 'linkColor'): readonly number[] {
  const buf = engine.lastBuffer(channel);
  if (buf === undefined) throw new Error(`no ${channel} buffer committed`);
  const out: number[] = [];
  for (let i = 3; i < buf.length; i += 4) out.push(buf[i]!);
  return out;
}

const alphaAt = (engine: FakeEngine, channel: 'pointColor' | 'linkColor', i: number): number =>
  alphasOf(engine, channel)[i]!;

describe('gate: stage-5 pass rules with LIVE stage-3 groups (brush lane)', () => {
  it('the collapsed fixture lays out exactly as the rule expects (scene shape precondition)', async () => {
    const { instance, engine } = await maskRig();
    expect(instance.getSceneNodeIds()).toEqual(['o1', 'o2', 'o3']);
    const structure = engine.lastCommit!.structure!;
    expect(structure.pointCount).toBe(4); // 3 physical + 1 super-node
    expect(Array.from(structure.links)).toEqual([1, 2, 0, SUPER_SLOT, SUPER_SLOT, 1]);

    // Unmasked baseline: physical rows carry the caller's opaque linkColor,
    // synthetics the theme's aggregate edge token.
    const links = alphasOf(engine, 'linkColor');
    expect(links[0]).toBe(1);
    expect(links[META_TO_GROUP]).toBeGreaterThan(0);
    expect(links[META_TO_GROUP]).toBe(links[META_FROM_GROUP]);
    expect(alphaAt(engine, 'pointColor', SUPER_SLOT)).toBe(1);
  });

  it('super-node passes iff ANY member passes the brush; meta-edge iff ANY underlying edge passes', async () => {
    const { instance, engine, session } = await maskRig();
    const base = alphasOf(engine, 'linkColor');
    const metaPass = base[META_TO_GROUP]!;

    // Brush [2,30]: m1 (v=1) fails, m2 (v=2) passes, o1/o2/o3 pass.
    await session.setBrush('v', { min: 2, max: 30 });
    expect(alphaAt(engine, 'pointColor', SUPER_SLOT)).toBe(1); // ANY member passes
    // meta(o1->G): underlying o1-m2 survives => passes.
    expect(alphaAt(engine, 'linkColor', META_TO_GROUP)).toBe(metaPass);
    // meta(G->o2): its ONLY underlying edge is m1-o2 => no survivor => hidden.
    expect(alphaAt(engine, 'linkColor', META_FROM_GROUP)).toBe(0);
    expect(alphaAt(engine, 'linkColor', 0)).toBe(1); // physical o2->o3 untouched
    // NOTE: `visible` counts SCENE entities, synthetics included (o1, o2, o3
    // and the super-node = 4; physical o2-o3 plus the surviving meta-edge =
    // 2), whereas getVisibleNodeIds() is physical-only by the rule — the
    // two therefore differ by the super-node count while a rewrite is live.
    expect(instance.store.getState().visible).toEqual({ nodes: 4, edges: 2 });
    expect(instance.getVisibleNodeIds()).toEqual(['o1', 'o2', 'o3']);

    // Brush [10,30]: BOTH members fail => the super-node hides and every
    // meta-edge loses its last underlying survivor.
    await session.setBrush('v', { min: 10, max: 30 });
    expect(alphaAt(engine, 'pointColor', SUPER_SLOT)).toBe(0);
    expect(alphaAt(engine, 'linkColor', META_TO_GROUP)).toBe(0);
    expect(alphaAt(engine, 'linkColor', META_FROM_GROUP)).toBe(0);
    expect(alphaAt(engine, 'linkColor', 0)).toBe(1);

    // Clearing restores every synthetic slot to its exact baseline.
    await session.setBrush('v', null);
    expect(alphaAt(engine, 'pointColor', SUPER_SLOT)).toBe(1);
    expect(alphasOf(engine, 'linkColor')).toEqual(base);
  });

  it('brush and hiddenNodeIds compose jointly per member: neither lane alone hides the super-node, both together do', async () => {
    const { instance, engine, session } = await maskRig();
    const metaPass = alphasOf(engine, 'linkColor')[META_TO_GROUP]!;

    instance.hideNodes(['m2']); // one member down via the hidden lane
    expect(alphaAt(engine, 'pointColor', SUPER_SLOT)).toBe(1);
    // meta(o1->G): o1-m1 still passes; meta(G->o2) untouched.
    expect(alphaAt(engine, 'linkColor', META_TO_GROUP)).toBe(metaPass);
    expect(alphaAt(engine, 'linkColor', META_FROM_GROUP)).toBe(metaPass);

    await session.setBrush('v', { min: 2, max: 30 }); // and m1 down via brush
    expect(alphaAt(engine, 'pointColor', SUPER_SLOT)).toBe(0);
    expect(alphaAt(engine, 'linkColor', META_TO_GROUP)).toBe(0);
    expect(alphaAt(engine, 'linkColor', META_FROM_GROUP)).toBe(0);

    instance.showNodes(['m2']); // m2 back => the super-node returns
    expect(alphaAt(engine, 'pointColor', SUPER_SLOT)).toBe(1);
    expect(alphaAt(engine, 'linkColor', META_TO_GROUP)).toBe(metaPass);
    expect(alphaAt(engine, 'linkColor', META_FROM_GROUP)).toBe(0); // m1 still brushed out
  });

  it('a hidden PHYSICAL endpoint hides the meta-edge regardless of member state (edge survival rule)', async () => {
    const { instance, engine } = await maskRig();
    const metaPass = alphasOf(engine, 'linkColor')[META_TO_GROUP]!;
    instance.hideNodes(['o1']); // the meta-edge's physical endpoint
    expect(alphaAt(engine, 'pointColor', SUPER_SLOT)).toBe(1); // members untouched
    expect(alphaAt(engine, 'linkColor', META_TO_GROUP)).toBe(0);
    expect(alphaAt(engine, 'linkColor', META_FROM_GROUP)).toBe(metaPass);
  });

  it("a 'dim'-mode filter dims a super-node only when NO member is undimmed", async () => {
    const { instance, engine } = await maskRig();
    const mutedAlpha = instance.store.getState().theme.mutedAlpha;

    // Dim everything below v=2: m1 dims, m2 does not => the super-node has an
    // undimmed member and stays at full alpha.
    instance.applyHostUpdate({ filter: { nodes: (n) => (n.attrs?.v ?? 0) >= 2, mode: 'dim' } });
    expect(alphaAt(engine, 'pointColor', SUPER_SLOT)).toBe(1);

    // Dim both members => the super-node dims (never hides: dim is not hide).
    instance.applyHostUpdate({ filter: { nodes: (n) => (n.attrs?.v ?? 0) >= 10, mode: 'dim' } });
    expect(alphaAt(engine, 'pointColor', SUPER_SLOT)).toBeCloseTo(mutedAlpha, 6);
  });
});
