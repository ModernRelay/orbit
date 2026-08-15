/**
 * Lasso overlay tests — jsdom + FakeEngine (screen == space, seeded grid
 * positions: a(0,0), b(10,0), c(20,0)).
 *
 * jsdom has no PointerEvent capture machinery, so pointer events are
 * dispatched as MouseEvents with the pointer type name (React dispatches on
 * the event type) and set/releasePointerCapture are stubbed per test.
 */

import { describe, expect, it } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createRef } from 'react';
import type { GraphSnapshot, NodeId } from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { Graph } from '../src/index';
import type { GraphHandle } from '../src/index';

const snapshot: GraphSnapshot = {
  datasetKey: 'ds',
  sourceRevision: 1,
  nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  edges: [{ source: 'a', target: 'b' }],
};

/** Triangle in FakeEngine screen coords covering b(10,0) and c(20,0), not a(0,0). */
const TRIANGLE: readonly [number, number][] = [
  [5, -5],
  [50, -5],
  [5, 20],
];

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

/** Instance-level pointer-capture stub; returns the live captured-id set. */
function stubPointerCapture(el: HTMLElement): Set<number> {
  const active = new Set<number>();
  Object.assign(el, {
    setPointerCapture: (id: number): void => {
      active.add(id);
    },
    releasePointerCapture: (id: number): void => {
      active.delete(id);
    },
    hasPointerCapture: (id: number): boolean => active.has(id),
  });
  return active;
}

interface Setup {
  fake: FakeEngine;
  handle: GraphHandle;
  overlay: HTMLElement;
  captured: Set<number>;
  container: HTMLElement;
}

async function setup(): Promise<Setup> {
  const fake = new FakeEngine();
  const handleRef = createRef<GraphHandle>();
  const { container } = render(<Graph ref={handleRef} engine={() => fake} data={snapshot} />);
  await act(async () => {});
  const overlay = container.querySelector<HTMLElement>('[data-orbit-lasso]');
  expect(overlay).not.toBeNull();
  return {
    fake,
    handle: handleRef.current!,
    overlay: overlay!,
    captured: stubPointerCapture(overlay!),
    container,
  };
}

function selectedNodeIds(handle: GraphHandle): readonly NodeId[] {
  return handle.instance.store.getState().selection.nodeIds;
}

function polygonCalls(fake: FakeEngine): readonly unknown[][] {
  return fake.calls.filter((c) => c.method === 'pointsInPolygon').map((c) => [...c.args]);
}

/** Shift+drag the TRIANGLE polygon; `metaKey` applies to the release. */
function dragTriangle(overlay: HTMLElement, metaKey: boolean): void {
  fireEvent.keyDown(window, { key: 'Shift' });
  firePointer(overlay, 'pointerdown', { pointerId: 1, clientX: 5, clientY: -5, shiftKey: true });
  firePointer(overlay, 'pointermove', { pointerId: 1, clientX: 50, clientY: -5, shiftKey: true });
  firePointer(overlay, 'pointermove', { pointerId: 1, clientX: 5, clientY: 20, shiftKey: true });
  firePointer(overlay, 'pointerup', { pointerId: 1, clientX: 5, clientY: 20, metaKey });
  fireEvent.keyUp(window, { key: 'Shift' });
}

describe('<Lasso>', () => {
  it('is pointer-inert unless Shift is held (or a drag is in progress)', async () => {
    const { overlay } = await setup();
    expect(overlay.style.pointerEvents).toBe('none');

    fireEvent.keyDown(window, { key: 'Shift' });
    expect(overlay.style.pointerEvents).toBe('auto');

    fireEvent.keyUp(window, { key: 'Shift' });
    expect(overlay.style.pointerEvents).toBe('none');

    // Mid-drag the overlay stays active even after Shift is released.
    fireEvent.keyDown(window, { key: 'Shift' });
    firePointer(overlay, 'pointerdown', { pointerId: 1, clientX: 0, clientY: 0, shiftKey: true });
    fireEvent.keyUp(window, { key: 'Shift' });
    expect(overlay.style.pointerEvents).toBe('auto');
    firePointer(overlay, 'pointerup', { pointerId: 1, clientX: 0, clientY: 0 });
    expect(overlay.style.pointerEvents).toBe('none');
  });

  it('ignores pointerdown without Shift', async () => {
    const { overlay, container } = await setup();
    firePointer(overlay, 'pointerdown', { pointerId: 1, clientX: 5, clientY: -5 });
    expect(container.querySelector('[data-orbit-lasso-preview]')).toBeNull();
  });

  it('draws an SVG preview and resolves the polygon through pointsInPolygon on release', async () => {
    const { fake, handle, overlay, captured, container } = await setup();

    fireEvent.keyDown(window, { key: 'Shift' });
    firePointer(overlay, 'pointerdown', { pointerId: 1, clientX: 5, clientY: -5, shiftKey: true });
    expect(captured.has(1)).toBe(true);
    firePointer(overlay, 'pointermove', { pointerId: 1, clientX: 50, clientY: -5, shiftKey: true });

    // Preview path over the committed points (the throttle appended the move).
    const path = container.querySelector('[data-orbit-lasso-preview] path');
    expect(path).not.toBeNull();
    expect(path!.getAttribute('d')).toBe('M 5 -5 L 50 -5');

    // Same-frame moves coalesce into `pending`; release commits the trailing point.
    firePointer(overlay, 'pointermove', { pointerId: 1, clientX: 5, clientY: 20, shiftKey: true });
    firePointer(overlay, 'pointerup', { pointerId: 1, clientX: 5, clientY: 20 });

    expect(polygonCalls(fake)).toEqual([[TRIANGLE]]);
    expect(selectedNodeIds(handle)).toEqual(['b', 'c']);

    // Clean release: no capture, no preview, overlay inert after Shift up.
    expect(captured.size).toBe(0);
    expect(container.querySelector('[data-orbit-lasso-preview]')).toBeNull();
    fireEvent.keyUp(window, { key: 'Shift' });
    expect(overlay.style.pointerEvents).toBe('none');
  });

  it('meta-release unions with the existing selection (additive)', async () => {
    const { handle, overlay } = await setup();
    act(() => {
      handle.setSelection(['a']);
    });

    dragTriangle(overlay, true);
    expect(selectedNodeIds(handle)).toEqual(['a', 'b', 'c']); // accepted-base order

    // plain release replaces
    dragTriangle(overlay, false);
    expect(selectedNodeIds(handle)).toEqual(['b', 'c']);
  });

  it('a release with fewer than 3 points selects nothing', async () => {
    const { fake, handle, overlay, captured } = await setup();
    fireEvent.keyDown(window, { key: 'Shift' });
    firePointer(overlay, 'pointerdown', { pointerId: 1, clientX: 5, clientY: -5, shiftKey: true });
    firePointer(overlay, 'pointermove', { pointerId: 1, clientX: 50, clientY: -5, shiftKey: true });
    firePointer(overlay, 'pointerup', { pointerId: 1, clientX: 50, clientY: -5 });

    expect(polygonCalls(fake)).toEqual([]);
    expect(selectedNodeIds(handle)).toEqual([]);
    expect(captured.size).toBe(0);
  });

  it('pointercancel aborts: no selection, no capture, no preview', async () => {
    const { fake, handle, overlay, captured, container } = await setup();
    fireEvent.keyDown(window, { key: 'Shift' });
    firePointer(overlay, 'pointerdown', { pointerId: 1, clientX: 5, clientY: -5, shiftKey: true });
    firePointer(overlay, 'pointermove', { pointerId: 1, clientX: 50, clientY: -5, shiftKey: true });
    firePointer(overlay, 'pointercancel', { pointerId: 1 });

    expect(captured.size).toBe(0);
    expect(container.querySelector('[data-orbit-lasso-preview]')).toBeNull();

    // A stray release after the abort is inert.
    firePointer(overlay, 'pointerup', { pointerId: 1, clientX: 5, clientY: 20 });
    expect(polygonCalls(fake)).toEqual([]);
    expect(selectedNodeIds(handle)).toEqual([]);
  });

  it('Escape aborts the drag in progress', async () => {
    const { fake, handle, overlay, captured, container } = await setup();
    fireEvent.keyDown(window, { key: 'Shift' });
    firePointer(overlay, 'pointerdown', { pointerId: 1, clientX: 5, clientY: -5, shiftKey: true });
    firePointer(overlay, 'pointermove', { pointerId: 1, clientX: 50, clientY: -5, shiftKey: true });
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(captured.size).toBe(0);
    expect(container.querySelector('[data-orbit-lasso-preview]')).toBeNull();

    firePointer(overlay, 'pointerup', { pointerId: 1, clientX: 5, clientY: 20 });
    expect(polygonCalls(fake)).toEqual([]);
    expect(selectedNodeIds(handle)).toEqual([]);

    // The gesture works again after an abort.
    dragTriangle(overlay, false);
    expect(selectedNodeIds(handle)).toEqual(['b', 'c']);
  });

  it('enableLasso={false} renders no overlay', async () => {
    const fake = new FakeEngine();
    const { container } = render(<Graph engine={() => fake} data={snapshot} enableLasso={false} />);
    await act(async () => {});
    expect(container.querySelector('[data-orbit-lasso]')).toBeNull();
  });
});
