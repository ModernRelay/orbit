/**
 * <GraphHistogram> — crossfilter histogram.
 *
 * SVG dual-layer bar chart over one crossfilter dimension: total bars
 * (muted) with the joint-filtered layer (accent) overlaid. Numeric/temporal
 * dimensions brush by pointer-drag over the plot (any drag REPLACES the
 * brush), double-click clears, ArrowLeft/ArrowRight nudge the window by one
 * bin, Escape clears (the plot is focusable). Categorical dimensions render
 * clickable rows toggling category exclusions. All text values (dimension
 * key, category keys) render as TEXT NODES. Headless-styleable: providing
 * `className` drops the built-in dark-theme inline styles.
 */

import type { CSSProperties, ReactElement } from 'react';
import type { CategoryBin } from '@modernrelay/orbit-core';
import type { AnyGraphInstance } from '../../GraphProvider';
import { useResolvedInstance } from '../shared';
import { brushRangePct, sliderValueNow, sliderValueText, toggleCategoryExclusion, useRangeBrush } from '../_shared/brush';
import { useCrossfilterDimension, useSessionSetBrush } from '../_shared/crossfilter';

export interface GraphHistogramProps {
  /** Crossfilter dimension key (must appear in the `crossfilter` prop). */
  dimension: string;
  /** Plot height in CSS px. Default 96. */
  height?: number;
  /** Explicit instance; defaults to the ambient <Graph>/<GraphProvider> one. */
  instance?: AnyGraphInstance;
  /** Class hook for the root; providing it drops the default styles. */
  className?: string;
  style?: CSSProperties;
  /** Class hook for each categorical row; providing it drops its defaults. */
  categoryClassName?: string;
}

// --- default dark-theme styling (dropped when `className` is provided) ---

const ROOT_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: 8,
  borderRadius: 8,
  background: 'rgba(23, 25, 32, 0.92)',
  border: '1px solid rgba(255, 255, 255, 0.14)',
  color: '#e8eaf0',
  font: '12px/1.4 system-ui, sans-serif',
};

const TITLE_STYLE: CSSProperties = { opacity: 0.75 };

const PLOT_STYLE: CSSProperties = {
  position: 'relative',
  cursor: 'crosshair',
  touchAction: 'none',
  userSelect: 'none',
};

const SVG_STYLE: CSSProperties = { display: 'block', width: '100%' };

const CATEGORY_ROW_STYLE: CSSProperties = {
  appearance: 'none',
  display: 'flex',
  justifyContent: 'space-between',
  gap: 8,
  background: 'transparent',
  border: 'none',
  borderRadius: 4,
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  padding: '2px 4px',
  textAlign: 'left',
};

const EXCLUDED_ROW_STYLE: CSSProperties = {
  ...CATEGORY_ROW_STYLE,
  opacity: 0.45,
  textDecoration: 'line-through',
};

const TOTAL_FILL = 'rgba(148, 163, 184, 0.35)';
const FILTERED_FILL = '#7aa2ff';
const BRUSH_FILL = 'rgba(122, 162, 255, 0.18)';
const BRUSH_STROKE = 'rgba(122, 162, 255, 0.85)';

export function GraphHistogram(props: GraphHistogramProps): ReactElement {
  const instance = useResolvedInstance(props.instance, '<GraphHistogram>');
  const { summary, brush } = useCrossfilterDimension(instance, props.dimension);
  const setBrush = useSessionSetBrush(instance, props.dimension);

  const domain = summary?.domain ?? null;
  const handlers = useRangeBrush({
    domain,
    binCount: summary?.bins.length ?? 0,
    brush,
    setBrush,
  });

  const styled = props.className === undefined;
  const height = props.height ?? 96;
  const categorical = summary !== null && summary.kind === 'categorical';
  const range = brushRangePct(brush, domain);

  const renderCategory = (cat: CategoryBin, maxTotal: number): ReactElement => {
    const pct = maxTotal > 0 ? Math.round((cat.filtered / maxTotal) * 100) : 0;
    return (
      <button
        key={cat.key}
        type="button"
        data-orbit-histogram-category={cat.key}
        aria-pressed={cat.excluded}
        aria-label={`Toggle category ${cat.key}`}
        className={props.categoryClassName}
        style={
          props.categoryClassName !== undefined
            ? undefined
            : cat.excluded
              ? EXCLUDED_ROW_STYLE
              : CATEGORY_ROW_STYLE
        }
        onClick={() => {
          setBrush(toggleCategoryExclusion(brush, cat.key));
        }}
      >
        <span data-orbit-histogram-category-label="">{cat.key}</span>
        <span
          data-orbit-histogram-category-count=""
          aria-hidden="true"
          style={
            props.categoryClassName !== undefined
              ? undefined
              : {
                  background: `linear-gradient(to right, ${FILTERED_FILL}33 ${pct}%, transparent ${pct}%)`,
                  borderRadius: 2,
                  padding: '0 4px',
                }
          }
        >
          {cat.filtered}/{cat.total}
        </span>
      </button>
    );
  };

  let body: ReactElement;
  if (summary === null) {
    body = (
      <div data-orbit-histogram-empty="" style={styled ? TITLE_STYLE : undefined}>
        No data
      </div>
    );
  } else if (categorical) {
    const maxTotal = summary.categories.reduce((m, c) => (c.total > m ? c.total : m), 0);
    body = (
      <div
        data-orbit-histogram-categories=""
        style={styled ? { display: 'flex', flexDirection: 'column' } : undefined}
      >
        {summary.categories.map((cat) => renderCategory(cat, maxTotal))}
      </div>
    );
  } else {
    const bins = summary.bins;
    const maxTotal = bins.reduce((m, b) => (b.total > m ? b.total : m), 0);
    const barW = bins.length > 0 ? 100 / bins.length : 100;
    body = (
      <div
        data-orbit-histogram-plot=""
        tabIndex={0}
        aria-label={`${props.dimension} brush: drag to filter, arrow keys nudge, Escape clears`}
        role="slider"
        aria-orientation="horizontal"
        aria-valuemin={summary.domain?.min ?? 0}
        aria-valuemax={summary.domain?.max ?? 0}
        aria-valuenow={sliderValueNow(brush, summary.domain)}
        aria-valuetext={sliderValueText(brush, summary.domain)}
        style={styled ? PLOT_STYLE : undefined}
        onPointerDown={handlers.onPointerDown}
        onPointerMove={handlers.onPointerMove}
        onPointerUp={handlers.onPointerUp}
        onPointerCancel={handlers.onPointerCancel}
        onDoubleClick={handlers.onDoubleClick}
        onKeyDown={handlers.onKeyDown}
      >
        <svg
          width="100%"
          height={height}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
          style={styled ? SVG_STYLE : undefined}
        >
          {bins.map((bin, i) => {
            const x = i * barW + barW * 0.05;
            const w = barW * 0.9;
            const totalH = maxTotal > 0 ? (bin.total / maxTotal) * 100 : 0;
            const filteredH = maxTotal > 0 ? (bin.filtered / maxTotal) * 100 : 0;
            return (
              <g key={i}>
                <rect
                  data-orbit-histogram-bar-total=""
                  x={x}
                  y={100 - totalH}
                  width={w}
                  height={totalH}
                  fill={TOTAL_FILL}
                />
                <rect
                  data-orbit-histogram-bar-filtered=""
                  x={x}
                  y={100 - filteredH}
                  width={w}
                  height={filteredH}
                  fill={FILTERED_FILL}
                />
              </g>
            );
          })}
          {range !== null ? (
            <rect
              data-orbit-histogram-brush=""
              x={range.leftPct}
              y={0}
              width={range.widthPct}
              height={100}
              fill={BRUSH_FILL}
              stroke={BRUSH_STROKE}
              strokeWidth={0.5}
              pointerEvents="none"
            />
          ) : null}
        </svg>
      </div>
    );
  }

  return (
    <div
      data-orbit-histogram={props.dimension}
      role="group"
      aria-label={`${props.dimension} histogram`}
      className={props.className}
      style={styled ? { ...ROOT_STYLE, ...props.style } : props.style}
    >
      <div data-orbit-histogram-title="" style={styled ? TITLE_STYLE : undefined}>
        {props.dimension}
      </div>
      {body}
    </div>
  );
}
