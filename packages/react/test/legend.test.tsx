/**
 * Styling surface tests — jsdom + FakeEngine + the REAL
 * core scale/metric/theme machinery. Scale prop plumbing (canonical-key
 * diffing, one commit), <GraphLegend> ramp/categorical/size rendering,
 * renderLegend slot, useGraphTheme, prop diffing (metrics/nodeImage/
 * edgeArrows/showLinks), text-node safety, and entry importability.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import type { GraphSnapshot, MetricColumn, Scale } from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { Graph, useGraphTheme } from '../src/index';
import type { GraphHandle } from '../src/index';
import { GraphLegend } from '../src/components/Legend';

/** Path graph a—b—c: degrees a=1, b=2, c=1 → degree domain [1,2]. */
const pathSnapshot: GraphSnapshot = {
  datasetKey: 'ds',
  sourceRevision: 1,
  nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  edges: [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
  ],
};

type NA = { label: string };

/** Labels A, B, W over declared domain [A, B, Z] → rows A,B,Z(empty),W. */
const catSnapshot: GraphSnapshot<NA> = {
  datasetKey: 'ds-cat',
  sourceRevision: 1,
  nodes: [
    { id: 'a', attrs: { label: 'A' } },
    { id: 'b', attrs: { label: 'B' } },
    { id: 'w', attrs: { label: 'W' } },
  ],
  edges: [],
};

const catScale: Scale<string, NA> = {
  kind: 'categorical',
  by: 'label',
  domain: ['A', 'B', 'Z'],
};

function degreeRamp(): Scale<string> {
  return { kind: 'sequential', metric: 'degree', range: ['#000000', '#ffffff'] };
}

async function flush(): Promise<void> {
  await act(async () => {});
}

afterEach(cleanup);

describe('<Graph> scale/style prop plumbing', () => {
  it('a scale-valued nodeColor lands as one commit; canonically-equal literals never re-forward', async () => {
    const fake = new FakeEngine();
    const handleRef = createRef<GraphHandle>();
    const { rerender } = render(
      <Graph ref={handleRef} engine={() => fake} data={pathSnapshot} nodeColor={degreeRamp()} />,
    );
    await flush();

    // Exactly the ready replay commit, carrying the projected scale buffer.
    expect(fake.commits.length).toBe(1);
    expect(fake.lastCommit!.buffers?.pointColor).toBeDefined();

    const spy = vi.spyOn(handleRef.current!.instance, 'applyHostUpdate');
    try {
      // New object identity, equal canonical structure → never re-forwarded.
      rerender(
        <Graph ref={handleRef} engine={() => fake} data={pathSnapshot} nodeColor={degreeRamp()} />,
      );
      expect(spy).not.toHaveBeenCalled();

      // Structurally different scale → exactly one forwarded update.
      const reversed: Scale<string> = {
        kind: 'sequential',
        metric: 'degree',
        range: ['#ffffff', '#000000'],
      };
      rerender(
        <Graph ref={handleRef} engine={() => fake} data={pathSnapshot} nodeColor={reversed} />,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ nodeColor: reversed });

      // Scale → accessor flip is a genuine change.
      const accessor = (): string => '#ff0000';
      rerender(
        <Graph ref={handleRef} engine={() => fake} data={pathSnapshot} nodeColor={accessor} />,
      );
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('handle getScaleInfo/getMetricValue delegate to the instance', async () => {
    const fake = new FakeEngine();
    const handleRef = createRef<GraphHandle>();
    render(
      <Graph ref={handleRef} engine={() => fake} data={pathSnapshot} nodeColor={degreeRamp()} />,
    );
    await flush();
    const handle = handleRef.current!;

    expect(handle.getScaleInfo('nodeColor')!.domain).toEqual([1, 2]);
    expect(handle.getScaleInfo('nodeSize')).toBeNull(); // not scale-valued
    expect(handle.getMetricValue('degree', 'b')).toBe(2);
    expect(handle.getMetricValue('degree', 'nope')).toBeNull();
  });

  it('metrics/edgeArrows/showLinks/nodeImage diff by reference/value; theme diffs by JSON', async () => {
    const fake = new FakeEngine();
    const handleRef = createRef<GraphHandle>();
    const metrics: readonly MetricColumn[] = [
      // Atomic data+metrics mount: stamped with the issue-time revision (0).
      { metric: 'score', forModelRevision: 0, align: 'ids', ids: ['a', 'b', 'c'], values: [10, 20, 30] },
    ];
    const nodeImage = (): string | null => null;
    const props = {
      engine: () => fake,
      data: pathSnapshot,
      metrics,
      nodeImage,
      edgeArrows: true,
      showLinks: true,
      theme: { background: '#101010' },
    } as const;
    const { rerender } = render(<Graph ref={handleRef} {...props} />);
    await flush();
    const handle = handleRef.current!;
    expect(handle.getMetricValue('score', 'b')).toBe(20); // column admitted
    expect(handle.instance.store.getState().theme.background).toBe('#101010');

    const spy = vi.spyOn(handle.instance, 'applyHostUpdate');
    try {
      // Same references/values, new-but-equal theme object → zero updates.
      rerender(<Graph ref={handleRef} {...props} theme={{ background: '#101010' }} />);
      expect(spy).not.toHaveBeenCalled();

      // Value change on a toggle → exactly the changed key forwards.
      rerender(<Graph ref={handleRef} {...props} showLinks={false} />);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ showLinks: false });

      // New metrics array reference → forwarded.
      rerender(<Graph ref={handleRef} {...props} showLinks={false} metrics={[...metrics]} />);
      expect(spy).toHaveBeenCalledTimes(2);

      // Removing the nodeImage prop forwards the explicit clear.
      const { nodeImage: _dropped, ...withoutImage } = props;
      rerender(<Graph ref={handleRef} {...withoutImage} showLinks={false} metrics={metrics} />);
      expect(spy).toHaveBeenCalledTimes(3);
      expect(spy.mock.calls[2]![0]).toMatchObject({ nodeImage: null });
      // Re-omitting stays omitted — no repeat null spam.
      rerender(<Graph ref={handleRef} {...withoutImage} showLinks={false} metrics={metrics} />);
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });

  it('renderLegend renders inside a positioned slot and re-reads scale info', async () => {
    const fake = new FakeEngine();
    const { container } = render(
      <Graph
        engine={() => fake}
        data={pathSnapshot}
        nodeColor={degreeRamp()}
        renderLegend={(info) => (
          <span data-testid="custom-legend">{info.nodeColor?.domain?.join('..') ?? 'none'}</span>
        )}
      />,
    );
    await flush();

    expect(container.querySelector('[data-orbit-legend-slot]')).not.toBeNull();
    expect(screen.getByTestId('custom-legend').textContent).toBe('1..2');
  });
});

describe('<GraphLegend>', () => {
  it('renders nothing when the channel is not scale-valued', async () => {
    const fake = new FakeEngine();
    const { container } = render(
      <Graph engine={() => fake} data={pathSnapshot} nodeColor="#ff0000">
        <GraphLegend />
      </Graph>,
    );
    await flush();
    expect(container.querySelector('[data-orbit-legend]')).toBeNull();
  });

  it('sequential degree ramp: gradient bar + min/max domain ticks + metric name', async () => {
    const fake = new FakeEngine();
    const { container } = render(
      <Graph engine={() => fake} data={pathSnapshot} nodeColor={degreeRamp()}>
        <GraphLegend />
      </Graph>,
    );
    await flush();

    const legend = container.querySelector('[data-orbit-legend="nodeColor"]');
    expect(legend).not.toBeNull();
    expect(legend!.querySelector('[data-orbit-legend-title]')!.textContent).toBe('degree');

    const ramp = legend!.querySelector<HTMLElement>('[data-orbit-legend-ramp="sequential"]');
    expect(ramp).not.toBeNull();
    expect(ramp!.style.background).toContain('linear-gradient');

    const ticks = [...legend!.querySelectorAll('[data-orbit-legend-tick]')].map(
      (t) => t.textContent,
    );
    expect(ticks).toEqual(['1', '2']);
  });

  it('categorical: swatch rows with counts, click callback, excluded dimming', async () => {
    const fake = new FakeEngine();
    const onCategoryClick = vi.fn();
    const { container } = render(
      <Graph engine={() => fake} data={catSnapshot} nodeColor={catScale}>
        <GraphLegend excludedValues={['B']} onCategoryClick={onCategoryClick} />
      </Graph>,
    );
    await flush();

    const rows = [...container.querySelectorAll<HTMLButtonElement>('[data-orbit-legend-row]')];
    // Declared order first (Z is empty but present), extras sorted.
    expect(rows.map((r) => r.querySelector('[data-orbit-legend-value]')!.textContent)).toEqual([
      'A',
      'B',
      'Z',
      'W',
    ]);
    expect(rows.map((r) => r.querySelector('[data-orbit-legend-count]')!.textContent)).toEqual([
      '1',
      '1',
      '0',
      '1',
    ]);
    // Every row carries a color chip.
    for (const row of rows) {
      expect(row.querySelector('[data-orbit-legend-swatch]')).not.toBeNull();
    }

    // Excluded rows render dimmed with the pressed affordance.
    const rowB = rows[1]!;
    expect(rowB.getAttribute('aria-pressed')).toBe('true');
    expect(rowB.style.opacity).toBe('0.45');
    expect(rows[0]!.getAttribute('aria-pressed')).toBe('false');

    // The HOST owns filtering: a click only reports the value.
    fireEvent.click(rows[3]!);
    expect(onCategoryClick).toHaveBeenCalledExactlyOnceWith('W');
  });

  it('nodeSize scale: 4 graduated dots with value labels', async () => {
    const fake = new FakeEngine();
    const sizeScale: Scale<number> = { kind: 'sequential', metric: 'degree', range: [2, 14] };
    const { container } = render(
      <Graph engine={() => fake} data={pathSnapshot} nodeSize={sizeScale}>
        <GraphLegend channel="nodeSize" />
      </Graph>,
    );
    await flush();

    const legend = container.querySelector('[data-orbit-legend="nodeSize"]');
    expect(legend).not.toBeNull();
    const dots = [...legend!.querySelectorAll<HTMLElement>('[data-orbit-legend-dot]')];
    expect(dots.length).toBe(4);
    // Small → large across the size range.
    expect(dots[0]!.style.width).toBe('2px');
    expect(dots[3]!.style.width).toBe('14px');

    const labels = [...legend!.querySelectorAll('[data-orbit-legend-tick]')].map(
      (t) => t.textContent,
    );
    expect(labels).toEqual(['1', '1.33', '1.67', '2']);
  });

  it('hostile category names render as literal text nodes, never markup', async () => {
    const hostile = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    const snapshot: GraphSnapshot<NA> = {
      datasetKey: 'ds-hostile',
      sourceRevision: 1,
      nodes: [{ id: 'a', attrs: { label: hostile } }],
      edges: [],
    };
    const fake = new FakeEngine();
    const { container } = render(
      <Graph engine={() => fake} data={snapshot} nodeColor={{ kind: 'categorical', by: 'label' }}>
        <GraphLegend />
      </Graph>,
    );
    await flush();

    const value = container.querySelector('[data-orbit-legend-value]');
    expect(value!.textContent).toBe(hostile);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe('useGraphTheme', () => {
  function ThemeProbe(): JSX.Element {
    const theme = useGraphTheme();
    return <div data-testid="theme">{`${theme.background}|${theme.nodeDefault}`}</div>;
  }

  it('reads the resolved store theme and follows base switches/partial merges', async () => {
    const fake = new FakeEngine();
    const { rerender } = render(
      <Graph engine={() => fake} data={pathSnapshot}>
        <ThemeProbe />
      </Graph>,
    );
    await flush();
    // Default dark base.
    expect(screen.getByTestId('theme').textContent).toBe('#0b0e14|#94a3b8');

    // Partial over the light base.
    rerender(
      <Graph engine={() => fake} data={pathSnapshot} theme={{ base: 'light', accent: '#ff00ff' }}>
        <ThemeProbe />
      </Graph>,
    );
    expect(screen.getByTestId('theme').textContent).toBe('#ffffff|#475569');

    // v0.1 {background} shorthand merges over the dark base.
    rerender(
      <Graph engine={() => fake} data={pathSnapshot} theme={{ background: '#123456' }}>
        <ThemeProbe />
      </Graph>,
    );
    expect(screen.getByTestId('theme').textContent).toBe('#123456|#94a3b8');
  });
});

describe('entry points', () => {
  it('GraphLegend and useGraphTheme are importable', () => {
    expect(typeof GraphLegend).toBe('function');
    expect(typeof useGraphTheme).toBe('function');
  });
});
