/**
 * Streaming per-column summaries for prepared artifacts, using the
 * `ColumnSummary` shape defined locally in types.ts.
 *
 * Accumulation rules (single pass, bounded memory):
 * - `count` — total rows of the owning table; identical across the
 * table's summaries.
 * - `nullCount` — rows with no usable value for the column: key absent,
 * `null`/`undefined`, or a number that fails core's
 * `coerceNumeric` hygiene (NaN/±Infinity → null through the single
 * coercion layer).
 * - numeric lane — finite numbers feed min/max (over ALL values) and
 * quantiles [0.25, 0.5, 0.75] from a retained sample:
 * Algorithm-R reservoir capped at RESERVOIR_CAP = 10 000.
 * While the value count is ≤ the cap the sample is the whole
 * column, so quantiles are EXACT (type-7 linear
 * interpolation, the common statistical default); beyond the
 * cap they are reservoir-approximate (and, because Algorithm
 * R draws from Math.random, nondeterministic — acceptable
 * for a profile, documented here).
 * - categorical lane — strings and booleans feed a value→count map capped at
 * CATEGORY_CAP = 10 000 distinct keys: once full, unseen
 * values stop being tracked (existing keys still count) and
 * the summary is marked truncated. `categories` reports the
 * top TOP_CATEGORIES = 20 by count (ties broken by first
 * occurrence); `categoriesTruncated` is set when the map
 * overflowed OR more than 20 distinct values were tracked.
 * - `approximateUnique` — all primitive values (numbers, strings, booleans;
 * type-tagged so `1` and `'1'` stay distinct) in a Set
 * capped at UNIQUE_CAP = 10 000; once capped the reported
 * value is the cap itself (a lower bound).
 * - other types — objects/arrays/dates/bigints/functions/symbols count as
 * present (not null) but contribute to no value statistic;
 * this profile tier only characterizes primitives.
 */

import { coerceNumeric } from '@modernrelay/orbit-core';
import type { ColumnSummary } from './types';

export const RESERVOIR_CAP = 10_000;
export const UNIQUE_CAP = 10_000;
export const CATEGORY_CAP = 10_000;
export const TOP_CATEGORIES = 20;
export const QUANTILE_PROBS = [0.25, 0.5, 0.75] as const;

class ColumnAccumulator {
  /** Values with a usable value; `nullCount` falls out as rows − present. */
  presentCount = 0;

  numericCount = 0;
  min = Infinity;
  max = -Infinity;
  /** Algorithm-R reservoir of numeric values (exact sample while ≤ cap). */
  reservoir: number[] = [];
  numericSeen = 0;

  categories = new Map<string, number>();
  categoriesOverflowed = false;
  hasCategorical = false;

  uniques = new Set<string>();
  uniquesOverflowed = false;

  add(value: unknown): void {
    if (value === null || value === undefined) {
      return; // counts as null via rows − presentCount
    }
    if (typeof value === 'number') {
      const coerced = coerceNumeric(value);
      if (coerced === null) {
        // NaN/±Infinity: hygiene says no usable value.
        return;
      }
      this.presentCount++;
      this.numericCount++;
      if (coerced < this.min) this.min = coerced;
      if (coerced > this.max) this.max = coerced;
      this.numericSeen++;
      if (this.reservoir.length < RESERVOIR_CAP) {
        this.reservoir.push(coerced);
      } else {
        const j = Math.floor(Math.random() * this.numericSeen);
        if (j < RESERVOIR_CAP) this.reservoir[j] = coerced;
      }
      this.addUnique('n:' + coerced);
      return;
    }
    if (typeof value === 'string' || typeof value === 'boolean') {
      this.presentCount++;
      this.hasCategorical = true;
      const key = String(value);
      const existing = this.categories.get(key);
      if (existing !== undefined) {
        this.categories.set(key, existing + 1);
      } else if (this.categories.size < CATEGORY_CAP) {
        this.categories.set(key, 1);
      } else {
        this.categoriesOverflowed = true;
      }
      this.addUnique((typeof value === 'string' ? 's:' : 'b:') + key);
      return;
    }
    // Opaque non-primitive: present, but no value statistics.
    this.presentCount++;
  }

  private addUnique(key: string): void {
    if (this.uniques.size < UNIQUE_CAP) {
      this.uniques.add(key);
    } else if (!this.uniques.has(key)) {
      this.uniquesOverflowed = true;
    }
  }

  finalize(totalRows: number): ColumnSummary {
    const summary: ColumnSummary = {
      count: totalRows,
      nullCount: totalRows - this.presentCount,
    };
    if (this.numericCount > 0) {
      summary.min = this.min;
      summary.max = this.max;
      summary.quantiles = computeQuantiles(this.reservoir);
    }
    if (this.presentCount > 0 && (this.numericCount > 0 || this.hasCategorical)) {
      summary.approximateUnique = this.uniquesOverflowed ? UNIQUE_CAP : this.uniques.size;
    }
    if (this.hasCategorical) {
      // Top-N by count; ties keep first-occurrence (Map iteration) order via
      // a stable sort over insertion-ordered entries.
      const entries = [...this.categories.entries()];
      entries.sort((a, b) => b[1] - a[1]);
      summary.categories = entries
        .slice(0, TOP_CATEGORIES)
        .map(([value, count]) => ({ value, count }));
      if (this.categoriesOverflowed || this.categories.size > TOP_CATEGORIES) {
        summary.categoriesTruncated = true;
      }
    }
    return summary;
  }
}

/** Type-7 (linear interpolation between closest ranks) quantiles over a sample. */
export function computeQuantiles(sample: readonly number[]): readonly number[] {
  const sorted = [...sample].sort((a, b) => a - b);
  const n = sorted.length;
  return QUANTILE_PROBS.map((p) => {
    if (n === 1) return sorted[0]!;
    const idx = (n - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    const loV = sorted[lo]!;
    const hiV = sorted[hi]!;
    return lo === hi ? loV : loV + (hiV - loV) * (idx - lo);
  });
}

/**
 * Summarizes one table's attr columns. Columns known up front (CSV header,
 * Arrow/Parquet schema) are seeded so an all-empty column still reports
 * `{count, nullCount: count}`; row-object lanes discover columns as they
 * appear (rows before a column's first appearance count as null via
 * `count - presentCount`).
 */
export class TableSummarizer {
  private readonly columns = new Map<string, ColumnAccumulator>();
  private rows = 0;

  seed(columnNames: Iterable<string>): void {
    for (const name of columnNames) {
      if (!this.columns.has(name)) this.columns.set(name, new ColumnAccumulator());
    }
  }

  addRow(attrs: Readonly<Record<string, unknown>> | undefined): void {
    this.rows++;
    if (attrs === undefined) return;
    for (const key of Object.keys(attrs)) {
      let acc = this.columns.get(key);
      if (acc === undefined) {
        acc = new ColumnAccumulator();
        this.columns.set(key, acc);
      }
      acc.add(attrs[key]);
    }
  }

  finalize(): Readonly<Record<string, ColumnSummary>> {
    const out: Record<string, ColumnSummary> = {};
    for (const [name, acc] of this.columns) {
      // A column literally named '__proto__' must land as an own
      // property, not invoke the prototype setter.
      Object.defineProperty(out, name, {
        value: acc.finalize(this.rows),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
}
