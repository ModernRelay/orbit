/**
 * label lane — pure candidate selector.
 *
 * Covers: zoom-LOD gate, showFor bypass-but-culled, capacity-first showFor
 * with accepted-base overload accounting, weight/degree ranking with
 * accepted-base tie-breaks, determinism, and viewport culling on both the
 * engine (pointsInRect) and CPU (spaceToScreen) paths.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  LABEL_MAX_VISIBLE_CAP,
  selectLabelCandidates,
} from '../src/labels';
import type { LabelCandidateViewport, SelectLabelCandidatesArgs } from '../src/labels';
import type { GraphNode, RenderScene } from '../src/types';

type NAttrs = { label?: string | null };

interface Fixture {
  scene: RenderScene;
  nodes: GraphNode<NAttrs>[];
  positions: Float32Array;
}

/** Scene in accepted-base order; node i sits at coords[i]; attrs.label = ID. */
function fixture(
  ids: readonly string[],
  coords: ReadonlyArray<readonly [number, number]>,
  links: ReadonlyArray<readonly [number, number]> = [],
): Fixture {
  const indexById = new Map(ids.map((id, i) => [id, i] as const));
  const positions = new Float32Array(2 * ids.length);
  ids.forEach((_, i) => {
    positions[2 * i] = coords[i]![0];
    positions[2 * i + 1] = coords[i]![1];
  });
  const linkBuf = new Uint32Array(2 * links.length);
  links.forEach(([s, t], k) => {
    linkBuf[2 * k] = s;
    linkBuf[2 * k + 1] = t;
  });
  const scene: RenderScene = {
    count: ids.length,
    linkCount: links.length,
    idByIndex: [...ids],
    indexById,
    edgeIdByIndex: links.map((_, k) => `e${k}`),
    positions,
    links: linkBuf,
  };
  const nodes = ids.map((id) => ({ id, attrs: { label: id.toUpperCase() } }));
  return { scene, nodes, positions };
}

const identity = (p: readonly [number, number]): readonly [number, number] => p;

/** Identity-projected viewport; omit `rect` for "size unknown → no cull". */
function vp(zoom: number, rect?: readonly [number, number, number, number]): LabelCandidateViewport {
  return rect === undefined ? { zoom } : { zoom, screenRect: rect, spaceToScreen: identity };
}

function degreeOfLinks(links: ReadonlyArray<readonly [number, number]>): (i: number) => number {
  return (i) => links.reduce((d, [s, t]) => d + (s === i ? 1 : 0) + (t === i ? 1 : 0), 0);
}

function select<N>(args: SelectLabelCandidatesArgs<N>) {
  return selectLabelCandidates(args);
}

function ids(result: { placements: readonly { id: string }[] }): string[] {
  return result.placements.map((p) => p.id);
}

describe('zoom-LOD gate', () => {
  const f = fixture(['a', 'b'], [[0, 0], [10, 10]]);

  it('is empty below the default minZoom of 1', () => {
    const r = select({ ...f, viewport: vp(0.5), config: {} });
    expect(r).toEqual({ placements: [], overloadCount: 0 });
  });

  it('labels at/above minZoom (custom threshold honored)', () => {
    expect(ids(select({ ...f, viewport: vp(1.9), config: { minZoom: 2 } }))).toEqual([]);
    expect(ids(select({ ...f, viewport: vp(2), config: { minZoom: 2 } }))).toEqual(['a', 'b']);
  });

  it('enabled:false empties the lane even with showFor', () => {
    const r = select({ ...f, viewport: vp(2), config: { enabled: false, showFor: ['a'] } });
    expect(r).toEqual({ placements: [], overloadCount: 0 });
  });
});

describe('showFor', () => {
  it('bypasses zoom-LOD but stays viewport-culled', () => {
    const f = fixture(['a', 'b', 'c'], [[10, 10], [100, 100], [20, 20]]);
    const r = select({
      ...f,
      viewport: vp(0.5, [0, 0, 50, 50]), // below minZoom 1; b is outside the rect
      config: { showFor: ['a', 'b'] },
    });
    // a: forced + visible; b: forced but culled; c: visible but LOD-gated.
    expect(r.placements).toEqual([{ id: 'a', text: 'A', forced: true }]);
    expect(r.overloadCount).toBe(0);
  });

  it('claims capacity first in accepted-base order and reports overload', () => {
    const f = fixture(['a', 'b', 'c'], [[0, 0], [1, 1], [2, 2]]);
    const r = select({
      ...f,
      viewport: vp(1),
      config: { maxVisible: 2, showFor: ['c', 'a', 'b'] }, // argument order loses
    });
    expect(r.placements).toEqual([
      { id: 'a', text: 'A', forced: true },
      { id: 'b', text: 'B', forced: true },
    ]);
    expect(r.overloadCount).toBe(1);
  });

  it('dedupes showFor and ignores unknown ids without overload', () => {
    const f = fixture(['a', 'b'], [[0, 0], [1, 1]]);
    const r = select({
      ...f,
      viewport: vp(1),
      config: { maxVisible: 1, showFor: ['a', 'a', 'ghost'] },
    });
    expect(ids(r)).toEqual(['a']);
    expect(r.overloadCount).toBe(0);
  });

  it('fills the remaining capacity with ranked non-forced nodes', () => {
    const f = fixture(['a', 'b', 'c', 'd'], [[0, 0], [1, 1], [2, 2], [3, 3]]);
    const weights: Record<string, number> = { a: 1, b: 5, c: 9, d: 0 };
    const r = select({
      ...f,
      viewport: vp(1),
      config: { maxVisible: 3, showFor: ['d'], getWeight: (n) => weights[n.id]! },
    });
    expect(r.placements).toEqual([
      { id: 'd', text: 'D', forced: true },
      { id: 'c', text: 'C', forced: false },
      { id: 'b', text: 'B', forced: false },
    ]);
  });
});

describe('ranking', () => {
  it('ranks by getWeight descending', () => {
    const f = fixture(['a', 'b', 'c'], [[0, 0], [1, 1], [2, 2]]);
    const weights: Record<string, number> = { a: 1, b: 3, c: 2 };
    const r = select({
      ...f,
      viewport: vp(1),
      config: { maxVisible: 2, getWeight: (n) => weights[n.id]! },
    });
    expect(ids(r)).toEqual(['b', 'c']);
  });

  it('defaults to degree via degreeOf', () => {
    const links: ReadonlyArray<readonly [number, number]> = [[0, 1], [0, 2], [0, 3], [1, 2]];
    const f = fixture(['a', 'b', 'c', 'd'], [[0, 0], [1, 1], [2, 2], [3, 3]], links);
    const r = select({ ...f, viewport: vp(1), config: { maxVisible: 2 }, degreeOf: degreeOfLinks(links) });
    // degrees: a=3, b=2, c=2, d=1 → a first, then b beats c on accepted-base tie.
    expect(ids(r)).toEqual(['a', 'b']);
  });

  it('breaks ties by accepted-base order (no degreeOf → all zero)', () => {
    const f = fixture(['z', 'y', 'x'], [[0, 0], [1, 1], [2, 2]]);
    const r = select({ ...f, viewport: vp(1), config: { maxVisible: 2 } });
    expect(ids(r)).toEqual(['z', 'y']);
  });

  it('is deterministic across repeated calls', () => {
    const links: ReadonlyArray<readonly [number, number]> = [[0, 1], [1, 2], [2, 3], [3, 0]];
    const f = fixture(['a', 'b', 'c', 'd'], [[0, 0], [1, 1], [2, 2], [3, 3]], links);
    const args: SelectLabelCandidatesArgs<NAttrs> = {
      ...f,
      viewport: vp(1),
      config: { maxVisible: 3, showFor: ['d'] },
      degreeOf: degreeOfLinks(links),
    };
    const first = select(args);
    for (let i = 0; i < 5; i++) expect(select(args)).toEqual(first);
  });
});

describe('viewport culling', () => {
  it('CPU path: culls via spaceToScreen against the rect and skips NaN positions', () => {
    const f = fixture(['in', 'out', 'unknown'], [[10, 10], [999, 10], [NaN, NaN]]);
    const r = select({ ...f, viewport: vp(1, [0, 0, 100, 100]), config: {} });
    expect(ids(r)).toEqual(['in']);
  });

  it('CPU path with no rect treats every known position as visible', () => {
    const f = fixture(['a', 'b', 'nan'], [[0, 0], [99999, 99999], [NaN, NaN]]);
    const r = select({ ...f, viewport: vp(1), config: {} });
    expect(ids(r)).toEqual(['a', 'b']);
  });

  it('engine path: pointsInRect decides visibility and receives the rect', () => {
    const f = fixture(['a', 'b', 'c'], [[0, 0], [1, 1], [2, 2]]);
    const pointsInRect = vi.fn(() => [2]);
    const r = select({
      ...f,
      viewport: vp(1, [0, 0, 100, 100]),
      config: {},
      pointsInRect,
    });
    expect(pointsInRect).toHaveBeenCalledExactlyOnceWith([0, 0, 100, 100]);
    expect(ids(r)).toEqual(['c']);
  });

  it('engine path returning null falls back to the CPU cull', () => {
    const f = fixture(['in', 'out'], [[10, 10], [999, 999]]);
    const r = select({
      ...f,
      viewport: vp(1, [0, 0, 100, 100]),
      config: {},
      pointsInRect: () => null,
    });
    expect(ids(r)).toEqual(['in']);
  });
});

describe('text and capacity policy', () => {
  it('defaults text to attrs.label ?? id and honors getText', () => {
    const f = fixture(['a', 'b'], [[0, 0], [1, 1]]);
    f.nodes[1] = { id: 'b' }; // no attrs → falls back to id
    expect(select({ ...f, viewport: vp(1), config: {} }).placements).toEqual([
      { id: 'a', text: 'A', forced: false },
      { id: 'b', text: 'b', forced: false },
    ]);
    const custom = select({ ...f, viewport: vp(1), config: { getText: (n) => `<${n.id}>` } });
    expect(custom.placements.map((p) => p.text)).toEqual(['<a>', '<b>']);
  });

  it('a throwing getText falls back to the id', () => {
    const f = fixture(['a'], [[0, 0]]);
    const r = select({
      ...f,
      viewport: vp(1),
      config: {
        getText: () => {
          throw new Error('boom');
        },
      },
    });
    expect(r.placements).toEqual([{ id: 'a', text: 'a', forced: false }]);
  });

  it('clamps maxVisible to the 1024 policy cap and defaults to 64', () => {
    const n = LABEL_MAX_VISIBLE_CAP + 6;
    const idsAll = Array.from({ length: n }, (_, i) => `n${i}`);
    const coords = idsAll.map((_, i) => [i, 0] as const);
    const f = fixture(idsAll, coords);
    expect(select({ ...f, viewport: vp(1), config: { maxVisible: 5000 } }).placements).toHaveLength(
      LABEL_MAX_VISIBLE_CAP,
    );
    expect(select({ ...f, viewport: vp(1), config: {} }).placements).toHaveLength(64);
    expect(select({ ...f, viewport: vp(1), config: { maxVisible: 0 } }).placements).toHaveLength(0);
  });
});
