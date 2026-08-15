/**
 * groups wiring through the React binding.
 *
 * Covers: the `groups` prop lane (structural diff — equal literals never
 * re-forward), controlled ops firing onGroupsChange intents that the
 * host reflects back, uncontrolled handle ops writing + notifying, the
 * typed onGroupClick/onMetaEdgeClick callbacks, and the
 * `groupBy` prop pass-through with its derived notification.
 */

import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createRef } from 'react';
import type { GraphNode, GraphSnapshot, ResolvedGroup } from '@modernrelay/orbit-core';
import { groupByDerivedId } from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { Graph } from '../src/index';
import type { GraphHandle } from '../src/index';

/** a—b plus c: collapsing {b,c} → scene points [a, super@1], links [meta@0]. */
const snapshot: GraphSnapshot = {
  datasetKey: 'ds',
  sourceRevision: 1,
  nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  edges: [{ source: 'a', target: 'b' }],
};

const GROUP_BC = { id: 'g', memberIds: ['b', 'c'], collapsed: true } as const;

async function flush(): Promise<void> {
  await act(async () => {});
}

describe('<Graph> groups wiring', () => {
  it('forwards the groups prop, rewrites the scene, and never re-forwards an equal literal', async () => {
    const fake = new FakeEngine();
    const { rerender } = render(
      <Graph engine={() => fake} data={snapshot} groups={[{ ...GROUP_BC }]} />,
    );
    await flush();

    const collapsed = fake.lastCommit!;
    expect(collapsed.structure?.pointCount).toBe(2); // physical a + super
    const commitsAfterMount = fake.commits.length;

    // A NEW-but-structurally-equal literal must not re-publish or commit.
    rerender(<Graph engine={() => fake} data={snapshot} groups={[{ ...GROUP_BC }]} />);
    await flush();
    expect(fake.commits.length).toBe(commitsAfterMount);

    // A structural change (collapsed flips) re-forwards.
    rerender(
      <Graph engine={() => fake} data={snapshot} groups={[{ ...GROUP_BC, collapsed: false }]} />,
    );
    await flush();
    expect(fake.commits.length).toBe(commitsAfterMount + 1);
    expect(fake.lastCommit!.structure?.pointCount).toBe(3); // members returned
  });

  it('controlled mode: handle ops fire onGroupsChange intents; reflecting the prop applies them', async () => {
    const fake = new FakeEngine();
    const onGroupsChange = vi.fn();
    const ref = createRef<GraphHandle>();
    const { rerender } = render(
      <Graph
        ref={ref}
        engine={() => fake}
        data={snapshot}
        groups={[{ ...GROUP_BC }]}
        onGroupsChange={onGroupsChange}
      />,
    );
    await flush();
    const storeBefore = ref.current!.instance.store.getState().groups;

    act(() => {
      ref.current!.ungroup('g');
    });
    // Intent only: the resolved next array, no store write.
    expect(onGroupsChange).toHaveBeenCalledTimes(1);
    expect(onGroupsChange).toHaveBeenCalledWith([]);
    expect(ref.current!.instance.store.getState().groups).toBe(storeBefore);

    // The host reflects the intent back through the prop — now it applies.
    rerender(
      <Graph
        ref={ref}
        engine={() => fake}
        data={snapshot}
        groups={[]}
        onGroupsChange={onGroupsChange}
      />,
    );
    await flush();
    expect(ref.current!.instance.store.getState().groups).toEqual([]);
  });

  it('uncontrolled mode: handle ops write and onGroupsChange notifies with the store array', async () => {
    const fake = new FakeEngine();
    const onGroupsChange = vi.fn();
    const ref = createRef<GraphHandle>();
    render(
      <Graph ref={ref} engine={() => fake} data={snapshot} onGroupsChange={onGroupsChange} />,
    );
    await flush();

    act(() => {
      ref.current!.groupNodes({ ...GROUP_BC });
    });
    const expected: readonly ResolvedGroup[] = [
      { id: 'g', memberIds: ['b', 'c'], collapsed: true, derived: false },
    ];
    expect(onGroupsChange).toHaveBeenCalledTimes(1);
    expect(onGroupsChange).toHaveBeenCalledWith(expected);
    expect(ref.current!.instance.store.getState().groups).toEqual(expected);
    expect(fake.lastCommit!.structure?.pointCount).toBe(2);

    act(() => {
      ref.current!.setGroupCollapsed('g', false);
    });
    expect(ref.current!.instance.store.getState().groups[0]!.collapsed).toBe(false);
    expect(fake.lastCommit!.structure?.pointCount).toBe(3);
  });

  it('onGroupClick / onMetaEdgeClick fire with typed payloads from engine hits', async () => {
    const fake = new FakeEngine();
    const onNodeClick = vi.fn();
    const onGroupClick = vi.fn();
    const onEdgeClick = vi.fn();
    const onMetaEdgeClick = vi.fn();
    const ref = createRef<GraphHandle>();
    render(
      <Graph
        ref={ref}
        engine={() => fake}
        data={snapshot}
        groups={[{ ...GROUP_BC }]}
        onNodeClick={onNodeClick}
        onGroupClick={onGroupClick}
        onEdgeClick={onEdgeClick}
        onMetaEdgeClick={onMetaEdgeClick}
      />,
    );
    await flush();

    act(() => {
      fake.injectPointClick(1); // the super-node slot
    });
    expect(onNodeClick).not.toHaveBeenCalled();
    expect(onGroupClick).toHaveBeenCalledTimes(1);
    const group = onGroupClick.mock.calls[0]![0].group as ResolvedGroup;
    expect(group.id).toBe('g');
    expect(group.memberIds).toEqual(['b', 'c']);
    expect(ref.current!.instance.store.getState().selection.groupIds).toEqual(['g']);

    act(() => {
      fake.injectLinkClick(0); // the meta-edge slot (rerouted a→b)
    });
    expect(onEdgeClick).not.toHaveBeenCalled();
    expect(onMetaEdgeClick).toHaveBeenCalledTimes(1);
    expect(onMetaEdgeClick.mock.calls[0]![0].metaEdge).toMatchObject({
      source: 'a',
      target: 'g',
      count: 1,
    });
  });

  it('groupBy prop derives read-only groups and notifies through onGroupsChange', async () => {
    const fake = new FakeEngine();
    const onGroupsChange = vi.fn();
    const ref = createRef<GraphHandle>();
    const typed: GraphSnapshot<{ kind: string }> = {
      datasetKey: 'ds',
      sourceRevision: 1,
      nodes: [
        { id: 'a', attrs: { kind: 'x' } },
        { id: 'b', attrs: { kind: 'x' } },
        { id: 'c', attrs: { kind: 'y' } },
      ],
      edges: [],
    };
    const by = (n: GraphNode<{ kind: string }>): string | null => n.attrs?.kind ?? null;
    // Mount without groupBy first: event subscriptions attach in a passive
    // effect, so a notification fired during the mount commit would predate
    // them (the same holds for every instance event in the binding).
    const { rerender } = render(
      <Graph<{ kind: string }, Record<string, unknown>>
        ref={ref as never}
        engine={() => fake}
        data={typed}
        onGroupsChange={onGroupsChange}
      />,
    );
    await flush();
    rerender(
      <Graph<{ kind: string }, Record<string, unknown>>
        ref={ref as never}
        engine={() => fake}
        data={typed}
        groupBy={{ by }}
        onGroupsChange={onGroupsChange}
      />,
    );
    await flush();

    // Derivation alone: derived array published + notified, ZERO rewrites.
    const groups = (ref.current as unknown as GraphHandle).instance.store.getState().groups;
    expect(groups.map((g) => g.id)).toEqual([groupByDerivedId('x'), groupByDerivedId('y')]);
    expect(groups.every((g) => g.derived && !g.collapsed)).toBe(true);
    expect(onGroupsChange).toHaveBeenCalledWith(groups);
    expect(fake.lastCommit!.structure?.pointCount).toBe(3); // unchanged scene

    // The one allowed op under groupBy: collapse toggles the residue.
    act(() => {
      (ref.current as unknown as GraphHandle).setGroupCollapsed(groupByDerivedId('x'), true);
    });
    expect(fake.lastCommit!.structure?.pointCount).toBe(2); // c + super(x)
  });
});

describe('<Graph> persistent pins wiring', () => {
  it('forwards pinnedNodeIds, latches controlled, and routes handle ops as intents', async () => {
    const fake = new FakeEngine();
    const handleRef = createRef<GraphHandle>();
    const onPinnedChange = vi.fn();
    const { rerender } = render(
      <Graph
        ref={handleRef}
        engine={() => fake}
        data={snapshot}
        pinnedNodeIds={['a']}
        onPinnedChange={onPinnedChange}
      />,
    );
    await flush();

    const pinCalls = () => fake.calls.filter((c) => c.method === 'setPinnedIndices');
    expect(pinCalls().length).toBeGreaterThan(0);
    expect(pinCalls()[pinCalls().length - 1]!.args[0]).toEqual([0]); // 'a' at slot 0

    // Equal-element literal never re-forwards.
    const before = pinCalls().length;
    rerender(
      <Graph
        ref={handleRef}
        engine={() => fake}
        data={snapshot}
        pinnedNodeIds={['a']}
        onPinnedChange={onPinnedChange}
      />,
    );
    await flush();
    expect(pinCalls().length).toBe(before);

    // CONTROLLED: the handle op fires the intent and writes nothing.
    onPinnedChange.mockClear();
    act(() => {
      handleRef.current!.unpinNodes(['a']);
    });
    expect(onPinnedChange).toHaveBeenCalledTimes(1);
    expect(onPinnedChange.mock.calls[0]![0]).toEqual([]);
    expect(pinCalls()[pinCalls().length - 1]!.args[0]).toEqual([0]); // unchanged

    // The host reflects the intent back.
    rerender(
      <Graph
        ref={handleRef}
        engine={() => fake}
        data={snapshot}
        pinnedNodeIds={[]}
        onPinnedChange={onPinnedChange}
      />,
    );
    await flush();
    expect(pinCalls()[pinCalls().length - 1]!.args[0]).toBeNull();
  });

  it('uncontrolled handle ops write the slice and notify with the applied set', async () => {
    const fake = new FakeEngine();
    const handleRef = createRef<GraphHandle>();
    const onPinnedChange = vi.fn();
    render(
      <Graph
        ref={handleRef}
        engine={() => fake}
        data={snapshot}
        onPinnedChange={onPinnedChange}
      />,
    );
    await flush();

    act(() => {
      handleRef.current!.pinNodes(['b']);
    });
    expect(onPinnedChange).toHaveBeenCalledTimes(1);
    expect(onPinnedChange.mock.calls[0]![0]).toEqual(['b']);
    const pinCalls = fake.calls.filter((c) => c.method === 'setPinnedIndices');
    expect(pinCalls[pinCalls.length - 1]!.args[0]).toEqual([1]); // 'b' at slot 1
  });
});
