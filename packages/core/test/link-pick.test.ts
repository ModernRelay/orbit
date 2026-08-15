import { describe, expect, it, vi } from 'vitest';
import { LinkPickIndex } from '../src/linkPick';
import type { LinkPickGridSnapshot } from '../src/linkPick';

// ---------------------------------------------------------------------------
// deterministic fixtures
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so the property runs are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Fixture {
  positions: Float32Array;
  links: Uint32Array;
  extent: number;
}

/** Uniform random endpoints: long links, coarse grid (cell ≈ 0.5·extent). */
function makeUniformGraph(rand: () => number, linkCount: number, pointCount: number, extent: number): Fixture {
  const positions = new Float32Array(pointCount * 2);
  for (let i = 0; i < positions.length; i++) positions[i] = rand() * extent;
  const links = new Uint32Array(linkCount * 2);
  for (let i = 0; i < links.length; i++) links[i] = Math.floor(rand() * pointCount);
  return { positions, links, extent };
}

/** Jittered lattice with mostly-local links: short links, fine grid. */
function makeLatticeGraph(rand: () => number, linkCount: number, pointCount: number, spacing = 10): Fixture {
  const side = Math.max(1, Math.ceil(Math.sqrt(pointCount)));
  const positions = new Float32Array(pointCount * 2);
  for (let i = 0; i < pointCount; i++) {
    positions[i * 2] = (i % side) * spacing + (rand() - 0.5) * spacing * 0.6;
    positions[i * 2 + 1] = Math.floor(i / side) * spacing + (rand() - 0.5) * spacing * 0.6;
  }
  const links = new Uint32Array(linkCount * 2);
  for (let l = 0; l < linkCount; l++) {
    const a = Math.floor(rand() * pointCount);
    let b: number;
    if (rand() < 0.02) {
      b = Math.floor(rand() * pointCount); // occasional long-range link
    } else {
      const dc = Math.floor(rand() * 5) - 2;
      const dr = Math.floor(rand() * 5) - 2;
      b = a + dr * side + dc;
      if (b < 0 || b >= pointCount) b = a; // degenerates to a self-loop at the border
    }
    links[l * 2] = a;
    links[l * 2 + 1] = b;
  }
  return { positions, links, extent: side * spacing };
}

// ---------------------------------------------------------------------------
// independent brute-force oracle
// ---------------------------------------------------------------------------

/** Test-local copy of the exact distance metric (independent of src/). */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

/** O(L) nearest-segment scan; ascending order gives the lower-index tie-break. */
function oracleNearest(
  positions: Float32Array,
  links: Uint32Array,
  x: number,
  y: number,
  tolerance: number,
  visible?: (linkIndex: number) => boolean,
): number | null {
  const linkCount = links.length >>> 1;
  const tol2 = tolerance * tolerance;
  let best = -1;
  let bestD2 = Number.POSITIVE_INFINITY;
  for (let l = 0; l < linkCount; l++) {
    if (visible !== undefined && !visible(l)) continue;
    const a = links[l * 2]!;
    const b = links[l * 2 + 1]!;
    const ax = positions[a * 2]!;
    const ay = positions[a * 2 + 1]!;
    const bx = positions[b * 2]!;
    const by = positions[b * 2 + 1]!;
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) continue;
    const d2 = segDist2(x, y, ax, ay, bx, by);
    if (d2 > tol2) continue;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = l;
    }
  }
  return best >= 0 ? best : null;
}

function u32Equal(a: Uint32Array, b: Uint32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function expectSameGrid(a: LinkPickGridSnapshot, b: LinkPickGridSnapshot): void {
  expect(b.mode).toBe(a.mode);
  expect(b.cellSize).toBe(a.cellSize);
  expect(b.cols).toBe(a.cols);
  expect(b.rows).toBe(a.rows);
  expect(b.minX).toBe(a.minX);
  expect(b.minY).toBe(a.minY);
  expect(u32Equal(b.cellOffsets, a.cellOffsets)).toBe(true);
  expect(u32Equal(b.cellLinkIds, a.cellLinkIds)).toBe(true);
}

// ---------------------------------------------------------------------------
// unit behavior
// ---------------------------------------------------------------------------

describe('LinkPickIndex basics', () => {
  it('reports null before any build and after invalidate()', () => {
    const index = new LinkPickIndex();
    expect(index.isBuilt).toBe(false);
    expect(index.gridSnapshot()).toBeNull();
    expect(index.nearestLink(0, 0, 100)).toBeNull();

    index.build(new Float32Array([0, 0, 10, 0]), new Uint32Array([0, 1]));
    expect(index.nearestLink(5, 1, 2)).toBe(0);
    index.invalidate();
    expect(index.isBuilt).toBe(false);
    expect(index.nearestLink(5, 1, 2)).toBeNull();
  });

  it('handles an empty link buffer', () => {
    const index = new LinkPickIndex();
    index.build(new Float32Array([1, 2]), new Uint32Array(0));
    expect(index.isBuilt).toBe(true);
    expect(index.nearestLink(1, 2, 1000)).toBeNull();
  });

  it('throws on an odd-length link buffer', () => {
    const index = new LinkPickIndex();
    expect(() => index.build(new Float32Array(4), new Uint32Array([0, 1, 0]))).toThrow(RangeError);
  });

  it('hits and misses a single segment by exact distance', () => {
    const index = new LinkPickIndex();
    index.build(new Float32Array([0, 0, 10, 0]), new Uint32Array([0, 1]));
    expect(index.nearestLink(5, 3, 3)).toBe(0); // d = 3 ≤ tol
    expect(index.nearestLink(5, 3, 2.999)).toBeNull(); // d = 3 > tol
    expect(index.nearestLink(-4, 0, 3.999)).toBeNull(); // beyond endpoint a
    expect(index.nearestLink(-4, 0, 4)).toBe(0); // endpoint distance
    expect(index.nearestLink(5, 0, 0)).toBe(0); // on the segment, tolerance 0
  });

  it('breaks exact-distance ties toward the lower link index', () => {
    // Two coincident parallel links.
    const index = new LinkPickIndex();
    index.build(new Float32Array([0, 0, 10, 0]), new Uint32Array([0, 1, 0, 1]));
    expect(index.nearestLink(5, 1, 2)).toBe(0);
  });

  it('picks zero-length (coincident-endpoint) links as points', () => {
    const index = new LinkPickIndex();
    index.build(new Float32Array([3, 4, 3, 4]), new Uint32Array([0, 1]));
    expect(index.nearestLink(3, 6, 2)).toBe(0);
    expect(index.nearestLink(3, 6.01, 2)).toBeNull();
  });

  it('handles all-coincident positions (degenerate bbox)', () => {
    const index = new LinkPickIndex();
    index.build(new Float32Array([7, 7, 7, 7]), new Uint32Array([0, 1]));
    expect(index.nearestLink(7, 7, 0.5)).toBe(0);
    expect(index.nearestLink(9, 7, 0.5)).toBeNull();
  });

  it('excludes NaN-tombstoned links and never returns them', () => {
    const positions = new Float32Array([0, 0, 10, 0, Number.NaN, Number.NaN, 5, 5]);
    const links = new Uint32Array([0, 1, 0, 2, 2, 3]); // links 1 & 2 touch the tombstone
    const index = new LinkPickIndex();
    index.build(positions, links);
    expect(index.nearestLink(5, 0.5, 1)).toBe(0);
    expect(index.nearestLink(5, 4, 2)).toBeNull(); // near tombstoned link 2's live endpoint span only
    expect(index.nearestLink(5, 0.5, 1)).toBe(oracleNearest(positions, links, 5, 0.5, 1));
  });

  it('answers queries outside the grid bounding box correctly', () => {
    const index = new LinkPickIndex();
    index.build(new Float32Array([0, 0, 10, 0]), new Uint32Array([0, 1]));
    expect(index.nearestLink(100, 100, 5)).toBeNull();
    expect(index.nearestLink(12, 0, 2)).toBe(0);
  });

  it('rejects non-finite queries and negative tolerance', () => {
    const index = new LinkPickIndex();
    index.build(new Float32Array([0, 0, 10, 0]), new Uint32Array([0, 1]));
    expect(index.nearestLink(Number.NaN, 0, 5)).toBeNull();
    expect(index.nearestLink(5, 0, -1)).toBeNull();
    expect(index.nearestLink(5, 0, Number.NaN)).toBeNull();
  });
});

describe('LinkPickIndex segment-cell resource bounds', () => {
  it('indexes adversarial long diagonals by grid perimeter and preserves corner picks', () => {
    const LONG_LINKS = 64;
    const SHORT_LINKS = 960;
    const positions = new Float32Array([
      0, 0,
      1024, 1024,
      0, 1024,
      1024, 0,
      512, 512,
      512.25, 512,
    ]);
    const links = new Uint32Array((LONG_LINKS + SHORT_LINKS) * 2);
    const diagonals = [
      [0, 1],
      [2, 3],
      [1, 0],
      [3, 2],
    ] as const;
    for (let l = 0; l < LONG_LINKS; l++) {
      const endpoints = diagonals[l % diagonals.length]!;
      links[l * 2] = endpoints[0];
      links[l * 2 + 1] = endpoints[1];
    }
    for (let l = LONG_LINKS; l < LONG_LINKS + SHORT_LINKS; l++) {
      links[l * 2] = 4;
      links[l * 2 + 1] = 5;
    }

    const index = new LinkPickIndex();
    index.build(positions, links);
    const grid = index.gridSnapshot()!;
    expect(grid.mode).toBe('grid');
    expect([grid.cols, grid.rows]).toEqual([64, 64]);

    const maxCellsPerLongLink =
      1 + (grid.cols - 1) + (grid.rows - 1) + Math.min(grid.cols - 1, grid.rows - 1);
    expect(grid.cellLinkIds.length).toBeLessThanOrEqual(
      LONG_LINKS * maxCellsPerLongLink + SHORT_LINKS,
    );

    // Mixed-sign link 1 passes through exact grid corners. Its supercover
    // must include floor's side-adjacent corner cell even at tolerance 0.
    for (let l = 0; l < diagonals.length; l++) {
      const onlyDirection = (linkIndex: number): boolean => linkIndex === l;
      expect(index.nearestLink(512, 512, 0, onlyDirection)).toBe(l);
    }
    const onlyMixedSign = (linkIndex: number): boolean => linkIndex === 1;
    expect(index.nearestLink(256, 768, 0, onlyMixedSign)).toBe(1);

    for (const [x, y, tolerance] of [
      [700, 700, 0],
      [700, 704, 3],
      [700, 704, 4],
      [900, 124, 20],
      [512.1, 512.2, 0.3],
    ] as const) {
      expect(index.nearestLink(x, y, tolerance)).toBe(
        oracleNearest(positions, links, x, y, tolerance),
      );
    }
  });

  it('degrades deterministically to exact scan before the CSR entry cap', () => {
    const LONG_LINKS = 4096;
    const SHORT_LINKS = 12_288;
    const positions = new Float32Array([
      0, 0,
      1024, 1024,
      0, 1024,
      1024, 0,
      512, 512,
      512.25, 512,
    ]);
    const links = new Uint32Array((LONG_LINKS + SHORT_LINKS) * 2);
    const diagonals = [
      [0, 1],
      [2, 3],
      [1, 0],
      [3, 2],
    ] as const;
    for (let l = 0; l < LONG_LINKS; l++) {
      const endpoints = diagonals[l % diagonals.length]!;
      links[l * 2] = endpoints[0];
      links[l * 2 + 1] = endpoints[1];
    }
    for (let l = LONG_LINKS; l < LONG_LINKS + SHORT_LINKS; l++) {
      links[l * 2] = 4;
      links[l * 2 + 1] = 5;
    }

    const index = new LinkPickIndex();
    index.build(positions, links);
    const snapshot = index.gridSnapshot()!;
    expect(snapshot.mode).toBe('scan');
    expect([snapshot.cols, snapshot.rows]).toEqual([1, 1]);
    expect(snapshot.cellLinkIds).toHaveLength(0);
    const same = new LinkPickIndex();
    same.build(positions, links);
    expectSameGrid(snapshot, same.gridSnapshot()!);

    for (const [x, y, tolerance] of [
      [128, 128, 0],
      [128, 896, 0],
      [512.1, 512.2, 0.3],
      [800, 812, 10],
      [1200, 1200, 5],
    ] as const) {
      expect(index.nearestLink(x, y, tolerance)).toBe(
        oracleNearest(positions, links, x, y, tolerance),
      );
    }
    const onlyMixedSign = (linkIndex: number): boolean => linkIndex === 1;
    expect(index.nearestLink(512, 512, 0, onlyMixedSign)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// oracle property suite
// ---------------------------------------------------------------------------

describe('LinkPickIndex oracle property suite', () => {
  it('matches the oracle at zero tolerance across randomized segment points', () => {
    const rand = mulberry32(0xc0ffee);
    const { positions, links } = makeLatticeGraph(rand, 2500, 1200, 16);
    const index = new LinkPickIndex();
    index.build(positions, links);

    let exactHits = 0;
    for (let q = 0; q < 2000; q++) {
      const l = Math.floor(rand() * (links.length >>> 1));
      const endpoint = q % 2;
      const point = links[l * 2 + endpoint]!;
      const x = positions[point * 2]!;
      const y = positions[point * 2 + 1]!;
      const want = oracleNearest(positions, links, x, y, 0);
      expect(index.nearestLink(x, y, 0)).toBe(want);
      if (want !== null) exactHits++;
    }
    expect(exactHits).toBe(2000);
  });

  it('matches the brute-force oracle on ≥10k queries across random graphs', () => {
    const rand = mulberry32(0x5eed);
    const GRAPHS = 12;
    const QUERIES_PER_GRAPH = 900;
    let totalQueries = 0;
    let hits = 0;
    let nulls = 0;

    for (let g = 0; g < GRAPHS; g++) {
      const linkCount = 100 + Math.floor(rand() * 4901); // 100 … 5000
      const pointCount = Math.max(2, Math.floor(linkCount / 2));
      const fixture =
        g % 2 === 0
          ? makeLatticeGraph(rand, linkCount, pointCount)
          : makeUniformGraph(rand, linkCount, pointCount, 10 + rand() * 990);
      const { positions, links, extent } = fixture;

      const index = new LinkPickIndex();
      index.build(positions, links);
      const cell = index.gridSnapshot()!.cellSize;
      // Tolerances spanning well below and well above the cell size.
      const tolerances = [cell * 0.05, cell * 0.3, cell, cell * 2.5, cell * 8];

      for (let q = 0; q < QUERIES_PER_GRAPH; q++) {
        const tol = tolerances[Math.floor(rand() * tolerances.length)]!;
        let x: number;
        let y: number;
        if (rand() < 0.5) {
          // Bias toward hits: perturb a random point along a random link.
          const l = Math.floor(rand() * linkCount);
          const a = links[l * 2]!;
          const b = links[l * 2 + 1]!;
          const t = rand();
          x = positions[a * 2]! + (positions[b * 2]! - positions[a * 2]!) * t + (rand() - 0.5) * tol * 3;
          y =
            positions[a * 2 + 1]! +
            (positions[b * 2 + 1]! - positions[a * 2 + 1]!) * t +
            (rand() - 0.5) * tol * 3;
        } else {
          // Uniform over an inflated box — lands outside the bbox too.
          x = (rand() * 1.4 - 0.2) * extent;
          y = (rand() * 1.4 - 0.2) * extent;
        }
        const got = index.nearestLink(x, y, tol);
        const want = oracleNearest(positions, links, x, y, tol);
        if (got !== want) {
          expect.fail(
            `graph ${g} query ${q} at (${x}, ${y}) tol ${tol}: grid ${String(got)} !== oracle ${String(want)}`,
          );
        }
        if (want === null) nulls++;
        else hits++;
        totalQueries++;
      }
    }

    expect(totalQueries).toBeGreaterThanOrEqual(10000);
    // Both branches of the contract must actually be exercised.
    expect(hits).toBeGreaterThan(1000);
    expect(nulls).toBeGreaterThan(1000);
  });

  it('applies a random visibility mask per candidate at query time', () => {
    const rand = mulberry32(0xfacade);
    const fixture = makeLatticeGraph(rand, 2000, 1000);
    const { positions, links, extent } = fixture;
    const index = new LinkPickIndex();
    index.build(positions, links);
    const cell = index.gridSnapshot()!.cellSize;

    const visibleArr: boolean[] = [];
    for (let l = 0; l < 2000; l++) visibleArr.push(rand() < 0.6);
    const mask = (l: number): boolean => visibleArr[l]!;

    let maskChangedResult = 0;
    for (let q = 0; q < 800; q++) {
      const x = rand() * extent;
      const y = rand() * extent;
      const tol = cell * (0.2 + rand() * 4);
      const gotMasked = index.nearestLink(x, y, tol, mask);
      const wantMasked = oracleNearest(positions, links, x, y, tol, mask);
      expect(gotMasked).toBe(wantMasked);
      if (gotMasked !== index.nearestLink(x, y, tol)) maskChangedResult++;
    }
    // The mask must have observable effect, not be a no-op.
    expect(maskChangedResult).toBeGreaterThan(0);
  });

  it('never calls Array.prototype.sort during build or query (counting sort only)', () => {
    const rand = mulberry32(0xdeed);
    const fixture = makeLatticeGraph(rand, 5000, 2500);
    const sortSpy = vi.spyOn(Array.prototype, 'sort');
    try {
      const index = new LinkPickIndex();
      index.build(fixture.positions, fixture.links);
      for (let q = 0; q < 200; q++) {
        index.nearestLink(rand() * fixture.extent, rand() * fixture.extent, 5 + rand() * 20);
      }
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('is deterministic: same inputs produce identical grid arrays', () => {
    const fixture = makeLatticeGraph(mulberry32(0xabba), 3000, 1500);
    const a = new LinkPickIndex();
    const b = new LinkPickIndex();
    a.build(fixture.positions, fixture.links);
    b.build(fixture.positions, fixture.links);
    expectSameGrid(a.gridSnapshot()!, b.gridSnapshot()!);
  });
});

// ---------------------------------------------------------------------------
// chunked build
// ---------------------------------------------------------------------------

describe('LinkPickIndex.buildChunked', () => {
  it('yields multiple times under budget on a 100k-link fixture and equals the one-shot build', () => {
    const fixture = makeLatticeGraph(mulberry32(0x100c), 100_000, 20_000);

    const oneShot = new LinkPickIndex();
    oneShot.build(fixture.positions, fixture.links);

    const chunked = new LinkPickIndex();
    let t = 0;
    const fakeNow = (): number => ++t; // strictly monotonic fake clock
    let yields = 0;
    for (const _ of chunked.buildChunked(fixture.positions, fixture.links, 2, fakeNow)) {
      void _;
      yields++;
    }

    expect(yields).toBeGreaterThan(3);
    expectSameGrid(oneShot.gridSnapshot()!, chunked.gridSnapshot()!);

    // Spot-check query parity between the two builds.
    const rand = mulberry32(0xbeef);
    for (let q = 0; q < 200; q++) {
      const x = rand() * fixture.extent;
      const y = rand() * fixture.extent;
      const tol = 1 + rand() * 20;
      expect(chunked.nearestLink(x, y, tol)).toBe(oneShot.nearestLink(x, y, tol));
    }
  });

  it('keeps the previous grid armed until the chunked rebuild commits', () => {
    const index = new LinkPickIndex();
    index.build(new Float32Array([0, 0, 10, 0]), new Uint32Array([0, 1]));
    expect(index.nearestLink(5, 1, 2)).toBe(0);

    // New structure: the only link now lives far away.
    const positions = new Float32Array([100, 100, 110, 100]);
    const links = new Uint32Array([0, 1]);
    let t = 0;
    const it = index.buildChunked(positions, links, 0, () => ++t); // budget 0 → yields at every check
    it.next(); // start, not yet committed (fixture too small to hit a check, but not done either way)

    // Drain to commit.
    let r = it.next();
    while (!r.done) r = it.next();
    expect(index.nearestLink(5, 1, 2)).toBeNull(); // old link gone
    expect(index.nearestLink(105, 101, 2)).toBe(0); // new link armed
  });

  it('produces identical grids across different budgets (chunking never changes results)', () => {
    const fixture = makeLatticeGraph(mulberry32(0x51ce), 30_000, 10_000);
    const oneShot = new LinkPickIndex();
    oneShot.build(fixture.positions, fixture.links);

    for (const budget of [0, 1, 7]) {
      const chunked = new LinkPickIndex();
      let t = 0;
      const iter = chunked.buildChunked(fixture.positions, fixture.links, budget, () => (t += 0.5));
      let r = iter.next();
      while (!r.done) r = iter.next();
      expectSameGrid(oneShot.gridSnapshot()!, chunked.gridSnapshot()!);
    }
  });
});

// ---------------------------------------------------------------------------
// micro-benchmark artifact (informational — NOT a perf gate)
// ---------------------------------------------------------------------------

describe('LinkPickIndex micro-benchmark (informational)', () => {
  it('logs build + query timings on a 100k-link fixture', () => {
    const fixture = makeLatticeGraph(mulberry32(0xbe9c), 100_000, 20_000);
    const index = new LinkPickIndex();

    const t0 = performance.now();
    index.build(fixture.positions, fixture.links);
    const buildMs = performance.now() - t0;

    const rand = mulberry32(0xcafe);
    const QUERIES = 10_000;
    let hits = 0;
    const t1 = performance.now();
    for (let q = 0; q < QUERIES; q++) {
      if (index.nearestLink(rand() * fixture.extent, rand() * fixture.extent, 2 + rand() * 10) !== null) hits++;
    }
    const queryMs = performance.now() - t1;

    const snap = index.gridSnapshot()!;
    console.log(
      `[bench] LinkPickIndex 100k links: build ${buildMs.toFixed(1)} ms | ` +
        `${QUERIES} queries ${queryMs.toFixed(1)} ms (${((queryMs * 1000) / QUERIES).toFixed(2)} µs/query, ${hits} hits) | ` +
        `grid ${snap.cols}×${snap.rows}, cell ${snap.cellSize.toFixed(2)}, ${snap.cellLinkIds.length} entries`,
    );
    expect(index.isBuilt).toBe(true);
    expect(hits).toBeGreaterThan(0);
  });
});
