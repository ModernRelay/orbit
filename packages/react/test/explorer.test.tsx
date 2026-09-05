import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { createGraphInstance, createInvestigationSession } from '@modernrelay/orbit-core';
import type { GraphSnapshot } from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { GraphExplorer } from '../src/components/Explorer';
import type { GraphExplorerProps } from '../src/components/Explorer';
import { GraphInspector } from '../src/components/Inspector';
import { GraphSearch } from '../src/components/Search';

const snapshot: GraphSnapshot = {
  datasetKey: 'investigation-fixture', sourceRevision: 1,
  nodes: [
    { id: 'a', attrs: { label: 'Alpha', risk: 7 } },
    { id: 'b', attrs: { label: 'Beta', risk: 4 } },
    { id: 'c', attrs: { label: 'Gamma', risk: 9 } },
    { id: 'd', attrs: { label: 'Delta', risk: 2 } },
  ],
  edges: [
    { id: 'ab', source: 'a', target: 'b', attrs: { type: 'employs', evidence: 'annual filing' } },
    { id: 'bc', source: 'b', target: 'c', attrs: { type: 'funds' } },
    { id: 'ad', source: 'a', target: 'd', attrs: { type: 'employs' } },
  ],
};
const disposers: (() => void)[] = [];
afterEach(() => { cleanup(); disposers.splice(0).reverse().forEach((dispose) => dispose()); vi.restoreAllMocks(); });

async function rig(props: Partial<GraphExplorerProps> = {}) {
  const engine = new FakeEngine();
  const instance = createGraphInstance({ engine: () => engine, searchIndex: ['label'], fitViewOnFirstData: false });
  instance.applyHostUpdate({ data: snapshot, crossfilter: [{ key: 'table', kind: 'categorical', get: (node) => node.id }] });
  const host = document.createElement('div'); document.body.appendChild(host);
  await instance.attach(host);
  const investigation = createInvestigationSession(instance);
  disposers.push(() => { investigation.destroy(); instance.destroy(); host.remove(); });
  const view = render(<GraphExplorer instance={instance} investigation={investigation} layout="panel" {...props} />);
  return { instance, engine, investigation, view };
}

async function search(view: ReturnType<typeof render>, query: string) {
  fireEvent.change(view.getByRole('combobox', { name: 'Search graph' }), { target: { value: query } });
  return view.findByRole('option', { name: new RegExp(query, 'i') });
}
function tableFilter(view: ReturnType<typeof render>): HTMLInputElement {
  return view.container.querySelector<HTMLInputElement>('[data-orbit-table-filter]')!;
}

describe('GraphExplorer investigation journeys', () => {
  it('connects search, passive inspection, comparison, ordered paths, table filtering and durable restore', async () => {
    const { instance, engine, investigation, view } = await rig();
    fireEvent.click(await search(view, 'Beta'));
    expect(view.getByRole('complementary').textContent).toContain('Beta');
    const cameraCalls = engine.cameraCalls.length;
    fireEvent.click(within(view.getByRole('complementary')).getByRole('button', { name: 'Alpha' }));
    expect(view.getByRole('complementary').textContent).toContain('Alpha');
    expect(engine.cameraCalls.length).toBe(cameraCalls);
    expect(view.getByRole('region', { name: 'Entity table' })).toBeTruthy();
    act(() => instance.selectNodes(['a', 'c']));
    fireEvent.click(view.getByRole('button', { name: 'Compare selection' }));
    expect(view.getByRole('table', { name: 'Selected node comparison' }).textContent).toContain('Gamma');
    fireEvent.click(view.getByRole('button', { name: 'Use two selected nodes' }));
    fireEvent.change(view.getByLabelText('Path direction'), { target: { value: 'outgoing' } });
    fireEvent.click(view.getByRole('button', { name: 'Find connection' }));
    await waitFor(() => expect(investigation.store.getState().paths).toHaveLength(1));
    const explanation = view.container.querySelector<HTMLElement>('[data-orbit-saved-path]')!;
    expect([...explanation.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['Alpha → employs', 'Beta → funds', 'Gamma']);
    fireEvent.click(within(explanation).getByRole('button', { name: 'employs' }));
    expect(view.getByRole('complementary').textContent).toContain('annual filing');
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'c']);
    expect(engine.cameraCalls.length).toBe(cameraCalls);
    fireEvent.change(tableFilter(view), { target: { value: 'Alpha' } });
    await waitFor(() => expect(instance.getVisibleNodeIds()).toEqual(['a']));
    fireEvent.change(view.getByLabelText('Investigation title'), { target: { value: 'Supplier overlap' } });
    fireEvent.change(view.getByLabelText('Investigation notes'), { target: { value: 'Review the annual filing.' } });
    fireEvent.click(view.getByRole('button', { name: 'Save checkpoint' }));
    await waitFor(() => expect(investigation.store.getState().checkpoints).toHaveLength(1));
    const saved = investigation.store.getState().checkpoints[0]!;
    expect(saved.paths[0]!.path.edgeIds).toEqual(['ab', 'bc']);
    expect(saved.tableQuery).toBe('Alpha');
    fireEvent.change(tableFilter(view), { target: { value: '' } });
    fireEvent.change(view.getByLabelText('Investigation notes'), { target: { value: 'Changed' } });
    act(() => instance.hideNodes(['a']));
    fireEvent.click(view.getByRole('button', { name: 'Restore Supplier overlap' }));
    await waitFor(() => expect(investigation.store.getState().status).toBe('idle'));
    await waitFor(() => expect((view.getByLabelText('Investigation notes') as HTMLTextAreaElement).value).toBe('Review the annual filing.'));
    expect(tableFilter(view).value).toBe('Alpha');
    await waitFor(() => expect(instance.getVisibleNodeIds()).toEqual(['a']));
    expect(view.container.querySelectorAll('[data-orbit-saved-path]')).toHaveLength(1);
    fireEvent.click(view.getByRole('button', { name: 'Clear Table: Alpha' }));
    await waitFor(() => expect(instance.getVisibleNodeIds()).toHaveLength(4));
  });

  it('makes hidden search recovery explicit and ignores a recovery completed after a newer query', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const onRecoverSearchResult = vi.fn(() => pending);
    const { instance, view } = await rig({ onRecoverSearchResult });
    act(() => instance.hideNodes(['b']));
    const focus = vi.spyOn(instance, 'focusNode');
    fireEvent.click(await search(view, 'Beta'));
    expect(onRecoverSearchResult).not.toHaveBeenCalled();
    expect(instance.getVisibleNodeIds()).not.toContain('b');
    fireEvent.click(view.getByRole('button', { name: 'Reveal filtered entity' }));
    expect(onRecoverSearchResult).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), 'filtered');
    await search(view, 'Gamma');
    await act(async () => { instance.showNodes(['b']); release(); await pending; });
    expect(focus).not.toHaveBeenCalled();
    expect(view.getByRole('complementary').textContent).not.toContain('annual filing');
  });

  it('pages typed expansions while preserving context and exposes an explicit retract', async () => {
    const { instance, investigation, view } = await rig();
    act(() => { instance.applyHostUpdate({ subgraph: { seedIds: ['a'], hops: 0 } }); instance.selectNodes(['a']); });
    fireEvent.change(view.getByRole('textbox', { name: 'Relationship type' }), { target: { value: 'employs' } });
    fireEvent.change(view.getByLabelText('Expansion direction'), { target: { value: 'outgoing' } });
    fireEvent.change(view.getByLabelText('Expansion page size'), { target: { value: '1' } });
    fireEvent.click(view.getByRole('button', { name: 'Load relationships' }));
    await waitFor(() => expect(investigation.store.getState().expansions).toHaveLength(1));
    expect(instance.getSceneNodeIds()).toEqual(['a', 'b']);
    fireEvent.click(await view.findByRole('button', { name: 'Load next page' }));
    await waitFor(() => expect(investigation.store.getState().expansions).toHaveLength(2));
    expect(instance.getSceneNodeIds()).toEqual(['a', 'b', 'd']);
    expect(instance.getSceneNodeIds()).not.toContain('c');
    fireEvent.click(view.getByRole('button', { name: 'Retract last page' }));
    await waitFor(() => expect(instance.getSceneNodeIds()).toEqual(['a', 'b']));
    expect(investigation.store.getState().expansions).toHaveLength(1);
    fireEvent.click(view.getByRole('button', { name: 'Retract last page' }));
    await waitFor(() => expect(instance.getSceneNodeIds()).toEqual(['a']));
    expect(investigation.store.getState().expansions).toHaveLength(0);
  });

  it('shows source mismatches without restoring unrelated data', async () => {
    const { instance, investigation, view } = await rig();
    await act(async () => { await investigation.checkpoint('Original source'); });
    act(() => instance.applyHostUpdate({ data: { datasetKey: 'replacement', sourceRevision: 8, nodes: [{ id: 'z' }], edges: [] } }));
    fireEvent.click(view.getByRole('button', { name: 'Restore Original source' }));
    expect((await view.findByRole('alert')).textContent).toMatch(/source/i);
    expect(instance.getSceneNodeIds()).toEqual(['z']);
  });

  it('discards the displayed continuation when undo changes the saved expansion stack', async () => {
    const { instance, investigation, view } = await rig();
    act(() => { instance.applyHostUpdate({ subgraph: { seedIds: ['a'], hops: 0 } }); instance.selectNodes(['a']); });
    fireEvent.change(view.getByLabelText('Expansion page size'), { target: { value: '1' } });
    fireEvent.click(view.getByRole('button', { name: 'Load relationships' }));
    await view.findByRole('button', { name: 'Load next page' });
    act(() => instance.undo());
    expect(investigation.store.getState().expansions).toHaveLength(0);
    expect(view.queryByRole('button', { name: 'Load next page' })).toBeNull();
    act(() => instance.redo());
    expect(investigation.store.getState().expansions).toHaveLength(1);
    expect(view.queryByRole('button', { name: 'Load next page' })).toBeNull();
  });

  it('reports hop limits separately from disconnected paths and saves no invented explanation', async () => {
    const { investigation, view } = await rig();
    fireEvent.change(view.getByLabelText('Path source'), { target: { value: 'a' } });
    fireEvent.change(view.getByLabelText('Path target'), { target: { value: 'c' } });
    fireEvent.change(view.getByLabelText('Path hop limit'), { target: { value: '1' } });
    fireEvent.click(view.getByRole('button', { name: 'Find connection' }));
    await view.findByText(/No connection within 1 hops/);
    expect(investigation.store.getState().paths).toHaveLength(0);
  });

  it('creates an internal session safely under StrictMode', async () => {
    const { instance, view } = await rig();
    view.unmount();
    const strict = render(<StrictMode><GraphExplorer instance={instance} layout="panel" /></StrictMode>);
    fireEvent.change(await strict.findByLabelText('Investigation notes'), { target: { value: 'Still active' } });
    fireEvent.click(strict.getByRole('button', { name: 'Save checkpoint' }));
    await strict.findByRole('button', { name: 'Restore Untitled investigation' });
  });

  it('does not rescan neighborhoods while editing notes and clears source-specific explanations on replacement', async () => {
    const { instance, investigation, view } = await rig();
    act(() => {
      instance.selectNodes(['a']);
      investigation.savePath({ sourceId: 'a', targetId: 'b', path: { nodeIds: ['a', 'b'], edgeIds: ['ab'] } });
    });
    const read = vi.spyOn(instance, 'getNeighborhood');
    fireEvent.change(view.getByLabelText('Investigation notes'), { target: { value: 'First finding' } });
    fireEvent.change(view.getByLabelText('Investigation notes'), { target: { value: 'First finding with evidence' } });
    expect(read).not.toHaveBeenCalled();
    act(() => instance.applyHostUpdate({ data: { datasetKey: 'other', sourceRevision: 1, nodes: [{ id: 'a', attrs: { label: 'Unrelated Alpha' } }], edges: [] } }));
    expect(investigation.store.getState().paths).toHaveLength(0);
    expect(view.container.querySelector('[data-orbit-saved-path]')).toBeNull();
  });

  it('clears constraints explicitly and lets graph history reverse a clear', async () => {
    const clearHostFilter = vi.fn();
    const { instance, view } = await rig({ constraints: [{ id: 'host', label: 'Type: company', onClear: clearHostFilter }] });
    expect(clearHostFilter).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Clear Type: company' }));
    expect(clearHostFilter).toHaveBeenCalledTimes(1);
    await act(async () => {});
    act(() => instance.hideNodes(['d']));
    fireEvent.click(view.getByRole('button', { name: 'Clear 1 manually hidden' }));
    await waitFor(() => expect(instance.getVisibleNodeIds()).toContain('d'));
    fireEvent.click(view.getByRole('button', { name: 'Undo last graph change' }));
    expect(instance.getVisibleNodeIds()).not.toContain('d');
  });

  it('can switch between externally owned and internal sessions without reusing a destroyed owner', async () => {
    const { instance, investigation, view } = await rig();
    view.rerender(<GraphExplorer instance={instance} layout="panel" />);
    fireEvent.change(await view.findByLabelText('Investigation title'), { target: { value: 'Internal one' } });
    view.rerender(<GraphExplorer instance={instance} investigation={investigation} layout="panel" />);
    expect((view.getByLabelText('Investigation title') as HTMLInputElement).value).toBe('Untitled investigation');
    view.rerender(<GraphExplorer instance={instance} layout="panel" />);
    fireEvent.change(await view.findByLabelText('Investigation title'), { target: { value: 'Internal two' } });
    fireEvent.click(view.getByRole('button', { name: 'Save checkpoint' }));
    await view.findByRole('button', { name: 'Restore Internal two' });
  });
});

describe('explicit inspector and controlled search', () => {
  it('reads a namespaced relationship type and browses without camera or selection writes', async () => {
    const { instance, engine, view } = await rig();
    view.unmount();
    act(() => instance.applyHostUpdate({ data: { ...snapshot, sourceRevision: 2, edges: [{ id: 'ab', source: 'a', target: 'b', attrs: { 'orbit:type': 'works_at' } }] } }));
    const onInspect = vi.fn();
    const camera = engine.cameraCalls.length;
    const inspector = render(<GraphInspector instance={instance} subject={{ kind: 'node', id: 'a' }} layout="panel" typeField="orbit:type" onInspect={onInspect} />);
    fireEvent.click(inspector.getByRole('button', { name: /works_at/ }));
    expect(onInspect).toHaveBeenCalledWith({ kind: 'edge', id: 'ab' });
    expect(engine.cameraCalls.length).toBe(camera);
    expect(instance.store.getState().selection.nodeIds).toEqual([]);
  });

  it('schedules restored controlled queries once and clears externally reset queries', async () => {
    const { instance, view } = await rig(); view.unmount();
    const calls = vi.spyOn(instance, 'search');
    const controlled = render(<GraphSearch instance={instance} value="Beta" />);
    await controlled.findByRole('option', { name: /Beta/ });
    expect(calls).toHaveBeenCalledTimes(1);
    controlled.rerender(<GraphSearch instance={instance} value="" />);
    expect(instance.store.getState().search).toBeNull();
    expect(controlled.queryByRole('option')).toBeNull();
  });
});
