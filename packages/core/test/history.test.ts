/**
 * history command-stack kernel — value-diff commands,
 * transactions, coalescing, bounded stack, application seam, disabled mode.
 * Property-style tests drive random record/undo/redo/coalesce sequences
 * against a naive snapshot-per-step oracle over a simple two-slice model.
 */

import { describe, expect, it, vi } from 'vitest';

import { HISTORY_LIMIT_DEFAULT, HistoryKernel } from '../src/history';
import type { HistoryCommand, HistoryDepths } from '../src/history';

/** Deterministic PRNG (mulberry32) for property-style cases. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('HistoryKernel: record / undo / redo', () => {
  it('record → undo returns the inverted command and moves the cursor', () => {
    const kernel = new HistoryKernel();
    kernel.record('selection', ['a'], ['a', 'b']);
    expect(kernel.peekUndoDepth()).toBe(1);
    expect(kernel.peekRedoDepth()).toBe(0);

    const cmds = kernel.undo();
    expect(cmds).toEqual([{ slice: 'selection', before: ['a', 'b'], after: ['a'] }]);
    expect(kernel.peekUndoDepth()).toBe(0);
    expect(kernel.peekRedoDepth()).toBe(1);
  });

  it('redo replays the original commands in original order', () => {
    const kernel = new HistoryKernel();
    kernel.record('selection', ['a'], ['b']);
    kernel.undo();

    const cmds = kernel.redo();
    expect(cmds).toEqual([{ slice: 'selection', before: ['a'], after: ['b'] }]);
    expect(kernel.peekUndoDepth()).toBe(1);
    expect(kernel.peekRedoDepth()).toBe(0);
  });

  it('undo/redo return null at the ends of the stack', () => {
    const kernel = new HistoryKernel();
    expect(kernel.undo()).toBeNull();
    expect(kernel.redo()).toBeNull();
    kernel.record('selection', [], ['x']);
    expect(kernel.redo()).toBeNull(); // nothing undone yet
    kernel.undo();
    expect(kernel.undo()).toBeNull();
  });

  it('freezes stored and returned commands (kernel stores what it is given)', () => {
    const kernel = new HistoryKernel();
    kernel.record('selection', ['a'], ['b']);
    const cmds = kernel.undo()!;
    expect(Object.isFrozen(cmds)).toBe(true);
    expect(Object.isFrozen(cmds[0])).toBe(true);
    const replay = kernel.redo()!;
    expect(Object.isFrozen(replay)).toBe(true);
    expect(Object.isFrozen(replay[0])).toBe(true);
  });
});

describe('HistoryKernel: transactions', () => {
  it('multi-command transaction is one atomic entry, undone in reverse order', () => {
    const kernel = new HistoryKernel();
    kernel.begin('gesture');
    kernel.record('selection', [], ['a']);
    kernel.record('hidden', [], ['h1']);
    kernel.record('viewport', { x: 0 }, { x: 5 });
    kernel.end();

    expect(kernel.peekUndoDepth()).toBe(1); // one entry, not three

    const cmds = kernel.undo()!;
    expect(cmds).toEqual([
      { slice: 'viewport', before: { x: 5 }, after: { x: 0 } },
      { slice: 'hidden', before: ['h1'], after: [] },
      { slice: 'selection', before: ['a'], after: [] },
    ]);

    const replay = kernel.redo()!;
    expect(replay.map((c) => c.slice)).toEqual(['selection', 'hidden', 'viewport']);
  });

  it('record() outside a transaction is an implicit single-command transaction', () => {
    const kernel = new HistoryKernel();
    kernel.record('selection', [], ['a']);
    kernel.record('selection', ['a'], ['a', 'b']);
    expect(kernel.peekUndoDepth()).toBe(2);
    expect(kernel.undo()).toHaveLength(1);
    expect(kernel.undo()).toHaveLength(1);
  });

  it('nested begin() joins the outer transaction (depth-counted)', () => {
    const kernel = new HistoryKernel();
    kernel.begin('outer');
    kernel.record('selection', [], ['a']);
    kernel.begin('inner');
    kernel.record('hidden', [], ['h']);
    kernel.end(); // closes inner only
    expect(kernel.peekUndoDepth()).toBe(0); // outer still open
    kernel.record('viewport', 0, 1);
    kernel.end();

    expect(kernel.peekUndoDepth()).toBe(1);
    expect(kernel.undo()!.map((c) => c.slice)).toEqual(['viewport', 'hidden', 'selection']);
  });

  it('an empty transaction pushes no entry', () => {
    const kernel = new HistoryKernel();
    kernel.begin();
    kernel.end();
    expect(kernel.peekUndoDepth()).toBe(0);
  });

  it('unbalanced end() throws; undo/redo during an open transaction throw', () => {
    const kernel = new HistoryKernel();
    expect(() => kernel.end()).toThrow(/without a matching begin/);
    kernel.begin();
    expect(() => kernel.undo()).toThrow(/open transaction/);
    expect(() => kernel.redo()).toThrow(/open transaction/);
    kernel.end();
  });
});

describe('HistoryKernel: coalescing', () => {
  it('merges same-key transactions within the window: original before kept, after replaced', () => {
    let t = 0;
    const now = () => t;
    const kernel = new HistoryKernel();

    kernel.beginCoalesced('camera', 100, now);
    kernel.record('viewport', { x: 0 }, { x: 1 });
    kernel.end();

    t = 60;
    kernel.beginCoalesced('camera', 100, now);
    kernel.record('viewport', { x: 1 }, { x: 2 });
    kernel.end();

    expect(kernel.peekUndoDepth()).toBe(1);
    expect(kernel.undo()).toEqual([{ slice: 'viewport', before: { x: 2 }, after: { x: 0 } }]);
  });

  it('each merge refreshes the window anchor (continuous drag keeps coalescing)', () => {
    let t = 0;
    const now = () => t;
    const kernel = new HistoryKernel();
    for (const [time, x] of [
      [0, 1],
      [90, 2],
      [180, 3],
    ] as const) {
      t = time;
      kernel.beginCoalesced('camera', 100, now);
      kernel.record('viewport', { x: x - 1 }, { x });
      kernel.end();
    }
    // 0→90 and 90→180 are each within the window even though 0→180 is not.
    expect(kernel.peekUndoDepth()).toBe(1);
    expect(kernel.undo()).toEqual([{ slice: 'viewport', before: { x: 3 }, after: { x: 0 } }]);
  });

  it('does NOT merge across the window', () => {
    let t = 0;
    const now = () => t;
    const kernel = new HistoryKernel();

    kernel.beginCoalesced('camera', 100, now);
    kernel.record('viewport', { x: 0 }, { x: 1 });
    kernel.end();

    t = 101;
    kernel.beginCoalesced('camera', 100, now);
    kernel.record('viewport', { x: 1 }, { x: 2 });
    kernel.end();

    expect(kernel.peekUndoDepth()).toBe(2);
  });

  it('does NOT merge across different keys', () => {
    let t = 0;
    const now = () => t;
    const kernel = new HistoryKernel();

    kernel.beginCoalesced('camera', 100, now);
    kernel.record('viewport', { x: 0 }, { x: 1 });
    kernel.end();

    t = 10;
    kernel.beginCoalesced('timeline', 100, now);
    kernel.record('viewport', { x: 1 }, { x: 2 });
    kernel.end();

    expect(kernel.peekUndoDepth()).toBe(2);
  });

  it('a slice new to the merged entry is appended, existing slices are collapsed', () => {
    let t = 0;
    const now = () => t;
    const kernel = new HistoryKernel();

    kernel.beginCoalesced('play', 100, now);
    kernel.record('viewport', { x: 0 }, { x: 1 });
    kernel.end();

    t = 20;
    kernel.beginCoalesced('play', 100, now);
    kernel.record('timeline', 0, 5);
    kernel.record('viewport', { x: 1 }, { x: 2 });
    kernel.end();

    expect(kernel.peekUndoDepth()).toBe(1);
    expect(kernel.undo()).toEqual([
      { slice: 'timeline', before: 5, after: 0 },
      { slice: 'viewport', before: { x: 2 }, after: { x: 0 } },
    ]);
  });

  it('merge replaces the LAST command per slice when the prior entry touched it twice', () => {
    let t = 0;
    const now = () => t;
    const kernel = new HistoryKernel();

    kernel.beginCoalesced('play', 100, now);
    kernel.record('hidden', ['n1'], ['n9']);
    kernel.record('hidden', ['n9'], ['n0']);
    kernel.end();

    t = 10;
    kernel.beginCoalesced('play', 100, now);
    kernel.record('hidden', ['n0'], []);
    kernel.end();

    expect(kernel.peekUndoDepth()).toBe(1);
    // Undo lands on the original before...
    const undone = kernel.undo()!;
    expect(undone[undone.length - 1]).toEqual({ slice: 'hidden', before: ['n9'], after: ['n1'] });
    //...and redo replays to the merged net after (not a stale intermediate).
    const replay = kernel.redo()!;
    expect(replay[replay.length - 1]).toEqual({ slice: 'hidden', before: ['n9'], after: [] });
  });

  it('undo breaks the coalescing chain (no merge into a stale top entry)', () => {
    let t = 0;
    const now = () => t;
    const kernel = new HistoryKernel();

    kernel.beginCoalesced('camera', 100, now);
    kernel.record('viewport', { x: 0 }, { x: 1 });
    kernel.end();

    kernel.undo();

    t = 10;
    kernel.beginCoalesced('camera', 100, now);
    kernel.record('viewport', { x: 0 }, { x: 9 });
    kernel.end();

    // The undone entry was discarded (redo cleared); the new one is separate.
    expect(kernel.peekUndoDepth()).toBe(1);
    expect(kernel.peekRedoDepth()).toBe(0);
    expect(kernel.undo()).toEqual([{ slice: 'viewport', before: { x: 9 }, after: { x: 0 } }]);
  });

  it('a redone entry never re-coalesces', () => {
    let t = 0;
    const now = () => t;
    const kernel = new HistoryKernel();

    kernel.beginCoalesced('camera', 100, now);
    kernel.record('viewport', { x: 0 }, { x: 1 });
    kernel.end();
    kernel.undo();
    kernel.redo();

    t = 10;
    kernel.beginCoalesced('camera', 100, now);
    kernel.record('viewport', { x: 1 }, { x: 2 });
    kernel.end();

    expect(kernel.peekUndoDepth()).toBe(2);
  });

  it('an intervening non-coalesced entry breaks the chain', () => {
    let t = 0;
    const now = () => t;
    const kernel = new HistoryKernel();

    kernel.beginCoalesced('camera', 100, now);
    kernel.record('viewport', { x: 0 }, { x: 1 });
    kernel.end();

    kernel.record('selection', [], ['a']);

    t = 10;
    kernel.beginCoalesced('camera', 100, now);
    kernel.record('viewport', { x: 1 }, { x: 2 });
    kernel.end();

    expect(kernel.peekUndoDepth()).toBe(3);
  });
});

describe('HistoryKernel: bounds and redo invalidation', () => {
  it('defaults to a limit of 50', () => {
    expect(HISTORY_LIMIT_DEFAULT).toBe(50);
    const kernel = new HistoryKernel();
    for (let i = 0; i < 60; i++) kernel.record('n', i, i + 1);
    expect(kernel.peekUndoDepth()).toBe(50);
  });

  it('the 51st entry evicts the oldest; depths stay correct', () => {
    const kernel = new HistoryKernel({ limit: 50 });
    for (let i = 0; i < 51; i++) kernel.record('n', i, i + 1);
    expect(kernel.peekUndoDepth()).toBe(50);

    let last: readonly HistoryCommand[] | null = null;
    let steps = 0;
    for (let cmds = kernel.undo(); cmds !== null; cmds = kernel.undo()) {
      last = cmds;
      steps++;
    }
    expect(steps).toBe(50);
    // Entry 0 (0→1) was evicted; the oldest remaining recorded 1→2.
    expect(last).toEqual([{ slice: 'n', before: 2, after: 1 }]);
    expect(kernel.peekUndoDepth()).toBe(0);
    expect(kernel.peekRedoDepth()).toBe(50);
  });

  it('a new entry clears the redo stack', () => {
    const kernel = new HistoryKernel();
    kernel.record('s', 0, 1);
    kernel.record('s', 1, 2);
    kernel.undo();
    expect(kernel.peekRedoDepth()).toBe(1);

    kernel.record('s', 1, 9);
    expect(kernel.peekRedoDepth()).toBe(0);
    expect(kernel.redo()).toBeNull();
    expect(kernel.peekUndoDepth()).toBe(2);
  });

  it('clear() empties both stacks and any pending transaction', () => {
    const kernel = new HistoryKernel();
    kernel.record('s', 0, 1);
    kernel.record('s', 1, 2);
    kernel.undo();
    kernel.begin();
    kernel.record('s', 1, 5);
    kernel.clear();

    expect(kernel.peekUndoDepth()).toBe(0);
    expect(kernel.peekRedoDepth()).toBe(0);
    expect(kernel.undo()).toBeNull();
    expect(kernel.redo()).toBeNull();
    expect(() => kernel.end()).toThrow(); // pending transaction was dropped
  });

  it('rejects a non-positive or fractional limit', () => {
    expect(() => new HistoryKernel({ limit: 0 })).toThrow(RangeError);
    expect(() => new HistoryKernel({ limit: 1.5 })).toThrow(RangeError);
  });
});

describe('HistoryKernel: depth subscription', () => {
  it('notifies on depth changes only, with the current depths', () => {
    const kernel = new HistoryKernel();
    const seen: HistoryDepths[] = [];
    const unsubscribe = kernel.subscribe((d) => seen.push(d));

    kernel.begin();
    kernel.end(); // empty: no depth change, no notification
    expect(seen).toEqual([]);

    kernel.record('s', 0, 1);
    kernel.undo();
    kernel.redo();
    kernel.clear();
    expect(seen).toEqual([
      { undoDepth: 1, redoDepth: 0 },
      { undoDepth: 0, redoDepth: 1 },
      { undoDepth: 1, redoDepth: 0 },
      { undoDepth: 0, redoDepth: 0 },
    ]);

    unsubscribe();
    kernel.record('s', 1, 2);
    expect(seen).toHaveLength(4);
  });

  it('a coalesced merge with unchanged depths emits no notification', () => {
    let t = 0;
    const now = () => t;
    const kernel = new HistoryKernel();
    const cb = vi.fn();
    kernel.subscribe(cb);

    kernel.beginCoalesced('camera', 100, now);
    kernel.record('viewport', 0, 1);
    kernel.end();
    expect(cb).toHaveBeenCalledTimes(1);

    t = 10;
    kernel.beginCoalesced('camera', 100, now);
    kernel.record('viewport', 1, 2);
    kernel.end();
    expect(cb).toHaveBeenCalledTimes(1); // merged: depths unchanged
  });
});

describe('HistoryKernel: disabled mode (history: false)', () => {
  it('record/begin/end/undo/redo are inert and depths stay 0', () => {
    const kernel = new HistoryKernel({ enabled: false });
    const cb = vi.fn();
    kernel.subscribe(cb);

    kernel.begin('label');
    kernel.record('s', 0, 1);
    kernel.end();
    kernel.record('s', 1, 2);
    kernel.beginCoalesced('camera', 100, () => 0);
    kernel.record('viewport', 0, 1);
    kernel.end();
    expect(() => kernel.end()).not.toThrow(); // no-op, no bookkeeping to violate

    expect(kernel.peekUndoDepth()).toBe(0);
    expect(kernel.peekRedoDepth()).toBe(0);
    expect(kernel.undo()).toBeNull();
    expect(kernel.redo()).toBeNull();
    kernel.clear();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('HistoryKernel: DEV serializability assert (debug flag)', () => {
  it('fires on a function payload', () => {
    const kernel = new HistoryKernel({ debug: true });
    expect(() => kernel.record('selection', ['a'], () => ['b'])).toThrow(TypeError);
    expect(() => kernel.record('selection', () => ['a'], ['b'])).toThrow(/function/);
    expect(kernel.peekUndoDepth()).toBe(0); // nothing was recorded
  });

  it('fires on Map/Set (nested too) and on cycles; passes plain data', () => {
    const kernel = new HistoryKernel({ debug: true });
    expect(() => kernel.record('pins', new Map(), [])).toThrow(/Map/);
    expect(() => kernel.record('hidden', [], { nested: new Set(['x']) })).toThrow(/Set/);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => kernel.record('s', cyclic, [])).toThrow(/cycle/);

    expect(() =>
      kernel.record('s', { deep: [{ n: 1, s: 'x', b: true, nil: null, u: undefined }] }, [1, 2]),
    ).not.toThrow();
    expect(kernel.peekUndoDepth()).toBe(1);
  });

  it('does not walk payloads without the debug flag', () => {
    const kernel = new HistoryKernel();
    expect(() => kernel.record('selection', ['a'], () => ['b'])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Property test: random record/undo/redo/coalesce sequences vs a naive
// snapshot-per-step oracle over a simple { selection, hidden } model.
// ---------------------------------------------------------------------------

type Model = { selection: readonly string[]; hidden: readonly string[] };
const SLICES = ['selection', 'hidden'] as const;

function cloneModel(m: Model): Model {
  return { selection: [...m.selection], hidden: [...m.hidden] };
}

function applyCommands(m: Model, cmds: readonly HistoryCommand[]): Model {
  let next: Model = { ...m };
  for (const c of cmds) next = { ...next, [c.slice]: c.after as readonly string[] };
  return next;
}

describe('HistoryKernel: property test against snapshot oracle', () => {
  const LIMIT = 5;
  const WINDOW = 100;
  const STEPS = 300;

  it.each([[1], [7], [42], [1337]])('seed %i: model always matches the oracle', (seed) => {
    const rand = rng(seed);
    const int = (n: number) => Math.floor(rand() * n);
    const value = (): string[] => Array.from({ length: int(4) }, () => `n${int(10)}`);

    let t = 0;
    const now = () => t;
    const kernel = new HistoryKernel({ limit: LIMIT });

    let model: Model = { selection: [], hidden: [] };
    // Oracle: timeline of full snapshots, cursor at the current state, plus a
    // coalescing anchor mirroring "last op was a push with this tag".
    const timeline: Model[] = [cloneModel(model)];
    let cursor = 0;
    let lastTag: { key: string; time: number } | null = null;

    const mutate = (): void => {
      const slice = SLICES[int(SLICES.length)]!;
      const next = value();
      kernel.record(slice, model[slice], next);
      model = { ...model, [slice]: next };
    };

    const oraclePush = (tag: { key: string; time: number } | null): void => {
      timeline.splice(cursor + 1); // any new entry discards the redo branch
      const merge = tag !== null && lastTag !== null && lastTag.key === tag.key && tag.time - lastTag.time <= WINDOW;
      if (merge) {
        timeline[cursor] = cloneModel(model); // original before kept implicitly
      } else {
        timeline.push(cloneModel(model));
        cursor++;
        if (timeline.length - 1 > LIMIT) {
          timeline.shift(); // eviction of the oldest entry
          cursor--;
        }
      }
      lastTag = tag;
    };

    for (let step = 0; step < STEPS; step++) {
      const r = rand();
      if (r < 0.25) {
        // implicit single-command transaction
        mutate();
        oraclePush(null);
      } else if (r < 0.45) {
        // explicit multi-command transaction (sometimes nested)
        kernel.begin('txn');
        mutate();
        if (rand() < 0.5) {
          kernel.begin('inner');
          mutate();
          kernel.end();
        }
        if (rand() < 0.5) mutate();
        kernel.end();
        oraclePush(null);
      } else if (r < 0.7) {
        // coalesced transaction with a fake clock
        t += int(160); // sometimes inside the window, sometimes past it
        const key = rand() < 0.7 ? 'drag' : 'other';
        kernel.beginCoalesced(key, WINDOW, now);
        mutate();
        if (rand() < 0.4) mutate();
        kernel.end();
        oraclePush({ key, time: t });
      } else if (r < 0.85) {
        const cmds = kernel.undo();
        if (cursor === 0) {
          expect(cmds).toBeNull();
        } else {
          expect(cmds).not.toBeNull();
          model = applyCommands(model, cmds!);
          cursor--;
          expect(model).toEqual(timeline[cursor]);
          lastTag = null;
        }
      } else if (r < 0.98) {
        const cmds = kernel.redo();
        if (cursor === timeline.length - 1) {
          expect(cmds).toBeNull();
        } else {
          expect(cmds).not.toBeNull();
          model = applyCommands(model, cmds!);
          cursor++;
          expect(model).toEqual(timeline[cursor]);
          lastTag = null;
        }
      } else {
        kernel.clear();
        timeline.length = 0;
        timeline.push(cloneModel(model));
        cursor = 0;
        lastTag = null;
      }

      // Depths must track the oracle after every step.
      expect(kernel.peekUndoDepth()).toBe(cursor);
      expect(kernel.peekRedoDepth()).toBe(timeline.length - 1 - cursor);
    }

    // Drain: walking all the way down and back up reproduces both endpoints.
    for (let cmds = kernel.undo(); cmds !== null; cmds = kernel.undo()) {
      model = applyCommands(model, cmds);
      cursor--;
    }
    expect(cursor).toBe(0);
    expect(model).toEqual(timeline[0]);
    for (let cmds = kernel.redo(); cmds !== null; cmds = kernel.redo()) {
      model = applyCommands(model, cmds);
      cursor++;
    }
    expect(cursor).toBe(timeline.length - 1);
    expect(model).toEqual(timeline[timeline.length - 1]);
  });
});
