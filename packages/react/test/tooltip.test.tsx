/**
 * <GraphTooltip> hover card tests (jsdom + FakeEngine + real
 * core).
 *
 * Covers: delayed appearance (delayMs after the store hover publication, via
 * the FakeEngine hover injection), immediate hide on unhover, cursor-anchored
 * positioning through the pointer fallback lane (jsdom has no PointerEvent
 * MouseEvents with pointer TYPES drive the window listener), the label-lane
 * priority when the hovered id is tracked, TEXT-NODE-only rendering of
 * hostile attrs, the 6-attr-row cap, and the `render` escape hatch.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { createGraphInstance } from '@modernrelay/orbit-core';
import type { GraphInstance, GraphSnapshot, LabelConfig } from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { GraphProvider } from '../src/GraphProvider';
import { GraphTooltip } from '../src/components/Tooltip/index';

// --- harness ----------------------------------------------------------------

const instances: GraphInstance[] = [];
const hosts: HTMLElement[] = [];

const defaultSnapshot: GraphSnapshot = {
  datasetKey: 'tooltip-fixture',
  sourceRevision: 1,
  nodes: [
    { id: 'a', attrs: { label: 'Alpha', kind: 'hub', weight: 3 } },
    { id: 'b' },
  ],
  edges: [{ source: 'a', target: 'b' }],
};

interface SetupOptions {
  data?: GraphSnapshot;
  labels?: LabelConfig;
  props?: Parameters<typeof GraphTooltip>[0];
}

async function setup(opts: SetupOptions = {}): Promise<{
  instance: GraphInstance;
  engine: FakeEngine;
  view: RenderResult;
}> {
  const engine = new FakeEngine();
  const instance = createGraphInstance({ engine: () => engine });
  instances.push(instance);
  instance.applyHostUpdate({
    data: opts.data ?? defaultSnapshot,
    ...(opts.labels !== undefined ? { labels: opts.labels } : {}),
  });

  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  await instance.attach(host);

  const view = render(
    <GraphProvider instance={instance}>
      <GraphTooltip {...opts.props} />
    </GraphProvider>,
  );
  return { instance, engine, view };
}

function card(view: RenderResult): HTMLElement | null {
  return view.container.querySelector<HTMLElement>('[data-orbit-tooltip]');
}

/** jsdom has no PointerEvent: a MouseEvent with the pointer TYPE carries real
 * clientX/clientY to the window listener. */
function movePointer(x: number, y: number): void {
  fireEvent(
    window,
    new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const instance of instances) instance.destroy();
  instances.length = 0;
  for (const host of hosts) host.remove();
  hosts.length = 0;
});

// --- tests ------------------------------------------------------------------

describe('<GraphTooltip> delay & visibility', () => {
  it('appears delayMs after hover at the tracked pointer position; hides immediately on unhover', async () => {
    vi.useFakeTimers();
    const { engine, view } = await setup();

    act(() => {
      engine.injectPointHover(0); // hover a
      movePointer(40, 25);
    });
    expect(card(view)).toBeNull(); // armed, not yet visible

    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(card(view)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1); // 150ms — the default delay elapses
    });
    const el = card(view);
    expect(el).not.toBeNull();
    expect(el!.getAttribute('role')).toBe('tooltip');
    // Cursor-anchored fallback: client px + the 12px offset (zero-rect host).
    expect(el!.style.transform).toBe('translate3d(52px, 37px, 0)');

    act(() => {
      engine.injectPointHover(null); // unhover hides IMMEDIATELY (no delay)
    });
    expect(card(view)).toBeNull();
  });

  it('a re-hover inside the delay window re-arms for the newest node', async () => {
    vi.useFakeTimers();
    const { engine, view } = await setup();
    act(() => {
      engine.injectPointHover(0);
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => {
      engine.injectPointHover(1); // switch target mid-window
    });
    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(card(view)).toBeNull(); // the old timer was cancelled
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(card(view)!.textContent).toBe('b'); // no attrs → id title only
  });

  it('follows the pointer while visible (untracked id → cursor lane)', async () => {
    vi.useFakeTimers();
    const { engine, view } = await setup();
    act(() => {
      engine.injectPointHover(0);
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    act(() => {
      movePointer(100, 60);
    });
    expect(card(view)!.style.transform).toBe('translate3d(112px, 72px, 0)');
    act(() => {
      movePointer(10, 20);
    });
    expect(card(view)!.style.transform).toBe('translate3d(22px, 32px, 0)');
  });

  it('prefers the label position lane when the hovered id is tracked', async () => {
    vi.useFakeTimers();
    // Force-track 'a' through the label lane and settle so a placement
    // with real screen coords exists (FakeEngine: screen == space).
    const { engine, view } = await setup({
      labels: { enabled: true, showFor: ['a'], minZoom: 0 },
    });
    act(() => {
      engine.injectSimulationEnd(); // settle → candidate re-rank
      engine.emitFrame(); // scheduler tick → positions channel fires
    });
    act(() => {
      engine.injectPointHover(0);
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    act(() => {
      movePointer(500, 500); // cursor lane must NOT win for a tracked id
      engine.emitFrame();
    });
    const el = card(view)!;
    // Node a sits at the FakeEngine seed grid origin (0, 0) → label lane
    // transform, not the 512px cursor transform.
    expect(el.style.transform).toBe('translate3d(0px, 0px, 0)');
  });
});

describe('<GraphTooltip> content', () => {
  it('renders label + attr rows as TEXT NODES only (hostile attrs stay literal)', async () => {
    vi.useFakeTimers();
    const payload = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    const { engine, view } = await setup({
      data: {
        datasetKey: 'xss',
        sourceRevision: 1,
        nodes: [{ id: 'evil', attrs: { label: payload, note: payload } }],
        edges: [],
      },
    });
    act(() => {
      engine.injectPointHover(0);
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    const el = card(view)!;
    expect(el.querySelector('[data-orbit-tooltip-label]')!.textContent).toBe(payload);
    expect(el.querySelector('[data-orbit-tooltip-attr="note"]')!.textContent).toBe(
      `note${payload}`,
    );
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.container.querySelector('img')).toBeNull();
  });

  it('caps the default card at 6 attr rows (label excluded as the title)', async () => {
    vi.useFakeTimers();
    const attrs: Record<string, unknown> = { label: 'Nine' };
    for (let i = 0; i < 9; i++) attrs[`k${i}`] = i;
    const { engine, view } = await setup({
      data: {
        datasetKey: 'many-attrs',
        sourceRevision: 1,
        nodes: [{ id: 'n', attrs }],
        edges: [],
      },
    });
    act(() => {
      engine.injectPointHover(0);
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    const rows = view.container.querySelectorAll('[data-orbit-tooltip-attr]');
    expect(rows.length).toBe(6);
    expect(view.container.querySelector('[data-orbit-tooltip-attr="label"]')).toBeNull();
  });

  it('the render prop replaces the default content', async () => {
    vi.useFakeTimers();
    const { engine, view } = await setup({
      props: { render: (node) => <em data-custom="">{`custom:${node.id}`}</em> },
    });
    act(() => {
      engine.injectPointHover(0);
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(card(view)!.querySelector('[data-custom]')!.textContent).toBe('custom:a');
    expect(card(view)!.querySelector('[data-orbit-tooltip-label]')).toBeNull();
  });
});

describe('<GraphTooltip> edge hover', () => {
  /** The fixture's single edge id is synthesized by (`a→b#0`). */
  const EDGE_ID = 'a→b#0';

  it('shows a card for a hovered EDGE, cursor-anchored and marked as an edge', async () => {
    vi.useFakeTimers();
    const { instance, engine, view } = await setup({
      data: {
        datasetKey: 'edge-fixture',
        sourceRevision: 1,
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [{ source: 'a', target: 'b', attrs: { label: 'cites', weight: 7 } }],
      },
    });
    expect(instance.getEdge(EDGE_ID)).toBeDefined();

    act(() => {
      engine.injectLinkHover(0);
      // Edges never enter the label position lane, so the cursor is the anchor.
      movePointer(40, 60);
    });
    expect(card(view)).toBeNull(); // still inside the delay window
    act(() => {
      vi.advanceTimersByTime(150);
    });

    const el = card(view)!;
    expect(el).not.toBeNull();
    expect(el.hasAttribute('data-orbit-tooltip-edge')).toBe(true);
    expect(el.querySelector('[data-orbit-tooltip-label]')!.textContent).toBe('cites');
    expect(el.querySelector('[data-orbit-tooltip-attr="weight"]')!.textContent).toContain('7');

    // Unhover clears immediately.
    act(() => {
      engine.injectLinkHover(null);
    });
    expect(card(view)).toBeNull();
  });

  it('a NODE hover wins over a simultaneous edge hover', async () => {
    vi.useFakeTimers();
    const { engine, view } = await setup();
    act(() => {
      engine.injectLinkHover(0);
      engine.injectPointHover(0);
      movePointer(40, 25);
    });
    // The arming effect must flush before timers advance.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    const el = card(view)!;
    // The node card, not the edge card.
    expect(el.hasAttribute('data-orbit-tooltip-edge')).toBe(false);
    expect(el.querySelector('[data-orbit-tooltip-label]')!.textContent).toBe('Alpha');
  });

  it('getEdgeText retitles the card without taking over the body', async () => {
    vi.useFakeTimers();
    const { engine, view } = await setup({
      data: {
        datasetKey: 'edge-typed',
        sourceRevision: 1,
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [{ source: 'a', target: 'b', attrs: { 'orbit:type': 'PublishedBySource' } }],
      },
      props: {
        getEdgeText: (edge) =>
          String((edge.attrs as Record<string, unknown>)['orbit:type'] ?? edge.id),
      },
    });
    act(() => {
      engine.injectLinkHover(0);
      movePointer(40, 25);
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    const el = card(view)!;
    expect(el.querySelector('[data-orbit-tooltip-label]')!.textContent).toBe('PublishedBySource');
    // …and the default attr rows still render.
    expect(el.querySelector('[data-orbit-tooltip-attr="orbit:type"]')).not.toBeNull();
  });

  it('edges={false} ignores edge hovers entirely', async () => {
    vi.useFakeTimers();
    const { engine, view } = await setup({ props: { edges: false } });
    act(() => {
      engine.injectLinkHover(0);
      movePointer(40, 25);
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(card(view)).toBeNull();
  });

  it('renders untrusted edge text as TEXT NODES only', async () => {
    vi.useFakeTimers();
    const payload = '<script>alert(1)</script>';
    const { engine, view } = await setup({
      data: {
        datasetKey: 'edge-xss',
        sourceRevision: 1,
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [{ source: 'a', target: 'b', attrs: { label: payload } }],
      },
    });
    act(() => {
      engine.injectLinkHover(0);
      movePointer(40, 25);
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    const title = card(view)!.querySelector('[data-orbit-tooltip-label]')!;
    expect(title.textContent).toBe(payload);
    expect(title.children.length).toBe(0);
    expect(view.container.querySelector('script')).toBeNull();
  });
});
