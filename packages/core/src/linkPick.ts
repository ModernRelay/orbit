/**
 * CPU link-pick fallback: a uniform grid over ALL links in SPACE
 * coordinates (cell ≈ median link length), used when the engine lacks native
 * `linkAt` (`capabilities.linkPicking === false`). Backs
 * `onEdgeClick`/`onEdgeHover` via the index→edge mapping.
 *
 * Coordinate contract: everything here is SPACE coordinates. Callers invert
 * the affine `Viewport` (space = (screen − center)/zoom + [x, y]) and pass a
 * space-unit tolerance (`tolerancePx / zoom`).
 *
 * Invalidation contract (normative — wave 2 enforces arming):
 * - The grid indexes a POSITION SNAPSHOT (the `posBuf` CPU mirror as of
 * the build call). It NEVER observes live simulation positions: while the
 * simulation is hot (alpha above threshold) or an animated `setLayout`
 * transition runs, picking is DISARMED by the caller; on settle one
 * per-event `getPositions` refreshes the mirror and the grid is rebuilt.
 * - Rebuild ONLY on structural change (link buffer changed) or position
 * sync. The grid is invariant under camera moves and visibility-mask
 * changes: the mask is applied per candidate at QUERY time via the
 * optional `visible` callback (pure pass-through until mask wiring supplies the real
 * mask through it).
 *
 * Build uses two counting-sort passes into CSR grid arrays (`cellOffsets`,
 * `cellLinkIds`). Each segment is inserted with a supercover grid traversal,
 * so a link contributes O(cols + rows) cells in the worst case instead of
 * every cell in its O(cols * rows) axis-aligned bounding box. There is no
 * comparison sort or per-link allocation beyond the CSR arrays (plus
 * O(cells) cursor and O(links) query stamps). Links with a non-finite endpoint
 * (NaN-tombstoned points) are excluded and can never be returned. A hard
 * CSR-entry cap deterministically degrades pathological builds to exact O(L)
 * query scans with no cell-link payload.
 */

/** visibility mask applied per candidate at query time. */
export type LinkVisibilityMask = (linkIndex: number) => boolean;

/**
 * Read-only view of the built grid (diagnostics/tests). The typed arrays are
 * the LIVE internal buffers — never mutate them.
 */
export interface LinkPickGridSnapshot {
  /** `scan` means the CSR cap tripped and queries use an exact full scan. */
  readonly mode: 'grid' | 'scan';
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  readonly minX: number;
  readonly minY: number;
  /** CSR: length `cols * rows + 1`; `[0, 0]` in `scan` mode. */
  readonly cellOffsets: Uint32Array;
  /** CSR segment-supercover pairs; empty in `scan` mode. */
  readonly cellLinkIds: Uint32Array;
}

interface GridState extends LinkPickGridSnapshot {
  readonly positions: Float32Array;
  readonly links: Uint32Array;
  readonly linkCount: number;
}

/** Median-length sampling cap. */
const MEDIAN_SAMPLE_CAP = 1024;
/** Absolute floor for the cell size (degenerate/coincident layouts). */
const MIN_CELL_SIZE = 1e-6;
/** Hard cap per grid dimension (memory guard for tiny-median layouts). */
const MAX_GRID_DIM = 4096;
/**
 * Hard cap for the CSR cell-link payload (8 MiB of Uint32 ids). Above this,
 * build degrades to an exact scan with no cell-link payload instead of
 * risking a large typed-array allocation on diagonal-heavy graphs.
 */
const MAX_CELL_LINK_ENTRIES = 2_097_152;
/** Links between build-budget checks (keeps `now` calls off the hot path). */
const LINK_BUDGET_INTERVAL = 4096;
/** Cells between prefix-sum budget checks. */
const CELL_BUDGET_INTERVAL = 65536;

/**
 * Exact point→segment squared distance (shared with the query path so the
 * grid and any external oracle agree bit-for-bit).
 */
export function pointSegmentDistanceSquared(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
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

/**
 * Deterministic Hoare quickselect for the (upper) median of
 * `values[0 … count)`. Avoids any comparison sort (partial partitioning
 * only); mutates the scratch buffer in place. O(count) average, and `count`
 * is capped at MEDIAN_SAMPLE_CAP anyway.
 */
function medianOfLengths(values: Float64Array, count: number): number {
  if (count === 0) return 0;
  const k = count >> 1;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const pivot = values[(lo + hi) >> 1]!;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (values[i]! < pivot) i++;
      while (values[j]! > pivot) j--;
      if (i <= j) {
        const t = values[i]!;
        values[i] = values[j]!;
        values[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return values[k]!;
}

/** Record one link in one cell during either the count or fill pass. */
function recordLinkCell(
  cell: number,
  linkIndex: number,
  countsOrCursor: Uint32Array,
  cellLinkIds: Uint32Array | null,
): void {
  if (cellLinkIds === null) {
    // Counts live one slot to the right so the in-place prefix sum below
    // directly produces CSR offsets.
    const slot = cell + 1;
    countsOrCursor[slot] = countsOrCursor[slot]! + 1;
    return;
  }
  const at = countsOrCursor[cell]!;
  cellLinkIds[at] = linkIndex;
  countsOrCursor[cell] = at + 1;
}

function gridCell(value: number, min: number, invCellSize: number, limit: number): number {
  const cell = Math.floor((value - min) * invCellSize);
  return cell < 0 ? 0 : cell >= limit ? limit - 1 : cell;
}

/**
 * Insert one segment with an allocation-free 2D supercover traversal.
 * Corner crossings conservatively include both side-adjacent cells as well
 * as the diagonal cell. This matters at tolerance zero because `floor`
 * assigns the exact corner to one of those side cells for mixed-sign lines.
 *
 * A monotone segment changes column at most `cols - 1` times and row at most
 * `rows - 1` times. Even with the two extra corner cells, insertion is bounded
 * by `1 + (cols - 1) + (rows - 1) + min(cols - 1, rows - 1)` cells — grid
 * perimeter, never bounding-box area.
 */
function indexLinkCells(
  positions: Float32Array,
  links: Uint32Array,
  linkIndex: number,
  minX: number,
  minY: number,
  cellSize: number,
  invCellSize: number,
  cols: number,
  rows: number,
  countsOrCursor: Uint32Array,
  cellLinkIds: Uint32Array | null,
): number {
  const a = links[linkIndex * 2]!;
  const b = links[linkIndex * 2 + 1]!;
  const ax = positions[a * 2]!;
  const ay = positions[a * 2 + 1]!;
  const bx = positions[b * 2]!;
  const by = positions[b * 2 + 1]!;
  if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) {
    return 0;
  }

  let col = gridCell(ax, minX, invCellSize, cols);
  let row = gridCell(ay, minY, invCellSize, rows);
  const endCol = gridCell(bx, minX, invCellSize, cols);
  const endRow = gridCell(by, minY, invCellSize, rows);
  recordLinkCell(row * cols + col, linkIndex, countsOrCursor, cellLinkIds);
  let entries = 1;

  const dx = bx - ax;
  const dy = by - ay;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  let tMaxX = Number.POSITIVE_INFINITY;
  let tMaxY = Number.POSITIVE_INFINITY;
  let tDeltaX = Number.POSITIVE_INFINITY;
  let tDeltaY = Number.POSITIVE_INFINITY;
  if (stepX !== 0) {
    const boundaryX = minX + (stepX > 0 ? col + 1 : col) * cellSize;
    tMaxX = (boundaryX - ax) / dx;
    tDeltaX = cellSize / Math.abs(dx);
  }
  if (stepY !== 0) {
    const boundaryY = minY + (stepY > 0 ? row + 1 : row) * cellSize;
    tMaxY = (boundaryY - ay) / dy;
    tDeltaY = cellSize / Math.abs(dy);
  }

  while (col !== endCol || row !== endRow) {
    // Once one endpoint cell coordinate is reached, only the other axis can
    // have an in-segment boundary left to cross.
    if (col === endCol) {
      row += stepY;
      tMaxY += tDeltaY;
      recordLinkCell(row * cols + col, linkIndex, countsOrCursor, cellLinkIds);
      entries++;
      continue;
    }
    if (row === endRow) {
      col += stepX;
      tMaxX += tDeltaX;
      recordLinkCell(row * cols + col, linkIndex, countsOrCursor, cellLinkIds);
      entries++;
      continue;
    }

    // Accumulated DDA arithmetic can put a mathematical corner crossing a few
    // ulps apart. Treat a tiny near-tie as a corner; the resulting superset is
    // conservative and still obeys the perimeter bound.
    const tieTolerance = 1e-12 * Math.max(1, Math.abs(tMaxX), Math.abs(tMaxY));
    if (tMaxX < tMaxY - tieTolerance) {
      col += stepX;
      tMaxX += tDeltaX;
      recordLinkCell(row * cols + col, linkIndex, countsOrCursor, cellLinkIds);
      entries++;
    } else if (tMaxY < tMaxX - tieTolerance) {
      row += stepY;
      tMaxY += tDeltaY;
      recordLinkCell(row * cols + col, linkIndex, countsOrCursor, cellLinkIds);
      entries++;
    } else {
      const nextCol = col + stepX;
      const nextRow = row + stepY;
      recordLinkCell(row * cols + nextCol, linkIndex, countsOrCursor, cellLinkIds);
      recordLinkCell(nextRow * cols + col, linkIndex, countsOrCursor, cellLinkIds);
      col = nextCol;
      row = nextRow;
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
      recordLinkCell(row * cols + col, linkIndex, countsOrCursor, cellLinkIds);
      entries += 3;
    }
  }
  return entries;
}

export class LinkPickIndex {
  private grid: GridState | null = null;
  /** Per-link visited stamps: dedupe across cells within one query. */
  private stamps = new Uint32Array(0);
  private queryStamp = 0;

  get isBuilt(): boolean {
    return this.grid !== null;
  }

  /** Read-only grid/scan index view for diagnostics/tests; null before build. */
  gridSnapshot(): LinkPickGridSnapshot | null {
    return this.grid;
  }

  /**
   * Drops the grid: `nearestLink` reports null until the next build. Wave 2
   * calls this on structural change / sim-hot disarm.
   */
  invalidate(): void {
    this.grid = null;
    this.stamps = new Uint32Array(0);
    this.queryStamp = 0;
  }

  /**
   * One-shot output-sensitive build over a position snapshot: O(L + I), where
   * I is the emitted segment-cell pairs up to `MAX_CELL_LINK_ENTRIES`; above
   * that cap it commits exact-scan mode. Drains the chunked generator with an
   * infinite budget so both entry points share one code path (chunked and
   * one-shot builds are bit-identical).
   */
  build(positions: Float32Array, links: Uint32Array): void {
    const it = this.buildChunked(positions, links, Number.POSITIVE_INFINITY, () => 0);
    let r = it.next();
    while (!r.done) r = it.next();
  }

  /**
   * Incremental build: yields whenever `now − sliceStart ≥ budgetMs` so a
   * scheduler can spread the work across idle frames.
   * Pure generator — no rAF/timers here; the caller owns scheduling.
   *
   * The previous grid stays armed and queryable until the new one commits on
   * generator completion; abandoning the iterator leaves the old grid
   * intact. At most one build should be in flight per index — the wave-2
   * scheduler serializes rebuilds.
   */
  *buildChunked(
    positions: Float32Array,
    links: Uint32Array,
    budgetMs: number,
    now: () => number,
  ): IterableIterator<void> {
    if ((links.length & 1) !== 0) {
      throw new RangeError(`LinkPickIndex: links length must be even ([src, tgt] pairs), got ${links.length}`);
    }
    const linkCount = links.length >>> 1;
    let sliceStart = now();

    // -- Pass 0a: bounding box over finite link endpoints (O(L)). --
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let l = 0; l < linkCount; l++) {
      const a = links[l * 2]!;
      const b = links[l * 2 + 1]!;
      const ax = positions[a * 2]!;
      const ay = positions[a * 2 + 1]!;
      const bx = positions[b * 2]!;
      const by = positions[b * 2 + 1]!;
      if (Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(bx) && Number.isFinite(by)) {
        if (ax < minX) minX = ax;
        if (ax > maxX) maxX = ax;
        if (bx < minX) minX = bx;
        if (bx > maxX) maxX = bx;
        if (ay < minY) minY = ay;
        if (ay > maxY) maxY = ay;
        if (by < minY) minY = by;
        if (by > maxY) maxY = by;
      }
      if ((l + 1) % LINK_BUDGET_INTERVAL === 0 && now() - sliceStart >= budgetMs) {
        yield;
        sliceStart = now();
      }
    }
    if (minX > maxX) {
      // No finite link at all — degenerate 1×1 grid, nothing inserted.
      minX = minY = maxX = maxY = 0;
    }

    // -- Pass 0b: median link length from a deterministic stride sample. --
    const sampleTarget = linkCount < MEDIAN_SAMPLE_CAP ? linkCount : MEDIAN_SAMPLE_CAP;
    const lengths = new Float64Array(sampleTarget);
    let sampleCount = 0;
    if (sampleTarget > 0) {
      const stride = linkCount / sampleTarget;
      for (let k = 0; k < sampleTarget; k++) {
        const l = Math.floor(k * stride);
        const a = links[l * 2]!;
        const b = links[l * 2 + 1]!;
        const ax = positions[a * 2]!;
        const ay = positions[a * 2 + 1]!;
        const bx = positions[b * 2]!;
        const by = positions[b * 2 + 1]!;
        if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) {
          continue;
        }
        const dx = bx - ax;
        const dy = by - ay;
        lengths[sampleCount++] = Math.sqrt(dx * dx + dy * dy);
      }
    }
    const median = medianOfLengths(lengths, sampleCount);

    // -- Grid geometry: cell ≈ median link length, clamped to a sane minimum
    // and to a per-dimension cap so degenerate medians can't explode the
    // cell arrays. --
    const width = maxX - minX;
    const height = maxY - minY;
    const targetDim = Math.min(MAX_GRID_DIM, Math.max(1, Math.ceil(Math.sqrt(linkCount * 4))));
    let cellSize = median;
    if (width / targetDim > cellSize) cellSize = width / targetDim;
    if (height / targetDim > cellSize) cellSize = height / targetDim;
    if (!(cellSize >= MIN_CELL_SIZE)) cellSize = MIN_CELL_SIZE;
    const invCellSize = 1 / cellSize;
    const cols = Math.max(1, Math.ceil(width * invCellSize));
    const rows = Math.max(1, Math.ceil(height * invCellSize));
    const cellCount = cols * rows;

    // -- Pass 1: count (cell, link) pairs along each segment supercover. --
    const cellOffsets = new Uint32Array(cellCount + 1);
    let totalEntries = 0;
    for (let l = 0; l < linkCount; l++) {
      totalEntries += indexLinkCells(
        positions,
        links,
        l,
        minX,
        minY,
        cellSize,
        invCellSize,
        cols,
        rows,
        cellOffsets,
        null,
      );
      if (totalEntries > MAX_CELL_LINK_ENTRIES) {
        // Deterministic bounded-memory degradation. Keep the geometry only as
        // a valid 1×1 diagnostic snapshot; nearestLink scans `links` exactly.
        const scanCellSize = Math.max(width, height, MIN_CELL_SIZE);
        this.grid = {
          mode: 'scan',
          positions,
          links,
          linkCount,
          minX,
          minY,
          cellSize: scanCellSize,
          cols: 1,
          rows: 1,
          cellOffsets: new Uint32Array(2),
          cellLinkIds: new Uint32Array(0),
        };
        this.stamps = new Uint32Array(0);
        this.queryStamp = 0;
        return;
      }
      if ((l + 1) % LINK_BUDGET_INTERVAL === 0 && now() - sliceStart >= budgetMs) {
        yield;
        sliceStart = now();
      }
    }

    // -- Exclusive prefix sum → CSR cell offsets. --
    for (let i = 1; i <= cellCount; i++) {
      cellOffsets[i] = cellOffsets[i]! + cellOffsets[i - 1]!;
      if (i % CELL_BUDGET_INTERVAL === 0 && now() - sliceStart >= budgetMs) {
        yield;
        sliceStart = now();
      }
    }

    // -- Pass 2: counting-sort fill (ascending link order per cell). --
    const cellLinkIds = new Uint32Array(cellOffsets[cellCount]!);
    const cursor = cellOffsets.slice(0, cellCount);
    for (let l = 0; l < linkCount; l++) {
      indexLinkCells(
        positions,
        links,
        l,
        minX,
        minY,
        cellSize,
        invCellSize,
        cols,
        rows,
        cursor,
        cellLinkIds,
      );
      if ((l + 1) % LINK_BUDGET_INTERVAL === 0 && now() - sliceStart >= budgetMs) {
        yield;
        sliceStart = now();
      }
    }

    // -- Commit atomically: the old grid answered queries until this point. --
    this.grid = {
      mode: 'grid',
      positions,
      links,
      linkCount,
      minX,
      minY,
      cellSize,
      cols,
      rows,
      cellOffsets,
      cellLinkIds,
    };
    this.stamps = new Uint32Array(linkCount);
    this.queryStamp = 0;
  }

  /**
   * Nearest link within `tolerance` (space units) of the space point
   * `(x, y)`, or null. Scans the candidate cells covering the tolerance
   * disc's bounding box (typically the 3×3 neighborhood; more when the
   * tolerance exceeds the cell size), applies the optional visibility
   * mask per candidate, then runs the exact point→segment distance test.
   * Nearest wins; exact-distance ties break toward the LOWER link index.
   * Returns null while unbuilt/invalidated (picking disarmed).
   */
  nearestLink(x: number, y: number, tolerance: number, visible?: LinkVisibilityMask): number | null {
    const g = this.grid;
    if (g === null) return null;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(tolerance >= 0)) return null;

    if (g.mode === 'scan') {
      const { positions, links, linkCount } = g;
      const tol2 = tolerance * tolerance;
      let bestIdx = -1;
      let bestD2 = Number.POSITIVE_INFINITY;
      for (let l = 0; l < linkCount; l++) {
        if (visible !== undefined && !visible(l)) continue;
        const a = links[l * 2]!;
        const b = links[l * 2 + 1]!;
        const ax = positions[a * 2]!;
        const ay = positions[a * 2 + 1]!;
        const bx = positions[b * 2]!;
        const by = positions[b * 2 + 1]!;
        if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) {
          continue;
        }
        const d2 = pointSegmentDistanceSquared(x, y, ax, ay, bx, by);
        if (d2 > tol2) continue;
        if (d2 < bestD2 || (d2 === bestD2 && l < bestIdx)) {
          bestD2 = d2;
          bestIdx = l;
        }
      }
      return bestIdx >= 0 ? bestIdx : null;
    }
    if (g.cellLinkIds.length === 0) return null;

    const invCellSize = 1 / g.cellSize;
    const clampCol = (v: number): number => (v < 0 ? 0 : v > g.cols - 1 ? g.cols - 1 : v);
    const clampRow = (v: number): number => (v < 0 ? 0 : v > g.rows - 1 ? g.rows - 1 : v);
    const c0 = clampCol(Math.floor((x - tolerance - g.minX) * invCellSize));
    const c1 = clampCol(Math.floor((x + tolerance - g.minX) * invCellSize));
    const r0 = clampRow(Math.floor((y - tolerance - g.minY) * invCellSize));
    const r1 = clampRow(Math.floor((y + tolerance - g.minY) * invCellSize));

    let stamp = this.queryStamp + 1;
    if (stamp > 0xffffffff) {
      this.stamps.fill(0);
      stamp = 1;
    }
    this.queryStamp = stamp;

    const { positions, links, cellOffsets, cellLinkIds } = g;
    const stamps = this.stamps;
    const tol2 = tolerance * tolerance;
    let bestIdx = -1;
    let bestD2 = Number.POSITIVE_INFINITY;
    for (let r = r0; r <= r1; r++) {
      const rowBase = r * g.cols;
      for (let c = c0; c <= c1; c++) {
        const cell = rowBase + c;
        const end = cellOffsets[cell + 1]!;
        for (let i = cellOffsets[cell]!; i < end; i++) {
          const l = cellLinkIds[i]!;
          if (stamps[l] === stamp) continue; // already tested via another cell
          stamps[l] = stamp;
          if (visible !== undefined && !visible(l)) continue;
          const a = links[l * 2]!;
          const b = links[l * 2 + 1]!;
          const d2 = pointSegmentDistanceSquared(
            x,
            y,
            positions[a * 2]!,
            positions[a * 2 + 1]!,
            positions[b * 2]!,
            positions[b * 2 + 1]!,
          );
          if (d2 > tol2) continue;
          if (d2 < bestD2 || (d2 === bestD2 && l < bestIdx)) {
            bestD2 = d2;
            bestIdx = l;
          }
        }
      }
    }
    return bestIdx >= 0 ? bestIdx : null;
  }
}
