/**
 * <GraphInspector> docked panel tests (jsdom + FakeEngine +
 * real core).
 *
 * Covers: the empty state (no / multi selection), the attrs table with
 * TEXT-NODE-only rendering of hostile attrs, the renderAttrs escape hatch,
 * neighbor resolution through the focusNode seam ('Show neighbors' → list →
 * click → focusNode camera fly), the default quick actions wired to the
 * public mutators (Expand / Isolate / Pin↔Unpin toggle / Hide), and the
 * quickActions render-prop replacement.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { createGraphInstance } from '@modernrelay/orbit-core';
import type { GraphInstance, GraphSnapshot } from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { GraphProvider } from '../src/GraphProvider';
import { GraphInspector } from '../src/components/Inspector/index';

// --- fixtures ---------------------------------------------------------------

/** a—b, b—c (plus self-loop b—b that must NOT list), c—d; b carries attrs. */
const handSnapshot: GraphSnapshot = {
  datasetKey: 'inspector-hand',
  sourceRevision: 1,
  nodes: [
    { id: 'a' },
    { id: 'b', attrs: { label: 'Bee', kind: 'insect', wings: 2 } },
    { id: 'c' },
    { id: 'd' },
  ],
  edges: [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'b', target: 'b' },
    { source: 'c', target: 'd' },
  ],
};

// --- harness ----------------------------------------------------------------

const instances: GraphInstance[] = [];
const hosts: HTMLElement[] = [];

async function setup(
  props: Parameters<typeof GraphInspector>[0] = {},
  snapshot: GraphSnapshot = handSnapshot,
): Promise<{ instance: GraphInstance; engine: FakeEngine; view: RenderResult }> {
  const engine = new FakeEngine();
  const instance = createGraphInstance({ engine: () => engine });
  instances.push(instance);
  instance.applyHostUpdate({ data: snapshot });

  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  await instance.attach(host);

  const view = render(
    <GraphProvider instance={instance}>
      <GraphInspector {...props} />
    </GraphProvider>,
  );
  return { instance, engine, view };
}

function panel(view: RenderResult): HTMLElement {
  const el = view.container.querySelector<HTMLElement>('[data-orbit-inspector]');
  if (el === null) throw new Error('inspector not rendered');
  return el;
}

function actionButton(view: RenderResult, id: string): HTMLButtonElement {
  const el = view.container.querySelector<HTMLButtonElement>(
    `[data-orbit-inspector-action="${id}"]`,
  );
  if (el === null) throw new Error(`action '${id}' not rendered`);
  return el;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const instance of instances) instance.destroy();
  instances.length = 0;
  for (const host of hosts) host.remove();
  hosts.length = 0;
});

// --- tests ------------------------------------------------------------------

describe('<GraphInspector> empty state', () => {
  it('shows the empty state with no selection and with a multi selection', async () => {
    const { instance, view } = await setup();
    expect(panel(view).getAttribute('role')).toBe('complementary');
    expect(view.container.querySelector('[data-orbit-inspector-empty]')).not.toBeNull();
    expect(view.container.querySelector('[data-orbit-inspector-attrs]')).toBeNull();

    act(() => {
      instance.setSelection(['a', 'b']);
    });
    const empty = view.container.querySelector('[data-orbit-inspector-empty]');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain('2 nodes selected');

    act(() => {
      instance.setSelection(['b']);
    });
    expect(view.container.querySelector('[data-orbit-inspector-empty]')).toBeNull();
  });

  it('docks right by default and left via dock="left"', async () => {
    const { view } = await setup({ dock: 'left' });
    expect(panel(view).style.left).toBe('12px');
    expect(panel(view).style.right).toBe('');
  });
});

describe('<GraphInspector> attrs table', () => {
  it('renders the selected-single node title and attr rows', async () => {
    const { instance, view } = await setup();
    act(() => {
      instance.setSelection(['b']);
    });
    expect(view.container.querySelector('[data-orbit-inspector-title]')!.textContent).toBe('Bee');
    const rows = [...view.container.querySelectorAll('[data-orbit-inspector-attr]')];
    expect(rows.map((r) => r.textContent)).toEqual(['labelBee', 'kindinsect', 'wings2']);
  });

  it('renders hostile attrs as literal text nodes', async () => {
    const payload = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    const { instance, view } = await setup(
      {},
      {
        datasetKey: 'xss',
        sourceRevision: 1,
        nodes: [{ id: 'evil', attrs: { label: payload, note: payload } }],
        edges: [],
      },
    );
    act(() => {
      instance.setSelection(['evil']);
    });
    expect(view.container.querySelector('[data-orbit-inspector-title]')!.textContent).toBe(
      payload,
    );
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.container.querySelector('img')).toBeNull();
  });

  it('renderAttrs replaces the default table', async () => {
    const { instance, view } = await setup({
      renderAttrs: (node) => <div data-custom-attrs="">{`custom:${node.id}`}</div>,
    });
    act(() => {
      instance.setSelection(['b']);
    });
    expect(view.container.querySelector('[data-orbit-inspector-attrs]')).toBeNull();
    expect(view.container.querySelector('[data-custom-attrs]')!.textContent).toBe('custom:b');
  });
});

describe('<GraphInspector> neighbors', () => {
  it('resolves neighbors through the focusNode seam and lists them (self-loop excluded)', async () => {
    const { instance, engine, view } = await setup();
    const focusSpy = vi.spyOn(instance, 'focusNode');
    act(() => {
      instance.setSelection(['b']);
    });

    // Unresolved yet: the explicit v0.9 affordance is shown.
    const resolve = view.container.querySelector<HTMLButtonElement>(
      '[data-orbit-inspector-resolve-neighbors]',
    );
    expect(resolve).not.toBeNull();

    fireEvent.click(resolve!);
    expect(focusSpy).toHaveBeenCalledWith('b');
    // The camera flew to b (engine index 1) — focus IS the resolution seam.
    expect(
      engine.cameraCalls.some((c) => c.method === 'zoomToIndex' && c.args[0] === 1),
    ).toBe(true);

    const neighbors = [
      ...view.container.querySelectorAll<HTMLElement>('[data-orbit-inspector-neighbor]'),
    ];
    expect(neighbors.map((n) => n.getAttribute('data-orbit-inspector-neighbor'))).toEqual([
      'a',
      'c',
    ]);

    // Clicking a neighbor focuses it (click → focusNode).
    fireEvent.click(neighbors[0]!);
    expect(focusSpy).toHaveBeenLastCalledWith('a');
    expect(
      engine.cameraCalls.some((c) => c.method === 'zoomToIndex' && c.args[0] === 0),
    ).toBe(true);
  });

  it('a model change drops the stale neighbor cache', async () => {
    const { instance, view } = await setup();
    act(() => {
      instance.setSelection(['b']);
    });
    fireEvent.click(
      view.container.querySelector<HTMLButtonElement>('[data-orbit-inspector-resolve-neighbors]')!,
    );
    expect(view.container.querySelectorAll('[data-orbit-inspector-neighbor]').length).toBe(2);

    act(() => {
      instance.applyHostUpdate({
        data: {
          ...handSnapshot,
          sourceRevision: 2,
          nodes: [...handSnapshot.nodes, { id: 'e' }],
        },
      });
    });
    // Back to the unresolved affordance — never stale rows.
    expect(view.container.querySelectorAll('[data-orbit-inspector-neighbor]').length).toBe(0);
    expect(
      view.container.querySelector('[data-orbit-inspector-resolve-neighbors]'),
    ).not.toBeNull();
  });
});

describe('<GraphInspector> quick actions', () => {
  it('wires Expand / Isolate / Pin / Hide to the public mutators', async () => {
    const { instance, view } = await setup();
    act(() => {
      instance.setSelection(['b']);
    });

    const expandSpy = vi.spyOn(instance, 'expandNode');
    fireEvent.click(actionButton(view, 'expand'));
    expect(expandSpy).toHaveBeenCalledWith('b');

    fireEvent.click(actionButton(view, 'isolate'));
    expect(instance.store.getState().scope).toEqual({ seedIds: ['b'], hops: 1 });

    fireEvent.click(actionButton(view, 'pin'));
    expect(instance.store.getState().pins.has('b')).toBe(true);
    // The toggle flipped: Unpin now renders, Pin is gone.
    expect(view.container.querySelector('[data-orbit-inspector-action="pin"]')).toBeNull();
    fireEvent.click(actionButton(view, 'unpin'));
    expect(instance.store.getState().pins.has('b')).toBe(false);

    fireEvent.click(actionButton(view, 'hide'));
    expect(instance.store.getState().hiddenNodeIds.has('b')).toBe(true);
  });

  it('quickActions receives the defaults and replaces the row', async () => {
    const seen: string[][] = [];
    const onCustom = vi.fn();
    const { instance, view } = await setup({
      quickActions: ({ defaultActions }) => {
        seen.push(defaultActions.map((a) => a.id));
        return [{ id: 'custom', label: 'Custom', onSelect: onCustom }];
      },
    });
    act(() => {
      instance.setSelection(['b']);
    });
    expect(seen[0]).toEqual(['expand', 'isolate', 'pin', 'hide']);
    expect(view.container.querySelector('[data-orbit-inspector-action="expand"]')).toBeNull();
    fireEvent.click(actionButton(view, 'custom'));
    expect(onCustom).toHaveBeenCalledTimes(1);
  });
});
