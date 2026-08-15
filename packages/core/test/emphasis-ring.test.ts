/**
 * emphasis ring — taking control of a surface that was already half-on.
 *
 * The focused-point ring has followed pointer hover since v0.1 (cosmos draws
 * it whenever `setFocusedIndex` is set — no boolean gate). This slice NAMES
 * it: one theme token (`theme.emphasisRing`), one host toggle
 * (`emphasisRing`, default true), one camera-free driver (`emphasizeNode`).
 * These tests pin the contract's OTHER side too: the toggle must suppress
 * every driver (hover, focusNode, emphasizeNode, structural re-applies)
 * through the single applyEmphasis gate, with exactly one clearing write.
 */

import { describe, expect, it } from 'vitest';

import { callsOf, container, makeInstance, snap } from './helpers';
import type { InstanceHarness } from './helpers';
import type { FakeEngine } from '../src/testing/index';

interface ReadyHarness extends InstanceHarness {
  engine: FakeEngine;
}

async function setup(): Promise<ReadyHarness> {
  const h = makeInstance({ fitViewOnFirstData: false });
  await h.instance.attach(container);
  h.instance.applyHostUpdate({
    data: snap(1, ['a', 'b', 'c'], [
      ['a', 'b'],
      ['b', 'c'],
    ]),
  });
  return { ...h, engine: h.engines[0]! };
}

const ringCalls = (engine: FakeEngine) => callsOf(engine, 'setFocusedIndex');

describe('emphasizeNode', () => {
  it('rings without the camera: setFocusedIndex only, no zoom, no selection push', async () => {
    const { instance, engine } = await setup();
    const zoomsBefore = callsOf(engine, 'zoomToIndex').length;
    const selectionsBefore = callsOf(engine, 'setSelectedIndices').length;

    instance.emphasizeNode('b');

    expect(ringCalls(engine).at(-1)!.args).toEqual([1]);
    expect(callsOf(engine, 'zoomToIndex')).toHaveLength(zoomsBefore);
    expect(callsOf(engine, 'setSelectedIndices')).toHaveLength(selectionsBefore);
  });

  it('null clears; unknown ids are a silent no-op', async () => {
    const { instance, engine } = await setup();
    instance.emphasizeNode('b');
    const before = ringCalls(engine).length;

    instance.emphasizeNode('nope'); // stale row racing a model swap = data
    expect(ringCalls(engine)).toHaveLength(before);

    instance.emphasizeNode(null);
    expect(ringCalls(engine).at(-1)!.args).toEqual([null]);
  });

  it('no-ops before attach instead of throwing', () => {
    const { instance } = makeInstance();
    expect(() => instance.emphasizeNode('a')).not.toThrow();
    expect(() => instance.emphasizeNode(null)).not.toThrow();
  });
});

describe('emphasisRing toggle', () => {
  it('OFF is exactly ONE clearing write; every driver then no-ops', async () => {
    const { instance, engine } = await setup();
    engine.injectPointHover(0); // live hover ring on a
    const before = ringCalls(engine).length;

    instance.applyHostUpdate({ emphasisRing: false });
    expect(ringCalls(engine)).toHaveLength(before + 1);
    expect(ringCalls(engine).at(-1)!.args).toEqual([null]);

    // Re-sending false is no change — no second clearing write.
    instance.applyHostUpdate({ emphasisRing: false });
    expect(ringCalls(engine)).toHaveLength(before + 1);

    // Hover still publishes STATE (hover is data; only the visual is gated)…
    engine.injectPointHover(1);
    expect(instance.store.getState().hover.nodeId).toBe('b');
    // …but no driver reaches the engine ring.
    instance.emphasizeNode('c');
    const neighbors = instance.focusNode('a');
    expect(neighbors).toEqual(['b']); // focusNode keeps zoom + neighbors
    expect(callsOf(engine, 'zoomToIndex').length).toBeGreaterThan(0);
    expect(ringCalls(engine)).toHaveLength(before + 1);
  });

  it('OFF gates the structural re-apply lane too', async () => {
    const { instance, engine } = await setup();
    engine.injectPointHover(1);
    instance.applyHostUpdate({ emphasisRing: false });
    const before = ringCalls(engine).length;

    // Structural change with the hovered node still present: the highlight
    // remap re-pushes selection/pins/hover — the hover ring must stay gated.
    instance.applyHostUpdate({
      data: snap(2, ['a', 'b', 'c', 'd'], [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'd'],
      ]),
    });
    expect(ringCalls(engine)).toHaveLength(before);
  });

  it('ON restores the current hover ring in the same update', async () => {
    const { instance, engine } = await setup();
    engine.injectPointHover(2); // hover c
    instance.applyHostUpdate({ emphasisRing: false });

    instance.applyHostUpdate({ emphasisRing: true });
    expect(ringCalls(engine).at(-1)!.args).toEqual([2]);
  });
});

describe('sticky keyboard emphasis — replay, prune, supersede', () => {
  it('survives a structural commit with a freshly mapped index (no hover active)', async () => {
    const { instance, engine } = await setup();
    instance.emphasizeNode('b'); // index 1 in the current scene

    // Full replace that REMAPS b: x prepended, b now at index 2.
    instance.applyHostUpdate({
      data: snap(2, ['x', 'a', 'b', 'c'], [
        ['a', 'b'],
        ['b', 'c'],
      ]),
    });
    expect(ringCalls(engine).at(-1)!.args).toEqual([2]);
  });

  it('a departed target prunes and NEVER resurrects when the id returns later', async () => {
    const { instance, engine } = await setup();
    instance.emphasizeNode('b');

    instance.applyHostUpdate({ data: snap(2, ['a', 'c'], [['a', 'c']]) }); // b departs
    const after = ringCalls(engine).length;

    instance.applyHostUpdate({ data: snap(3, ['a', 'b', 'c'], [['a', 'b']]) }); // b is back
    expect(ringCalls(engine)).toHaveLength(after); // …but the ring is not
  });

  it('pointer hover supersedes the sticky target — no replay after hover ends', async () => {
    const { instance, engine } = await setup();
    instance.emphasizeNode('b');
    engine.injectPointHover(0); // pointer takes the channel
    engine.injectPointHover(null); // and leaves — channel cleared
    const before = ringCalls(engine).length;

    // Structural change: hover is gone AND the keyboard target was
    // superseded, so NOTHING re-applies.
    instance.applyHostUpdate({
      data: snap(2, ['a', 'b', 'c', 'd'], [['a', 'b']]),
    });
    expect(ringCalls(engine)).toHaveLength(before);
  });

  it('context recovery replays the sticky target', async () => {
    const { instance, engine } = await setup();
    instance.emphasizeNode('c');
    const before = ringCalls(engine).length;

    engine.injectContextLost();
    engine.injectContextRestored();

    const restored = ringCalls(engine).slice(before);
    expect(restored.some((c) => c.args[0] === 2)).toBe(true);
  });

  it('toggling the ring back ON restores the sticky target when no hover exists', async () => {
    const { instance, engine } = await setup();
    instance.emphasizeNode('c');
    instance.applyHostUpdate({ emphasisRing: false });
    instance.applyHostUpdate({ emphasisRing: true });
    expect(ringCalls(engine).at(-1)!.args).toEqual([2]);
  });
});

describe('theme.emphasisRing token', () => {
  it('a lone token change flows as a config-only commit', async () => {
    const { instance, engine } = await setup();
    const commitsBefore = engine.commits.length;

    instance.applyHostUpdate({ theme: { emphasisRing: '#ff0000' } });

    expect(engine.commits.length).toBe(commitsBefore + 1);
    expect(engine.lastCommit!.config).toEqual({ emphasisRingColor: '#ff0000' });
    expect(engine.lastCommit!.buffers).toBeUndefined();
  });

  it('the mount replay always carries the token (dark default)', async () => {
    const { engines } = await setup();
    expect(engines[0]!.commits[0]!.config!.emphasisRingColor).toBe('#7aa2f7');
  });
});
