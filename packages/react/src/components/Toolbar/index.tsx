/**
 * <GraphToolbar> — camera & simulation controls.
 *
 * Thin view over the GraphInstance ref API: zoom ±, fit view, reset view,
 * fullscreen toggle, screenshot download, and a simulation play/pause toggle
 * that mirrors the store's `simulationRunning` field. Headless-styleable:
 * providing `className`/`buttonClassName` drops the built-in dark-theme
 * inline styles, and `renderButton` replaces the default <button> rendering
 * entirely while keeping the wiring.
 *
 * Fullscreen note: the instance exposes no container getter by design — the
 * element sent fullscreen is `containerRef.current`, defaulting to
 * `document.documentElement`.
 */

import { Fragment, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactElement, ReactNode, RefObject } from 'react';
import type { AnyGraphInstance } from '../../GraphProvider';
import { cornerStyle, mergeStyle, useResolvedInstance } from '../shared';
import type { GraphCorner } from '../shared';

export type GraphToolbarAction =
  | 'zoom-in'
  | 'zoom-out'
  | 'fit-view'
  | 'reset-view'
  | 'fullscreen'
  | 'screenshot'
  | 'simulation';

/** One toolbar affordance, as handed to the `renderButton` render prop. */
export interface GraphToolbarButton {
  action: GraphToolbarAction;
  /** Accessible label (also the default tooltip). */
  label: string;
  /** Default glyph rendered inside the button. */
  glyph: string;
  disabled: boolean;
  /** Present on the toggles (fullscreen, simulation). */
  pressed?: boolean;
  /** Perform the action. */
  run(): void;
}

export interface GraphToolbarProps {
  /** Explicit instance; defaults to the ambient <Graph>/<GraphProvider> one. */
  instance?: AnyGraphInstance;
  /** Corner the toolbar anchors to. Default 'top-left'. */
  position?: GraphCorner;
  /** Distance from the two anchored edges in CSS px. Default 12. */
  offset?: number;
  /** Class hook for the toolbar root; providing it drops the default styles
   * INCLUDING placement — position it yourself in CSS. */
  className?: string;
  /** Style overrides merged over the defaults; an inset you set here wins
   * over the one `position` implies (they are resolved per axis, never
   * layered). */
  style?: CSSProperties;
  /** Class hook for each button; providing it drops the default styles. */
  buttonClassName?: string;
  /** Element sent fullscreen; default `document.documentElement`. */
  containerRef?: RefObject<HTMLElement | null>;
  /** Download filename for screenshots. Default 'orbit-graph.png'. */
  screenshotFileName?: string;
  /** Render-prop replacement for a single button (wiring stays intact). */
  renderButton?: (button: GraphToolbarButton) => ReactNode;
}

// --- default dark-theme styling (dropped when class hooks are provided) ---

const TOOLBAR_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  padding: 4,
  borderRadius: 8,
  background: 'rgba(23, 25, 32, 0.92)',
  border: '1px solid rgba(255, 255, 255, 0.14)',
  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
  color: '#e8eaf0',
  font: '13px/1.4 system-ui, sans-serif',
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

export function GraphToolbar(props: GraphToolbarProps): ReactElement {
  const instance = useResolvedInstance(props.instance, '<GraphToolbar>');

  // --- store mirror: simulationRunning drives the play/pause toggle ---
  const subscribe = useCallback(
    (onStoreChange: () => void) => instance.store.subscribe(onStoreChange),
    [instance],
  );
  const getSimulationRunning = useCallback(
    () => instance.store.getState().simulationRunning,
    [instance],
  );
  const simulationRunning = useSyncExternalStore(
    subscribe,
    getSimulationRunning,
    getSimulationRunning,
  );

  // --- fullscreen state mirror (for aria-pressed / label) ---
  const [fullscreenActive, setFullscreenActive] = useState(false);
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onChange = (): void => {
      setFullscreenActive((document.fullscreenElement ?? null) !== null);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
    };
  }, []);

  // --- screenshot capability sniff: probe once when the instance is ready
  // (captureScreenshot resolves null pre-ready and when the engine lacks
  // support); a null resolution no-op-disables the button permanently. ---
  const [screenshotSupported, setScreenshotSupported] = useState(true);
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    const probe = (): void => {
      void instance.captureScreenshot().then((blob) => {
        if (!cancelled && blob === null) setScreenshotSupported(false);
      });
    };
    if (instance.store.getState().status === 'ready') {
      probe();
    } else {
      unsubscribe = instance.store.subscribe(() => {
        if (instance.store.getState().status !== 'ready') return;
        unsubscribe?.();
        unsubscribe = null;
        probe();
      });
    }
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [instance]);

  const screenshotFileName = props.screenshotFileName;
  const takeScreenshot = useCallback((): void => {
    void instance.captureScreenshot().then((blob) => {
      if (blob === null) {
        // Unsupported / not ready — no-op-disable from here on.
        setScreenshotSupported(false);
        return;
      }
      if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = screenshotFileName ?? 'orbit-graph.png';
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    });
  }, [instance, screenshotFileName]);

  const containerRef = props.containerRef;
  const toggleFullscreen = useCallback((): void => {
    if (typeof document === 'undefined') return;
    if ((document.fullscreenElement ?? null) !== null) {
      if (typeof document.exitFullscreen === 'function') {
        void document.exitFullscreen().catch(() => undefined);
      }
      return;
    }
    const el = containerRef?.current ?? document.documentElement;
    if (typeof el.requestFullscreen === 'function') {
      void el.requestFullscreen().catch(() => undefined);
    }
  }, [containerRef]);

  const buttons: GraphToolbarButton[] = [
    {
      action: 'zoom-in',
      label: 'Zoom in',
      glyph: '+',
      disabled: false,
      run: () => {
        instance.zoomIn();
      },
    },
    {
      action: 'zoom-out',
      label: 'Zoom out',
      glyph: '−',
      disabled: false,
      run: () => {
        instance.zoomOut();
      },
    },
    {
      action: 'fit-view',
      label: 'Fit view',
      glyph: '⤢',
      disabled: false,
      run: () => {
        instance.fitView();
      },
    },
    {
      action: 'reset-view',
      label: 'Reset view',
      glyph: '↺',
      disabled: false,
      run: () => {
        instance.setViewport({ x: 0, y: 0, zoom: 1 });
      },
    },
    {
      action: 'fullscreen',
      label: fullscreenActive ? 'Exit fullscreen' : 'Enter fullscreen',
      glyph: '⛶',
      disabled: false,
      pressed: fullscreenActive,
      run: toggleFullscreen,
    },
    {
      action: 'screenshot',
      label: 'Save screenshot',
      glyph: '◫',
      disabled: !screenshotSupported,
      run: takeScreenshot,
    },
    {
      action: 'simulation',
      label: simulationRunning ? 'Pause simulation' : 'Resume simulation',
      glyph: simulationRunning ? '⏸' : '▶',
      disabled: false,
      pressed: simulationRunning,
      run: () => {
        if (instance.isSimulationRunning()) instance.pauseSimulation();
        else instance.resumeSimulation();
      },
    },
  ];

  const renderButton = props.renderButton;
  return (
    <div
      data-orbit-toolbar=""
      role="toolbar"
      aria-label="Graph controls"
      className={props.className}
      style={
        props.className !== undefined
          ? props.style
          : mergeStyle(
              { ...cornerStyle(props.position ?? 'top-left', props.offset), ...TOOLBAR_STYLE },
              props.style,
            )
      }
    >
      {buttons.map((button) =>
        renderButton !== undefined ? (
          <Fragment key={button.action}>{renderButton(button)}</Fragment>
        ) : (
          <button
            key={button.action}
            type="button"
            data-orbit-toolbar-button={button.action}
            className={props.buttonClassName}
            style={
              props.buttonClassName !== undefined
                ? undefined
                : button.disabled
                  ? DISABLED_BUTTON_STYLE
                  : BUTTON_STYLE
            }
            aria-label={button.label}
            title={button.label}
            aria-pressed={button.pressed}
            disabled={button.disabled}
            onClick={() => {
              button.run();
            }}
          >
            {button.glyph}
          </button>
        ),
      )}
    </div>
  );
}
