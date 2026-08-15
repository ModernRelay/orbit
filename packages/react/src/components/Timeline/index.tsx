/**
 * <GraphTimeline> — timeline playback control.
 *
 * A slim horizontal band over one numeric/temporal crossfilter dimension:
 * the same pointer-drag brushing as the histogram (shared module), a
 * play/pause button wired to instance.playTimeline/pauseTimeline (the button
 * mirrors store `timeline.playingKey === dimension`), and a translucent
 * current-window indicator. While PLAYING, a user drag pauses playback (the
 * core folds the pause into the same brush publication). Headless-styleable:
 * providing `className` drops the built-in dark-theme inline styles.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import type { TimelinePlayback } from '@modernrelay/orbit-core';
import type { AnyGraphInstance } from '../../GraphProvider';
import { useResolvedInstance } from '../shared';
import { brushRangePct, sliderValueNow, sliderValueText, useRangeBrush } from '../_shared/brush';
import { useCrossfilterDimension, useSessionSetBrush } from '../_shared/crossfilter';

export interface GraphTimelineProps {
  /** Crossfilter dimension key — numeric/temporal to be playable. */
  dimension: string;
  /** Playback options forwarded to instance.playTimeline. */
  playback?: Partial<TimelinePlayback>;
  /** Band height in CSS px. Default 24. */
  height?: number;
  /** Explicit instance; defaults to the ambient <Graph>/<GraphProvider> one. */
  instance?: AnyGraphInstance;
  /** Class hook for the root; providing it drops the default styles. */
  className?: string;
  style?: CSSProperties;
  /** Class hook for the play/pause button; providing it drops its defaults. */
  buttonClassName?: string;
}

// --- default dark-theme styling (dropped when `className` is provided) ---

const ROOT_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: 6,
  borderRadius: 8,
  background: 'rgba(23, 25, 32, 0.92)',
  border: '1px solid rgba(255, 255, 255, 0.14)',
  color: '#e8eaf0',
  font: '12px/1.4 system-ui, sans-serif',
};

const BUTTON_STYLE: CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: 'none',
  borderRadius: 6,
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  minWidth: 28,
  minHeight: 28,
  padding: '2px 6px',
};

const DISABLED_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_STYLE,
  cursor: 'default',
  opacity: 0.4,
};

const PLOT_STYLE: CSSProperties = {
  position: 'relative',
  flex: 1,
  cursor: 'crosshair',
  touchAction: 'none',
  userSelect: 'none',
};

const SVG_STYLE: CSSProperties = { display: 'block', width: '100%' };

const TRACK_FILL = 'rgba(148, 163, 184, 0.18)';
const DENSITY_FILL = 'rgba(148, 163, 184, 0.4)';
const WINDOW_FILL = 'rgba(122, 162, 255, 0.28)';
const WINDOW_STROKE = 'rgba(122, 162, 255, 0.9)';

export function GraphTimeline(props: GraphTimelineProps): ReactElement {
  const instance = useResolvedInstance(props.instance, '<GraphTimeline>');
  const { summary, brush } = useCrossfilterDimension(instance, props.dimension);
  const setBrush = useSessionSetBrush(instance, props.dimension);

  // --- store mirror: timeline.playingKey drives the play/pause toggle ---
  const subscribe = useCallback(
    (onStoreChange: () => void) => instance.store.subscribe(onStoreChange),
    [instance],
  );
  const getPlayingKey = useCallback(
    (): string | null => instance.store.getState().timeline.playingKey,
    [instance],
  );
  const playingKey = useSyncExternalStore(subscribe, getPlayingKey, getPlayingKey);
  const playing = playingKey === props.dimension;

  const domain = summary?.domain ?? null;
  const handlers = useRangeBrush({
    domain,
    binCount: summary?.bins.length ?? 0,
    brush,
    setBrush,
  });

  const playable = summary !== null && summary.kind !== 'categorical' && domain !== null;
  const toggle = useCallback((): void => {
    if (instance.store.getState().timeline.playingKey === props.dimension) {
      instance.pauseTimeline();
      return;
    }
    try {
      instance.playTimeline(props.dimension, props.playback);
    } catch {
      // Not playable (categorical / unknown / no dimensions yet): inert.
    }
  }, [instance, props.dimension, props.playback]);

  const styled = props.className === undefined;
  const height = props.height ?? 24;
  const bins = summary?.bins ?? [];
  const maxTotal = bins.reduce((m, b) => (b.total > m ? b.total : m), 0);
  const barW = bins.length > 0 ? 100 / bins.length : 100;
  const range = brushRangePct(brush, domain);
  const label = playing ? 'Pause timeline' : 'Play timeline';

  return (
    <div
      data-orbit-timeline={props.dimension}
      role="group"
      aria-label={`${props.dimension} timeline`}
      className={props.className}
      style={styled ? { ...ROOT_STYLE, ...props.style } : props.style}
    >
      <button
        type="button"
        data-orbit-timeline-toggle=""
        aria-label={label}
        title={label}
        aria-pressed={playing}
        disabled={!playable}
        className={props.buttonClassName}
        style={
          props.buttonClassName !== undefined
            ? undefined
            : playable
              ? BUTTON_STYLE
              : DISABLED_BUTTON_STYLE
        }
        onClick={toggle}
      >
        {playing ? '⏸' : '▶'}
      </button>
      <div
        data-orbit-timeline-plot=""
        tabIndex={0}
        aria-label={`${props.dimension} timeline brush: drag to filter, arrow keys nudge, Escape clears`}
        role="slider"
        aria-orientation="horizontal"
        aria-valuemin={summary?.domain?.min ?? 0}
        aria-valuemax={summary?.domain?.max ?? 0}
        aria-valuenow={sliderValueNow(brush, summary?.domain)}
        aria-valuetext={sliderValueText(brush, summary?.domain)}
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
          <rect x={0} y={0} width={100} height={100} fill={TRACK_FILL} rx={2} />
          {bins.map((bin, i) => {
            const h = maxTotal > 0 ? (bin.total / maxTotal) * 100 : 0;
            return (
              <rect
                key={i}
                data-orbit-timeline-density=""
                x={i * barW + barW * 0.1}
                y={100 - h}
                width={barW * 0.8}
                height={h}
                fill={DENSITY_FILL}
              />
            );
          })}
          {range !== null ? (
            <rect
              data-orbit-timeline-window=""
              x={range.leftPct}
              y={0}
              width={range.widthPct}
              height={100}
              fill={WINDOW_FILL}
              stroke={WINDOW_STROKE}
              strokeWidth={0.75}
              pointerEvents="none"
            />
          ) : null}
        </svg>
      </div>
    </div>
  );
}
