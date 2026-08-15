/**
 * <GraphSearch> search box tests (jsdom + FakeEngine + real
 * core).
 *
 * Covers: the debounce window (ONE instance.search per settled window, never
 * one per keystroke), emptied-input cancellation + clearSearch, the result
 * list + score rendering from store.search, Enter activation focusing an
 * in-scene result (FakeEngine camera recorded), the unavailable
 * contract for each reason ('not-loaded' via a custom service, 'out-of-scope'
 * via a hard scope, 'filtered' via the hidden mask), I6 query coherence
 * (Enter is a no-op against a stale publication during the debounce window),
 * Escape clearing, the ARIA combobox wiring, and untrusted-label literal
 * rendering.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { createGraphInstance } from '@modernrelay/orbit-core';
import type {
  GraphInstance,
  GraphSnapshot,
  SearchResult,
  SearchService,
} from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { Graph } from '../src/Graph';
import { GraphProvider } from '../src/GraphProvider';
import { GraphSearch } from '../src/components/Search/index';

// --- fixtures ---------------------------------------------------------------

/** a 'Alpha' — b 'Beta' — c 'Gamma' chain (accepted-base order = a, b, c). */
const snapshot: GraphSnapshot = {
  datasetKey: 'search-fixture',
  sourceRevision: 1,
  nodes: [
    { id: 'a', attrs: { label: 'Alpha' } },
    { id: 'b', attrs: { label: 'Beta' } },
    { id: 'c', attrs: { label: 'Gamma' } },
  ],
  edges: [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
  ],
};

// --- harness ----------------------------------------------------------------

const instances: GraphInstance[] = [];
const hosts: HTMLElement[] = [];

interface SetupOptions {
  data?: GraphSnapshot;
  searchIndex?: readonly string[];
  service?: SearchService;
  props?: Parameters<typeof GraphSearch>[0];
}

async function setup(opts: SetupOptions = {}): Promise<{
  instance: GraphInstance;
  engine: FakeEngine;
  view: RenderResult;
  input: HTMLInputElement;
}> {
  const engine = new FakeEngine();
  const instance = createGraphInstance({
    engine: () => engine,
    ...(opts.service !== undefined ? { services: { search: opts.service } } : {}),
    // D7: searchIndex is construction-only.
    ...(opts.searchIndex !== undefined ? { searchIndex: opts.searchIndex } : {}),
  });
  instances.push(instance);
  instance.applyHostUpdate({ data: opts.data ?? snapshot });

  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  await instance.attach(host);

  const view = render(
    <GraphProvider instance={instance}>
      <GraphSearch {...opts.props} />
    </GraphProvider>,
  );
  const input = view.container.querySelector<HTMLInputElement>('[data-orbit-search-input]');
  if (input === null) throw new Error('search input not rendered');
  return { instance, engine, view, input };
}

function options(view: RenderResult): HTMLElement[] {
  return [...view.container.querySelectorAll<HTMLElement>('[role="option"]')];
}

/** Type + settle the debounce window + let the search publication land. */
async function typeAndSettle(input: HTMLInputElement, value: string, ms = 200): Promise<void> {
  fireEvent.change(input, { target: { value } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
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

describe('<GraphSearch> debounce', () => {
  it('issues ONE instance.search per settled debounce window, with the final text', async () => {
    vi.useFakeTimers();
    const { instance, input } = await setup({ searchIndex: ['label'] });
    const searchSpy = vi.spyOn(instance, 'search');

    fireEvent.change(input, { target: { value: 'a' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100); // inside the window
    });
    fireEvent.change(input, { target: { value: 'al' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100); // keystroke reset the window
    });
    fireEvent.change(input, { target: { value: 'alpha' } });
    expect(searchSpy).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).toHaveBeenCalledWith('alpha', { limit: 20 });
  });

  it('respects debounceMs and limit props', async () => {
    vi.useFakeTimers();
    const { instance, input } = await setup({
      searchIndex: ['label'],
      props: { debounceMs: 50, limit: 3 },
    });
    const searchSpy = vi.spyOn(instance, 'search');
    fireEvent.change(input, { target: { value: 'a' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(49);
    });
    expect(searchSpy).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(searchSpy).toHaveBeenCalledWith('a', { limit: 3 });
  });

  it('an emptied input cancels the pending window and clears the shared slice', async () => {
    vi.useFakeTimers();
    const { instance, input } = await setup({ searchIndex: ['label'] });
    await typeAndSettle(input, 'alpha');
    expect(instance.store.getState().search).not.toBeNull();

    const searchSpy = vi.spyOn(instance, 'search');
    fireEvent.change(input, { target: { value: 'alp' } }); // pending window…
    fireEvent.change(input, { target: { value: '' } }); // …cancelled by emptying
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(searchSpy).not.toHaveBeenCalled();
    expect(instance.store.getState().search).toBeNull();
  });
});

describe('<GraphSearch> result list', () => {
  it('renders store.search results with the score when present (ARIA combobox/listbox)', async () => {
    vi.useFakeTimers();
    const { view, input } = await setup({ searchIndex: ['label'] });
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('false');

    await typeAndSettle(input, 'alpha');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const listbox = view.container.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    expect(listbox!.id).toBe(input.getAttribute('aria-controls'));

    const opts = options(view);
    expect(opts.length).toBe(1);
    // 'Alpha' searched by its full field value: exact-field tier (2.5).
    expect(opts[0]!.querySelector('[data-orbit-search-result-label]')!.textContent).toBe('Alpha');
    expect(opts[0]!.querySelector('[data-orbit-search-result-score]')!.textContent).toBe('2.5');
  });

  it('moves the active option with ArrowDown/ArrowUp and mirrors aria-activedescendant', async () => {
    vi.useFakeTimers();
    // Query 'a' hits all three: id-exact 'a' (3), then label substrings.
    const { view, input } = await setup({ searchIndex: ['label'] });
    await typeAndSettle(input, 'a');
    const opts = options(view);
    expect(opts.length).toBe(3);
    expect(input.getAttribute('aria-activedescendant')).toBeNull();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(opts[0]!.id);
    expect(opts[0]!.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(opts[1]!.id);

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toBe(opts[0]!.id);
  });

  it('renders hostile result labels as literal text nodes', async () => {
    vi.useFakeTimers();
    const payload = '<img src=x onerror=alert(1)>alpha';
    const { view, input } = await setup({
      data: {
        datasetKey: 'xss',
        sourceRevision: 1,
        nodes: [{ id: 'evil', attrs: { label: payload } }],
        edges: [],
      },
      searchIndex: ['label'],
    });
    await typeAndSettle(input, 'alpha');
    const label = view.container.querySelector('[data-orbit-search-result-label]');
    expect(label!.textContent).toBe(payload);
    expect(view.container.querySelector('img')).toBeNull();
  });
});

describe('<GraphSearch> activation', () => {
  it('Enter focuses an in-scene result (camera fly recorded) and closes the listbox', async () => {
    vi.useFakeTimers();
    const { view, engine, input } = await setup({ searchIndex: ['label'] });
    await typeAndSettle(input, 'gamma'); // matches only c (scene index 2)

    fireEvent.keyDown(input, { key: 'Enter' }); // no active option → first result
    expect(
      engine.cameraCalls.some((c) => c.method === 'zoomToIndex' && c.args[0] === 2),
    ).toBe(true);
    // 'focused' closes the listbox and clears the highlight.
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('click activates a result through activateSearchResult', async () => {
    vi.useFakeTimers();
    const { view, instance, input } = await setup({ searchIndex: ['label'] });
    const activateSpy = vi.spyOn(instance, 'activateSearchResult');
    await typeAndSettle(input, 'beta');
    fireEvent.click(options(view)[0]!);
    expect(activateSpy).toHaveBeenCalledTimes(1);
    expect(activateSpy.mock.calls[0]![0]).toMatchObject({ id: 'b' });
  });

  it("fires onResultUnavailable with 'not-loaded' for a result outside the model", async () => {
    vi.useFakeTimers();
    const ghost: SearchResult = { id: 'ghost', label: 'Ghost' };
    const service: SearchService = {
      revisionDependencies: ['source', 'model'],
      search: () => Promise.resolve([ghost]),
    };
    const onResultUnavailable = vi.fn();
    const { input } = await setup({ service, props: { onResultUnavailable } });
    await typeAndSettle(input, 'gh');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onResultUnavailable).toHaveBeenCalledTimes(1);
    expect(onResultUnavailable.mock.calls[0]![0]).toMatchObject({ id: 'ghost' });
    expect(onResultUnavailable.mock.calls[0]![1]).toBe('not-loaded');
  });

  it("fires onResultUnavailable with 'out-of-scope' under a hard scope", async () => {
    vi.useFakeTimers();
    const onResultUnavailable = vi.fn();
    const { instance, input } = await setup({
      searchIndex: ['label'],
      props: { onResultUnavailable },
    });
    act(() => {
      instance.applyHostUpdate({ subgraph: { seedIds: ['a'], hops: 0 } });
    });
    await typeAndSettle(input, 'gamma'); // c: in the model, outside the scope
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onResultUnavailable).toHaveBeenCalledTimes(1);
    expect(onResultUnavailable.mock.calls[0]![0]).toMatchObject({ id: 'c' });
    expect(onResultUnavailable.mock.calls[0]![1]).toBe('out-of-scope');
  });

  it("fires onResultUnavailable with 'filtered' for a mask-hidden node", async () => {
    vi.useFakeTimers();
    const onResultUnavailable = vi.fn();
    const { instance, input } = await setup({
      searchIndex: ['label'],
      props: { onResultUnavailable },
    });
    act(() => {
      instance.hideNodes(['b']);
    });
    await typeAndSettle(input, 'beta');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onResultUnavailable).toHaveBeenCalledTimes(1);
    expect(onResultUnavailable.mock.calls[0]![0]).toMatchObject({ id: 'b' });
    expect(onResultUnavailable.mock.calls[0]![1]).toBe('filtered');
  });
});

describe('<GraphSearch> query coherence (I6)', () => {
  it('Enter during the debounce window after an edit is a no-op — no stale activation, listbox stays open', async () => {
    vi.useFakeTimers();
    const { view, instance, input } = await setup({ searchIndex: ['label'] });
    await typeAndSettle(input, 'alpha'); // 'alpha' publication lands
    expect(options(view).length).toBe(1);

    const activateSpy = vi.spyOn(instance, 'activateSearchResult');
    fireEvent.change(input, { target: { value: 'beta' } }); // inside the window
    fireEvent.keyDown(input, { key: 'Enter' }); // store.search still answers 'alpha'

    expect(activateSpy).not.toHaveBeenCalled();
    // No-op means untouched: the input keeps its text, the listbox stays open
    // (still showing the previous publication's rows, per combobox convention).
    expect(input.value).toBe('beta');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(view.container.querySelector('[role="listbox"]')).not.toBeNull();
    expect(options(view).length).toBe(1);
  });

  it("once the edited query's publication lands, ArrowDown + Enter activates its result", async () => {
    vi.useFakeTimers();
    const { view, instance, input } = await setup({ searchIndex: ['label'] });
    await typeAndSettle(input, 'alpha');

    const activateSpy = vi.spyOn(instance, 'activateSearchResult');
    fireEvent.change(input, { target: { value: 'beta' } });
    fireEvent.keyDown(input, { key: 'Enter' }); // stale — gated by I6
    expect(activateSpy).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200); // 'beta' publication lands
    });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(activateSpy).toHaveBeenCalledTimes(1);
    expect(activateSpy.mock.calls[0]![0]).toMatchObject({ id: 'b' });
    // 'focused' activation closes the listbox as before.
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
  });
});

describe('<GraphSearch> inside <Graph>', () => {
  it('the searchIndex prop reaches the service and onSearchResultUnavailable is the default callback', async () => {
    vi.useFakeTimers();
    const onSearchResultUnavailable = vi.fn();
    const view = render(
      <Graph
        engine={() => new FakeEngine()}
        data={snapshot}
        searchIndex={['label']}
        subgraph={{ seedIds: ['a'], hops: 0 }}
        onSearchResultUnavailable={onSearchResultUnavailable}
      >
        <GraphSearch />
      </Graph>,
    );
    await act(async () => {}); // engine mount
    const input = view.container.querySelector<HTMLInputElement>('[data-orbit-search-input]');
    expect(input).not.toBeNull();

    // Label-field matching proves the searchIndex prop forwarded: without
    // the declaration the service is id-only and 'gamma' misses.
    await typeAndSettle(input!, 'gamma');
    expect(options(view).length).toBe(1);

    // c is in the model but outside the hard scope: with no local
    // onResultUnavailable prop, the <Graph>-level default fires.
    fireEvent.keyDown(input!, { key: 'Enter' });
    expect(onSearchResultUnavailable).toHaveBeenCalledTimes(1);
    expect(onSearchResultUnavailable.mock.calls[0]![0]).toMatchObject({ id: 'c' });
    expect(onSearchResultUnavailable.mock.calls[0]![1]).toBe('out-of-scope');
  });

  it('D7: a changed searchIndex prop is ignored with ONE console warning (construction-only)', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = new FakeEngine();
    const props = { engine: () => engine, data: snapshot };
    const view = render(
      <Graph {...props} searchIndex={['label']}>
        <GraphSearch />
      </Graph>,
    );
    await act(async () => {});

    // Change the prop TWICE: exactly one warning, and the instance keeps
    // the construction-time fields (label matching still works).
    view.rerender(
      <Graph {...props} searchIndex={['name']}>
        <GraphSearch />
      </Graph>,
    );
    view.rerender(
      <Graph {...props} searchIndex={[]}>
        <GraphSearch />
      </Graph>,
    );
    const d7Warnings = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('construction-only'),
    );
    expect(d7Warnings).toHaveLength(1);

    const input = view.container.querySelector<HTMLInputElement>('[data-orbit-search-input]');
    await typeAndSettle(input!, 'gamma'); // label-field match → still indexed
    expect(options(view).length).toBe(1);
    warnSpy.mockRestore();
  });
});

describe('<GraphSearch> Escape', () => {
  it('clears the input, the listbox, and the store slice (instance.clearSearch)', async () => {
    vi.useFakeTimers();
    const { view, instance, input } = await setup({ searchIndex: ['label'] });
    await typeAndSettle(input, 'alpha');
    expect(options(view).length).toBe(1);
    expect(instance.store.getState().search).not.toBeNull();

    const clearSpy = vi.spyOn(instance, 'clearSearch');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('');
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
    expect(instance.store.getState().search).toBeNull();
  });
});
