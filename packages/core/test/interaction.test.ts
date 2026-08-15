/**
 * Interaction wiring: lasso selection through the ownership path,
 * the focus neighborhood with its documented single-highlight-channel
 * compromise, and the drag-pin built-in follow-up
 * whose position survives structural swaps and context recovery.
 *
 * FakeEngine geometry: screen == space; seeded positions put node i at
 * ((i % 100) * 10, floor(i / 100) * 10).
 */

import { describe, expect, it } from 'vitest';

import { callsOf, container, makeInstance, snap } from './helpers';
import type { InstanceHarness } from './helpers';
import { createGraphInstance } from '../src/instance';
import type { GraphInstance } from '../src/instance';
import { FakeEngine } from '../src/testing/index';
import type { SelectionState } from '../src/types';

interface ReadyHarness extends InstanceHarness {
  engine: FakeEngine;
}

async function setup(
  links: ReadonlyArray<readonly [string, string]> = [['a', 'b']],
  ids: readonly string[] = ['a', 'b', 'c'],
): Promise<ReadyHarness> {
  const h = makeInstance();
  await h.instance.attach(container);
  h.instance.applyHostUpdate({ data: snap(1, ids, links) });
  return { ...h, engine: h.engines[0]! };
}

/** Instance whose engines get the listed OPTIONAL methods shadowed away. */
function makeStrippedInstance(methods: readonly string[]): {
  instance: GraphInstance<{ label: string }, { weight: number }>;
  engines: FakeEngine[];
} {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance<{ label: string }, { weight: number }>({
    engine: () => {
      const e = new FakeEngine();
      for (const m of methods) {
        (e as unknown as Record<string, unknown>)[m] = undefined;
      }
      engines.push(e);
      return e;
    },
  });
  return { instance, engines };
}

// Around a(0,0) and b(10,0); excludes c(20,0).
const POLY_AB: readonly [number, number][] = [
  [-5, -5],
  [15, -5],
  [15, 5],
  [-5, 5],
];
// Around a(0,0) only.
const POLY_A: readonly [number, number][] = [
  [-5, -5],
  [5, -5],
  [5, 5],
  [-5, 5],
];

describe('selectWithinPolygon', () => {
  it('replace mode: resolves ids in accepted-base order, writes the store, pushes the engine', async () => {
    const { instance, engine } = await setup();
    const events: SelectionState[] = [];
    instance.on('selectionChange', (p) => events.push(p));

    const resolved = instance.selectWithinPolygon(POLY_AB);

    expect(resolved).toEqual(['a', 'b']);
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'b']);
    expect(callsOf(engine, 'setSelectedIndices').at(-1)!.args).toEqual([[0, 1]]);
    expect(events).toHaveLength(1);
    expect(events[0]!.nodeIds).toEqual(['a', 'b']);
  });

  it('additive mode: unions with the current selection in accepted-base order', async () => {
    const { instance } = await setup();
    instance.selectNodes(['c']);

    const resolved = instance.selectWithinPolygon(POLY_A, { additive: true });

    expect(resolved).toEqual(['a']); // the lasso's own ids, not the union
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'c']);
  });

  it('drops hidden ids from the resolved set', async () => {
    const { instance } = await setup();
    instance.hideNodes(['b']);

    const resolved = instance.selectWithinPolygon(POLY_AB);

    expect(resolved).toEqual(['a']);
    expect(instance.store.getState().selection.nodeIds).toEqual(['a']);
  });

  it('controlled selection: intent only — no store write, no engine push, ids still returned', async () => {
    const { instance, engine } = await setup();
    instance.applyHostUpdate({ selection: ['c'] }); // flips to controlled
    const pushesBefore = callsOf(engine, 'setSelectedIndices').length;
    const events: SelectionState[] = [];
    instance.on('selectionChange', (p) => events.push(p));

    const resolved = instance.selectWithinPolygon(POLY_AB);

    expect(resolved).toEqual(['a', 'b']);
    expect(instance.store.getState().selection.nodeIds).toEqual(['c']); // host still owns
    expect(callsOf(engine, 'setSelectedIndices')).toHaveLength(pushesBefore);
    expect(events).toHaveLength(1);
    expect(events[0]!.nodeIds).toEqual(['a', 'b']); // the intent
  });

  it('no-ops (empty result) when the engine lacks pointsInPolygon', async () => {
    const { instance } = makeStrippedInstance(['pointsInPolygon']);
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
    instance.selectNodes(['b']);

    expect(instance.selectWithinPolygon(POLY_AB)).toEqual([]);
    expect(instance.store.getState().selection.nodeIds).toEqual(['b']); // untouched
  });
});

describe('focusNode neighborhood', () => {
  const FOCUS_LINKS: ReadonlyArray<readonly [string, string]> = [
    ['a', 'b'],
    ['a', 'c'],
    ['b', 'd'],
  ];

  it('returns 1-hop neighbor ids via engine.neighborIndices and keeps v0.1 camera behavior', async () => {
    const { instance, engine } = await setup(FOCUS_LINKS, ['a', 'b', 'c', 'd']);

    const neighbors = instance.focusNode('a');

    expect(neighbors).toEqual(['b', 'c']);
    expect(callsOf(engine, 'neighborIndices')).toHaveLength(1);
    expect(callsOf(engine, 'setFocusedIndex').at(-1)!.args).toEqual([0]);
    expect(callsOf(engine, 'zoomToIndex').at(-1)!.args).toEqual([0]);
  });

  it('falls back to the core CSR adjacency when the engine lacks neighborIndices', async () => {
    const { instance } = makeStrippedInstance(['neighborIndices']);
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c', 'd'], FOCUS_LINKS) });

    expect(instance.focusNode('a')).toEqual(['b', 'c']);
    expect(instance.focusNode('d')).toEqual(['b']);

    // Adjacency cache invalidates on model change.
    instance.applyHostUpdate({
      data: snap(2, ['a', 'b', 'c', 'd'], [...FOCUS_LINKS, ['a', 'd']]),
    });
    expect(instance.focusNode('a')).toEqual(['b', 'c', 'd']);
  });

  it('highlights the [id, ...neighbors] ring ONLY when selection is empty and uncontrolled', async () => {
    const { instance, engine } = await setup(FOCUS_LINKS, ['a', 'b', 'c', 'd']);
    const events: unknown[] = [];
    instance.on('selectionChange', (p) => events.push(p));

    instance.focusNode('a');

    // Ring pushed through the engine's single highlight channel (documented
    // single-channel compromise) — but NEVER written to selection state.
    expect(callsOf(engine, 'setSelectedIndices').at(-1)!.args).toEqual([[0, 1, 2]]);
    expect(instance.store.getState().selection.nodeIds).toEqual([]);
    expect(events).toHaveLength(0);
  });

  it('does not push the ring when a selection exists, when opted out, or when controlled', async () => {
    const { instance, engine } = await setup(FOCUS_LINKS, ['a', 'b', 'c', 'd']);

    instance.selectNodes(['d']);
    let pushes = callsOf(engine, 'setSelectedIndices').length;
    expect(instance.focusNode('a')).toEqual(['b', 'c']); // ids still returned
    expect(callsOf(engine, 'setSelectedIndices')).toHaveLength(pushes);

    instance.clearSelection();
    pushes = callsOf(engine, 'setSelectedIndices').length;
    expect(instance.focusNode('a', { highlightNeighbors: false })).toEqual(['b', 'c']);
    expect(callsOf(engine, 'setSelectedIndices')).toHaveLength(pushes);

    instance.applyHostUpdate({ selection: [] }); // controlled, empty
    pushes = callsOf(engine, 'setSelectedIndices').length;
    expect(instance.focusNode('a')).toEqual(['b', 'c']);
    expect(callsOf(engine, 'setSelectedIndices')).toHaveLength(pushes);
  });

  it('returns [] for unknown ids and before ready', async () => {
    const h = makeInstance();
    expect(h.instance.focusNode('a')).toEqual([]); // pre-attach
    await h.instance.attach(container);
    h.instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
    expect(h.instance.focusNode('missing')).toEqual([]);
  });
});

describe('drag-pin built-in follow-up', () => {
  it('drag end pins at the release position: pins slice + mapped engine push', async () => {
    const { instance, engine } = await setup();
    const drags: Array<{ id: string; x: number; y: number }> = [];
    instance.on('nodeDragStart', (p) => drags.push({ id: p.node.id, x: NaN, y: NaN }));
    instance.on('nodeDragEnd', (p) => drags.push({ id: p.node.id, x: p.x, y: p.y }));

    engine.injectDragStart(1);
    engine.injectDragEnd(1, 33, 44);

    expect(drags).toEqual([
      { id: 'b', x: NaN, y: NaN },
      { id: 'b', x: 33, y: 44 },
    ]);
    expect(instance.store.getState().pins.get('b')).toEqual([33, 44]);
    expect(callsOf(engine, 'setPinnedIndices').at(-1)!.args).toEqual([[1]]);
  });

  it('preventDefault on nodeDragEnd cancels the pin', async () => {
    const { instance, engine } = await setup();
    instance.on('nodeDragEnd', (_p, control) => control.preventDefault());

    engine.injectDragEnd(1, 33, 44);

    expect(instance.store.getState().pins.size).toBe(0);
    expect(callsOf(engine, 'setPinnedIndices')).toHaveLength(0);
  });

  it('the pinned position survives a structural snapshot swap with freshly mapped indices', async () => {
    const { instance, engine } = await setup();
    engine.injectDragEnd(1, 33, 44); // pin b at (33, 44)

    // Structural swap: 'z' prepended shifts b from index 1 to index 2.
    instance.applyHostUpdate({ data: snap(2, ['z', 'a', 'b'], [['a', 'b']]) });

    const structure = engine.lastCommit!.structure!;
    expect(structure.pointCount).toBe(3);
    expect(structure.positions[4]).toBe(33); // b's position, at its NEW slot
    expect(structure.positions[5]).toBe(44);
    expect(callsOf(engine, 'setPinnedIndices').at(-1)!.args).toEqual([[2]]);
    expect(instance.store.getState().pins.get('b')).toEqual([33, 44]);
  });

  it('context recovery replays a drag-created pin: position and index re-applied', async () => {
    const { instance, engine } = await setup();
    engine.injectDragEnd(1, 33, 44);

    engine.injectContextLost();
    engine.injectContextRestored();

    expect(instance.store.getState().status).toBe('ready');
    const structure = engine.lastCommit!.structure!;
    expect(structure.positions[2]).toBe(33); // b at index 1 in the replay
    expect(structure.positions[3]).toBe(44);
    expect(callsOf(engine, 'setPinnedIndices').at(-1)!.args).toEqual([[1]]);
    expect(engine.pinnedIndices).toEqual([1]);
    expect(instance.store.getState().pins.get('b')).toEqual([33, 44]);
  });

  it('a drag-created pin outlives a settle readback from an engine that ignores pins', async () => {
    const { instance, engine } = await setup();
    engine.injectDragEnd(1, 33, 44);

    // FakeEngine never mirrors pins into its position buffer; the settle
    // readback must not clobber the pinned coordinates in the cache.
    engine.nudgePositions(1, 1);
    engine.injectSimulationEnd();

    instance.applyHostUpdate({ data: snap(2, ['a', 'b', 'c', 'd'], [['a', 'b']]) });
    const structure = engine.lastCommit!.structure!;
    expect(structure.positions[2]).toBe(33);
    expect(structure.positions[3]).toBe(44);
    expect(structure.positions[0]).toBe(1); // unpinned nodes keep the settle drift
    expect(structure.positions[1]).toBe(1);
  });

  it('unpinNode releases a drag-created pin through the existing mutator', async () => {
    const { instance, engine } = await setup();
    engine.injectDragEnd(1, 33, 44);
    expect(instance.store.getState().pins.size).toBe(1);

    instance.unpinNode('b');

    expect(instance.store.getState().pins.size).toBe(0);
    expect(callsOf(engine, 'setPinnedIndices').at(-1)!.args).toEqual([null]);
  });
});

// ---------------------------------------------------------------------------
// DOM-presenter context-menu behavior (requestNodeContextMenu)
// ---------------------------------------------------------------------------

describe('requestNodeContextMenu', () => {
  it('emits the SAME typed contextMenu event the canvas gesture produces', async () => {
    const { instance } = await setup();
    const events: unknown[] = [];
    instance.on('contextMenu', (p) => events.push(p));

    instance.requestNodeContextMenu('a', [120, 44]);

    expect(events).toHaveLength(1);
    const payload = events[0] as {
      target: { kind: string; node?: { id: string } };
      screen: readonly [number, number];
    };
    expect(payload.target.kind).toBe('node');
    expect(payload.target.node!.id).toBe('a');
    expect(payload.screen).toEqual([120, 44]);
  });

  it('is a silent no-op for unknown ids — a stale presenter is data, not an error', async () => {
    const { instance } = await setup();
    const events: unknown[] = [];
    instance.on('contextMenu', (p) => events.push(p));

    instance.requestNodeContextMenu('nope', [10, 10]);

    expect(events).toHaveLength(0);
    expect(instance.getDiagnostics().filter((d) => d.severity === 'error')).toEqual([]);
  });
});
