/**
 * <GraphNavigator> semantic navigator tests (jsdom + FakeEngine).
 *
 * Covers: bounded paged rows (never one DOM row per entity), roving tabindex +
 * aria-activedescendant, Enter → focusNode neighborhood re-rooting (engine and
 * core CSR adjacency routes on a hand fixture), Space selection toggling via
 * the mutator, Home/End/PageUp/PageDown, Escape back to the entry list,
 * getAccessibleLabel resolution, untrusted-label literal rendering, and the
 * announced 'Page x of y' controls.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { createGraphInstance } from '@modernrelay/orbit-core';
import type { AccessibilityConfig, GraphInstance, GraphSnapshot } from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { GraphProvider } from '../src/GraphProvider';
import { GraphNavigator } from '../src/components/Navigator/index';
import { setSearchResultUnavailableCallback } from '../src/hooks';

// --- fixtures -------------------------------------------------------------

/** Seeded chain: n0 — n1 — … — n{count-1} (accepted-base order = index order). */
function chainSnapshot(count: number): GraphSnapshot {
  return {
    datasetKey: 'chain',
    sourceRevision: 1,
    nodes: Array.from({ length: count }, (_, i) => ({ id: `n${i}` })),
    edges: Array.from({ length: count - 1 }, (_, i) => ({
      source: `n${i}`,
      target: `n${i + 1}`,
    })),
  };
}

/** Hand fixture for adjacency assertions: a—b, b—c (plus a self-loop b—b that
 * must NOT count as a neighbor), c—d. neighbors(b) === [a, c]. */
const handSnapshot: GraphSnapshot = {
  datasetKey: 'hand',
  sourceRevision: 1,
  nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
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

interface SetupOptions {
  snapshot: GraphSnapshot;
  accessibility?: AccessibilityConfig;
  engine?: FakeEngine;
  /** D7 construction-only search fields (read once at instance creation). */
  searchIndex?: readonly string[];
}

async function setup(
  opts: SetupOptions,
): Promise<{ instance: GraphInstance; engine: FakeEngine; view: RenderResult }> {
  const engine = opts.engine ?? new FakeEngine();
  const instance = createGraphInstance({
    engine: () => engine,
    ...(opts.searchIndex !== undefined ? { searchIndex: opts.searchIndex } : {}),
  });
  instances.push(instance);
  const update: { data: GraphSnapshot; accessibility?: AccessibilityConfig } = {
    data: opts.snapshot,
  };
  if (opts.accessibility !== undefined) update.accessibility = opts.accessibility;
  instance.applyHostUpdate(update);

  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  await instance.attach(host);

  const view = render(
    <GraphProvider instance={instance}>
      <GraphNavigator />
    </GraphProvider>,
  );
  return { instance, engine, view };
}

function options(view: RenderResult): HTMLElement[] {
  return [...view.container.querySelectorAll<HTMLElement>('[role="option"]')];
}

function optionTexts(view: RenderResult): string[] {
  return options(view).map((el) => el.textContent ?? '');
}

function listbox(view: RenderResult): HTMLElement {
  const el = view.container.querySelector<HTMLElement>('[role="listbox"]');
  if (el === null) throw new Error('navigator listbox not rendered');
  return el;
}

function pageStatus(view: RenderResult): HTMLElement {
  const el = view.container.querySelector<HTMLElement>('[data-orbit-navigator-page-status]');
  if (el === null) throw new Error('navigator page status not rendered');
  return el;
}

function activeDescendant(view: RenderResult): HTMLElement {
  const id = listbox(view).getAttribute('aria-activedescendant');
  if (id === null) throw new Error('no aria-activedescendant set');
  const el = document.getElementById(id);
  if (el === null) throw new Error(`aria-activedescendant ${id} resolves to nothing`);
  return el;
}

function tabbableOptions(view: RenderResult): HTMLElement[] {
  return options(view).filter((el) => el.getAttribute('tabindex') === '0');
}

afterEach(() => {
  cleanup();
  for (const instance of instances) instance.destroy();
  instances.length = 0;
  for (const host of hosts) host.remove();
  hosts.length = 0;
});

// --- tests ------------------------------------------------------------------

describe('<GraphNavigator> bounded rendering & paging', () => {
  it('updates the entry roster immediately when isolation changes or clears', async () => {
    const { instance, view } = await setup({ snapshot: handSnapshot });
    act(() => {
      instance.applyHostUpdate({ subgraph: { seedIds: ['b'], hops: 0 } });
    });
    expect(optionTexts(view)).toEqual(['b']);
    expect(pageStatus(view).textContent).toBe('All nodes: page 1 of 1 (1 item)');
    act(() => { instance.resetIsolation(); });
    expect(optionTexts(view)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('renders a bounded, paged entry list — never one DOM row per entity', async () => {
    const { view } = await setup({ snapshot: chainSnapshot(200) });

    // Default navigatorWindow (50): exactly one page of rows for 200 nodes.
    const opts = options(view);
    expect(opts.length).toBe(50);
    expect(opts[0]!.textContent).toBe('n0');
    expect(opts[49]!.textContent).toBe('n49');

    // Exactly one item is tabbable (roving tabindex).
    expect(tabbableOptions(view).length).toBe(1);

    // Announced page state carries counts.
    const status = pageStatus(view);
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe('All nodes: page 1 of 4 (200 items)');
  });

  it('respects accessibility.navigatorWindow and pages via the announced Prev/Next controls', async () => {
    const { view } = await setup({
      snapshot: chainSnapshot(200),
      accessibility: { navigatorWindow: 5 },
    });

    expect(optionTexts(view)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
    expect(pageStatus(view).textContent).toBe('All nodes: page 1 of 40 (200 items)');

    const prev = view.getByRole('button', { name: 'Previous page' });
    const next = view.getByRole('button', { name: 'Next page' });
    expect(prev).toHaveProperty('disabled', true);

    fireEvent.click(next);
    expect(optionTexts(view)).toEqual(['n5', 'n6', 'n7', 'n8', 'n9']);
    expect(pageStatus(view).textContent).toBe('All nodes: page 2 of 40 (200 items)');
    expect(prev).toHaveProperty('disabled', false);

    fireEvent.click(prev);
    expect(optionTexts(view)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
    expect(pageStatus(view).textContent).toBe('All nodes: page 1 of 40 (200 items)');
  });
});

describe('<GraphNavigator> roving tabindex & keyboard model', () => {
  it('moves the roving tabindex and aria-activedescendant with ArrowDown/ArrowUp', async () => {
    const { view } = await setup({
      snapshot: chainSnapshot(30),
      accessibility: { navigatorWindow: 5 },
    });
    const box = listbox(view);
    const opts = options(view);

    // Initial state: first row active/tabbable, mirrored on the container.
    expect(opts[0]!.getAttribute('tabindex')).toBe('0');
    expect(opts[1]!.getAttribute('tabindex')).toBe('-1');
    expect(activeDescendant(view)).toBe(opts[0]);

    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(opts[0]!.getAttribute('tabindex')).toBe('-1');
    expect(opts[1]!.getAttribute('tabindex')).toBe('0');
    expect(activeDescendant(view)).toBe(opts[1]);
    // DOM focus follows — focus never lives only in WebGL pixels.
    expect(document.activeElement).toBe(opts[1]);
    expect(tabbableOptions(view).length).toBe(1);

    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(activeDescendant(view)).toBe(opts[0]);
    expect(opts[0]!.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(opts[0]);
  });

  it('Home/End jump to the bounds; PageDown/PageUp page the active list', async () => {
    const { view } = await setup({
      snapshot: chainSnapshot(30),
      accessibility: { navigatorWindow: 5 },
    });
    const box = listbox(view);

    fireEvent.keyDown(box, { key: 'End' });
    expect(activeDescendant(view).textContent).toBe('n4');

    fireEvent.keyDown(box, { key: 'Home' });
    expect(activeDescendant(view).textContent).toBe('n0');

    fireEvent.keyDown(box, { key: 'PageDown' });
    expect(optionTexts(view)).toEqual(['n5', 'n6', 'n7', 'n8', 'n9']);
    expect(activeDescendant(view).textContent).toBe('n5');
    expect(pageStatus(view).textContent).toBe('All nodes: page 2 of 6 (30 items)');

    fireEvent.keyDown(box, { key: 'PageUp' });
    expect(optionTexts(view)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
    expect(activeDescendant(view).textContent).toBe('n0');
    expect(pageStatus(view).textContent).toBe('All nodes: page 1 of 6 (30 items)');
  });
});

describe('<GraphNavigator> Enter → focusNode neighborhood re-rooting', () => {
  it('invalidates the focused neighborhood and learned degrees on scene rewrites', async () => {
    const { instance, view } = await setup({ snapshot: handSnapshot });
    fireEvent.keyDown(listbox(view), { key: 'ArrowDown' });
    fireEvent.keyDown(listbox(view), { key: 'Enter' });
    expect(optionTexts(view)).toEqual(['b · 2 neighbors', 'a', 'c']);

    act(() => {
      instance.applyHostUpdate({ subgraph: { seedIds: ['b', 'c'], hops: 0 } });
    });
    expect(optionTexts(view)).toEqual(['b', 'c']);
    expect(view.queryByText('Focused node')).toBeNull();
    fireEvent.keyDown(listbox(view), { key: 'Enter' });
    expect(optionTexts(view)).toEqual(['b · 1 neighbor', 'c']);

    act(() => { instance.resetIsolation(); });
    expect(optionTexts(view)).toEqual(['a', 'b', 'c', 'd']);
    act(() => { instance.foldNode('b', { memberIds: ['a'] }); });
    expect(optionTexts(view)).toEqual(['b', 'c', 'd']);
    act(() => { instance.unfoldNode('b'); });
    expect(optionTexts(view)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('calls focusNode and re-roots to the 1-hop neighborhood (engine adjacency route)', async () => {
    const { view, instance, engine } = await setup({ snapshot: handSnapshot });
    const focusSpy = vi.spyOn(instance, 'focusNode');
    const box = listbox(view);

    fireEvent.keyDown(box, { key: 'ArrowDown' }); // active: b
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalledWith('b');
    // Syncs TO the graph: the camera flew to b (engine index 1).
    expect(
      engine.cameraCalls.some((c) => c.method === 'zoomToIndex' && c.args[0] === 1),
    ).toBe(true);

    // Re-rooted: focused section with root + undirected neighbors [a, c];
    // the self-loop b—b never lists b as its own neighbor.
    const focused = view.container.querySelector('[aria-label^="Focused node"]');
    expect(focused).not.toBeNull();
    expect(focused!.getAttribute('aria-label')).toBe(
      'Focused node b: 2 neighbors, page 1 of 1',
    );
    expect(optionTexts(view)).toEqual(['b · 2 neighbors', 'a', 'c']);
    // The entry list is replaced while a node is focused.
    expect(view.container.querySelector('[aria-label^="All nodes"]')).toBeNull();
    expect(pageStatus(view).textContent).toBe('Focused node: page 1 of 1 (2 items)');
  });

  it('resolves the neighborhood through the core CSR adjacency when the engine lacks neighborIndices', async () => {
    const engine = new FakeEngine();
    // Shadow the prototype method: core must fall back to buildAdjacency over
    // the current scene links.
    Object.defineProperty(engine, 'neighborIndices', { value: undefined });
    const { view } = await setup({ snapshot: handSnapshot, engine });
    const box = listbox(view);

    fireEvent.keyDown(box, { key: 'ArrowDown' }); // active: b
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(optionTexts(view)).toEqual(['b · 2 neighbors', 'a', 'c']);
  });

  it('a model change drops the stale neighborhood and returns to the entry list', async () => {
    const { view, instance } = await setup({ snapshot: handSnapshot });
    fireEvent.keyDown(listbox(view), { key: 'Enter' }); // root at a
    expect(view.container.querySelector('[aria-label^="Focused node"]')).not.toBeNull();

    act(() => {
      instance.applyHostUpdate({
        data: {
          ...handSnapshot,
          sourceRevision: 2,
          nodes: [...handSnapshot.nodes, { id: 'e' }],
        },
      });
    });

    expect(view.container.querySelector('[aria-label^="Focused node"]')).toBeNull();
    expect(view.container.querySelector('[aria-label^="All nodes"]')).not.toBeNull();
  });
});

describe('<GraphNavigator> selection & transient focus', () => {
  it('Space toggles selection membership through the selectNodes mutator', async () => {
    const { view, instance } = await setup({ snapshot: handSnapshot });
    const selectSpy = vi.spyOn(instance, 'selectNodes');
    const box = listbox(view);

    fireEvent.keyDown(box, { key: ' ' }); // toggle a on
    expect(selectSpy).toHaveBeenNthCalledWith(1, ['a']);

    // aria-selected reflects the store on every row showing a.
    const aRows = options(view).filter((el) => (el.textContent ?? '').startsWith('a'));
    expect(aRows.length).toBeGreaterThan(0);
    for (const row of aRows) expect(row.getAttribute('aria-selected')).toBe('true');
    // The selection section appeared (paged like everything else).
    expect(view.container.querySelector('[aria-label^="Selection"]')).not.toBeNull();

    fireEvent.keyDown(box, { key: ' ' }); // toggle a back off
    expect(selectSpy).toHaveBeenNthCalledWith(2, []);
    expect(view.container.querySelector('[aria-label^="Selection"]')).toBeNull();
    for (const el of options(view)) {
      expect(el.getAttribute('aria-selected')).toBe('false');
    }
  });

  it('Escape clears the transient focus and restores the entry list', async () => {
    const { view } = await setup({ snapshot: handSnapshot });
    const box = listbox(view);

    fireEvent.keyDown(box, { key: 'Enter' }); // root at a
    expect(view.container.querySelector('[aria-label^="Focused node"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label^="All nodes"]')).toBeNull();

    fireEvent.keyDown(box, { key: 'Escape' });
    expect(view.container.querySelector('[aria-label^="Focused node"]')).toBeNull();
    expect(view.container.querySelector('[aria-label^="All nodes"]')).not.toBeNull();
    // Active item defaults back to the first entry row ('a' keeps its learned
    // neighbor count from the visit — the per-model degree cache).
    expect(activeDescendant(view).textContent).toBe('a · 1 neighbor');
    expect(options(view)[0]!.getAttribute('tabindex')).toBe('0');
  });
});

describe('<GraphNavigator> search results section', () => {
  it('appears only when store.search is non-null, bounded by navigatorWindow, and pages', async () => {
    const { view, instance } = await setup({
      snapshot: chainSnapshot(30),
      accessibility: { navigatorWindow: 5 },
    });
    expect(view.container.querySelector('[aria-label^="Search results"]')).toBeNull();

    await act(async () => {
      await instance.search('n', { limit: 20 });
    });
    const section = view.container.querySelector('[aria-label^="Search results"]');
    expect(section).not.toBeNull();
    expect(section!.getAttribute('aria-label')).toBe(
      'Search results for n: 20 results, page 1 of 4',
    );
    // Bounded: 5 search rows (never one per result) ahead of the entry list.
    const rows = [...section!.querySelectorAll('[role="option"]')];
    expect(rows.map((r) => r.textContent)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
    // The entry list stays present (and bounded) alongside the results.
    expect(view.container.querySelector('[aria-label^="All nodes"]')).not.toBeNull();

    // The search list pages like every other list (PageDown targets the
    // active row's list — the first row is a search row).
    fireEvent.keyDown(listbox(view), { key: 'PageDown' });
    const paged = [
      ...view.container
        .querySelector('[aria-label^="Search results"]')!
        .querySelectorAll('[role="option"]'),
    ];
    expect(paged.map((r) => r.textContent)).toEqual(['n5', 'n6', 'n7', 'n8', 'n9']);

    // clearSearch removes the section.
    act(() => {
      instance.clearSearch();
    });
    expect(view.container.querySelector('[aria-label^="Search results"]')).toBeNull();
  });

  it('Enter on a search row routes through activateSearchResult (focus fly, no re-root)', async () => {
    const { view, instance, engine } = await setup({
      snapshot: chainSnapshot(10),
      accessibility: { navigatorWindow: 5 },
    });
    await act(async () => {
      await instance.search('n3', { limit: 5 });
    });
    const activateSpy = vi.spyOn(instance, 'activateSearchResult');

    // First row (the exact-id match n3) is the initial active row.
    fireEvent.keyDown(listbox(view), { key: 'Enter' });
    expect(activateSpy).toHaveBeenCalledTimes(1);
    expect(activateSpy.mock.calls[0]![0]).toMatchObject({ id: 'n3' });
    // an in-scene, mask-visible result focuses — the camera flew to
    // n3 (engine index 3; activation routes through the core's focus path).
    expect(
      engine.cameraCalls.some((c) => c.method === 'zoomToIndex' && c.args[0] === 3),
    ).toBe(true);
    // …but the navigator does NOT re-root a neighborhood from a search row.
    expect(view.container.querySelector('[aria-label^="Focused node"]')).toBeNull();
  });

  it('forwards unavailable search activation to the Graph-level callback channel', async () => {
    const { view, instance } = await setup({
      snapshot: chainSnapshot(10),
      accessibility: { navigatorWindow: 5 },
    });
    await act(async () => {
      await instance.search('n3', { limit: 5 });
    });
    const onUnavailable = vi.fn();
    setSearchResultUnavailableCallback(instance, onUnavailable);
    act(() => {
      instance.applyHostUpdate({ subgraph: { seedIds: ['n0'], hops: 0 } });
    });

    fireEvent.keyDown(listbox(view), { key: 'Enter' });

    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onUnavailable.mock.calls[0]![0]).toMatchObject({ id: 'n3' });
    expect(onUnavailable.mock.calls[0]![1]).toBe('out-of-scope');
  });

  it('search rows render the service label as a text node (hostile labels literal)', async () => {
    const payload = '<script>alert(1)</script>';
    const { view, instance } = await setup({
      snapshot: {
        datasetKey: 'search-xss',
        sourceRevision: 1,
        nodes: [{ id: 'evil', attrs: { label: payload } }],
        edges: [],
      },
      accessibility: { navigatorWindow: 5 },
      searchIndex: ['label'],
    });
    // The label field is declared at CONSTRUCTION (D7) so the service
    // labels the match with it.
    await act(async () => {
      await instance.search('alert', { limit: 5 });
    });
    const section = view.container.querySelector('[aria-label^="Search results"]')!;
    const row = section.querySelector('[role="option"]')!;
    expect(row.textContent).toBe(payload);
    expect(view.container.querySelector('script')).toBeNull();
  });
});

describe('<GraphNavigator> text names & state exposure', () => {
  it('uses accessibility.getAccessibleLabel for item names', async () => {
    const { view } = await setup({
      snapshot: chainSnapshot(10),
      accessibility: {
        navigatorWindow: 5,
        getAccessibleLabel: (node) => `Label of ${node.id}`,
      },
    });
    expect(optionTexts(view)).toEqual([
      'Label of n0',
      'Label of n1',
      'Label of n2',
      'Label of n3',
      'Label of n4',
    ]);
  });

  it('falls back to attrs.label, then the node id', async () => {
    const { view } = await setup({
      snapshot: {
        datasetKey: 'labels',
        sourceRevision: 1,
        nodes: [{ id: 'x1', attrs: { label: 'Alpha' } }, { id: 'x2' }],
        edges: [{ source: 'x1', target: 'x2' }],
      },
    });
    expect(optionTexts(view)).toEqual(['Alpha', 'x2']);
  });

  it('renders script-payload labels as literal text nodes', async () => {
    const payload = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    const { view } = await setup({
      snapshot: {
        datasetKey: 'xss',
        sourceRevision: 1,
        nodes: [{ id: 'evil', attrs: { label: payload } }],
        edges: [],
      },
    });
    const row = options(view)[0]!;
    expect(row.textContent).toBe(payload);
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.container.querySelector('img')).toBeNull();
  });

  it('exposes pinned and hidden state in item text', async () => {
    const { view, instance } = await setup({
      snapshot: chainSnapshot(5),
    });
    act(() => {
      instance.pinNode('n1', [1, 2]);
      instance.hideNodes(['n2']);
    });
    const texts = optionTexts(view);
    expect(texts).toContain('n1 · pinned');
    expect(texts).toContain('n2 · hidden');
  });

  it('exposes the neighbor count for resolved roots in item text', async () => {
    const { view } = await setup({ snapshot: handSnapshot });
    const box = listbox(view);
    fireEvent.keyDown(box, { key: 'ArrowDown' }); // active: b
    fireEvent.keyDown(box, { key: 'Enter' }); // root at b — learns degree(b)=2
    fireEvent.keyDown(box, { key: 'Escape' }); // back to the entry list
    expect(optionTexts(view)).toEqual(['a', 'b · 2 neighbors', 'c', 'd']);
  });
});

describe('<GraphNavigator> keyboard emphasis ring', () => {
  const rings = (engine: FakeEngine) =>
    engine.calls.filter((c) => c.method === 'setFocusedIndex');

  it('arrow keys ring the active row WITHOUT flying the camera', async () => {
    const { view, engine } = await setup({ snapshot: chainSnapshot(5) });
    const box = listbox(view);
    const camerasBefore = engine.cameraCalls.length;

    fireEvent.keyDown(box, { key: 'ArrowDown' }); // active: n1
    expect(rings(engine).at(-1)!.args).toEqual([1]);

    fireEvent.keyDown(box, { key: 'End' }); // active: n4
    expect(rings(engine).at(-1)!.args).toEqual([4]);

    // The ring is the whole point — the camera must not move on arrows.
    expect(engine.cameraCalls).toHaveLength(camerasBefore);
  });

  it('paging rings the first row of the new page', async () => {
    const { view, engine } = await setup({
      snapshot: chainSnapshot(30),
      accessibility: { navigatorWindow: 5 },
    });
    fireEvent.keyDown(listbox(view), { key: 'PageDown' }); // page 2 → n5
    expect(rings(engine).at(-1)!.args).toEqual([5]);
  });

  it('Escape back to the entry list clears the ring', async () => {
    const { view, engine } = await setup({ snapshot: handSnapshot });
    const box = listbox(view);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' }); // transient root at b
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(rings(engine).at(-1)!.args).toEqual([null]);
  });

  it('focus leaving the panel clears the ring; moving inside it does not', async () => {
    const { view, engine } = await setup({ snapshot: chainSnapshot(5) });
    const box = listbox(view);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    const ringsBefore = rings(engine).length;

    // Focus hop WITHIN the panel (option → option): no clear.
    fireEvent.blur(options(view)[1]!, { relatedTarget: options(view)[0]! });
    expect(rings(engine)).toHaveLength(ringsBefore);

    // Focus leaves the panel entirely: cleared.
    fireEvent.blur(options(view)[1]!, { relatedTarget: document.body });
    expect(rings(engine).at(-1)!.args).toEqual([null]);
  });

  it('unmount clears a ring left by keyboard navigation', async () => {
    const { view, engine } = await setup({ snapshot: chainSnapshot(5) });
    fireEvent.keyDown(listbox(view), { key: 'ArrowDown' });
    view.unmount();
    expect(rings(engine).at(-1)!.args).toEqual([null]);
  });

  it('blur does NOT clear the channel while a canvas hover is active', async () => {
    const { view, engine } = await setup({ snapshot: chainSnapshot(5) });
    const box = listbox(view);
    fireEvent.keyDown(box, { key: 'ArrowDown' }); // keyboard ring
    act(() => {
      engine.injectPointHover(3); // pointer takes the shared channel
    });
    const before = rings(engine).length;

    fireEvent.blur(options(view)[1]!, { relatedTarget: document.body });
    expect(rings(engine)).toHaveLength(before); // hover ring untouched
  });

  it('unmount leaves an active hover ring alone', async () => {
    const { view, engine } = await setup({ snapshot: chainSnapshot(5) });
    fireEvent.keyDown(listbox(view), { key: 'ArrowDown' });
    act(() => {
      engine.injectPointHover(3);
    });
    const before = rings(engine).length;
    view.unmount();
    expect(rings(engine)).toHaveLength(before);
  });
});
