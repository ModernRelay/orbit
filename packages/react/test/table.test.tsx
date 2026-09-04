/**
 * <GraphTable> tests (jsdom + FakeEngine + real core).
 *
 * Covers: zero-props rendering from store context, bounded column derivation
 * and the explicit `columns` pick, the renderCell render prop, bounded
 * mounted-row count at 100K rows with scroll-following windows, bidirectional
 * sync (brush narrows table / table filter narrows graph via the crossfilter
 * session / row-click selection both directions), local-only degradation
 * without a session, sort coercion with the null tier last regardless of
 * direction, and the RFC-4180 CSV export goldens (formula-injection
 * neutralization, documented opt-out, hostile fixture in node AND edge
 * modes).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createRef } from 'react';
import type { ReactNode } from 'react';
import type { RenderResult } from '@testing-library/react';
import { createGraphInstance } from '@modernrelay/orbit-core';
import type {
  DimensionSpec,
  GraphHostUpdate,
  GraphInstance,
  GraphSnapshot,
} from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { GraphProvider } from '../src/GraphProvider';
import { GraphTable } from '../src/components/Table/index';
import type { GraphTableHandle } from '../src/components/Table/index';
import {
  PAYLOAD_SENTINEL,
  expectInert,
  payloadDataset,
} from '../../../fixtures/security/payload-dataset';

// --- fixtures ---------------------------------------------------------------

const syncSnapshot: GraphSnapshot = {
  datasetKey: 'table-sync',
  sourceRevision: 1,
  nodes: [
    { id: 'a', attrs: { name: 'ant', v: 0 } },
    { id: 'b', attrs: { name: 'bat', v: 1 } },
    { id: 'c', attrs: { name: 'cat', v: 2 } },
    { id: 'd', attrs: { name: 'dog', v: 3 } },
    { id: 'e', attrs: { name: 'emu', v: 4 } },
    { id: 'f', attrs: { name: 'fox', v: 5 } },
  ],
  edges: [
    { id: 'e1', source: 'a', target: 'b', attrs: { rel: 'friend' } },
    { id: 'e2', source: 'c', target: 'd', attrs: { rel: 'enemy' } },
  ],
};

const vDim: DimensionSpec = {
  key: 'v',
  kind: 'numeric',
  get: (n) => (n.attrs as { v?: number } | undefined)?.v,
  bins: 5,
};
/** The documented table-filter registration target: id-keyed categorical. */
const tableDim: DimensionSpec = { key: 'table', kind: 'categorical', get: (n) => n.id };

/** sort fixture: numeric tier, string tier, and the null tier (sentinel
 * strings / explicit null) in interleaved base order. */
const sortSnapshot: GraphSnapshot = {
  datasetKey: 'table-sort',
  sourceRevision: 1,
  nodes: [
    { id: 'r1', attrs: { val: 3 } },
    { id: 'r2', attrs: { val: '10' } },
    { id: 'r3', attrs: { val: 'apple' } },
    { id: 'r4', attrs: { val: 'NaN' } },
    { id: 'r5', attrs: { val: -2 } },
    { id: 'r6', attrs: { val: 'Infinity' } },
    { id: 'r7', attrs: { val: 'banana' } },
    { id: 'r8', attrs: { val: null } },
  ],
  edges: [],
};

const csvSnapshot: GraphSnapshot = {
  datasetKey: 'table-csv',
  sourceRevision: 1,
  nodes: [
    { id: 'c1', attrs: { val: '=SUM(A1)' } },
    { id: 'c2', attrs: { val: -5 } },
    { id: 'c3', attrs: { val: '+1' } },
    { id: 'c4', attrs: { val: '@x' } },
    { id: 'c5', attrs: { val: '\tind' } },
    { id: 'c6', attrs: { val: '\rcr' } },
    { id: 'c7', attrs: { val: 'He said "hi"' } },
    { id: 'c8', attrs: { val: 'a,b' } },
    { id: 'c9', attrs: { val: 'l1\nl2' } },
  ],
  edges: [],
};

// --- harness ----------------------------------------------------------------

const instances: GraphInstance<any, any>[] = [];
const hosts: HTMLElement[] = [];

async function setup(
  update: GraphHostUpdate<any, any>,
  ui: ReactNode,
): Promise<{ instance: GraphInstance<any, any>; engine: FakeEngine; view: RenderResult }> {
  const engine = new FakeEngine();
  const instance = createGraphInstance({ engine: () => engine }) as GraphInstance<any, any>;
  instances.push(instance);
  instance.applyHostUpdate(update);
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  await instance.attach(host);
  const view = render(<GraphProvider instance={instance}>{ui}</GraphProvider>);
  await flush();
  return { instance, engine, view };
}

async function flush(): Promise<void> {
  await act(async () => {});
}

function rowIds(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('[data-orbit-table-row]')].map((el) =>
    el.getAttribute('data-orbit-table-row'),
  );
}

function headerKeys(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('[data-orbit-table-header]')].map((el) =>
    el.getAttribute('data-orbit-table-header'),
  );
}

function filterInput(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>('[data-orbit-table-filter]');
  if (el === null) throw new Error('filter input not rendered');
  return el;
}

afterEach(() => {
  cleanup();
  for (const instance of instances) instance.destroy();
  instances.length = 0;
  for (const host of hosts) host.remove();
  hosts.length = 0;
  delete (globalThis as Record<string, unknown>)[PAYLOAD_SENTINEL];
});

// --- rendering ----------------------------------------------------------------

describe('<GraphTable> rendering', () => {
  it('renders visible node rows from store context with zero props (jsdom + FakeEngine)', async () => {
    const { view } = await setup({ data: syncSnapshot }, <GraphTable />);

    const root = view.container.querySelector('[data-orbit-table="nodes"]');
    expect(root).not.toBeNull();
    expect(root!.getAttribute('aria-label')).toBe('Graph table');
    expect(headerKeys(view.container)).toEqual(['id', 'name', 'v']);
    expect(rowIds(view.container)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);

    const rowA = view.container.querySelector('[data-orbit-table-row="a"]')!;
    const cells = [...rowA.querySelectorAll('[data-orbit-table-cell]')].map(
      (el) => el.textContent,
    );
    expect(cells).toEqual(['a', 'ant', '0']);
  });

  it('derives columns from a bounded sampled prefix; the columns prop overrides', async () => {
    const snapshot: GraphSnapshot = {
      datasetKey: 'table-cols',
      sourceRevision: 1,
      nodes: [
        { id: 'n1', attrs: { p: 1 } },
        { id: 'n2', attrs: { q: 2 } },
        { id: 'n3', attrs: { late: 3 } },
      ],
      edges: [],
    };
    const { instance, view } = await setup(
      { data: snapshot },
      <GraphTable columnSample={2} />,
    );

    // Bounded sample: 'late' appears only past the sampled prefix.
    expect(headerKeys(view.container)).toEqual(['id', 'p', 'q']);

    view.rerender(
      <GraphProvider instance={instance}>
        <GraphTable columns={['id', 'late']} />
      </GraphProvider>,
    );
    expect(headerKeys(view.container)).toEqual(['id', 'late']);
    const rowN3 = view.container.querySelector('[data-orbit-table-row="n3"]')!;
    const cells = [...rowN3.querySelectorAll('[data-orbit-table-cell]')].map(
      (el) => el.textContent,
    );
    expect(cells).toEqual(['n3', '3']);
  });

  it('renderCell replaces cell content (render-prop customization)', async () => {
    const { view } = await setup(
      { data: syncSnapshot },
      <GraphTable
        columns={['id', 'name']}
        renderCell={(ctx) =>
          ctx.column.key === 'name' ? (
            <em data-testid="custom-cell">{ctx.text.toUpperCase()}</em>
          ) : (
            ctx.text
          )
        }
      />,
    );
    const rowA = view.container.querySelector('[data-orbit-table-row="a"]')!;
    const custom = rowA.querySelector('[data-testid="custom-cell"]');
    expect(custom).not.toBeNull();
    expect(custom!.textContent).toBe('ANT');
  });
});

// --- virtualization -------------------------------------------------------------

describe('<GraphTable> virtualization', () => {
  it(
    'bounds the mounted row count at 100K rows and the window follows scroll',
    { timeout: 60_000 },
    async () => {
      const nodes = Array.from({ length: 100_000 }, (_, i) => ({ id: `n${i}` }));
      const { view } = await setup(
        { data: { datasetKey: 'table-100k', sourceRevision: 1, nodes, edges: [] } },
        <GraphTable rowHeight={28} height={320} overscan={8} />,
      );

      // ceil(320/28) + 2*8 = 28 mounted rows — bounded, never O(rows).
      expect(rowIds(view.container).length).toBeLessThanOrEqual(40);
      expect(
        view.container.querySelector('[role="table"]')!.getAttribute('aria-rowcount'),
      ).toBe('100001');
      const spacer = view.container.querySelector<HTMLElement>('[data-orbit-table-spacer]')!;
      expect(spacer.style.height).toBe('2800000px');
      expect(rowIds(view.container)).toContain('n0');
      expect(rowIds(view.container)).not.toContain('n50000');

      const viewport = view.container.querySelector<HTMLElement>('[data-orbit-table-viewport]')!;
      fireEvent.scroll(viewport, { target: { scrollTop: 28 * 50_000 } });

      const mounted = rowIds(view.container);
      expect(mounted.length).toBeLessThanOrEqual(40);
      expect(mounted).toContain('n50000');
      expect(mounted).not.toContain('n0');
    },
  );
});

// --- bidirectional sync -----------------------------------------------------------

describe('<GraphTable> bidirectional sync', () => {
  it('keeps attribute columns searchable after its brush hides every row', async () => {
    const { instance, view } = await setup(
      { data: syncSnapshot, crossfilter: [tableDim] },
      <GraphTable />,
    );

    fireEvent.change(filterInput(view.container), { target: { value: 'no match' } });
    await flush();
    expect(instance.getVisibleNodeIds()).toEqual([]);
    expect(rowIds(view.container)).toEqual([]);
    expect(headerKeys(view.container)).toEqual(['id', 'name', 'v']);

    // Correcting a typo must work without first clearing the filter. This
    // matches an attribute value, not an ID.
    fireEvent.change(filterInput(view.container), { target: { value: 'ant' } });
    await flush();
    expect(instance.getVisibleNodeIds()).toEqual(['a']);
    expect(rowIds(view.container)).toEqual(['a']);

    fireEvent.change(filterInput(view.container), { target: { value: 'fox' } });
    await flush();
    expect(instance.getVisibleNodeIds()).toEqual(['f']);
    expect(rowIds(view.container)).toEqual(['f']);
  });

  it('keeps sampled attributes discoverable when another dimension hides their rows', async () => {
    const { instance, view } = await setup(
      {
        data: {
          datasetKey: 'table-heterogeneous', sourceRevision: 1,
          nodes: [{ id: 'a', attrs: { first: 'ant', v: 0 } }, { id: 'b', attrs: { second: 'bat', v: 1 } }],
          edges: [],
        },
        crossfilter: [vDim, tableDim],
      },
      <GraphTable />,
    );
    const session = instance.getCrossfilterSession()!;
    await act(async () => { await session.setBrush('v', { min: 0, max: 0 }); });
    fireEvent.change(filterInput(view.container), { target: { value: 'bat' } });
    await flush();
    expect(rowIds(view.container)).toEqual([]);
    expect(headerKeys(view.container)).toContain('second');

    await act(async () => { await session.setBrush('v', null); });
    expect(instance.getVisibleNodeIds()).toEqual(['b']);
    expect(rowIds(view.container)).toEqual(['b']);
  });

  it('a crossfilter brush narrows the table rows (graph → table)', async () => {
    const { instance, view } = await setup(
      { data: syncSnapshot, crossfilter: [vDim, tableDim] },
      <GraphTable />,
    );
    const session = instance.getCrossfilterSession();
    expect(session).not.toBeNull();

    await act(async () => {
      await session!.setBrush('v', { min: 0.5, max: 2.5 });
    });
    expect(rowIds(view.container)).toEqual(['b', 'c']);

    await act(async () => {
      await session!.setBrush('v', null);
    });
    expect(rowIds(view.container)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('the table filter narrows the graph via the crossfilter session (table → graph)', async () => {
    const { instance, view } = await setup(
      { data: syncSnapshot, crossfilter: [vDim, tableDim] },
      <GraphTable />,
    );
    const session = instance.getCrossfilterSession()!;

    fireEvent.change(filterInput(view.container), { target: { value: 'at' } });
    await flush();

    // 'at' matches bat/cat: the brush excludes the non-matching scene ids.
    const brush = session.getBrush('table');
    expect(brush).not.toBeNull();
    expect(new Set((brush as { excluded: readonly string[] }).excluded)).toEqual(
      new Set(['a', 'd', 'e', 'f']),
    );
    expect(instance.store.getState().visible.nodes).toBe(2);
    expect(instance.getVisibleNodeIds()).toEqual(['b', 'c']);
    expect(rowIds(view.container)).toEqual(['b', 'c']);

    // Clearing the filter clears the brush and restores the graph.
    fireEvent.change(filterInput(view.container), { target: { value: '' } });
    await flush();
    expect(session.getBrush('table')).toBeNull();
    expect(instance.store.getState().visible.nodes).toBe(6);
    expect(rowIds(view.container)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('unmounting the table clears the brush it wrote', async () => {
    const { instance, view } = await setup(
      { data: syncSnapshot, crossfilter: [vDim, tableDim] },
      <GraphTable />,
    );
    const session = instance.getCrossfilterSession()!;

    fireEvent.change(filterInput(view.container), { target: { value: 'at' } });
    await flush();
    expect(instance.store.getState().visible.nodes).toBe(2);

    view.unmount();
    await flush();
    expect(session.getBrush('table')).toBeNull();
    expect(instance.store.getState().visible.nodes).toBe(6);
  });

  it('changing filterDimension clears the previous brush without a stale intersection', async () => {
    const { instance, view } = await setup(
      {
        data: syncSnapshot,
        crossfilter: [vDim, tableDim, { ...tableDim, key: 'table2' }],
      },
      <GraphTable />,
    );
    const session = instance.getCrossfilterSession()!;

    fireEvent.change(filterInput(view.container), { target: { value: 'at' } });
    await flush();
    expect(session.getBrush('table')).not.toBeNull();

    // Re-point the table at a DIFFERENT dimension. The old brush must clear
    // — before the fix it stayed active and intersected later filters.
    view.rerender(
      <GraphProvider instance={instance}>
        <GraphTable filterDimension="table2" filterText="at" />
      </GraphProvider>,
    );
    await flush();
    expect(session.getBrush('table')).toBeNull();
    expect(session.getBrush('table2')).not.toBeNull();
  });

  it('degrades to local-only narrowing when the host configured no crossfilter', async () => {
    const { instance, view } = await setup({ data: syncSnapshot }, <GraphTable />);
    expect(instance.getCrossfilterSession()).toBeNull();

    fireEvent.change(filterInput(view.container), { target: { value: 'at' } });
    await flush();

    expect(rowIds(view.container)).toEqual(['b', 'c']); // table narrows…
    expect(instance.store.getState().visible.nodes).toBe(6); // …the graph does not
  });

  it('row click writes SelectionState and graph selection highlights rows', async () => {
    const { instance, view } = await setup({ data: syncSnapshot }, <GraphTable />);

    fireEvent.click(view.container.querySelector('[data-orbit-table-row="b"]')!);
    expect(instance.store.getState().selection.nodeIds).toEqual(['b']);
    expect(
      view.container
        .querySelector('[data-orbit-table-row="b"]')!
        .getAttribute('aria-selected'),
    ).toBe('true');

    // meta-click toggles membership (additive).
    fireEvent.click(view.container.querySelector('[data-orbit-table-row="c"]')!, {
      metaKey: true,
    });
    expect(instance.store.getState().selection.nodeIds).toEqual(['b', 'c']);

    // graph → table: an external selection write re-highlights rows.
    act(() => {
      instance.selectNodes(['d']);
    });
    const selected = [...view.container.querySelectorAll('[data-orbit-table-row]')]
      .filter((el) => el.getAttribute('aria-selected') === 'true')
      .map((el) => el.getAttribute('data-orbit-table-row'));
    expect(selected).toEqual(['d']);
  });

  it('edge rows follow endpoint visibility and write edge selection', async () => {
    const { instance, view } = await setup(
      { data: syncSnapshot },
      <GraphTable mode="edges" edges={syncSnapshot.edges} />,
    );

    expect(headerKeys(view.container)).toEqual(['id', 'source', 'target', 'rel']);
    expect(rowIds(view.container)).toEqual(['e1', 'e2']);

    fireEvent.click(view.container.querySelector('[data-orbit-table-row="e1"]')!);
    expect(instance.store.getState().selection.edgeIds).toEqual(['e1']);
    expect(
      view.container
        .querySelector('[data-orbit-table-row="e1"]')!
        .getAttribute('aria-selected'),
    ).toBe('true');

    // Hiding an endpoint drops the edge row (documented approximation).
    act(() => {
      instance.hideNodes(['a']);
    });
    expect(rowIds(view.container)).toEqual(['e2']);
  });
});

// --- sorting --------------------------------------------------------------------

describe('<GraphTable> sorting', () => {
  it('orders numeric, then string, with the null tier last regardless of direction', async () => {
    const { view } = await setup({ data: sortSnapshot }, <GraphTable />);
    const sortButton = view.container.querySelector<HTMLButtonElement>(
      '[data-orbit-table-sort="val"]',
    )!;
    const header = view.container.querySelector('[data-orbit-table-header="val"]')!;

    // asc: numerics (-2, 3, '10'), strings ('apple', 'banana'), then the null
    // tier ('NaN', 'Infinity', null) in stable base order — LAST.
    fireEvent.click(sortButton);
    expect(header.getAttribute('aria-sort')).toBe('ascending');
    expect(rowIds(view.container)).toEqual(['r5', 'r1', 'r2', 'r3', 'r7', 'r4', 'r6', 'r8']);

    // desc flips within each tier; nulls stay last.
    fireEvent.click(sortButton);
    expect(header.getAttribute('aria-sort')).toBe('descending');
    expect(rowIds(view.container)).toEqual(['r2', 'r1', 'r5', 'r7', 'r3', 'r4', 'r6', 'r8']);

    // third click restores base (visible) order.
    fireEvent.click(sortButton);
    expect(header.getAttribute('aria-sort')).toBe('none');
    expect(rowIds(view.container)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']);
  });
});

// --- CSV export -----------------------------------------------------------------------

describe('<GraphTable> CSV export', () => {
  it('exports RFC-4180 with formula-injection neutralization (golden)', async () => {
    const ref = createRef<GraphTableHandle>();
    await setup({ data: csvSnapshot }, <GraphTable ref={ref} columns={['id', 'val']} />);

    const csv = ref.current!.exportCsv();
    expect(csv).toBe(
      'id,val\r\n' +
        "c1,'=SUM(A1)\r\n" + // string '=…' neutralized
        'c2,-5\r\n' + // numeric cell exempt, plain number
        "c3,'+1\r\n" +
        "c4,'@x\r\n" +
        "c5,'\tind\r\n" + // leading TAB neutralized (no quoting needed)
        "c6,\"'\rcr\"\r\n" + // leading CR neutralized, then quoted (contains CR)
        'c7,"He said ""hi"""\r\n' + // embedded quotes doubled
        'c8,"a,b"\r\n' + // comma cell quoted
        'c9,"l1\nl2"', // newline cell quoted; CRLF records, no trailing CRLF
    );
  });

  it('neutralizeFormulas={false} disables prefixing (the default stays safe)', async () => {
    const ref = createRef<GraphTableHandle>();
    await setup(
      { data: csvSnapshot },
      <GraphTable ref={ref} columns={['id', 'val']} neutralizeFormulas={false} />,
    );
    const csv = ref.current!.exportCsv();
    expect(csv).toContain('c1,=SUM(A1)');
    expect(csv).toContain('c3,+1');
    expect(csv).not.toContain("'=SUM(A1)");
  });

  it('hostile-label fixture exports fully neutralized CSV in node and edge modes', async () => {
    const nodeRef = createRef<GraphTableHandle>();
    const edgeRef = createRef<GraphTableHandle>();
    const { view } = await setup(
      { data: payloadDataset as GraphSnapshot<any, any> },
      <>
        <GraphTable ref={nodeRef} />
        <GraphTable ref={edgeRef} mode="edges" edges={payloadDataset.edges} />
      </>,
    );

    // The table DOM itself renders every payload as inert text.
    expectInert(document.body);
    expect(view.container.textContent).toContain('<script>');

    for (const csv of [nodeRef.current!.exportCsv(), edgeRef.current!.exportCsv()]) {
      // Every CSV formula payload is apostrophe-prefixed…
      expect(csv).toContain("'=cmd");
      expect(csv).toContain("'+1");
      expect(csv).toContain("'-1");
      expect(csv).toContain("'@x");
      // …and no cell in any record starts with a live formula lead (the
      // fixture has no numeric attrs, so a leading '-' is never legitimate).
      for (const record of csv.split('\r\n')) {
        for (const cell of record.split(',')) {
          const body = cell.startsWith('"') ? cell.slice(1) : cell;
          expect(body).not.toMatch(/^[=+@\-\t\r]/);
        }
      }
    }
  });
});
