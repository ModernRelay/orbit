/**
 * <GraphHistogram> tests — jsdom + FakeEngine + the REAL core
 * crossfilter engine. Dual-layer bars, pointer-drag brushing, double-click
 * clear, categorical exclusion toggles, keyboard nudge/clear, instance
 * resolution, live hooks, and text-node safety.
 *
 * jsdom has no PointerEvent machinery, so pointer events are dispatched as
 * MouseEvents with the pointer type name (React dispatches on the event
 * type) and plot rects are stubbed per test.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { DimensionSpec, GraphSnapshot } from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { Graph, GraphProvider, useGraphCrossfilter, useGraphVisible } from '../src/index';
import type { GraphHandle } from '../src/index';
import { GraphHistogram } from '../src/components/Histogram';

type NA = { v: number; cat: string };

const vDim: DimensionSpec<NA> = { key: 'v', kind: 'numeric', get: (n) => n.attrs?.v, bins: 5 };
const catDim: DimensionSpec<NA> = { key: 'cat', kind: 'categorical', get: (n) => n.attrs?.cat };
const dims: readonly DimensionSpec<NA>[] = [vDim, catDim];

/** v = 0..5 (domain [0,5], 5 bins → totals [1,1,1,1,2]); cat x,x,x,y,y,z. */
const snapshot: GraphSnapshot<NA> = {
  datasetKey: 'ds',
  sourceRevision: 1,
  nodes: [
    { id: 'a', attrs: { v: 0, cat: 'x' } },
    { id: 'b', attrs: { v: 1, cat: 'x' } },
    { id: 'c', attrs: { v: 2, cat: 'x' } },
    { id: 'd', attrs: { v: 3, cat: 'y' } },
    { id: 'e', attrs: { v: 4, cat: 'y' } },
    { id: 'f', attrs: { v: 5, cat: 'z' } },
  ],
  edges: [{ source: 'a', target: 'b' }],
};

interface PointerInit extends MouseEventInit {
  pointerId?: number;
}

function firePointer(target: Element, type: string, init: PointerInit = {}): void {
  const { pointerId, ...mouseInit } = init;
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...mouseInit });
  if (pointerId !== undefined) {
    Object.defineProperty(event, 'pointerId', { value: pointerId });
  }
  fireEvent(target, event);
}

/** jsdom rects are all-zero; stub the plot's rect so x → domain math works. */
function stubRect(el: Element, rect: { left: number; width: number }): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      x: rect.left,
      y: 0,
      left: rect.left,
      top: 0,
      right: rect.left + rect.width,
      bottom: 20,
      width: rect.width,
      height: 20,
      toJSON: () => ({}),
    }) as DOMRect;
}

async function flush(): Promise<void> {
  await act(async () => {});
}

async function mountGraph(children: ReactNode) {
  const fake = new FakeEngine();
  const handleRef = createRef<GraphHandle<NA>>();
  const { container } = render(
    <Graph ref={handleRef} engine={() => fake} data={snapshot} crossfilter={dims}>
      {children}
    </Graph>,
  );
  await flush();
  await flush();
  const handle = handleRef.current!;
  const session = handle.instance.getCrossfilterSession();
  expect(session).not.toBeNull();
  return { fake, handle, instance: handle.instance, session: session!, container };
}

const heightsOf = (container: HTMLElement, selector: string): (string | null)[] =>
  [...container.querySelectorAll(selector)].map((r) => r.getAttribute('height'));

afterEach(() => {
  cleanup();
});

describe('<GraphHistogram> numeric', () => {
  it('renders the dual layer: total bars + a joint-filtered overlay', async () => {
    const { container, session } = await mountGraph(<GraphHistogram dimension="v" />);

    const root = container.querySelector('[data-orbit-histogram]')!;
    expect(root.getAttribute('role')).toBe('group');
    expect(root.getAttribute('aria-label')).toBe('v histogram');

    // Unbrushed: filtered === total, bar per bin in both layers.
    expect(heightsOf(container, '[data-orbit-histogram-bar-total]')).toEqual([
      '50',
      '50',
      '50',
      '50',
      '100',
    ]);
    expect(heightsOf(container, '[data-orbit-histogram-bar-filtered]')).toEqual([
      '50',
      '50',
      '50',
      '50',
      '100',
    ]);

    // Brushing ANOTHER dimension drops only the filtered layer.
    await act(async () => {
      await session.setBrush('cat', { excluded: ['x'] });
    });
    expect(heightsOf(container, '[data-orbit-histogram-bar-total]')).toEqual([
      '50',
      '50',
      '50',
      '50',
      '100',
    ]);
    expect(heightsOf(container, '[data-orbit-histogram-bar-filtered]')).toEqual([
      '0',
      '0',
      '0',
      '50',
      '100',
    ]);
  });

  it('pointer-drag sets a session range brush; double-click clears it', async () => {
    const { container, session, instance } = await mountGraph(<GraphHistogram dimension="v" />);
    const plot = container.querySelector('[data-orbit-histogram-plot]')!;
    stubRect(plot, { left: 0, width: 100 });

    expect(container.querySelector('[data-orbit-histogram-brush]')).toBeNull();
    firePointer(plot, 'pointerdown', { clientX: 10, pointerId: 1 });
    firePointer(plot, 'pointermove', { clientX: 50, pointerId: 1 });
    firePointer(plot, 'pointerup', { clientX: 50, pointerId: 1 });

    expect(session.getBrush('v')).toEqual({ min: 0.5, max: 2.5 });
    // mask fast path: visible counts shrink, accepted counts untouched.
    expect(instance.store.getState().visible).toEqual({ nodes: 2, edges: 0 });
    expect(instance.store.getState().nodeCount).toBe(6);
    // The brush region renders as a translucent overlay.
    const overlay = container.querySelector('[data-orbit-histogram-brush]')!;
    expect(overlay.getAttribute('x')).toBe('10');
    expect(overlay.getAttribute('width')).toBe('40');

    fireEvent.doubleClick(plot);
    expect(session.getBrush('v')).toBeNull();
    expect(instance.store.getState().visible).toEqual({ nodes: 6, edges: 1 });
    expect(container.querySelector('[data-orbit-histogram-brush]')).toBeNull();
  });

  it('a reverse drag orders min/max', async () => {
    const { container, session } = await mountGraph(<GraphHistogram dimension="v" />);
    const plot = container.querySelector('[data-orbit-histogram-plot]')!;
    stubRect(plot, { left: 0, width: 100 });

    firePointer(plot, 'pointerdown', { clientX: 80, pointerId: 2 });
    firePointer(plot, 'pointermove', { clientX: 20, pointerId: 2 });
    firePointer(plot, 'pointerup', { clientX: 20, pointerId: 2 });

    expect(session.getBrush('v')).toEqual({ min: 1, max: 4 });
  });

  it('keyboard: Left/Right nudge the brush by one bin, Escape clears', async () => {
    const { container, session } = await mountGraph(<GraphHistogram dimension="v" />);
    const plot = container.querySelector<HTMLElement>('[data-orbit-histogram-plot]')!;
    expect(plot.tabIndex).toBe(0); // focusable plot

    await act(async () => {
      await session.setBrush('v', { min: 1, max: 2 });
    });
    plot.focus();

    fireEvent.keyDown(plot, { key: 'ArrowRight' });
    expect(session.getBrush('v')).toEqual({ min: 2, max: 3 }); // one bin = span/5 = 1

    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(session.getBrush('v')).toEqual({ min: 1, max: 2 });

    // Clamped at the domain edge (window width preserved).
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(session.getBrush('v')).toEqual({ min: 0, max: 1 });

    fireEvent.keyDown(plot, { key: 'Escape' });
    expect(session.getBrush('v')).toBeNull();
  });
});

describe('<GraphHistogram> categorical', () => {
  it('clickable category rows toggle exclusions', async () => {
    const { container, session, instance } = await mountGraph(<GraphHistogram dimension="cat" />);

    const rows = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-orbit-histogram-category]'),
    ];
    expect(rows.map((r) => r.getAttribute('data-orbit-histogram-category'))).toEqual([
      'x',
      'y',
      'z',
    ]);
    expect(rows.map((r) => r.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false']);

    fireEvent.click(rows[0]!);
    expect(session.getBrush('cat')).toEqual({ excluded: ['x'] });
    expect(instance.store.getState().visible.nodes).toBe(3); // d, e, f
    expect(
      container
        .querySelector('[data-orbit-histogram-category="x"]')!
        .getAttribute('aria-pressed'),
    ).toBe('true');

    // Toggling the last exclusion back off clears the brush entirely.
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-orbit-histogram-category="x"]')!);
    expect(session.getBrush('cat')).toBeNull();
    expect(instance.store.getState().visible.nodes).toBe(6);
  });
});

describe('<GraphHistogram> composition', () => {
  it('resolves the instance via an explicit prop or a bare provider', async () => {
    const { instance } = await mountGraph(null);

    const explicit = render(<GraphHistogram dimension="v" instance={instance} />);
    expect(explicit.container.querySelectorAll('[data-orbit-histogram-bar-total]').length).toBe(5);

    const provided = render(
      <GraphProvider instance={instance}>
        <GraphHistogram dimension="v" />
      </GraphProvider>,
    );
    expect(provided.container.querySelectorAll('[data-orbit-histogram-bar-total]').length).toBe(5);
  });

  it('renders an empty state for an unknown dimension (no session crash)', async () => {
    const { container } = await mountGraph(<GraphHistogram dimension="nope" />);
    expect(container.querySelector('[data-orbit-histogram-empty]')).not.toBeNull();
    expect(container.querySelectorAll('[data-orbit-histogram-bar-total]').length).toBe(0);
  });

  it('useGraphCrossfilter/useGraphVisible return live values', async () => {
    function Probe(): ReactElement {
      const visible = useGraphVisible();
      const cf = useGraphCrossfilter('v');
      return (
        <div>
          <span data-testid="visible">{`${visible.nodes}/${visible.edges}`}</span>
          <span data-testid="bins">{cf.summary === null ? 'none' : cf.summary.bins.length}</span>
          <span data-testid="brush">{cf.brush === null ? 'none' : JSON.stringify(cf.brush)}</span>
          <button
            data-testid="set-brush"
            onClick={() => {
              cf.setBrush({ min: 3, max: 5 });
            }}
          />
        </div>
      );
    }
    const { container, session } = await mountGraph(<Probe />);
    const text = (id: string): string | null =>
      container.querySelector(`[data-testid="${id}"]`)!.textContent;

    expect(text('visible')).toBe('6/1');
    expect(text('bins')).toBe('5');
    expect(text('brush')).toBe('none');

    fireEvent.click(container.querySelector('[data-testid="set-brush"]')!);
    expect(session.getBrush('v')).toEqual({ min: 3, max: 5 });
    expect(text('visible')).toBe('3/0');
    expect(text('brush')).toBe('{"min":3,"max":5}');
  });

  it('renders hostile dimension keys and category values as inert text nodes', async () => {
    const hostileKey = '<img src=x onerror="window.__orbit_pwned_dim=1">';
    const hostileCat = '<script>window.__orbit_pwned_cat = true</script>';
    const hostileDim: DimensionSpec<NA> = {
      key: hostileKey,
      kind: 'categorical',
      get: () => hostileCat,
    };
    const fake = new FakeEngine();
    const { container } = render(
      <Graph engine={() => fake} data={snapshot} crossfilter={[hostileDim]}>
        <GraphHistogram dimension={hostileKey} />
      </Graph>,
    );
    await flush();

    expect(container.querySelector('[data-orbit-histogram-title]')!.textContent).toBe(hostileKey);
    expect(container.querySelector('[data-orbit-histogram-category-label]')!.textContent).toBe(
      hostileCat,
    );
    const root = container.querySelector('[role="group"]')!;
    expect(root.getAttribute('aria-label')).toBe(`${hostileKey} histogram`);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    const w = window as unknown as Record<string, unknown>;
    expect(w['__orbit_pwned_dim']).toBeUndefined();
    expect(w['__orbit_pwned_cat']).toBeUndefined();
  });
});
