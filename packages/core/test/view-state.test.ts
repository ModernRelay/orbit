/**
 * view state, Wave 1: the wire commitment.
 *
 * Everything pinned here is COMPATIBILITY, not implementation: deep-links
 * outlive releases, so the canonical-JSON encoding, the validator's verdicts,
 * the version-gate rules, and getViewState's capture rules are the contract
 * a v1 URL relies on for the rest of the library's life.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  canonicalJson,
  sameDataRef,
  validateViewState,
  VIEW_STATE_VERSION,
} from '../src/viewState';
import type { GraphViewState } from '../src/viewState';
import { container, makeInstance, snap } from './helpers';

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

describe('canonicalJson', () => {
  it('sorts object keys recursively; array order is preserved', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson([2, 1])).toBe('[2,1]'); // arrays are ordered data
  });

  it('follows JSON semantics: undefined members drop, non-finite numbers → null', () => {
    expect(canonicalJson({ a: undefined, b: 1 } as never)).toBe('{"b":1}');
    expect(canonicalJson(Number.POSITIVE_INFINITY as never)).toBe('null');
  });

  it('sameDataRef: key order never matters; value differences always do', () => {
    expect(sameDataRef({ graphId: 'g', branch: 'main' }, { branch: 'main', graphId: 'g' })).toBe(
      true,
    );
    expect(sameDataRef({ graphId: 'g' }, { graphId: 'h' })).toBe(false);
    expect(sameDataRef(undefined, undefined)).toBe(true);
    expect(sameDataRef(undefined, null)).toBe(false); // absent ≠ null
  });
});

// ---------------------------------------------------------------------------
// Validator + version gate
// ---------------------------------------------------------------------------

const MINIMAL: GraphViewState = {
  v: 1,
  camera: null,
  selection: { nodeIds: [], edgeIds: [], groupIds: [] },
  hiddenNodeIds: [],
  subgraph: null,
  groups: [],
  pinnedNodeIds: [],
  layout: { kind: 'force' },
  crossfilter: [],
};

describe('validateViewState', () => {
  it('accepts a minimal valid v1 state', () => {
    expect(validateViewState(MINIMAL)).toEqual({ ok: true, state: MINIMAL });
  });

  it('v HIGHER than known rejects as unsupported-version before field checks', () => {
    const verdict = validateViewState({ garbage: true, v: VIEW_STATE_VERSION + 1 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('unsupported-version');
  });

  it('equal v with unknown extra fields applies cleanly (additive rule)', () => {
    const verdict = validateViewState({ ...MINIMAL, futureFeature: { anything: [1] } });
    expect(verdict.ok).toBe(true);
  });

  it('a truncated payload reports problems and never throws', () => {
    const verdict = validateViewState({ v: 1, camera: { x: 1 } });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe('invalid-view-state');
      expect(verdict.problems.length).toBeGreaterThan(1); // every problem, not the first
    }
  });

  it('hostile payloads (wrong types everywhere) reject without throwing', () => {
    for (const raw of [null, 42, 'v=1', [], { v: 'one' }, { v: 0 }, { v: 1.5 }]) {
      const verdict = validateViewState(raw);
      expect(verdict.ok).toBe(false);
    }
  });

  it('validates both group forms and rejects a hybrid', () => {
    const manual = { ...MINIMAL, groups: [{ id: 'g', memberIds: ['a'] }] };
    const derived = { ...MINIMAL, groups: [{ key: 'alpha', collapsed: true }] };
    const hybrid = { ...MINIMAL, groups: [{ id: 'g' }] };
    expect(validateViewState(manual).ok).toBe(true);
    expect(validateViewState(derived).ok).toBe(true);
    expect(validateViewState(hybrid).ok).toBe(false);
  });

  it('validates tagged brushes: numeric range shape, categorical exclusions', () => {
    const good = {
      ...MINIMAL,
      crossfilter: [
        { key: 'score', state: { kind: 'numeric', range: [0, 1] } },
        { key: 'type', state: { kind: 'categorical', excluded: ['x'] } },
      ],
    };
    const bad = { ...MINIMAL, crossfilter: [{ key: 'score', state: { kind: 'numeric' } }] };
    expect(validateViewState(good).ok).toBe(true);
    expect(validateViewState(bad).ok).toBe(false);
  });

  it('folds validate as [anchor, memberIds] tuples', () => {
    expect(validateViewState({ ...MINIMAL, folds: [['hub', ['a', 'b']]] }).ok).toBe(true);
    expect(validateViewState({ ...MINIMAL, folds: [['hub']] }).ok).toBe(false);
    expect(validateViewState({ ...MINIMAL, folds: [{ hub: ['a'] }] }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getViewState capture rules (instance-level)
// ---------------------------------------------------------------------------

async function ready() {
  const h = makeInstance({ fitViewOnFirstData: false });
  await h.instance.attach(container);
  h.instance.applyHostUpdate({
    data: snap(1, ['a', 'b', 'c', 'd'], [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
    ]),
  });
  return { ...h, engine: h.engines[0]! };
}

describe('getViewState capture', () => {
  it('captures selection, hidden, pins, folds, scope, and dataRef verbatim', async () => {
    const { instance } = await ready();
    instance.setSelection(['a', 'b']);
    instance.hideNodes(['d']);
    instance.pinNodes(['a']);
    instance.foldNode('b');
    instance.applyHostUpdate({ dataRef: { graphId: 'g', branch: 'main' } });

    const state = instance.getViewState();
    expect(state.v).toBe(1);
    expect(state.selection.nodeIds).toEqual(['a', 'b']);
    expect(state.hiddenNodeIds).toEqual(['d']);
    expect(state.pinnedNodeIds).toEqual(['a']);
    expect(state.folds).toEqual([['b', ['a', 'c']]]);
    expect(state.layout).toEqual({ kind: 'force' });
    expect(state.dataRef).toEqual({ graphId: 'g', branch: 'main' });
    // The whole thing survives a URL round trip losslessly.
    const encoded = encodeURIComponent(JSON.stringify(state));
    expect(JSON.parse(decodeURIComponent(encoded))).toEqual(state);
  });

  it('serializes a sequential scale; drops a function accessor with ONE dev warning', async () => {
    const { instance } = await ready();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      instance.applyHostUpdate({
        nodeColor: { kind: 'sequential', metric: 'degree', range: ['#000', '#fff'] },
        nodeSize: () => 4,
      });
      const first = instance.getViewState();
      expect(first.styling?.nodeColor).toEqual({
        kind: 'sequential',
        metric: 'degree',
        range: ['#000', '#fff'],
      });
      expect(first.styling?.nodeSize).toBeUndefined();
      instance.getViewState(); // second call — the warning must NOT repeat
      const drops = warn.mock.calls.filter((c) => String(c[0]).includes('nodeSize'));
      expect(drops).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('constants are app defaults, not perspective state: not captured, no warning', async () => {
    const { instance } = await ready();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      instance.applyHostUpdate({ nodeColor: '#f00' });
      const state = instance.getViewState();
      expect(state.styling?.nodeColor).toBeUndefined();
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('nodeColor'))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('named theme serializes; expansion records never do', async () => {
    const { instance } = await ready();
    instance.applyHostUpdate({ theme: { base: 'light' } });
    await instance.expandNode('a').catch(() => {});
    const state = instance.getViewState();
    expect(state.styling?.theme).toBe('light');
    expect(JSON.stringify(state)).not.toContain('expansion');
  });

  it('under groupBy, groups serialize as collapsed {key, collapsed} pairs only', async () => {
    const { instance } = await ready();
    instance.applyHostUpdate({ groupBy: { by: (n) => (n.id <= 'b' ? 'low' : 'high') } });
    instance.setGroupCollapsed(JSON.stringify(['group', 'low']), true);

    const state = instance.getViewState();
    expect(state.groups).toEqual([{ key: 'low', collapsed: true }]);
    expect(JSON.stringify(state.groups)).not.toContain('memberIds');
  });

  it('includePositions embeds quantized coordinates for the visible set', async () => {
    const { instance } = await ready();
    const state = await instance.getViewState({ includePositions: true });
    expect(state.positions).toBeDefined();
    for (const [id, x, y] of state.positions!) {
      expect(typeof id).toBe('string');
      expect(x).toBe(Math.round(x * 100) / 100);
      expect(y).toBe(Math.round(y * 100) / 100);
    }
  });

  it('includePositions past the limit rejects with the typed materialization error', async () => {
    const { instance } = await ready();
    await expect(
      instance.getViewState({ includePositions: true, maxPositions: 2 }),
    ).rejects.toMatchObject({ detail: { code: 'export-materialization-too-large' } });
  });
});

// ---------------------------------------------------------------------------
// setViewState — the atomic restore (Wave 2, uncontrolled path)
// ---------------------------------------------------------------------------

describe('setViewState', () => {
  it('ROUND TRIP: capture on one instance, restore on a fresh one, slices match', async () => {
    const a = await ready();
    a.instance.setSelection(['a', 'c']);
    a.instance.hideNodes(['d']);
    a.instance.pinNodes(['a']);
    a.instance.foldNode('b');
    a.instance.applyHostUpdate({ subgraph: { seedIds: ['a'], hops: 2 } });
    const saved = a.instance.getViewState();

    const b = await ready();
    const result = await b.instance.setViewState(saved);
    expect(result).toEqual({ status: 'applied' });

    const sa = a.instance.store.getState();
    const sb = b.instance.store.getState();
    expect([...sb.selection.nodeIds]).toEqual([...sa.selection.nodeIds]);
    expect([...sb.hiddenNodeIds].sort()).toEqual([...sa.hiddenNodeIds].sort());
    expect([...sb.pinnedNodeIds].sort()).toEqual([...sa.pinnedNodeIds].sort());
    expect(b.instance.getFold('b')).toEqual(a.instance.getFold('b'));
    expect(sb.scope).toEqual(sa.scope);
    // And the restore itself is ONE undoable step.
    expect(sb.history.undoDepth).toBe(1);
    b.instance.undo();
    expect(b.instance.store.getState().selection.nodeIds).toEqual([]);
    expect(b.instance.getFold('b')).toBeNull();
  });

  it('a truncated payload leaves the store BYTE-IDENTICAL and publishes one diagnostic', async () => {
    const { instance } = await ready();
    instance.setSelection(['a']);
    const before = JSON.stringify(instance.store.getState(), (_k, v) =>
      v instanceof Map || v instanceof Set ? [...v] : v,
    );

    const result = await instance.setViewState({ v: 1, camera: { x: 1 } });
    expect(result.status).toBe('rejected');

    const after = JSON.stringify(
      { ...instance.store.getState(), diagnostics: [] },
      (_k, v) => (v instanceof Map || v instanceof Set ? [...v] : v),
    );
    const beforeNoDiags = JSON.stringify(
      { ...JSON.parse(before), diagnostics: [] },
      (_k, v) => v,
    );
    expect(after).toBe(beforeNoDiags);
    expect(
      instance.getDiagnostics().some((d) => d.code === 'invalid-view-state'),
    ).toBe(true);
  });

  it('v:2 rejects as unsupported-version; v:1 with unknown fields applies', async () => {
    const { instance } = await ready();
    const good = instance.getViewState();

    const higher = await instance.setViewState({ ...good, v: 2 });
    expect(higher.status).toBe('rejected');
    if (higher.status === 'rejected') expect(higher.code).toBe('unsupported-version');

    const additive = await instance.setViewState({ ...good, futureLane: { x: 1 } });
    expect(additive.status).toBe('applied');
  });

  it('dataRef mismatch fires the event INSTEAD of applying; ignoreMismatch opts in', async () => {
    const { instance } = await ready();
    instance.applyHostUpdate({ dataRef: { graphId: 'g', branch: 'main' } });
    const saved = instance.getViewState();
    instance.applyHostUpdate({ dataRef: { graphId: 'g', branch: 'other' } });

    const events: unknown[] = [];
    instance.on('viewStateMismatch', (p) => events.push(p));
    instance.setSelection(['d']);

    const gated = await instance.setViewState(saved);
    expect(gated).toEqual({ status: 'mismatch' });
    expect(events).toHaveLength(1);
    expect(instance.store.getState().selection.nodeIds).toEqual(['d']); // untouched

    const forced = await instance.setViewState(saved, { ignoreMismatch: true });
    expect(forced).toEqual({ status: 'applied' });
  });

  it('reordered dataRef keys compare equal (canonical, not stringify)', async () => {
    const { instance } = await ready();
    instance.applyHostUpdate({ dataRef: { a: 1, b: 2 } });
    const saved = instance.getViewState();
    const reordered = { ...saved, dataRef: { b: 2, a: 1 } };
    expect((await instance.setViewState(reordered)).status).toBe('applied');
  });

  it('a categorical brush restored over data with a NEW category keeps it visible', async () => {
    const dims = [{ key: 'kind', kind: 'categorical' as const, get: (n: { id: string }) => (n.id === 'a' ? 'x' : 'y') }];
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    h.instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]), crossfilter: dims });
    const session = h.instance.getCrossfilterSession()!;
    session.setBrush('kind', { excluded: ['x'] });
    const saved = h.instance.getViewState();
    expect(saved.crossfilter).toEqual([
      { key: 'kind', state: { kind: 'categorical', excluded: ['x'] } },
    ]);

    // Fresh instance whose data has a THIRD category 'z' — never excluded.
    const dims2 = [{ key: 'kind', kind: 'categorical' as const, get: (n: { id: string }) => (n.id === 'a' ? 'x' : n.id === 'b' ? 'y' : 'z') }];
    const h2 = makeInstance({ fitViewOnFirstData: false });
    await h2.instance.attach(container);
    h2.instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c'], [['a', 'b']]), crossfilter: dims2 });
    expect((await h2.instance.setViewState(saved)).status).toBe('applied');
    const visible = h2.instance.getVisibleNodeIds();
    expect(visible).toContain('c'); // the new 'z' category stays visible
    expect(visible).not.toContain('a'); // the excluded 'x' stays excluded
  });

  it('a controlled slice with no restore callback rejects BEFORE staging', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    h.instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
    const saved = h.instance.getViewState();
    const target = { ...saved, selection: { nodeIds: ['a'], edgeIds: [], groupIds: [] } };

    h.instance.applyHostUpdate({ selection: [] }); // latch controlled
    const result = await h.instance.setViewState(target);
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.code).toBe('missing-restore-callback');
    expect(h.instance.store.getState().selection.nodeIds).toEqual([]);
  });

  it('embedded positions restore pixel-faithfully and freeze the simulation', async () => {
    const a = await ready();
    const saved = await a.instance.getViewState({ includePositions: true });
    expect(saved.positions!.length).toBeGreaterThan(0);

    const b = await ready();
    expect((await b.instance.setViewState(saved)).status).toBe('applied');
    // The commit carried EXACTLY the saved coordinates for known ids…
    const commit = b.engine.lastCommit!;
    expect(commit.structure).toBeDefined();
    const byId = new Map(saved.positions!.map(([id, x, y]) => [id, [x, y] as const]));
    const posA = byId.get('a')!;
    const idxA = 0; // 'a' is slot 0 in this fixture
    expect(commit.structure!.positions[2 * idxA]).toBeCloseTo(posA[0], 5);
    // …and the sim is paused (fixed-equivalent freeze).
    expect(b.instance.store.getState().simulationRunning).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Aggregate restore protocol (Wave 3)
// ---------------------------------------------------------------------------

describe('aggregate restore protocol', () => {
  async function controlledRig() {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    h.instance.applyHostUpdate({
      data: snap(1, ['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]),
      selection: [], // latch controlled
    });
    return h;
  }

  it('stages, emits ONE intent, applies nothing until the matching reflection', async () => {
    const h = await controlledRig();
    h.instance.hideNodes(['c']); // an internal slice that must ALSO hold
    const target = {
      ...h.instance.getViewState(),
      selection: { nodeIds: ['a'], edgeIds: [], groupIds: [] },
      hiddenNodeIds: [],
    };

    const intents: unknown[] = [];
    h.instance.on('viewStateRestore', (p) => intents.push(p));

    const promise = h.instance.setViewState(target);
    // Staged: one intent, and NEITHER lane moved — the previous scene lives.
    expect(intents).toHaveLength(1);
    expect(h.instance.store.getState().selection.nodeIds).toEqual([]);
    expect([...h.instance.store.getState().hiddenNodeIds]).toEqual(['c']);

    // The host reflects the controlled lane with MATCHING values…
    h.instance.applyHostUpdate({ selection: ['a'] });
    await expect(promise).resolves.toEqual({ status: 'applied' });
    // …and the whole transaction commits: internal slices included.
    expect(h.instance.store.getState().selection.nodeIds).toEqual(['a']);
    expect(h.instance.store.getState().hiddenNodeIds.size).toBe(0);
  });

  it('a DIVERGENT reflection discards the stage and applies nothing', async () => {
    const h = await controlledRig();
    h.instance.hideNodes(['c']);
    const target = {
      ...h.instance.getViewState(),
      selection: { nodeIds: ['a'], edgeIds: [], groupIds: [] },
      hiddenNodeIds: [],
    };
    h.instance.on('viewStateRestore', () => {});

    const promise = h.instance.setViewState(target);
    h.instance.applyHostUpdate({ selection: ['b'] }); // NOT what was asked

    const result = await promise;
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.code).toBe('restore-diverged');
    // Internal slices held: hidden is untouched (the host's divergent write
    // to ITS lane stands — that lane is host-owned).
    expect([...h.instance.store.getState().hiddenNodeIds]).toEqual(['c']);
  });

  it('times out with nothing applied when the host never reflects', async () => {
    vi.useFakeTimers();
    try {
      const h = await controlledRig();
      const target = {
        ...h.instance.getViewState(),
        selection: { nodeIds: ['a'], edgeIds: [], groupIds: [] },
      };
      h.instance.on('viewStateRestore', () => {});
      const promise = h.instance.setViewState(target);
      vi.advanceTimersByTime(5001);
      const result = await promise;
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.code).toBe('restore-timeout');
      expect(h.instance.store.getState().selection.nodeIds).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second restore during a pending one rejects as restore-pending', async () => {
    const h = await controlledRig();
    const target = {
      ...h.instance.getViewState(),
      selection: { nodeIds: ['a'], edgeIds: [], groupIds: [] },
    };
    h.instance.on('viewStateRestore', () => {});
    const first = h.instance.setViewState(target);
    const second = await h.instance.setViewState(target);
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') expect(second.code).toBe('restore-pending');
    h.instance.applyHostUpdate({ selection: ['a'] });
    await expect(first).resolves.toEqual({ status: 'applied' });
  });

  it('undo of a controlled step holds the cursor until the reflection acks', async () => {
    const h = await controlledRig();
    // Build one controlled-selection history entry the pre-latch way is
    // impossible — so use an UNCONTROLLED rig latched AFTER the mutation.
    const g = makeInstance({ fitViewOnFirstData: false });
    await g.instance.attach(container);
    g.instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
    g.instance.setSelection(['a']); // records (uncontrolled at record time)
    g.instance.applyHostUpdate({ selection: ['a'] }); // NOW latch controlled
    expect(g.instance.store.getState().history.undoDepth).toBe(1);

    const intents: Array<{ source: string }> = [];
    g.instance.on('viewStateRestore', (p) => intents.push(p as { source: string }));

    expect(g.instance.undo()).toBe(true); // staged
    expect(intents).toHaveLength(1);
    expect(intents[0]!.source).toBe('undo');
    // Cursor holds: store depths unchanged, selection unchanged.
    expect(g.instance.store.getState().history.undoDepth).toBe(1);
    expect(g.instance.store.getState().selection.nodeIds).toEqual(['a']);

    // Reflection with the intent's target (empty selection) commits the walk.
    g.instance.applyHostUpdate({ selection: [] });
    expect(g.instance.store.getState().selection.nodeIds).toEqual([]);
    expect(g.instance.store.getState().history.undoDepth).toBe(0);
    void h;
  });
});

// ---------------------------------------------------------------------------
// Validator hardening
// ---------------------------------------------------------------------------

describe('validator hardening', () => {
  it('OMITTED camera/subgraph reject — null is a value, omission is truncation', () => {
    const { camera: _c, ...noCamera } = MINIMAL;
    const { subgraph: _s, ...noSubgraph } = MINIMAL;
    expect(validateViewState(noCamera).ok).toBe(false);
    expect(validateViewState(noSubgraph).ok).toBe(false);
    // The bug this pins: omission used to pass validation and then
    // subgraphPlain(undefined) threw INSIDE the acceptance queue — a crash
    // after the gate promised the payload was fully validated.
  });

  it('a cyclic dataRef rejects instead of overflowing the stack', async () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    const verdict = validateViewState({ ...MINIMAL, dataRef: cyclic });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problems.join()).toContain('dataRef');

    // And end to end through the public API: typed rejection, no throw.
    const { instance } = await (async () => {
      const h = makeInstance({ fitViewOnFirstData: false });
      await h.instance.attach(container);
      h.instance.applyHostUpdate({ data: snap(1, ['a'], []) });
      return h;
    })();
    const result = await instance.setViewState({ ...MINIMAL, dataRef: cyclic });
    expect(result.status).toBe('rejected');
  });

  it('sameDataRef treats non-JSON values as never-equal, and function members drop', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(sameDataRef(cyclic as never, cyclic as never)).toBe(false);
    // JSON.stringify semantics: function members drop, so these compare equal.
    expect(
      sameDataRef({ a: 1, fn: (() => {}) as never } as never, { a: 1 }),
    ).toBe(true);
    // …and a function in an ARRAY slot is null, exactly like JSON.stringify.
    expect(canonicalJson([(() => {}) as never] as never)).toBe('[null]');
  });
});
