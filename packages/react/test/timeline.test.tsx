/**
 * <GraphTimeline> tests — jsdom + FakeEngine + the REAL core timeline
 * (fake timers). Play/pause wiring against store timeline.playingKey, tick
 * advancement through the crossfilter mask fast path, drag-pauses-playback,
 * disabled states, handle delegation, and instance resolution.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { DimensionSpec, GraphSnapshot } from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { Graph, useGraphTimeline } from '../src/index';
import type { GraphHandle } from '../src/index';
import { GraphTimeline } from '../src/components/Timeline';

type NA = { t: number };

const tDim: DimensionSpec<NA> = { key: 't', kind: 'numeric', get: (n) => n.attrs?.t };
const catDim: DimensionSpec<NA> = { key: 'cat', kind: 'categorical', get: (n) => n.id };
const dims: readonly DimensionSpec<NA>[] = [tDim, catDim];

/** 11 nodes, t = 0,10,…,100 → domain [0,100]. */
const snapshot: GraphSnapshot<NA> = {
  datasetKey: 'ds',
  sourceRevision: 1,
  nodes: Array.from({ length: 11 }, (_, i) => ({ id: `n${i}`, attrs: { t: i * 10 } })),
  edges: [],
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

const toggleOf = (c: HTMLElement): HTMLButtonElement =>
  c.querySelector<HTMLButtonElement>('[data-orbit-timeline-toggle]')!;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('<GraphTimeline>', () => {
  it('play starts core playback, mirrors playingKey, and ticks advance the window', async () => {
    vi.useFakeTimers();
    const { container, instance, session } = await mountGraph(
      <GraphTimeline dimension="t" playback={{ tickMs: 100, step: 0.25, window: 10 }} />,
    );

    const root = container.querySelector('[data-orbit-timeline]')!;
    expect(root.getAttribute('role')).toBe('group');
    expect(root.getAttribute('aria-label')).toBe('t timeline');

    const btn = toggleOf(container);
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('Play timeline');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('[data-orbit-timeline-window]')).toBeNull();

    fireEvent.click(btn);
    expect(instance.store.getState().timeline.playingKey).toBe('t');
    expect(session.getBrush('t')).toEqual({ min: 0, max: 10 });
    expect(btn.getAttribute('aria-label')).toBe('Pause timeline');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    // Current-window indicator: 10% of the [0,100] domain from the start.
    const win = container.querySelector('[data-orbit-timeline-window]')!;
    expect(win.getAttribute('x')).toBe('0');
    expect(win.getAttribute('width')).toBe('10');

    act(() => {
      vi.advanceTimersByTime(100); // one tick: progress 0.25 → window [25,35]
    });
    expect(session.getBrush('t')).toEqual({ min: 25, max: 35 });
    expect(container.querySelector('[data-orbit-timeline-window]')!.getAttribute('x')).toBe('25');

    fireEvent.click(btn); // pause
    expect(instance.store.getState().timeline.playingKey).toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('Play timeline');
    // The tick chain stopped: time passing no longer moves the brush.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(session.getBrush('t')).toEqual({ min: 25, max: 35 });
  });

  it('a user drag on the band replaces the brush and pauses playback (core rule)', async () => {
    vi.useFakeTimers();
    const { container, instance, session } = await mountGraph(
      <GraphTimeline dimension="t" playback={{ tickMs: 100, step: 0.25, window: 10 }} />,
    );
    fireEvent.click(toggleOf(container));
    expect(instance.store.getState().timeline.playingKey).toBe('t');

    const plot = container.querySelector('[data-orbit-timeline-plot]')!;
    stubRect(plot, { left: 0, width: 100 });
    firePointer(plot, 'pointerdown', { clientX: 40, pointerId: 7 });
    firePointer(plot, 'pointermove', { clientX: 60, pointerId: 7 });
    firePointer(plot, 'pointerup', { clientX: 60, pointerId: 7 });

    expect(instance.store.getState().timeline.playingKey).toBeNull(); // paused, not fought
    expect(session.getBrush('t')).toEqual({ min: 40, max: 60 });
    expect(toggleOf(container).getAttribute('aria-pressed')).toBe('false');
    // Playback is dead: time passing no longer moves the brush.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(session.getBrush('t')).toEqual({ min: 40, max: 60 });

    // Double-click clears the window; Escape does too (shared brush logic).
    fireEvent.doubleClick(plot);
    expect(session.getBrush('t')).toBeNull();
  });

  it('the toggle is disabled for categorical or unknown dimensions', async () => {
    const { container } = await mountGraph(
      <>
        <GraphTimeline dimension="cat" />
        <GraphTimeline dimension="nope" />
      </>,
    );
    const toggles = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-orbit-timeline-toggle]'),
    ];
    expect(toggles.length).toBe(2);
    expect(toggles.map((b) => b.disabled)).toEqual([true, true]);
  });

  it('handle playTimeline/pauseTimeline/getCrossfilterSession delegate; useGraphTimeline is live', async () => {
    vi.useFakeTimers();
    function Probe(): ReactElement {
      const timeline = useGraphTimeline();
      return <span data-testid="playing">{String(timeline.playingKey)}</span>;
    }
    const { container, handle, instance, session } = await mountGraph(<Probe />);
    const playing = (): string | null =>
      container.querySelector('[data-testid="playing"]')!.textContent;

    expect(handle.getCrossfilterSession()).toBe(session);
    expect(playing()).toBe('null');

    act(() => {
      handle.playTimeline('t', { tickMs: 50, step: 0.5, window: 20 });
    });
    expect(instance.store.getState().timeline.playingKey).toBe('t');
    expect(playing()).toBe('t');
    expect(session.getBrush('t')).toEqual({ min: 0, max: 20 });

    act(() => {
      handle.pauseTimeline();
    });
    expect(instance.store.getState().timeline.playingKey).toBeNull();
    expect(playing()).toBe('null');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(session.getBrush('t')).toEqual({ min: 0, max: 20 }); // chain stopped
  });

  it('resolves the instance via an explicit prop outside the <Graph> tree', async () => {
    vi.useFakeTimers();
    const { instance, session } = await mountGraph(null);
    const { container } = render(
      <GraphTimeline dimension="t" instance={instance} playback={{ window: 10 }} />,
    );
    const btn = toggleOf(container);
    expect(btn.disabled).toBe(false);

    fireEvent.click(btn);
    expect(instance.store.getState().timeline.playingKey).toBe('t');
    expect(session.getBrush('t')).toEqual({ min: 0, max: 10 });

    fireEvent.click(btn);
    expect(instance.store.getState().timeline.playingKey).toBeNull();
  });
});
