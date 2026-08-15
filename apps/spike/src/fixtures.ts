/**
 * Deterministic scene generators for the M0 spike probes.
 *
 * Every generator is a pure function of its arguments, so probes can rebuild
 * identical typed arrays across separate `page.evaluate` calls instead of
 * shuttling buffers over the Playwright wire.
 */

/** mulberry32 — tiny deterministic PRNG, uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GridScene {
  positions: Float32Array;
  links: Float32Array;
  colors: Float32Array;
}

/**
 * `n` points on a square grid centered in the default 4096 space, linked
 * along rows. Colors are a bright uniform red.
 */
export function grid(n: number): GridScene {
  const side = Math.ceil(Math.sqrt(n));
  const span = 2400;
  const step = side > 1 ? span / (side - 1) : 0;
  const origin = (4096 - span) / 2;
  const positions = new Float32Array(n * 2);
  for (let i = 0; i < n; i += 1) {
    const col = i % side;
    const row = Math.floor(i / side);
    positions[i * 2] = origin + col * step;
    positions[i * 2 + 1] = origin + row * step;
  }
  const linkPairs: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    if ((i + 1) % side !== 0) {
      linkPairs.push(i, i + 1);
    }
  }
  const colors = new Float32Array(n * 4);
  for (let i = 0; i < n; i += 1) {
    colors[i * 4] = 1;
    colors[i * 4 + 1] = 0.25;
    colors[i * 4 + 2] = 0.25;
    colors[i * 4 + 3] = 1;
  }
  return { positions, links: new Float32Array(linkPairs), colors };
}

export interface SceneState {
  positions: Float32Array;
  links: Float32Array;
  colorsA: Float32Array;
  colorsB: Float32Array;
  positionsB: Float32Array;
  linksB: Float32Array;
}

/**
 * Seeded A/B scene pair: `n` points, `m` links, all derived from `seed`.
 * State A is uniformly red, state B uniformly blue; B also has fresh
 * positions and a fresh link set drawn from the same PRNG stream.
 * Positions live inside [margin, 4096 - margin] of the default space.
 */
export function seeded(n: number, m: number, seed: number): SceneState {
  const rng = mulberry32(seed);
  const margin = 300;
  const span = 4096 - margin * 2;

  const randomPositions = (): Float32Array => {
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n * 2; i += 1) {
      out[i] = margin + rng() * span;
    }
    return out;
  };
  const randomLinks = (): Float32Array => {
    const out = new Float32Array(m * 2);
    for (let i = 0; i < m; i += 1) {
      const a = Math.floor(rng() * n);
      let b = Math.floor(rng() * n);
      if (b === a) b = (b + 1) % n;
      out[i * 2] = a;
      out[i * 2 + 1] = b;
    }
    return out;
  };
  const uniformColors = (r: number, g: number, b: number): Float32Array => {
    const out = new Float32Array(n * 4);
    for (let i = 0; i < n; i += 1) {
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = 1;
    }
    return out;
  };

  const positions = randomPositions();
  const links = randomLinks();
  const colorsA = uniformColors(1, 0.08, 0.08);
  const colorsB = uniformColors(0.08, 0.08, 1);
  const positionsB = randomPositions();
  const linksB = randomLinks();
  return { positions, links, colorsA, colorsB, positionsB, linksB };
}

export interface NanScene {
  positions: Float32Array;
  links: Float32Array;
  clusterN: number;
  outlierN: number;
}

/**
 * nan-tombstones fixture: `clusterN` points clustered mid-space plus
 * (optionally) `outlierN` far-corner outliers, links chained through the
 * cluster and incident links from each outlier into the cluster. Fully
 * deterministic; the control scene (no outliers) shares the cluster stream.
 */
export function nanScene(includeOutliers: boolean, clusterN = 30, outlierN = 10): NanScene {
  const rng = mulberry32(5);
  const n = includeOutliers ? clusterN + outlierN : clusterN;
  const positions = new Float32Array(n * 2);
  for (let i = 0; i < clusterN; i += 1) {
    positions[i * 2] = 1500 + rng() * 1100;
    positions[i * 2 + 1] = 1500 + rng() * 1100;
  }
  if (includeOutliers) {
    for (let k = 0; k < outlierN; k += 1) {
      const i = clusterN + k;
      positions[i * 2] = 3650 + rng() * 300;
      positions[i * 2 + 1] = 3650 + rng() * 300;
    }
  }
  const linkPairs: number[] = [];
  for (let i = 0; i < clusterN - 1; i += 1) linkPairs.push(i, i + 1);
  if (includeOutliers) {
    for (let k = 0; k < outlierN; k += 1) linkPairs.push(clusterN + k, k);
  }
  return { positions, links: new Float32Array(linkPairs), clusterN, outlierN };
}

export interface SentinelScene extends SceneState {
  sentinelIndices: number[];
  sentinelSpacePositions: Array<[number, number]>;
  sizes: Float32Array;
}

/**
 * atomic-commit fixture: a seeded A/B scene where points 0..3 are large
 * sentinels pinned to the four space corners with IDENTICAL positions in
 * both A and B (only their color changes with the commit), all other points
 * confined to the center band so no link or point ever crosses a sentinel,
 * and links only between non-sentinel points.
 */
export function sentinelScene(n: number, m: number, seed: number): SentinelScene {
  const rng = mulberry32(seed);
  const corners: Array<[number, number]> = [
    [500, 500],
    [3600, 500],
    [500, 3600],
    [3600, 3600],
  ];
  const sentinelIndices = [0, 1, 2, 3];

  const centerPositions = (): Float32Array => {
    const out = new Float32Array(n * 2);
    for (const [i, corner] of corners.entries()) {
      out[i * 2] = corner[0];
      out[i * 2 + 1] = corner[1];
    }
    for (let i = corners.length; i < n; i += 1) {
      out[i * 2] = 1500 + rng() * 1100;
      out[i * 2 + 1] = 1500 + rng() * 1100;
    }
    return out;
  };
  const centerLinks = (): Float32Array => {
    const out = new Float32Array(m * 2);
    const lo = corners.length;
    const span = n - lo;
    for (let i = 0; i < m; i += 1) {
      const a = lo + Math.floor(rng() * span);
      let b = lo + Math.floor(rng() * span);
      if (b === a) b = lo + ((b - lo + 1) % span);
      out[i * 2] = a;
      out[i * 2 + 1] = b;
    }
    return out;
  };
  const uniformColors = (r: number, g: number, b: number): Float32Array => {
    const out = new Float32Array(n * 4);
    for (let i = 0; i < n; i += 1) {
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = 1;
    }
    return out;
  };

  const sizes = new Float32Array(n).fill(6);
  for (const i of sentinelIndices) sizes[i] = 36;

  return {
    positions: centerPositions(),
    links: centerLinks(),
    colorsA: uniformColors(1, 0.08, 0.08),
    colorsB: uniformColors(0.08, 0.08, 1),
    positionsB: centerPositions(),
    linksB: centerLinks(),
    sentinelIndices,
    sentinelSpacePositions: corners,
    sizes,
  };
}

/** FNV-1a checksum over the byte view of an array, as a hex string. */
export function checksum(arr: Float32Array | number[]): string {
  const f32 = arr instanceof Float32Array ? arr : Float32Array.from(arr);
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i] ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
