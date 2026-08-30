/**
 * soft filtering through the instance.
 *
 * The binding contract under test: a filter/hidden/brush change is a MASK
 * fast path — ONE buffers-only commit (no structure, no restart, zero
 * relayout), alpha channels rebuilt from cached base RGBA buffers, scope and
 * render revisions advanced (never model), store.visible maintained, and
 * hit-testing / selection populations / labels / edge picking all reading
 * the same mask.
 */

import { describe, expect, it } from 'vitest';

import { DIM_ALPHA_DEFAULT } from '../src/mask';
import type { GraphNode, SelectionState } from '../src/types';
import { callsOf, container, makeInstance, snap } from './helpers';
import type { NAttrs } from './helpers';

const eid = (s: string, t: string, k = 0): string => `${s}→${t}#${k}`;

const alphaAt = (buf: Float32Array, i: number): number => buf[4 * i + 3]!;

/** a-b-c-d chain: edges a→b, b→c, c→d. */
function chain4() {
  return snap(1, ['a', 'b', 'c', 'd'], [
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'd'],
  ]);
}

async function readyChain() {
  const h = makeInstance();
  await h.instance.attach(container);
  h.instance.applyHostUpdate({ data: chain4(), nodeColor: 'red', linkColor: 'blue' });
  return { instance: h.instance, engine: h.engines[0]!, engines: h.engines };
}

describe('filter prop — mask fast path', () => {
  it('keeps store.visible equal to scene counts when nothing masks', async () => {
    const { instance } = await readyChain();
    expect(instance.store.getState().visible).toEqual({ nodes: 4, edges: 3 });
  });

  it('expr filter hides failing nodes with ONE buffers-only commit and cascades edges', async () => {
    const { instance, engine } = await readyChain();
    const commitsBefore = engine.commits.length;
    const revBefore = instance.getRevisions();

    instance.applyHostUpdate({ filter: { nodes: { op: 'neq', field: 'id', value: 'b' } } });

    // Exactly one commit: buffers only — no structure, no restart.
    expect(engine.commits.length).toBe(commitsBefore + 1);
    const commit = engine.lastCommit!;
    expect(commit.structure).toBeUndefined();
    expect(commit.restart).toBeUndefined();
    const pc = commit.buffers!.pointColor!;
    expect(alphaAt(pc, 0)).toBe(1);
    expect(alphaAt(pc, 1)).toBe(0); // b hidden
    expect(alphaAt(pc, 2)).toBe(1);
    expect(alphaAt(pc, 3)).toBe(1);
    // edge cascade: both edges incident to b hide; c→d stays.
    const lc = commit.buffers!.linkColor!;
    expect(alphaAt(lc, 0)).toBe(0); // a→b
    expect(alphaAt(lc, 1)).toBe(0); // b→c
    expect(alphaAt(lc, 2)).toBe(1); // c→d

    const state = instance.store.getState();
    expect(state.visible).toEqual({ nodes: 3, edges: 1 });
    // scope+render advance; model does NOT.
    const rev = instance.getRevisions();
    expect(rev.model).toBe(revBefore.model);
    expect(rev.scope).toBe(revBefore.scope + 1);
    expect(rev.render).toBe(revBefore.render + 1);
  });

  it('dim mode mutes to DIM_ALPHA_DEFAULT without hiding or cascading', async () => {
    const { instance, engine } = await readyChain();
    instance.applyHostUpdate({
      filter: { nodes: { op: 'neq', field: 'id', value: 'b' }, mode: 'dim' },
    });

    const commit = engine.lastCommit!;
    const pc = commit.buffers!.pointColor!;
    expect(alphaAt(pc, 1)).toBeCloseTo(DIM_ALPHA_DEFAULT, 6);
    expect(alphaAt(pc, 0)).toBe(1);
    // Dim never hides: no edge cascade, no linkColor channel in the commit.
    expect(commit.buffers!.linkColor).toBeUndefined();
    expect(instance.store.getState().visible).toEqual({ nodes: 4, edges: 3 });
    // Dimmed nodes stay interactive: still in the selectAll population.
    instance.selectAll();
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'b', 'c', 'd']);
  });

  it('filter: null clears the mask (alphas restored, visible counts back)', async () => {
    const { instance, engine } = await readyChain();
    instance.applyHostUpdate({ filter: { nodes: { op: 'neq', field: 'id', value: 'b' } } });
    expect(instance.store.getState().visible.nodes).toBe(3);

    instance.applyHostUpdate({ filter: null });

    const commit = engine.lastCommit!;
    expect(commit.structure).toBeUndefined();
    expect(alphaAt(commit.buffers!.pointColor!, 1)).toBe(1);
    expect(alphaAt(commit.buffers!.linkColor!, 0)).toBe(1);
    expect(instance.store.getState().visible).toEqual({ nodes: 4, edges: 3 });
  });

  it('canonical-equal specs are no-ops: zero re-evaluation, zero commits', async () => {
    const { instance, engine } = await readyChain();
    let calls = 0;
    const predicate = (n: GraphNode<NAttrs>): boolean => {
      calls++;
      return n.id !== 'b';
    };
    instance.applyHostUpdate({ filter: { nodes: predicate } });
    const evalsAfterFirst = calls;
    expect(evalsAfterFirst).toBeGreaterThan(0);
    const commits = engine.commits.length;
    const rev = instance.getRevisions();

    // Same predicate REFERENCE in a structurally fresh spec object:
    // canonicalFilterKey-equal → zero re-evaluation, zero commits.
    instance.applyHostUpdate({ filter: { nodes: predicate } });

    expect(calls).toBe(evalsAfterFirst);
    expect(engine.commits.length).toBe(commits);
    expect(instance.getRevisions()).toEqual(rev);
  });

  it('throwing predicate fails OPEN and aggregates ONE filter-error diagnostic', async () => {
    const { instance } = await readyChain();
    instance.applyHostUpdate({
      filter: {
        nodes: (n: GraphNode<NAttrs>) => {
          if (n.id === 'b') throw new Error('boom');
          return n.id !== 'a';
        },
      },
    });

    // a hidden by the predicate; b visible despite throwing (fail open).
    expect(instance.store.getState().visible.nodes).toBe(3);
    expect(instance.getVisibleNodeIds()).toEqual(['b', 'c', 'd']);
    const filterErrors = instance.getDiagnostics().filter((d) => d.code === 'filter-error');
    expect(filterErrors).toHaveLength(1);
    expect(filterErrors[0]!.severity).toBe('warning');
    expect(filterErrors[0]!.count).toBe(1);
    expect(filterErrors[0]!.sampleIds).toEqual(['b']);
  });

  it('rejects a malformed filter BEFORE any work (validation error, store untouched)', async () => {
    const { instance, engine } = await readyChain();
    const commits = engine.commits.length;
    const rev = instance.getRevisions();

    expect(() =>
      instance.applyHostUpdate({
        // @ts-expect-error malformed op is exactly what validation rejects
        filter: { nodes: { op: 'bogus', field: 'id', value: 'b' } },
      }),
    ).toThrow(TypeError);

    expect(engine.commits.length).toBe(commits);
    expect(instance.getRevisions()).toEqual(rev);
    expect(instance.store.getState().visible).toEqual({ nodes: 4, edges: 3 });
  });

  it('composes the mask into the initial projection when data+filter arrive together', async () => {
    const h = makeInstance();
    await h.instance.attach(container);
    h.instance.applyHostUpdate({
      data: chain4(),
      nodeColor: 'red',
      filter: { nodes: { op: 'neq', field: 'id', value: 'b' } },
    });
    const commit = h.engines[0]!.lastCommit!;
    expect(commit.structure).toBeDefined();
    expect(alphaAt(commit.buffers!.pointColor!, 1)).toBe(0);
    expect(h.instance.store.getState().visible).toEqual({ nodes: 3, edges: 1 });
  });
});

describe('hiddenNodeIds — now visually effective', () => {
  it('hideNodes masks pixels (alpha 0 + edge cascade) and showAll restores', async () => {
    const { instance, engine } = await readyChain();
    const revBefore = instance.getRevisions();

    instance.hideNodes(['b']);

    const commit = engine.lastCommit!;
    expect(commit.structure).toBeUndefined();
    expect(commit.restart).toBeUndefined();
    expect(alphaAt(commit.buffers!.pointColor!, 1)).toBe(0);
    expect(alphaAt(commit.buffers!.linkColor!, 0)).toBe(0);
    expect(alphaAt(commit.buffers!.linkColor!, 2)).toBe(1);
    expect(instance.store.getState().visible).toEqual({ nodes: 3, edges: 1 });
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'c', 'd']);
    const rev = instance.getRevisions();
    expect(rev.model).toBe(revBefore.model);
    expect(rev.scope).toBe(revBefore.scope + 1);

    instance.showAll();
    expect(alphaAt(engine.lastCommit!.buffers!.pointColor!, 1)).toBe(1);
    expect(instance.store.getState().visible).toEqual({ nodes: 4, edges: 3 });
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('mask-hidden hover and click read as background', async () => {
    const { instance, engine } = await readyChain();
    let backgroundClicks = 0;
    let nodeClicks = 0;
    let lastHover: GraphNode<NAttrs> | null | undefined;
    instance.on('backgroundClick', () => backgroundClicks++);
    instance.on('nodeClick', () => nodeClicks++);
    instance.on('nodeHover', (p) => {
      lastHover = p.node;
    });
    instance.selectNodes(['a']);
    instance.hideNodes(['b']);

    engine.injectPointClick(1); // b's slot — masked → background semantics
    expect(nodeClicks).toBe(0);
    expect(backgroundClicks).toBe(1);
    expect(instance.store.getState().selection.nodeIds).toEqual([]); // cleared

    engine.injectPointHover(1);
    expect(lastHover).toBeNull();
    expect(instance.store.getState().hover.nodeId).toBeNull();
    expect(callsOf(engine, 'setFocusedIndex').at(-1)!.args).toEqual([null]);
  });
});

describe('selection over the visible set', () => {
  it('selectAll/invertSelection populate from scope ∧ mask', async () => {
    const { instance } = await readyChain();
    instance.applyHostUpdate({ filter: { nodes: { op: 'neq', field: 'id', value: 'b' } } });
    instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'b', 'c'] } });

    instance.selectAll();
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'c']);

    instance.selectNodes(['a']);
    instance.invertSelection();
    expect(instance.store.getState().selection.nodeIds).toEqual(['c']);
  });

  it('masked selected ids SURVIVE in SelectionState and all indices stay pushed', async () => {
    const { instance, engine } = await readyChain();
    instance.selectNodes(['a', 'b']);
    expect(callsOf(engine, 'setSelectedIndices').at(-1)!.args).toEqual([[0, 1]]);
    const pushes = callsOf(engine, 'setSelectedIndices').length;

    instance.applyHostUpdate({ filter: { nodes: { op: 'neq', field: 'id', value: 'b' } } });

    // The masked id stays selected; the engine
    // highlight keeps ALL selected indices (engine greyout hides b).
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'b']);
    expect(callsOf(engine, 'setSelectedIndices')).toHaveLength(pushes); // no churn

    instance.applyHostUpdate({ filter: null });
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'b']);
  });

  it('lasso drops mask-hidden ids', async () => {
    const { instance, engine } = await readyChain();
    engine.injectSimulationEnd(); // seed positions banked: (0,0)(10,0)(20,0)(30,0)
    instance.applyHostUpdate({ filter: { nodes: { op: 'neq', field: 'id', value: 'b' } } });

    const resolved = instance.selectWithinPolygon([
      [-5, -5],
      [15, -5],
      [15, 5],
      [-5, 5],
    ]);
    expect(resolved).toEqual(['a']); // b is inside the polygon but masked
  });
});

describe('label lane × mask', () => {
  it('mask-hidden nodes leave the candidate set', async () => {
    const { instance, engine } = await readyChain();
    instance.applyHostUpdate({ labels: { enabled: true, overlap: 'allow' } });
    engine.injectSimulationEnd(); // bank positions so candidates are placeable

    let latest: readonly { id: string }[] = [];
    instance.labels.subscribeCandidates((list) => {
      latest = list.map((p) => ({ id: p.id }));
    });
    // Degree-ranked order; assert membership, not rank.
    expect(new Set(latest.map((c) => c.id))).toEqual(new Set(['a', 'b', 'c', 'd']));

    instance.applyHostUpdate({ filter: { nodes: { op: 'neq', field: 'id', value: 'b' } } });
    expect(new Set(latest.map((c) => c.id))).toEqual(new Set(['a', 'c', 'd']));
  });
});

describe('edge picking honors the mask on both routes', () => {
  it('fallback route: the facade mask function reads live isEdgeVisible', async () => {
    const { instance, engine } = await readyChain();
    engine.injectSimulationEnd(); // settle → arm the pick grid

    expect(instance.pickEdgeAt([5, 0])?.id).toBe(eid('a', 'b'));

    instance.applyHostUpdate({ filter: { nodes: { op: 'neq', field: 'id', value: 'b' } } });
    // Buffers-only commit: the grid stays armed, the mask filters candidates.
    expect(instance.pickEdgeAt([5, 0])).toBeNull();
    expect(instance.pickEdgeAt([25, 0])?.id).toBe(eid('c', 'd')); // unmasked edge still picks
  });

  it('native route: onLink* host events are filtered through the same mask', async () => {
    const h = makeInstance({ engineOptions: { capabilities: { linkPicking: true } } });
    await h.instance.attach(container);
    h.instance.applyHostUpdate({ data: chain4() });
    const engine = h.engines[0]!;
    const clicks: string[] = [];
    const hovers: Array<string | null> = [];
    h.instance.on('edgeClick', (p) => clicks.push(p.edge.id));
    h.instance.on('edgeHover', (p) => hovers.push(p.edge === null ? null : p.edge.id));

    engine.injectLinkClick(0);
    expect(clicks).toEqual([eid('a', 'b')]);

    h.instance.applyHostUpdate({ filter: { nodes: { op: 'neq', field: 'id', value: 'b' } } });
    engine.injectLinkClick(0); // masked → dropped
    expect(clicks).toEqual([eid('a', 'b')]);
    engine.injectLinkHover(0); // masked → null hover
    expect(hovers.at(-1)).toBeNull();
    engine.injectLinkClick(2); // c→d unmasked → still delivered
    expect(clicks).toEqual([eid('a', 'b'), eid('c', 'd')]);
  });
});

describe('mask × replay and structural change', () => {
  it('recovery replay preserves mask alphas', async () => {
    const { instance, engine } = await readyChain();
    instance.applyHostUpdate({ filter: { nodes: { op: 'neq', field: 'id', value: 'b' } } });

    engine.injectContextLost();
    engine.injectContextRestored();

    expect(instance.store.getState().status).toBe('ready');
    const replay = engine.lastCommit!;
    expect(replay.structure).toBeDefined();
    expect(alphaAt(replay.buffers!.pointColor!, 1)).toBe(0);
    expect(alphaAt(replay.buffers!.linkColor!, 0)).toBe(0);
    expect(alphaAt(replay.buffers!.linkColor!, 2)).toBe(1);
  });

  it('detach/re-attach replay composes mask alphas on the fresh engine', async () => {
    const { instance, engines } = await readyChain();
    instance.applyHostUpdate({ filter: { nodes: { op: 'neq', field: 'id', value: 'b' } } });

    instance.detach();
    await instance.attach(container);

    const fresh = engines[1]!;
    const replay = fresh.lastCommit!;
    expect(replay.structure).toBeDefined();
    expect(alphaAt(replay.buffers!.pointColor!, 1)).toBe(0);
    expect(instance.store.getState().visible).toEqual({ nodes: 3, edges: 1 });
  });

  it('rebuilds mask memberships when a structural change shifts slot indices', async () => {
    const { instance, engine } = await readyChain();
    instance.applyHostUpdate({ filter: { nodes: { op: 'neq', field: 'id', value: 'b' } } });
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'c', 'd']);

    // rev 2: b moves to slot 2 and two new nodes appear (mask must grow).
    instance.applyHostUpdate({
      data: snap(2, ['x', 'y', 'b', 'z', 'w'], [['x', 'b']]),
    });

    const commit = engine.lastCommit!;
    expect(commit.structure).toBeDefined();
    const pc = commit.buffers!.pointColor!;
    expect(alphaAt(pc, 0)).toBe(1); // x
    expect(alphaAt(pc, 1)).toBe(1); // y
    expect(alphaAt(pc, 2)).toBe(0); // b — re-evaluated at its NEW slot
    expect(alphaAt(pc, 3)).toBe(1); // z
    expect(alphaAt(pc, 4)).toBe(1); // w
    expect(alphaAt(commit.buffers!.linkColor!, 0)).toBe(0); // x→b cascade
    expect(instance.store.getState().visible).toEqual({ nodes: 4, edges: 0 });
    expect(instance.getVisibleNodeIds()).toEqual(['x', 'y', 'z', 'w']);
  });

  it('hidden ids under a scope change keep masking at their new slots', async () => {
    const { instance } = await readyChain();
    instance.hideNodes(['c']);
    instance.applyHostUpdate({ subgraph: { seedIds: ['b', 'c', 'd'] } });
    // Scoped scene is [b, c, d]; c must still be masked at its new slot 1.
    expect(instance.getVisibleNodeIds()).toEqual(['b', 'd']);
    expect(instance.store.getState().visible).toEqual({ nodes: 2, edges: 0 });
  });
});

describe('selection payload sanity (masked ids in intents)', () => {
  it('controlled selection intents still carry masked ids', async () => {
    const { instance } = await readyChain();
    instance.applyHostUpdate({ selection: ['a', 'b'] }); // controlled
    instance.applyHostUpdate({ filter: { nodes: { op: 'neq', field: 'id', value: 'b' } } });
    const intents: SelectionState[] = [];
    instance.on('selectionChange', (p) => intents.push(p));
    instance.selectNodes(['a', 'b', 'c']);
    expect(intents).toEqual([{ nodeIds: ['a', 'b', 'c'], edgeIds: [], groupIds: [] }]);
    // Store selection untouched (host owns it); mask did not rewrite it.
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'b']);
  });
});
