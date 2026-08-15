/**
 * stage-3 group rewrite.
 *
 * Covers: acyclic/singly-parented validation (five violation fixtures, each ONE
 * 'config-error' diagnostic and ZERO engine commits), the collapsed-group
 * super-node/meta-edge rewrite feeding the structural diff (collapse ↔
 * expand as a diff with cached positions, never a reload — asserted against
 * FakeEngine commit logs vs a full-reload baseline), the accessor
 * isolation with dedicated aggregate style channels, the stage-5
 * meta-entity mask rules, the stage ordering (scope → groups), and the
 * distinct group-id namespace.
 */

import { describe, expect, it, vi } from 'vitest';

import { GRAPH_THEME_DARK } from '../src/instance';
import type { GraphInstance } from '../src/instance';
import {
  buildRepForest,
  groupSceneKey,
  metaEdgePublicId,
  metaEdgeSceneKey,
  metaEdgeWidthFor,
  rewriteGroups,
  sceneGroupsOf,
  sceneLinkRefAt,
  scenePointRefAt,
  superNodeSizeFor,
  validateGroupSpecs,
} from '../src/groups';
import { parseColor } from '../src/projection';
import { validateSnapshot } from '../src/validate';
import type { FakeEngine } from '../src/testing/index';
import type { GraphDiagnostic, GraphSnapshot, GroupSpec, RenderScene } from '../src/types';
import { container, makeInstance, snap } from './helpers';
import type { EAttrs, NAttrs } from './helpers';

type Instance = GraphInstance<NAttrs, EAttrs>;

/**
 * a—b—c—d—e with a second a→c edge: collapsing {b,c} reroutes a→b and a→c
 * into ONE meta-edge (count 2), c→d into another (count 1), drops the
 * internal b→c, and keeps d→e physical.
 */
const FIXTURE_IDS = ['a', 'b', 'c', 'd', 'e'] as const;
const FIXTURE_LINKS: ReadonlyArray<readonly [string, string]> = [
  ['a', 'b'],
  ['a', 'c'],
  ['b', 'c'],
  ['c', 'd'],
  ['d', 'e'],
];
const GROUP_BC: GroupSpec = {
  id: 'g',
  memberIds: ['b', 'c'],
  collapsed: true,
  color: '#ff0000',
};

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

const ACCENT_RGBA = parseColor(GRAPH_THEME_DARK.accent)!;
const EDGE_DEFAULT_RGBA = parseColor(GRAPH_THEME_DARK.edgeDefault)!;

// ---------------------------------------------------------------------------
// Validation — five violation fixtures, each ONE diagnostic, ZERO commits.
// ---------------------------------------------------------------------------

describe('group validation: acyclic/singly-parented violations reject before any rewrite', () => {
  const VIOLATIONS: ReadonlyArray<{ name: string; groups: readonly GroupSpec[] }> = [
    { name: 'duplicate membership', groups: [{ id: 'g', memberIds: ['b', 'b'] }] },
    { name: 'self-membership', groups: [{ id: 'g', memberIds: ['g'] }] },
    { name: 'unknown member', groups: [{ id: 'g', memberIds: ['nope'] }] },
    {
      // Nesting is LEGAL; a nesting CYCLE is not — containment is a forest.
      name: 'cyclic nesting',
      groups: [
        { id: 'g1', memberIds: ['g2'] },
        { id: 'g2', memberIds: ['g1'] },
      ],
    },
    {
      name: 'overlapping groups',
      groups: [
        { id: 'g1', memberIds: ['b'] },
        { id: 'g2', memberIds: ['b', 'c'] },
      ],
    },
  ];

  for (const fixture of VIOLATIONS) {
    it(`${fixture.name}: exactly one config-error diagnostic and zero commits`, async () => {
      const { instance, engine } = await readyFixture();
      const commitsBefore = engine.commits.length;
      const groupsBefore = instance.store.getState().groups;
      const revisionsBefore = instance.getRevisions();

      instance.applyHostUpdate({ groups: fixture.groups });

      const errs = configErrors(instance);
      expect(errs).toHaveLength(1);
      expect(errs[0]!.severity).toBe('error');
      expect(errs[0]!.count).toBeGreaterThanOrEqual(1);
      // A violating array changes NOTHING: no engine commit, no scene
      // mutation, no store.groups change, no revision movement.
      expect(engine.commits.length).toBe(commitsBefore);
      expect(instance.store.getState().groups).toBe(groupsBefore);
      expect(instance.getRevisions()).toEqual(revisionsBefore);
      expect(instance.getSceneNodeIds()).toEqual([...FIXTURE_IDS]);
    });
  }

  it('a subsequently valid array clears the config-error and applies', async () => {
    const { instance, engine } = await readyFixture();
    instance.applyHostUpdate({ groups: [{ id: 'g', memberIds: ['b', 'b'] }] });
    expect(configErrors(instance)).toHaveLength(1);

    const commitsBefore = engine.commits.length;
    instance.applyHostUpdate({ groups: [GROUP_BC] });
    expect(configErrors(instance)).toHaveLength(0);
    expect(instance.store.getState().groups.map((g) => g.id)).toEqual(['g']);
    expect(engine.commits.length).toBe(commitsBefore + 1);
  });

  it('members outside the current hard scope are NOT unknown (validated against the full model)', async () => {
    const { instance } = await readyFixture();
    instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'b'] } });
    instance.applyHostUpdate({ groups: [GROUP_BC] }); // c is out of scope, still known
    expect(configErrors(instance)).toHaveLength(0);
    expect(instance.store.getState().groups[0]!.memberIds).toEqual(['b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// Stage-3 rewrite: super-nodes, meta-edge rerouting, structural diff.
// ---------------------------------------------------------------------------

describe('stage-3 rewrite: collapsed groups become super-nodes with meta-edges', () => {
  it('rewrites the scene: members leave, one super-node enters, meta-edges reroute with counts', async () => {
    const { instance, engine } = await readyFixture();
    const commitsBefore = engine.commits.length;

    instance.applyHostUpdate({ groups: [GROUP_BC] });

    // E1: one commit for the whole collapse.
    expect(engine.commits.length).toBe(commitsBefore + 1);
    const commit = engine.lastCommit!;
    expect(commit.structure).toBeDefined();
    // Physical a,d,e + 1 super-node.
    expect(commit.structure!.pointCount).toBe(4);
    // Physical prefix ordering: [a, d, e], super at slot 3. Links: kept d→e
    // first, then meta a→G (count 2) and meta G→d (count 1).
    expect(Array.from(commit.structure!.links)).toEqual([1, 2, 0, 3, 3, 1]);
    expect(instance.getSceneNodeIds()).toEqual(['a', 'd', 'e']);

    // store.groups publishes the resolution in the SAME publication.
    expect(instance.store.getState().groups).toEqual([
      { id: 'g', memberIds: ['b', 'c'], collapsed: true, derived: false, color: '#ff0000' },
    ]);

    // Aggregate meta-edge width channel carries the badge datum.
    const widths = Array.from(commit.buffers!.linkWidth!);
    expect(widths).toEqual([1, Math.fround(metaEdgeWidthFor(2)), Math.fround(metaEdgeWidthFor(1))]);
  });

  it('a scope-driven publication: collapse advances scope, never model', async () => {
    const { instance } = await readyFixture();
    const before = instance.getRevisions();
    instance.applyHostUpdate({ groups: [GROUP_BC] });
    const after = instance.getRevisions();
    expect(after.model).toBe(before.model);
    expect(after.scope).toBe(before.scope + 1);
    expect(after.render).toBe(before.render + 1);
  });

  it('uncollapsed groups exist in store.groups only — zero commits, zero scene change', async () => {
    const { instance, engine } = await readyFixture();
    const commitsBefore = engine.commits.length;
    const revisionsBefore = instance.getRevisions();

    instance.applyHostUpdate({ groups: [{ id: 'g', memberIds: ['b', 'c'] }] });

    expect(engine.commits.length).toBe(commitsBefore);
    expect(instance.getRevisions()).toEqual(revisionsBefore);
    expect(instance.getSceneNodeIds()).toEqual([...FIXTURE_IDS]);
    expect(instance.store.getState().groups).toEqual([
      { id: 'g', memberIds: ['b', 'c'], collapsed: false, derived: false },
    ]);
  });

  it('groups: null clears — members return as a diff at their cached positions', async () => {
    const { instance, engine } = await readyFixture();
    const b0 = posOf(engine, instance, 'b');
    const c0 = posOf(engine, instance, 'c');

    instance.applyHostUpdate({ groups: [GROUP_BC] });
    const commitsAfterCollapse = engine.commits.length;
    instance.applyHostUpdate({ groups: null });

    expect(engine.commits.length).toBe(commitsAfterCollapse + 1);
    expect(instance.getSceneNodeIds()).toEqual([...FIXTURE_IDS]);
    expect(instance.store.getState().groups).toEqual([]);
    // Leave-and-return: members reappear where they were, never at origin.
    expect(posOf(engine, instance, 'b')).toEqual(b0);
    expect(posOf(engine, instance, 'c')).toEqual(c0);
  });

  it('stage ordering: the rewrite runs on the hard-scoped set — out-of-scope members never dangle', async () => {
    const { instance, engine } = await readyFixture();
    instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'b'] } }); // c,d,e out of scope
    instance.applyHostUpdate({ groups: [GROUP_BC] });

    const commit = engine.lastCommit!;
    // Scope {a,b} → b collapses → physical [a] + super; ONE meta a→G from
    // the surviving a→b edge; nothing references out-of-scope c.
    expect(commit.structure!.pointCount).toBe(2);
    expect(Array.from(commit.structure!.links)).toEqual([0, 1]);
    expect(instance.getSceneNodeIds()).toEqual(['a']);
    // Aggregate size reflects IN-SCOPE members only.
    expect(Array.from(commit.buffers!.pointSize!)).toEqual([4, superNodeSizeFor(1)]);
  });

  it('a group id equal to a node id coexists without collision (distinct namespaces)', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    h.instance.applyHostUpdate({
      data: snap(1, ['g1', 'x', 'y'], [['g1', 'x']]),
    });
    const engine = h.engines[0]!;

    h.instance.applyHostUpdate({
      groups: [{ id: 'g1', memberIds: ['x', 'y'], collapsed: true }],
    });
    expect(configErrors(h.instance)).toHaveLength(0);
    const commit = engine.lastCommit!;
    // Node g1 stays physical; the super-node occupies its own scene slot.
    expect(commit.structure!.pointCount).toBe(2);
    expect(h.instance.getSceneNodeIds()).toEqual(['g1']);
    expect(h.instance.store.getState().groups[0]!.id).toBe('g1');
  });
});

// ---------------------------------------------------------------------------
// Collapse/expand at 1,000 members: a diff, never a reload.
// ---------------------------------------------------------------------------

describe('collapse/expand of a 1,000-member group is a structural diff, never a reload', () => {
  const MEMBERS = Array.from({ length: 1000 }, (_, i) => `m${i}`);
  const OTHERS = Array.from({ length: 500 }, (_, i) => `o${i}`);
  const INCIDENT = 100;

  function bigSnapshot(): GraphSnapshot<NAttrs, EAttrs> {
    const links: (readonly [string, string])[] = [];
    // Intra-member chain (drops entirely while collapsed).
    for (let i = 0; i < MEMBERS.length - 1; i++) links.push([MEMBERS[i]!, MEMBERS[i + 1]!]);
    // Incident edges: distinct outside endpoints → INCIDENT meta-edges.
    for (let j = 0; j < INCIDENT; j++) links.push([OTHERS[j]!, MEMBERS[2 * j]!]);
    // Outside chain (kept verbatim).
    for (let i = 0; i < OTHERS.length - 1; i++) links.push([OTHERS[i]!, OTHERS[i + 1]!]);
    return snap(1, [...MEMBERS, ...OTHERS], links);
  }

  it('commit deltas are O(members + incident edges) against a full-reload baseline', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    const engine = h.engines[0]!;
    h.instance.applyHostUpdate({ data: bigSnapshot() });

    const loadCommit = engine.lastCommit!;
    // Full-reload BASELINE: every slot needs seeding (NaN positions) — this
    // is what "re-ingestion" costs.
    const nanSlots = (positions: Float32Array): number => {
      let n = 0;
      for (let i = 0; i < positions.length; i += 2) {
        if (Number.isNaN(positions[i]!)) n++;
      }
      return n;
    };
    const baselineSeeded = nanSlots(loadCommit.structure!.positions);
    expect(baselineSeeded).toBe(MEMBERS.length + OTHERS.length);

    // Record every settled position before collapsing.
    const preIds = h.instance.getSceneNodeIds();
    const prePos = engine.getPositions()!;
    const preById = new Map(preIds.map((id, i) => [id, [prePos[2 * i]!, prePos[2 * i + 1]!]] as const));

    // --- Collapse: ONE commit; only the super-node needs seeding. ---
    const commitsBefore = engine.commits.length;
    h.instance.applyHostUpdate({
      groups: [{ id: 'community', memberIds: MEMBERS, collapsed: true }],
    });
    expect(engine.commits.length).toBe(commitsBefore + 1);
    const collapseCommit = engine.lastCommit!;
    expect(collapseCommit.structure!.pointCount).toBe(OTHERS.length + 1);
    // Roster delta: 1000 members left, 1 super-node entered; links shrink to
    // the outside chain + INCIDENT meta-edges.
    expect(collapseCommit.structure!.links.length / 2).toBe(OTHERS.length - 1 + INCIDENT);
    // O(delta) seeding: exactly the ONE new super-node — never a re-ingest
    // of the surviving 500 (baseline re-seeds all 1500).
    expect(nanSlots(collapseCommit.structure!.positions)).toBe(1);
    // Survivors keep byte-identical positions.
    const keptIds = h.instance.getSceneNodeIds();
    expect(keptIds).toEqual(OTHERS);
    for (let i = 0; i < keptIds.length; i++) {
      const expected = preById.get(keptIds[i]!)!;
      expect(collapseCommit.structure!.positions[2 * i]).toBe(expected[0]);
      expect(collapseCommit.structure!.positions[2 * i + 1]).toBe(expected[1]);
    }

    // --- Expand: ONE commit; every member returns at its cached position
    // ZERO re-seeding (a reload would re-seed all 1500). ---
    const commitsAfterCollapse = engine.commits.length;
    h.instance.applyHostUpdate({ groups: null });
    expect(engine.commits.length).toBe(commitsAfterCollapse + 1);
    const expandCommit = engine.lastCommit!;
    expect(expandCommit.structure!.pointCount).toBe(MEMBERS.length + OTHERS.length);
    expect(nanSlots(expandCommit.structure!.positions)).toBe(0);
    const restoredIds = h.instance.getSceneNodeIds();
    for (let i = 0; i < restoredIds.length; i++) {
      const expected = preById.get(restoredIds[i]!)!;
      expect(expandCommit.structure!.positions[2 * i]).toBe(expected[0]);
      expect(expandCommit.structure!.positions[2 * i + 1]).toBe(expected[1]);
    }

    // Neither direction touched the model revision.
    expect(h.instance.getRevisions().model).toBe(1);
  });

  it('collapse publishes exactly once (E1)', async () => {
    const { instance } = await readyFixture();
    let publishes = 0;
    const unsub = instance.store.subscribe(() => publishes++);
    instance.applyHostUpdate({ groups: [GROUP_BC] });
    unsub();
    expect(publishes).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// synthetics never reach caller accessors; aggregate channels.
// ---------------------------------------------------------------------------

describe('accessor isolation: synthetics use dedicated aggregate channels', () => {
  it('nodeColor/nodeSize/linkColor/linkWidth accessors are never invoked with synthetic items', async () => {
    const { instance } = await readyFixture();
    const seenNodeIds = new Set<string>();
    const seenEdgeIds = new Set<string>();
    const nodeColor = vi.fn((n: { id: string }) => {
      seenNodeIds.add(n.id);
      return '#00ff00';
    });
    const nodeSize = vi.fn((n: { id: string }) => {
      seenNodeIds.add(n.id);
      return 5;
    });
    const linkColor = vi.fn((e: { id: string }) => {
      seenEdgeIds.add(e.id);
      return '#0000ff';
    });
    const linkWidth = vi.fn((e: { id: string }) => {
      seenEdgeIds.add(e.id);
      return 2;
    });

    instance.applyHostUpdate({ nodeColor, nodeSize, linkColor, linkWidth });
    instance.applyHostUpdate({ groups: [GROUP_BC] });
    // A style-only re-projection while collapsed re-runs accessors over the
    // rewritten scene — still physical rows only.
    instance.applyHostUpdate({ nodeColor: (n: { id: string }) => nodeColor(n) });

    expect(nodeColor).toHaveBeenCalled();
    expect(linkWidth).toHaveBeenCalled();
    const physicalNodeIds = new Set<string>(FIXTURE_IDS);
    for (const id of seenNodeIds) {
      expect(physicalNodeIds.has(id)).toBe(true);
      expect(id.startsWith('\u0000')).toBe(false);
    }
    for (const id of seenEdgeIds) {
      expect(id.startsWith('\u0000')).toBe(false);
      expect(id.includes('meta-edge')).toBe(false);
    }
  });

  it('aggregate channels: group color, member-count size, count-driven meta width', async () => {
    const { instance, engine } = await readyFixture();
    instance.applyHostUpdate({
      nodeColor: () => '#00ff00',
      nodeSize: () => 5,
      linkWidth: () => 2,
    });
    instance.applyHostUpdate({ groups: [GROUP_BC] });

    const buffers = engine.lastCommit!.buffers!;
    // Super-node slot 3: GroupSpec.color wins.
    expect(Array.from(buffers.pointColor!.slice(12, 16))).toEqual([1, 0, 0, 1]);
    // Member-count aggregate size at the super slot; physical keep theirs.
    expect(Array.from(buffers.pointSize!)).toEqual([5, 5, 5, Math.fround(superNodeSizeFor(2))]);
    // Meta-edge width from the underlying count (slots 1 and 2).
    expect(Array.from(buffers.linkWidth!)).toEqual([
      2,
      Math.fround(metaEdgeWidthFor(2)),
      Math.fround(metaEdgeWidthFor(1)),
    ]);
  });

  it('without GroupSpec.color the super-node renders the theme accent', async () => {
    const { instance, engine } = await readyFixture();
    instance.applyHostUpdate({
      groups: [{ id: 'g', memberIds: ['b', 'c'], collapsed: true }],
    });
    const buffers = engine.lastCommit!.buffers!;
    const superRgba = Array.from(buffers.pointColor!.slice(12, 16));
    expect(superRgba[0]).toBeCloseTo(ACCENT_RGBA[0], 5);
    expect(superRgba[1]).toBeCloseTo(ACCENT_RGBA[1], 5);
    expect(superRgba[2]).toBeCloseTo(ACCENT_RGBA[2], 5);
    // Meta-edges take the theme edge default through the aggregate lane.
    const metaRgba = Array.from(buffers.linkColor?.slice(4, 8) ?? []);
    if (metaRgba.length === 4) {
      expect(metaRgba[3]).toBeCloseTo(EDGE_DEFAULT_RGBA[3], 5);
    }
  });

  it('label accessors never see synthetic rows and scene keys never reach placements', async () => {
    const { instance, engine } = await readyFixture();
    const seen = new Set<string>();
    const getText = vi.fn((n: { id: string }) => {
      seen.add(n.id);
      return n.id.toUpperCase();
    });
    const placements: string[][] = [];
    instance.labels.subscribeCandidates((list) => placements.push(list.map((p) => p.id)));
    instance.applyHostUpdate({ labels: { enabled: true, minZoom: 0, getText } });
    instance.applyHostUpdate({ groups: [GROUP_BC] });
    engine.injectSimulationEnd();

    for (const id of seen) expect(id.startsWith('\u0000')).toBe(false);
    for (const list of placements) {
      for (const id of list) expect(id.startsWith('\u0000')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Stage-5 meta-entity mask rules.
// ---------------------------------------------------------------------------

describe('stage-5 meta-entity mask: any-member / any-underlying pass rules', () => {
  const alphaAt = (buf: Float32Array, slot: number): number => buf[4 * slot + 3]!;

  it('a filter matching a single member keeps the collapsed super-node visible', async () => {
    const { instance, engine } = await readyFixture();
    instance.applyHostUpdate({ groups: [GROUP_BC] });

    // Only member b passes; every physical node fails.
    instance.applyHostUpdate({
      filter: { nodes: { op: 'eq', field: 'label', value: 'B' } },
    });
    const colors = engine.lastCommit!.buffers!.pointColor!;
    expect(alphaAt(colors, 0)).toBe(0); // a
    expect(alphaAt(colors, 1)).toBe(0); // d
    expect(alphaAt(colors, 2)).toBe(0); // e
    expect(alphaAt(colors, 3)).toBeGreaterThan(0); // super: b passes
    expect(instance.store.getState().visible.nodes).toBe(1);
  });

  it('a filter matching no member hides the super-node', async () => {
    const { instance, engine } = await readyFixture();
    instance.applyHostUpdate({ groups: [GROUP_BC] });
    instance.applyHostUpdate({
      filter: { nodes: { op: 'eq', field: 'label', value: 'NOPE' } },
    });
    const colors = engine.lastCommit!.buffers!.pointColor!;
    expect(alphaAt(colors, 3)).toBe(0);
    expect(instance.store.getState().visible.nodes).toBe(0);
  });

  it('a meta-edge stays visible iff ANY underlying edge passes the edge filter', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    const engine = h.engines[0]!;
    // Distinct edge weights: a→b weighs 1, a→c weighs 2, c→d weighs 2.
    h.instance.applyHostUpdate({
      data: {
        datasetKey: 'ds',
        sourceRevision: 1,
        nodes: FIXTURE_IDS.map((id) => ({ id, attrs: { label: id.toUpperCase() } })),
        edges: [
          { source: 'a', target: 'b', attrs: { weight: 1 } },
          { source: 'a', target: 'c', attrs: { weight: 2 } },
          { source: 'b', target: 'c', attrs: { weight: 2 } },
          { source: 'c', target: 'd', attrs: { weight: 2 } },
          { source: 'd', target: 'e', attrs: { weight: 1 } },
        ],
      },
    });
    h.instance.applyHostUpdate({ groups: [GROUP_BC] });
    // Link slots: 0 = d→e physical, 1 = meta a→G {w1, w2}, 2 = meta G→d {w2}.
    h.instance.applyHostUpdate({
      filter: { edges: { op: 'eq', field: 'weight', value: 1 } },
    });
    const linkColors = engine.lastCommit!.buffers!.linkColor!;
    expect(alphaAt(linkColors, 0)).toBeGreaterThan(0); // d→e passes itself
    expect(alphaAt(linkColors, 1)).toBeGreaterThan(0); // one underlying passes
    expect(alphaAt(linkColors, 2)).toBe(0); // no underlying passes
  });

  it('hiddenNodeIds: hiding some members keeps the super-node; hiding all hides it', async () => {
    const { instance, engine } = await readyFixture();
    instance.applyHostUpdate({ groups: [GROUP_BC] });

    instance.hideNodes(['b']);
    let colors = engine.lastCommit!.buffers!.pointColor!;
    expect(alphaAt(colors, 3)).toBeGreaterThan(0); // c still passes

    instance.hideNodes(['c']);
    colors = engine.lastCommit!.buffers!.pointColor!;
    expect(alphaAt(colors, 3)).toBe(0); // no member passes

    instance.showNodes(['b', 'c']);
    colors = engine.lastCommit!.buffers!.pointColor!;
    expect(alphaAt(colors, 3)).toBeGreaterThan(0);
  });

  it('meta-edges hide when the composed node mask hides their physical endpoint', async () => {
    const { instance, engine } = await readyFixture();
    instance.applyHostUpdate({ groups: [GROUP_BC] });
    // Hiding a hides every underlying edge of meta a→G (they all ride a).
    instance.hideNodes(['a']);
    const linkColors = engine.lastCommit!.buffers!.linkColor!;
    expect(alphaAt(linkColors, 1)).toBe(0); // meta a→G
    expect(alphaAt(linkColors, 2)).toBeGreaterThan(0); // meta G→d unaffected
  });
});

// ---------------------------------------------------------------------------
// Pure module: rewrite shapes, discriminated refs, codecs.
// ---------------------------------------------------------------------------

describe('groups module: pure rewrite, refs, and codecs', () => {
  const model = validateSnapshot<NAttrs, EAttrs>(snap(1, [...FIXTURE_IDS], FIXTURE_LINKS));
  const resolved = [
    { id: 'g', memberIds: ['b', 'c'], collapsed: true, derived: false },
  ] as const;

  it('rewriteGroups keeps the id↔index bijection and appends synthetics as a contiguous suffix', () => {
    const rewrite = rewriteGroups(model, buildRepForest(resolved))!;
    expect(rewrite.graph.nodeIndex.size).toBe(rewrite.graph.nodes.length);
    expect(rewrite.physicalNodeCount).toBe(3);
    expect(rewrite.graph.nodes.slice(0, 3).map((n) => n.id)).toEqual(['a', 'd', 'e']);
    expect(rewrite.graph.nodes[3]!.id).toBe(groupSceneKey('g'));
    expect(rewrite.superNodes[0]!.presentMemberIds).toEqual(['b', 'c']);
    // Meta records carry the public tuple id and the badge count.
    expect(rewrite.metaEdges.map((m) => m.metaEdge)).toEqual([
      { id: metaEdgePublicId('node', 'a', 'group', 'g'), source: 'a', target: 'g', count: 2 },
      { id: metaEdgePublicId('group', 'g', 'node', 'd'), source: 'g', target: 'd', count: 1 },
    ]);
    // Underlying indices reference the PRE-rewrite edge list.
    expect(rewrite.metaEdges[0]!.underlying).toEqual([0, 1]);
    expect(rewrite.metaEdges[1]!.underlying).toEqual([3]);
  });

  // containment is a FOREST: a group may nest inside another. Only the
  // outermost collapsed representative materializes; everything beneath it
  // hides with it, and the descendants' edges route to the outer bubble.
  it('nesting: an inner group hides inside its collapsed outer group', () => {
    const nested = buildRepForest([
      // g-outer ∋ {a, g-inner}; g-inner ∋ {b, c}.
      { id: 'g-outer', memberIds: ['a', 'g-inner'], collapsed: true, derived: false },
      { id: 'g-inner', memberIds: ['b', 'c'], collapsed: true, derived: false },
    ]);
    const rewrite = rewriteGroups(model, nested)!;

    // ONE synthetic row: the inner group is itself hidden, so it never
    // materializes even though it is collapsed.
    expect(rewrite.superNodes).toHaveLength(1);
    expect(rewrite.superNodes[0]!.group.id).toBe('g-outer');
    // presentMemberIds is TRANSITIVE — a, plus the inner group's b and c.
    expect([...rewrite.superNodes[0]!.presentMemberIds].sort()).toEqual(['a', 'b', 'c']);
    expect(rewrite.physicalNodeCount).toBe(2);
    expect(rewrite.graph.nodes.slice(0, 2).map((n) => n.id)).toEqual(['d', 'e']);

    // Every a/b/c edge collapses into the outer bubble: a→b, a→c and b→c all
    // land on the same representative and drop; c→d reroutes to g-outer.
    expect(rewrite.metaEdges.map((m) => m.metaEdge)).toEqual([
      {
        id: metaEdgePublicId('group', 'g-outer', 'node', 'd'),
        source: 'g-outer',
        target: 'd',
        count: 1,
      },
    ]);
    // d→e is untouched by either group.
    expect(rewrite.physicalEdges.map((e) => [e.source, e.target])).toEqual([['d', 'e']]);
  });

  it('uncollapsed or non-intersecting groups produce no rewrite (null)', () => {
    expect(rewriteGroups(model, buildRepForest([{ ...resolved[0], collapsed: false }]))).toBeNull();
    expect(
      rewriteGroups(
        model,
        buildRepForest([{ id: 'g', memberIds: ['zz'], collapsed: true, derived: false }]),
      ),
    ).toBeNull();
  });

  it('discriminated scene refs resolve slots to public payloads, never scene keys', () => {
    const rewrite = rewriteGroups(model, buildRepForest(resolved))!;
    const scene: RenderScene = {
      count: rewrite.graph.nodes.length,
      linkCount: rewrite.graph.edges.length,
      idByIndex: rewrite.graph.nodes.map((n) => n.id),
      indexById: rewrite.graph.nodeIndex,
      edgeIdByIndex: rewrite.graph.edges.map((e) => e.id),
      positions: new Float32Array(2 * rewrite.graph.nodes.length),
      links: new Uint32Array(2 * rewrite.graph.edges.length),
      groups: sceneGroupsOf(rewrite),
    };
    expect(scenePointRefAt(scene, 0)).toEqual({ kind: 'node', id: 'a' });
    const superRef = scenePointRefAt(scene, 3)!;
    expect(superRef.kind).toBe('group');
    if (superRef.kind === 'group') expect(superRef.group.id).toBe('g');
    expect(sceneLinkRefAt(scene, 0)).toEqual({ kind: 'edge', id: model.edges[4]!.id });
    const metaRef = sceneLinkRefAt(scene, 1)!;
    expect(metaRef.kind).toBe('meta-edge');
    if (metaRef.kind === 'meta-edge') expect(metaRef.metaEdge.count).toBe(2);
    expect(scenePointRefAt(scene, 99)).toBeNull();
  });

  it('scene keys live outside the public id namespace and never equal each other across kinds', () => {
    expect(groupSceneKey('g')).not.toBe('g');
    expect(groupSceneKey('g').startsWith('\u0000')).toBe(true);
    expect(metaEdgeSceneKey('a', groupSceneKey('g')).startsWith('\u0000')).toBe(true);
    expect(groupSceneKey('meta-edge')).not.toBe(metaEdgeSceneKey('meta-edge', 'meta-edge'));
  });

  it('validateGroupSpecs treats a member naming another group id AND a real node as node membership', () => {
    // 'g1' names a group AND could name a node — with a node present it is
    // legal membership of that node (distinct namespaces).
    const withNode = validateSnapshot<NAttrs, EAttrs>(snap(1, ['g2', 'x'], []));
    const verdict = validateGroupSpecs(
      [
        { id: 'g1', memberIds: ['g2'] },
        { id: 'g2', memberIds: ['x'] },
      ],
      withNode.nodeIndex,
    );
    expect(verdict.diagnostic).toBeNull();
  });

  it('aggregate size/width formulas are monotonic and capped', () => {
    expect(superNodeSizeFor(1)).toBeLessThan(superNodeSizeFor(100));
    expect(superNodeSizeFor(10_000_000)).toBeLessThanOrEqual(36);
    expect(metaEdgeWidthFor(1)).toBeLessThan(metaEdgeWidthFor(64));
    expect(metaEdgeWidthFor(1_000_000)).toBeLessThanOrEqual(8);
  });
});
