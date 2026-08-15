/**
 * typed event dispatcher: synchronous registration-order
 * chains, exception isolation with a 'listener-error' diagnostic, and
 * preventDefault cancelling ONLY the built-in follow-up (click-selection,
 * drag-pin) — never other listeners.
 */

import { describe, expect, it } from 'vitest';

import { callsOf, container, makeInstance, snap } from './helpers';
import type { InstanceHarness } from './helpers';
import type { FakeEngine } from '../src/testing/index';

interface ReadyHarness extends InstanceHarness {
  engine: FakeEngine;
}

async function setup(): Promise<ReadyHarness> {
  const h = makeInstance();
  await h.instance.attach(container);
  h.instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c'], [['a', 'b']]) });
  return { ...h, engine: h.engines[0]! };
}

describe('dispatcher ordering & synchrony', () => {
  it('runs listeners synchronously in registration order', async () => {
    const { instance, engine } = await setup();
    const order: string[] = [];
    instance.on('nodeClick', () => order.push('first'));
    instance.on('nodeClick', () => order.push('second'));
    instance.on('nodeClick', () => order.push('third'));

    engine.injectPointClick(0);
    // Synchronous: the chain and the built-in follow-up completed before
    // injectPointClick returned.
    expect(order).toEqual(['first', 'second', 'third']);
    expect(instance.store.getState().selection.nodeIds).toEqual(['a']);
  });

  it('built-in follow-up runs AFTER the whole listener chain', async () => {
    const { instance, engine } = await setup();
    const selectionDuringChain: Array<readonly string[]> = [];
    instance.on('nodeClick', () => {
      selectionDuringChain.push(instance.store.getState().selection.nodeIds);
    });
    const selectionOrder: string[] = [];
    instance.on('nodeClick', () => selectionOrder.push('click'));
    instance.on('selectionChange', () => selectionOrder.push('selectionChange'));

    engine.injectPointClick(1);
    expect(selectionDuringChain).toEqual([[]]); // not yet applied mid-chain
    expect(selectionOrder).toEqual(['click', 'selectionChange']);
  });

  it('a listener unsubscribing mid-emit cannot skip a peer', async () => {
    const { instance, engine } = await setup();
    const order: string[] = [];
    const off = instance.on('nodeClick', () => {
      order.push('first');
      off();
    });
    instance.on('nodeClick', () => order.push('second'));

    engine.injectPointClick(0);
    expect(order).toEqual(['first', 'second']);
    engine.injectPointClick(0);
    expect(order).toEqual(['first', 'second', 'second']);
  });
});

describe('dispatcher exception isolation', () => {
  it("isolates a throwing listener: one 'listener-error' diagnostic, chain and built-in continue", async () => {
    const { instance, engine } = await setup();
    const order: string[] = [];
    instance.on('nodeClick', () => {
      order.push('thrower');
      throw new Error('listener exploded');
    });
    instance.on('nodeClick', () => order.push('survivor'));

    expect(() => engine.injectPointClick(0)).not.toThrow();

    expect(order).toEqual(['thrower', 'survivor']);
    // Built-in click-selection still applied (a throw is not preventDefault).
    expect(instance.store.getState().selection.nodeIds).toEqual(['a']);

    const diags = instance.getDiagnostics().filter((d) => d.code === 'listener-error');
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe('error');
    expect(diags[0]!.message).toMatch(/nodeClick/);
    expect(diags[0]!.message).toMatch(/listener exploded/);

    // Status untouched; the dispatcher stays live for later events.
    expect(instance.store.getState().status).toBe('ready');
    engine.injectPointClick(1);
    expect(order).toEqual(['thrower', 'survivor', 'thrower', 'survivor']);
    expect(instance.getDiagnostics().filter((d) => d.code === 'listener-error')).toHaveLength(2);
  });

  it('a throwing non-Error value is stringified into the diagnostic', async () => {
    const { instance, engine } = await setup();
    instance.on('backgroundClick', () => {
      throw 'plain string failure';
    });
    engine.injectPointClick(null);
    const diag = instance.getDiagnostics().find((d) => d.code === 'listener-error');
    expect(diag).toBeDefined();
    expect(diag!.message).toMatch(/plain string failure/);
  });
});

describe('preventDefault cancels ONLY the built-in follow-up', () => {
  it('nodeClick: selection not applied, selectionChange not emitted, later listeners still run', async () => {
    const { instance, engine } = await setup();
    const order: string[] = [];
    const selectionEvents: unknown[] = [];
    let prevent = true;
    instance.on('selectionChange', (p) => selectionEvents.push(p));
    instance.on('nodeClick', (_p, control) => {
      order.push('preventer');
      if (prevent) control.preventDefault();
    });
    instance.on('nodeClick', () => order.push('after'));
    const pushesBefore = callsOf(engine, 'setSelectedIndices').length;

    engine.injectPointClick(0);

    expect(order).toEqual(['preventer', 'after']); // other listeners still ran
    expect(instance.store.getState().selection.nodeIds).toEqual([]);
    expect(selectionEvents).toHaveLength(0);
    expect(callsOf(engine, 'setSelectedIndices')).toHaveLength(pushesBefore);

    // A later un-prevented click applies normally.
    prevent = false;
    engine.injectPointClick(1);
    expect(instance.store.getState().selection.nodeIds).toEqual(['b']);
    expect(selectionEvents).toHaveLength(1);
  });

  it('backgroundClick: the clear is cancelled, all namespaces survive', async () => {
    const { instance, engine } = await setup();
    instance.setSelection({ nodeIds: ['a'], edgeIds: ['a→b#0'], groupIds: [] });
    instance.on('backgroundClick', (_p, control) => control.preventDefault());

    engine.injectPointClick(null);
    expect(instance.store.getState().selection).toEqual({
      nodeIds: ['a'],
      edgeIds: ['a→b#0'],
      groupIds: [],
    });
  });

  it('nodeDragEnd: the drag-pin is cancelled; without preventDefault the node pins', async () => {
    const { instance, engine } = await setup();
    const seen: Array<{ id: string; x: number; y: number }> = [];
    let prevent = true;
    instance.on('nodeDragEnd', (p, control) => {
      seen.push({ id: p.node.id, x: p.x, y: p.y });
      if (prevent) control.preventDefault();
    });

    engine.injectDragEnd(1, 33, 44);
    expect(seen).toEqual([{ id: 'b', x: 33, y: 44 }]);
    expect(instance.store.getState().pins.size).toBe(0);
    expect(callsOf(engine, 'setPinnedIndices')).toHaveLength(0);

    prevent = false;
    engine.injectDragEnd(1, 35, 46);
    expect(instance.store.getState().pins.get('b')).toEqual([35, 46]);
    expect(callsOf(engine, 'setPinnedIndices').at(-1)!.args).toEqual([[1]]);
    expect(engine.pinnedIndices).toEqual([1]);
  });

  it('preventDefault scope is per-emit: it never leaks into the next event', async () => {
    const { instance, engine } = await setup();
    let once = true;
    instance.on('nodeClick', (_p, control) => {
      if (once) {
        once = false;
        control.preventDefault();
      }
    });
    engine.injectPointClick(0);
    expect(instance.store.getState().selection.nodeIds).toEqual([]);
    engine.injectPointClick(0);
    expect(instance.store.getState().selection.nodeIds).toEqual(['a']);
  });
});

describe('drag/link event mapping', () => {
  it('nodeDragStart carries the typed node object and has no built-in follow-up', async () => {
    const { instance, engine } = await setup();
    const starts: string[] = [];
    instance.on('nodeDragStart', (p) => starts.push(p.node.id));

    engine.injectDragStart(2);
    expect(starts).toEqual(['c']);
    expect(instance.store.getState().pins.size).toBe(0);
  });

  it('edgeClick/edgeHover map link indices to accepted edge objects and hover state', async () => {
    const { instance, engine } = await setup();
    const clicks: string[] = [];
    const hovers: Array<string | null> = [];
    instance.on('edgeClick', (p) => clicks.push(p.edge.id));
    instance.on('edgeHover', (p) => hovers.push(p.edge === null ? null : p.edge.id));

    engine.injectLinkHover(0);
    expect(instance.store.getState().hover.edgeId).toBe('a→b#0');
    engine.injectLinkClick(0);
    expect(clicks).toEqual(['a→b#0']);
    engine.injectLinkHover(null);
    expect(instance.store.getState().hover.edgeId).toBeNull();
    expect(hovers).toEqual(['a→b#0', null]);
  });

  it('node hover and edge hover occupy independent hover keys', async () => {
    const { instance, engine } = await setup();
    engine.injectPointHover(0);
    engine.injectLinkHover(0);
    expect(instance.store.getState().hover).toEqual({ nodeId: 'a', edgeId: 'a→b#0' });
    engine.injectPointHover(null);
    expect(instance.store.getState().hover).toEqual({ nodeId: null, edgeId: 'a→b#0' });
  });
});

describe('modifier wiring', () => {
  it('nodeClick carries metaKey true when either metaKey or shiftKey is held', async () => {
    const { instance, engine } = await setup();
    const metas: Array<boolean | undefined> = [];
    instance.on('nodeClick', (p) => metas.push(p.metaKey));

    engine.injectPointClick(0);
    engine.injectPointClick(0, { metaKey: true, shiftKey: false });
    engine.injectPointClick(0, { metaKey: false, shiftKey: true });
    engine.injectPointClick(0, { metaKey: false, shiftKey: false });

    expect(metas).toEqual([false, true, true, false]);
  });
});
