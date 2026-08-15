/**
 * timeline playback — fake timers.
 *
 * playTimeline drives a brush window across a numeric/temporal dimension's
 * domain through the crossfilter → mask fast path (zero relayout): a
 * setTimeout CHAIN advancing by `step` of the domain per `tickMs`; one
 * playing dimension; a USER brush on the playing key pauses; loop wraps or
 * playback stops at the end; pause/destroy leak no timers; one play session
 * coalesces into ONE history entry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGraphInstance } from '../src/instance';
import { FakeEngine } from '../src/testing/index';
import type { DimensionSpec, GraphSnapshot } from '../src/types';
import { container } from './helpers';

type NA = { t: number; u: number };
type EA = Record<string, never>;

const tDim: DimensionSpec<NA> = { key: 't', kind: 'numeric', get: (n) => n.attrs?.t };
const uDim: DimensionSpec<NA> = { key: 'u', kind: 'numeric', get: (n) => n.attrs?.u };
const catDim: DimensionSpec<NA> = { key: 'cat', kind: 'categorical', get: (n) => n.id };

/** 11 nodes, t = 0,10,…,100 (domain [0,100]); u mirrors t. */
function timeSnap(): GraphSnapshot<NA, EA> {
  return {
    datasetKey: 'ds',
    sourceRevision: 1,
    nodes: Array.from({ length: 11 }, (_, i) => ({
      id: `n${i}`,
      attrs: { t: i * 10, u: i * 10 },
    })),
    edges: [],
  };
}

async function readyRig() {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance<NA, EA>({
    engine: () => {
      const e = new FakeEngine();
      engines.push(e);
      return e;
    },
  });
  await instance.attach(container);
  instance.applyHostUpdate({ data: timeSnap(), crossfilter: [tDim, uDim, catDim] });
  const session = instance.getCrossfilterSession()!;
  return { instance, engines, engine: engines[0]!, session };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('playTimeline', () => {
  it('requires a crossfilter dimension with a numeric/temporal domain', async () => {
    const { instance } = await readyRig();
    expect(() => instance.playTimeline('cat')).toThrow(TypeError);
    expect(() => instance.playTimeline('nope')).toThrow(/unknown dimension/);

    const bare = createGraphInstance<NA, EA>({ engine: () => new FakeEngine() });
    expect(() => bare.playTimeline('t')).toThrow(TypeError);
  });

  it('invalid playback options reject BEFORE any state mutates or a timer schedules', async () => {
    const { instance } = await readyRig();
    const bad: ReadonlyArray<Partial<import('../src/types').TimelinePlayback>> = [
      { tickMs: 0 }, // would busy-loop setTimeout
      { tickMs: -5 },
      { tickMs: Number.NaN },
      { tickMs: Number.POSITIVE_INFINITY },
      { step: 0 }, // never terminates
      { step: -0.1 },
      { step: Number.NaN },
      { window: Number.NEGATIVE_INFINITY },
      { window: -1 },
      { window: Number.NaN },
      { mode: 'zigzag' as never },
    ];
    for (const playback of bad) {
      expect(() => instance.playTimeline('t', playback)).toThrow(TypeError);
      expect(instance.store.getState().timeline.playingKey).toBeNull();
      expect(vi.getTimerCount()).toBe(0); // nothing scheduled
    }

    // A VALID play still starts (the guard rejects only bad options)…
    instance.playTimeline('t', { tickMs: 50, step: 0.5 });
    expect(instance.store.getState().timeline.playingKey).toBe('t');
    // …and a subsequent INVALID call rejects without killing the live one.
    expect(() => instance.playTimeline('t', { tickMs: 0 })).toThrow(TypeError);
    expect(instance.store.getState().timeline.playingKey).toBe('t');
    instance.pauseTimeline();
  });

  it('sliding mode advances a fixed window by step·domain per tick', async () => {
    const { instance, session } = await readyRig();
    instance.playTimeline('t', { tickMs: 100, step: 0.25, window: 10 });

    expect(instance.store.getState().timeline.playingKey).toBe('t');
    expect(session.getBrush('t')).toEqual({ min: 0, max: 10 });
    expect(instance.store.getState().visible.nodes).toBe(2); // n0, n1

    vi.advanceTimersByTime(100);
    expect(session.getBrush('t')).toEqual({ min: 25, max: 35 });
    vi.advanceTimersByTime(100);
    expect(session.getBrush('t')).toEqual({ min: 50, max: 60 });
  });

  it('sliding default window is domain/10', async () => {
    const { instance, session } = await readyRig();
    instance.playTimeline('t', { tickMs: 100, step: 0.5 });
    expect(session.getBrush('t')).toEqual({ min: 0, max: 10 }); // span 100 → window 10
  });

  it('cumulative mode grows from the domain start', async () => {
    const { instance, session } = await readyRig();
    instance.playTimeline('t', { mode: 'cumulative', tickMs: 100, step: 0.5 });

    expect(session.getBrush('t')).toEqual({ min: 0, max: 0 });
    vi.advanceTimersByTime(100);
    expect(session.getBrush('t')).toEqual({ min: 0, max: 50 });
    vi.advanceTimersByTime(100);
    expect(session.getBrush('t')).toEqual({ min: 0, max: 100 });
    expect(instance.store.getState().visible.nodes).toBe(11);
  });

  it('stops at the end (playingKey → null, no timers left) without loop', async () => {
    const { instance, session } = await readyRig();
    instance.playTimeline('t', { mode: 'cumulative', tickMs: 100, step: 0.5 });

    vi.advanceTimersByTime(200); // progress 0.5 → 1.0
    expect(instance.store.getState().timeline.playingKey).toBe('t');
    vi.advanceTimersByTime(100); // progress 1.5 > 1 → stop
    expect(instance.store.getState().timeline.playingKey).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    // The final brush stays where playback ended.
    expect(session.getBrush('t')).toEqual({ min: 0, max: 100 });
  });

  it('loop: true wraps back to the domain start', async () => {
    const { instance, session } = await readyRig();
    instance.playTimeline('t', { tickMs: 100, step: 0.5, window: 10, loop: true });

    vi.advanceTimersByTime(200); // 0.5 → 1.0
    expect(session.getBrush('t')).toEqual({ min: 100, max: 110 });
    vi.advanceTimersByTime(100); // 1.5 > 1 → wrap to 0
    expect(session.getBrush('t')).toEqual({ min: 0, max: 10 });
    expect(instance.store.getState().timeline.playingKey).toBe('t');
    expect(vi.getTimerCount()).toBe(1); // still playing
  });

  it('one playing dimension: a second playTimeline supersedes the first', async () => {
    const { instance, session } = await readyRig();
    instance.playTimeline('t', { tickMs: 100, step: 0.25, window: 10 });
    instance.playTimeline('u', { tickMs: 100, step: 0.25, window: 10 });

    expect(instance.store.getState().timeline.playingKey).toBe('u');
    expect(vi.getTimerCount()).toBe(1); // the superseded chain was cleared
    const tBrush = session.getBrush('t');
    vi.advanceTimersByTime(300);
    expect(session.getBrush('t')).toEqual(tBrush); // frozen
    expect(session.getBrush('u')).toEqual({ min: 75, max: 85 }); // advancing
  });

  it('a USER setBrush on the playing key pauses playback', async () => {
    const { instance, session } = await readyRig();
    instance.playTimeline('t', { tickMs: 100, step: 0.25, window: 10 });

    await session.setBrush('t', { min: 5, max: 6 });

    expect(instance.store.getState().timeline.playingKey).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(session.getBrush('t')).toEqual({ min: 5, max: 6 });
    vi.advanceTimersByTime(500);
    expect(session.getBrush('t')).toEqual({ min: 5, max: 6 }); // stays paused

    // A user brush on a NON-playing key does not pause.
    instance.playTimeline('t', { tickMs: 100, step: 0.25, window: 10 });
    await session.setBrush('u', { min: 0, max: 100 });
    expect(instance.store.getState().timeline.playingKey).toBe('t');
  });

  it('pauseTimeline and destroy clear the timer chain', async () => {
    const { instance } = await readyRig();
    instance.playTimeline('t', { tickMs: 100 });
    instance.pauseTimeline();
    expect(instance.store.getState().timeline.playingKey).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    instance.playTimeline('t', { tickMs: 100 });
    expect(vi.getTimerCount()).toBe(1);
    instance.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('detach clears the timer and resets playingKey', async () => {
    const { instance } = await readyRig();
    instance.playTimeline('t', { tickMs: 100 });
    instance.detach();
    expect(instance.store.getState().timeline.playingKey).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a datasetKey change stops playback and clears the timer', async () => {
    const { instance } = await readyRig();
    instance.playTimeline('t', { tickMs: 100 });
    instance.applyHostUpdate({ data: { ...timeSnap(), datasetKey: 'ds2' } });
    expect(instance.store.getState().timeline.playingKey).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the WHOLE play session coalesces into ONE history entry', async () => {
    const { instance, session } = await readyRig();
    expect(instance.store.getState().history).toEqual({ undoDepth: 0, redoDepth: 0 });

    instance.playTimeline('t', { tickMs: 100, step: 0.25, window: 10 });
    vi.advanceTimersByTime(300); // three more ticks merge into the same entry
    instance.pauseTimeline();

    expect(instance.store.getState().history).toEqual({ undoDepth: 1, redoDepth: 0 });
    expect(instance.undo()).toBe(true);
    expect(session.getBrush('t')).toBeNull(); // back to the pre-play brush
    expect(instance.store.getState().visible.nodes).toBe(11);

    // A SECOND play session is a separate entry (session-scoped key).
    instance.playTimeline('t', { tickMs: 100, step: 0.5, window: 10 });
    instance.pauseTimeline();
    instance.playTimeline('t', { tickMs: 100, step: 0.5, window: 20 });
    instance.pauseTimeline();
    expect(instance.store.getState().history.undoDepth).toBe(2);
  });

  it('ticks drive the mask fast path: buffers-only commits, model untouched', async () => {
    const { instance, engine } = await readyRig();
    const revBefore = instance.getRevisions();
    const commitsBefore = engine.commits.length;

    instance.playTimeline('t', { tickMs: 100, step: 0.25, window: 10 });
    vi.advanceTimersByTime(200);

    for (const commit of engine.commits.slice(commitsBefore)) {
      expect(commit.structure).toBeUndefined();
      expect(commit.restart).toBeUndefined();
    }
    expect(instance.getRevisions().model).toBe(revBefore.model);
    expect(instance.getRevisions().render).toBeGreaterThan(revBefore.render);
  });
});
