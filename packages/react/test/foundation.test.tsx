/**
 * Foundation tests — instance resolution, component entry scaffolding,
 * live-region coalescing, container ARIA surface, reduced-motion plumbing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import type { ReactElement } from 'react';
import type { GraphSnapshot, GraphStoreState } from '@modernrelay/orbit-core';
import { GRAPH_THEME_DARK } from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { Graph, GraphProvider, LiveRegion, useResolvedInstance } from '../src/index';
import type { GraphHandle } from '../src/index';
import type { AnyGraphInstance } from '../src/GraphProvider';
import { ANNOUNCE_INTERVAL_MS } from '../src/LiveRegion';
import { GraphToolbar } from '../src/components/Toolbar/index';
import { GraphContextMenu } from '../src/components/ContextMenu/index';
import { GraphSelectionActions } from '../src/components/SelectionActions/index';
import { GraphNavigator } from '../src/components/Navigator/index';

const snapshot: GraphSnapshot = {
  datasetKey: 'ds',
  sourceRevision: 1,
  nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  edges: [{ source: 'a', target: 'b' }],
};

/** Flush the engine mount promise (and any deferred microtasks) inside act. */
async function flush(): Promise<void> {
  await act(async () => {});
}

function makeState(patch: Partial<GraphStoreState> = {}): GraphStoreState {
  return {
    status: 'ready',
    revisions: { source: null, model: 0, scope: 0, render: 0, appliedRender: null },
    nodeCount: 0,
    edgeCount: 0,
    selection: { nodeIds: [], edgeIds: [], groupIds: [] },
    hover: { nodeId: null, edgeId: null },
    pins: new Map(),
    hiddenNodeIds: new Set(),
    scope: null,
    pendingExpansions: new Set(),
    folds: new Map(),
    visible: { nodes: 0, edges: 0 },
    timeline: { playingKey: null },
    history: { undoDepth: 0, redoDepth: 0 },
    overlayIds: [],
    groups: [],
    pinnedNodeIds: new Set<string>(),
    search: null,
    viewport: null,
    diagnostics: [],
    simulationRunning: false,
    theme: GRAPH_THEME_DARK,
    ...patch,
  };
}

/** Minimal structural GraphInstance mock: the store surface LiveRegion and
 * the provider need. */
function createMockInstance(initial: Partial<GraphStoreState> = {}): {
  instance: AnyGraphInstance;
  setState: (patch: Partial<GraphStoreState>) => void;
} {
  let state = makeState(initial);
  const subs = new Set<() => void>();
  const store = {
    getState: () => state,
    subscribe: (cb: () => void) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
  return {
    instance: { store } as unknown as AnyGraphInstance,
    setState: (patch) => {
      state = { ...state, ...patch };
      for (const cb of [...subs]) cb();
    },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useResolvedInstance', () => {
  let captured: AnyGraphInstance | null = null;
  function Probe(props: { explicit?: AnyGraphInstance; name?: string }): ReactElement {
    captured = useResolvedInstance(props.explicit, props.name);
    return <div />;
  }

  it('resolves an explicit instance outside any provider', () => {
    const { instance } = createMockInstance();
    captured = null;
    render(<Probe explicit={instance} />);
    expect(captured).toBe(instance);
  });

  it('resolves the ambient GraphProvider context when no explicit instance is given', () => {
    const { instance } = createMockInstance();
    captured = null;
    render(
      <GraphProvider instance={instance}>
        <Probe />
      </GraphProvider>,
    );
    expect(captured).toBe(instance);
  });

  it('prefers the explicit instance over the ambient context', () => {
    const ambient = createMockInstance().instance;
    const explicit = createMockInstance().instance;
    captured = null;
    render(
      <GraphProvider instance={ambient}>
        <Probe explicit={explicit} />
      </GraphProvider>,
    );
    expect(captured).toBe(explicit);
  });

  it('throws a descriptive error naming the component when neither exists', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => render(<Probe name="<GraphToolbar>" />)).toThrow(
        /<GraphToolbar> requires a GraphInstance/,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe('component entries', () => {
  it('the four packaged component entries resolve and export their component', () => {
    expect(typeof GraphToolbar).toBe('function');
    expect(typeof GraphContextMenu).toBe('function');
    expect(typeof GraphSelectionActions).toBe('function');
    expect(typeof GraphNavigator).toBe('function');
  });
});

describe('<LiveRegion>', () => {
  it('coalesces rapid store changes into one announcement of the freshest summary', () => {
    vi.useFakeTimers();
    const mock = createMockInstance({ nodeCount: 3, edgeCount: 1 });
    const { container } = render(
      <GraphProvider instance={mock.instance}>
        <LiveRegion />
      </GraphProvider>,
    );
    const region = container.querySelector('[data-orbit-live-region]')!;
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');

    // Two rapid selection changes inside one coalescing window.
    act(() => {
      mock.setState({ selection: { nodeIds: ['a'], edgeIds: [], groupIds: [] } });
    });
    act(() => {
      mock.setState({ selection: { nodeIds: ['a', 'b'], edgeIds: [], groupIds: [] } });
    });
    expect(region.textContent).toBe(''); // window still open — nothing spoken

    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_INTERVAL_MS);
    });
    expect(region.textContent).toBe('Graph ready. 3 nodes, 1 edges. 2 selected.');

    // Exactly one announcement: nothing further without a summary change.
    const announced = region.textContent;
    act(() => {
      vi.advanceTimersByTime(5 * ANNOUNCE_INTERVAL_MS);
    });
    expect(region.textContent).toBe(announced);
  });

  it('does not announce store changes that leave the summary string unchanged', () => {
    vi.useFakeTimers();
    const mock = createMockInstance({ nodeCount: 2 });
    const { container } = render(
      <GraphProvider instance={mock.instance}>
        <LiveRegion />
      </GraphProvider>,
    );
    const region = container.querySelector('[data-orbit-live-region]')!;
    act(() => {
      mock.setState({ hover: { nodeId: 'a', edgeId: null } }); // not in the summary
    });
    act(() => {
      vi.advanceTimersByTime(5 * ANNOUNCE_INTERVAL_MS);
    });
    expect(region.textContent).toBe('');
  });

  it('is gated off entirely when announcements === false', () => {
    vi.useFakeTimers();
    const mock = createMockInstance({ nodeCount: 3 });
    const { container } = render(
      <GraphProvider instance={mock.instance}>
        <LiveRegion announcements={false} />
      </GraphProvider>,
    );
    const region = container.querySelector('[data-orbit-live-region]')!;
    act(() => {
      mock.setState({ selection: { nodeIds: ['a'], edgeIds: [], groupIds: [] } });
    });
    act(() => {
      vi.advanceTimersByTime(10 * ANNOUNCE_INTERVAL_MS);
    });
    expect(region.textContent).toBe('');
  });
});

describe('<Graph> accessibility surface', () => {
  it('applies role/aria-label to the canvas container and renders the live region', async () => {
    const { container } = render(<Graph engine={() => new FakeEngine()} data={snapshot} />);
    await flush();

    const canvas = container.querySelector('[data-orbit-canvas]')!;
    expect(canvas.getAttribute('role')).toBe('application');
    expect(canvas.getAttribute('aria-label')).toBe('Graph visualization');
    expect(canvas.hasAttribute('aria-describedby')).toBe(false);
    // The engine-owned canvas layer still has no React children.
    expect(canvas.childNodes.length).toBe(0);
    expect(container.querySelector('[data-orbit-live-region]')).not.toBeNull();
  });

  it('wires accessibility.label and aria-describedby for accessibility.description', async () => {
    const { container } = render(
      <Graph
        engine={() => new FakeEngine()}
        data={snapshot}
        accessibility={{ label: 'My graph', description: 'A demo graph' }}
      />,
    );
    await flush();

    const canvas = container.querySelector('[data-orbit-canvas]')!;
    expect(canvas.getAttribute('aria-label')).toBe('My graph');
    const descId = canvas.getAttribute('aria-describedby');
    expect(descId).toBeTruthy();
    const desc = document.getElementById(descId!);
    expect(desc).not.toBeNull();
    expect(desc!.textContent).toBe('A demo graph');
  });

  it('forwards labels/accessibility through one diffing applyHostUpdate', async () => {
    const fake = new FakeEngine();
    const handleRef = createRef<GraphHandle>();
    const { rerender } = render(<Graph ref={handleRef} engine={() => fake} data={snapshot} />);
    await flush();

    const spy = vi.spyOn(handleRef.current!.instance, 'applyHostUpdate');
    const labels = { minZoom: 2, maxVisible: 32 };
    const accessibility = { label: 'Named graph' };
    rerender(
      <Graph
        ref={handleRef}
        engine={() => fake}
        data={snapshot}
        labels={labels}
        accessibility={accessibility}
      />,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ labels, accessibility });

    // Identity-stable props re-commit issues no further host update.
    spy.mockClear();
    rerender(
      <Graph
        ref={handleRef}
        engine={() => fake}
        data={snapshot}
        labels={labels}
        accessibility={accessibility}
      />,
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('reduced motion', () => {
  it('subscribes to prefers-reduced-motion and reports changes via setReducedMotion', async () => {
    const listeners: ((e: { matches: boolean }) => void)[] = [];
    const mql = {
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: vi.fn((_type: string, cb: (e: { matches: boolean }) => void) => {
        listeners.push(cb);
      }),
      removeEventListener: vi.fn(),
    };
    const original = window.matchMedia;
    const matchMediaMock = vi.fn(() => mql);
    window.matchMedia = matchMediaMock as unknown as typeof window.matchMedia;
    try {
      const handleRef = createRef<GraphHandle>();
      const { unmount } = render(
        <Graph ref={handleRef} engine={() => new FakeEngine()} data={snapshot} />,
      );
      await flush();

      expect(matchMediaMock).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
      expect(listeners.length).toBe(1);

      // Install the pinned-interface spy, then flip the media preference.
      const spy = vi.fn();
      (
        handleRef.current!.instance as unknown as {
          setReducedMotion?: (v: boolean | undefined) => void;
        }
      ).setReducedMotion = spy;
      act(() => {
        listeners[0]!({ matches: true });
      });
      expect(spy).toHaveBeenCalledWith(true);
      act(() => {
        listeners[0]!({ matches: false });
      });
      expect(spy).toHaveBeenLastCalledWith(false);

      unmount();
      expect(mql.removeEventListener).toHaveBeenCalledTimes(1);
    } finally {
      window.matchMedia = original;
    }
  });
});
