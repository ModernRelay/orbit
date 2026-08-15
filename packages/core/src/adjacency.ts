/**
 * CSR adjacency over columnar link buffers.
 *
 * Pure, engine-free helpers shared by local expansion, incident-edge
 * dirtying, and the engine-facing `neighborIndices` interaction helper.
 * Build is O(L) via two counting passes over the flat
 * `[src0, tgt0, src1, tgt1, …]` link buffer — no comparison sort and no
 * per-link allocation (the only allocations are the CSR arrays plus one
 * point-sized cursor array).
 *
 * The adjacency is UNDIRECTED: every link contributes one neighbor entry per
 * endpoint slot, so parallel links repeat, and a self-loop (a, a) lists `a`
 * twice under point a — once per endpoint slot.
 */

export interface Adjacency {
  /**
   * Length `pointCount + 1`; the neighbors of point `i` live at
   * `neighbors[offsets[i] … offsets[i + 1])`.
   */
  readonly offsets: Uint32Array;
  /** Length `links.length` (two entries per link — one per direction). */
  readonly neighbors: Uint32Array;
}

/**
 * Builds a CSR adjacency from a flat `[src, tgt]` pair buffer.
 *
 * @param links flat `[src0, tgt0, src1, tgt1, …]` point-index pairs
 * @param pointCount number of points; every endpoint must be `< pointCount`
 */
export function buildAdjacency(links: Uint32Array, pointCount: number): Adjacency {
  if (!Number.isInteger(pointCount) || pointCount < 0) {
    throw new RangeError(`buildAdjacency: pointCount must be a non-negative integer, got ${pointCount}`);
  }
  if ((links.length & 1) !== 0) {
    throw new RangeError(`buildAdjacency: links length must be even ([src, tgt] pairs), got ${links.length}`);
  }

  const n = links.length;
  const offsets = new Uint32Array(pointCount + 1);

  // Pass 1: per-point degree counts (each endpoint slot counts once).
  for (let i = 0; i < n; i++) {
    const p = links[i]!;
    if (p >= pointCount) {
      throw new RangeError(`buildAdjacency: link endpoint ${p} out of range (pointCount ${pointCount})`);
    }
    offsets[p + 1] = offsets[p + 1]! + 1;
  }

  // Exclusive prefix sum → CSR offsets.
  for (let i = 1; i <= pointCount; i++) {
    offsets[i] = offsets[i]! + offsets[i - 1]!;
  }

  // Pass 2: counting-sort fill via a moving write cursor per point.
  const neighbors = new Uint32Array(n);
  const cursor = offsets.slice(0, pointCount);
  for (let i = 0; i < n; i += 2) {
    const a = links[i]!;
    const b = links[i + 1]!;
    const ca = cursor[a]!;
    neighbors[ca] = b;
    cursor[a] = ca + 1;
    const cb = cursor[b]!;
    neighbors[cb] = a;
    cursor[b] = cb + 1;
  }

  return { offsets, neighbors };
}

/**
 * Zero-copy neighbor list of one point: a `subarray` VIEW into
 * `adj.neighbors` — do not mutate, and do not hold across a rebuild.
 */
export function neighborsOf(adj: Adjacency, index: number): Uint32Array {
  const pointCount = adj.offsets.length - 1;
  if (!Number.isInteger(index) || index < 0 || index >= pointCount) {
    throw new RangeError(`neighborsOf: index ${index} out of range (pointCount ${pointCount})`);
  }
  return adj.neighbors.subarray(adj.offsets[index]!, adj.offsets[index + 1]!);
}

/**
 * CSR INCIDENCE: point → incident EDGE SLOTS. The plain Adjacency
 * stores neighbor points, which cannot drive incident-edge dirtying — the
 * delta cascade needs the edge slots themselves. Same two counting
 * passes and the same conventions: undirected (each edge listed under both
 * endpoints), parallel edges repeat, and a self-loop lists its edge slot
 * twice under its point — consumers' per-edge operations are idempotent, so
 * the duplicate is harmless and cheaper than a dedupe pass.
 */
export interface Incidence {
  /** Length `pointCount + 1`; edges of point `i` live at
   * `edgeSlots[offsets[i] … offsets[i + 1])`. */
  readonly offsets: Uint32Array;
  /** Length `links.length` (each edge appears once per endpoint slot). */
  readonly edgeSlots: Uint32Array;
}

export function buildIncidence(links: Uint32Array, pointCount: number): Incidence {
  if (!Number.isInteger(pointCount) || pointCount < 0) {
    throw new RangeError(
      `buildIncidence: pointCount must be a non-negative integer, got ${pointCount}`,
    );
  }
  if ((links.length & 1) !== 0) {
    throw new RangeError(
      `buildIncidence: links length must be even ([src, tgt] pairs), got ${links.length}`,
    );
  }

  const n = links.length;
  const offsets = new Uint32Array(pointCount + 1);
  for (let i = 0; i < n; i++) {
    const p = links[i]!;
    if (p >= pointCount) {
      throw new RangeError(
        `buildIncidence: link endpoint ${p} out of range (pointCount ${pointCount})`,
      );
    }
    offsets[p + 1] = offsets[p + 1]! + 1;
  }
  for (let i = 1; i <= pointCount; i++) {
    offsets[i] = offsets[i]! + offsets[i - 1]!;
  }
  const edgeSlots = new Uint32Array(n);
  const cursor = offsets.slice(0, pointCount);
  for (let i = 0; i < n; i += 2) {
    const edge = i >>> 1;
    const a = links[i]!;
    const b = links[i + 1]!;
    const ca = cursor[a]!;
    edgeSlots[ca] = edge;
    cursor[a] = ca + 1;
    const cb = cursor[b]!;
    edgeSlots[cb] = edge;
    cursor[b] = cb + 1;
  }
  return { offsets, edgeSlots };
}

/** Zero-copy incident-edge list of one point (same VIEW caveats as
 * `neighborsOf`). */
export function incidentEdgesOf(inc: Incidence, index: number): Uint32Array {
  const pointCount = inc.offsets.length - 1;
  if (!Number.isInteger(index) || index < 0 || index >= pointCount) {
    throw new RangeError(`incidentEdgesOf: index ${index} out of range (pointCount ${pointCount})`);
  }
  return inc.edgeSlots.subarray(inc.offsets[index]!, inc.offsets[index + 1]!);
}
