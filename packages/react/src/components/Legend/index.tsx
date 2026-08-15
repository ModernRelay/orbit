/**
 * <GraphLegend> — built-in legend over one scale-valued styling
 * channel.
 *
 * Reads `instance.getScaleInfo(channel)` and re-reads on store model/scope/
 * render revision advances and theme changes. Renders nothing when the
 * channel is not scale-valued. Forms:
 * - sequential color → gradient ramp bar + min/max domain ticks + metric name
 * - diverging color → two-tone bar + min/mid/max ticks
 * - categorical → swatch rows (color chip + value + count); a row click
 * calls `onCategoryClick(value)`, and rows listed in `excludedValues`
 * render dimmed
 * - numeric range (nodeSize scales) → graduated dots (4 steps, value labels)
 *
 * The HOST owns actual filtering: wire `onCategoryClick` to your `filter`
 * prop and feed the same values back through `excludedValues` for the dimmed
 * affordance. The host owns legend-driven filtering.
 *
 * All data-derived strings (category values) render as TEXT NODES — never
 * markup. Headless-styleable: providing `className` drops the built-in
 * inline styles (theme-token text/border colors included).
 */

import { useMemo } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { CATEGORICAL_PALETTE } from '@modernrelay/orbit-core';
import type { GraphTheme, ScaleChannelInfo, ScaleInfoRow } from '@modernrelay/orbit-core';
import type { AnyGraphInstance } from '../../GraphProvider';
import { useResolvedInstance } from '../shared';
import { useScaleInfoSubscription } from '../../hooks';

export interface GraphLegendProps {
  /** Styling channel to describe. Default 'nodeColor'. */
  channel?: 'nodeColor' | 'nodeSize';
  /** Categorical values the host currently filters out — their rows render
   * dimmed; filtering remains host-owned. */
  excludedValues?: readonly string[];
  /** Fired with the clicked categorical row's value. */
  onCategoryClick?: (value: string) => void;
  /** Explicit instance; defaults to the ambient <Graph>/<GraphProvider> one. */
  instance?: AnyGraphInstance;
  /** Class hook for the root; providing it drops the default styles. */
  className?: string;
  style?: CSSProperties;
}

/** Graduated-dot step count for numeric-range (size) legends. */
const SIZE_LEGEND_STEPS = 4;

// --- default styling (dropped when `className` is provided). Text/border
// tokens come from the resolved GraphTheme so the legend follows the theme
// prop; the translucent panel keeps the overlay look. ---

function rootStyle(theme: GraphTheme): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: 8,
    borderRadius: 8,
    minWidth: 120,
    background: 'rgba(23, 25, 32, 0.85)',
    border: '1px solid rgba(148, 163, 184, 0.25)',
    color: theme.labelFg,
    font: '12px/1.4 system-ui, sans-serif',
  };
}

const TITLE_STYLE: CSSProperties = { opacity: 0.75 };

const RAMP_STYLE: CSSProperties = { height: 10, borderRadius: 5 };

const TICK_ROW_STYLE: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 8,
  opacity: 0.85,
};

const CATEGORY_ROW_STYLE: CSSProperties = {
  appearance: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
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

const VALUE_STYLE: CSSProperties = { flex: 1, minWidth: 0 };

const COUNT_STYLE: CSSProperties = { opacity: 0.7 };

const DOT_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: 12,
};

const DOT_STEP_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 4,
};

/** Compact tick label: integers verbatim, else 3 significant digits. */
function formatTick(v: number): string {
  if (!Number.isFinite(v)) return '';
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(3)));
}

function dotStyle(size: number, theme: GraphTheme): CSSProperties {
  const px = Math.max(2, Math.abs(size));
  return {
    width: px,
    height: px,
    borderRadius: '50%',
    background: theme.accent,
  };
}

export function GraphLegend(props: GraphLegendProps): ReactElement | null {
  const instance = useResolvedInstance(props.instance, '<GraphLegend>');
  const channel = props.channel ?? 'nodeColor';
  const { version, theme } = useScaleInfoSubscription(instance);
  const info: ScaleChannelInfo | null = useMemo(
    () => instance.getScaleInfo(channel),
    // `version` invalidates: a new store revision can change scale info.
    [instance, channel, version],
  );
  if (info === null) return null;

  const styled = props.className === undefined;
  const scale = info.scale;
  const title =
    scale.kind === 'categorical'
      ? typeof scale.by === 'string'
        ? scale.by
        : 'category'
      : scale.metric;

  let body: ReactNode;
  if (scale.kind === 'categorical') {
    const palette: readonly (string | number)[] = scale.palette ?? CATEGORICAL_PALETTE;
    const excluded = props.excludedValues ?? [];
    const renderRow = (row: ScaleInfoRow): ReactElement => {
      const isExcluded = excluded.includes(row.value);
      const entry = row.colorIndex >= 0 ? palette[row.colorIndex] : undefined;
      return (
        <button
          key={row.value}
          type="button"
          data-orbit-legend-row={row.value}
          aria-pressed={isExcluded}
          style={styled ? (isExcluded ? EXCLUDED_ROW_STYLE : CATEGORY_ROW_STYLE) : undefined}
          onClick={() => {
            props.onCategoryClick?.(row.value);
          }}
        >
          <span
            data-orbit-legend-swatch=""
            aria-hidden="true"
            style={
              typeof entry === 'number'
                ? dotStyle(entry, theme)
                : {
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    background: entry ?? 'transparent',
                    flex: 'none',
                  }
            }
          />
          <span data-orbit-legend-value="" style={styled ? VALUE_STYLE : undefined}>
            {row.value}
          </span>
          <span data-orbit-legend-count="" style={styled ? COUNT_STYLE : undefined}>
            {row.count}
          </span>
        </button>
      );
    };
    body = (
      <div
        data-orbit-legend-rows=""
        style={styled ? { display: 'flex', flexDirection: 'column' } : undefined}
      >
        {(info.rows ?? []).map(renderRow)}
      </div>
    );
  } else {
    // sequential | diverging — tuple stops are colors (string) or sizes
    // (number); the domain resolves through the same frozen DomainStore
    // coordinate the projection uses, and may be absent.
    const stops = scale.range as readonly (string | number)[];
    const domain = info.domain;
    if (typeof stops[0] === 'number') {
      // Size legend: graduated dots, small→large, with value labels.
      const lo = stops[0];
      const hi = stops[stops.length - 1] as number;
      body = (
        <div data-orbit-legend-dots="" style={styled ? DOT_ROW_STYLE : undefined}>
          {Array.from({ length: SIZE_LEGEND_STEPS }, (_, i) => {
            const t = i / (SIZE_LEGEND_STEPS - 1);
            const size = lo + (hi - lo) * t;
            const label =
              domain !== undefined ? formatTick(domain[0] + (domain[1] - domain[0]) * t) : '';
            return (
              <span key={i} data-orbit-legend-dot-step="" style={styled ? DOT_STEP_STYLE : undefined}>
                <span data-orbit-legend-dot="" aria-hidden="true" style={dotStyle(size, theme)} />
                <span data-orbit-legend-tick="">{label}</span>
              </span>
            );
          })}
        </div>
      );
    } else {
      // Color legend: two-stop ramp (sequential) or three-stop bar with a
      // mid tick (diverging). Stops are host-provided CSS colors.
      const gradient = `linear-gradient(to right, ${stops.join(', ')})`;
      const ticks: string[] =
        domain === undefined
          ? [] // pending metric: no resolvable domain, no ticks
          : scale.kind === 'diverging'
            ? [formatTick(domain[0]), formatTick(scale.mid), formatTick(domain[1])]
            : [formatTick(domain[0]), formatTick(domain[1])];
      body = (
        <div style={styled ? { display: 'flex', flexDirection: 'column', gap: 4 } : undefined}>
          <div
            data-orbit-legend-ramp={scale.kind}
            style={styled ? { ...RAMP_STYLE, background: gradient } : { background: gradient }}
          />
          {ticks.length > 0 ? (
            <div data-orbit-legend-ticks="" style={styled ? TICK_ROW_STYLE : undefined}>
              {ticks.map((tick, i) => (
                <span key={i} data-orbit-legend-tick="">
                  {tick}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      );
    }
  }

  return (
    <div
      data-orbit-legend={channel}
      role="group"
      aria-label={`${title} legend`}
      className={props.className}
      style={styled ? { ...rootStyle(theme), ...props.style } : props.style}
    >
      <div data-orbit-legend-title="" style={styled ? TITLE_STYLE : undefined}>
        {title}
      </div>
      {body}
    </div>
  );
}
