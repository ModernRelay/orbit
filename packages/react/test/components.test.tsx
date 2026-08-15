/**
 * Provided-component tests — <GraphToolbar>,
 * <GraphContextMenu>, <GraphSelectionActions> composed inside a real <Graph>
 * over a FakeEngine (jsdom).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createRef } from 'react';
import type { ReactNode } from 'react';
import type { GraphInstance, GraphSnapshot } from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { Graph } from '../src/index';
import type { GraphHandle } from '../src/index';
import { GraphToolbar } from '../src/components/Toolbar';
import { GraphContextMenu } from '../src/components/ContextMenu';
import type { GraphContextMenuItem, GraphContextMenuTarget } from '../src/components/ContextMenu';
import { GraphSelectionActions } from '../src/components/SelectionActions';
import { GraphSimControls } from '../src/components/SimControls';
import { GraphMinimap } from '../src/components/Minimap';

const snapshot: GraphSnapshot = {
  datasetKey: 'ds',
  sourceRevision: 1,
  nodes: [{ id: 'a', attrs: { label: 'Alpha' } }, { id: 'b' }, { id: 'c' }],
  edges: [{ source: 'a', target: 'b' }],
};

/** Flush the engine mount promise (and any deferred microtasks) inside act. */
async function flush(): Promise<void> {
  await act(async () => {});
}

interface Mounted {
  fake: FakeEngine;
  instance: GraphInstance<Record<string, unknown>, Record<string, unknown>>;
  container: HTMLElement;
}

async function mountGraph(
  children: ReactNode,
  opts: { engine?: FakeEngine; data?: GraphSnapshot } = {},
): Promise<Mounted> {
  const fake = opts.engine ?? new FakeEngine();
  const handleRef = createRef<GraphHandle>();
  const { container } = render(
    <Graph ref={handleRef} engine={() => fake} data={opts.data ?? snapshot}>
      {children}
    </Graph>,
  );
  await flush();
  await flush(); // second pass drains the capability-sniff promise chain
  return { fake, instance: handleRef.current!.instance, container };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// <GraphToolbar>
// ---------------------------------------------------------------------------

describe('<GraphToolbar>', () => {
  const btn = (container: HTMLElement, action: string): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>(`[data-orbit-toolbar-button="${action}"]`)!;

  it('camera buttons drive the instance camera (recorded engine cameraCalls)', async () => {
    const { fake, container } = await mountGraph(<GraphToolbar />);
    const before = fake.cameraCalls.length;

    fireEvent.click(btn(container, 'zoom-in'));
    fireEvent.click(btn(container, 'zoom-out'));
    fireEvent.click(btn(container, 'fit-view'));
    fireEvent.click(btn(container, 'reset-view'));

    const cams = fake.cameraCalls.slice(before);
    expect(cams.map((c) => c.method)).toEqual(['zoom', 'zoom', 'fitView', 'setViewport']);
    expect(cams[0]!.args[0] as number).toBeGreaterThan(1);
    expect(cams[1]!.args[0] as number).toBeLessThan(1);
    expect(cams[3]!.args[0]).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('every button is a keyboard-focusable <button> with an aria-label', async () => {
    const { container } = await mountGraph(<GraphToolbar />);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-orbit-toolbar-button]')];
    expect(buttons.length).toBe(7);
    for (const b of buttons) {
      expect(b.tagName).toBe('BUTTON');
      expect(b.getAttribute('aria-label')).toBeTruthy();
    }
    const zoomIn = buttons.find((b) => b.dataset['orbitToolbarButton'] === 'zoom-in')!;
    zoomIn.focus();
    expect(document.activeElement).toBe(zoomIn);
  });

  it('sim toggle reflects store simulationRunning and drives pause/resume', async () => {
    const { fake, instance, container } = await mountGraph(<GraphToolbar />);
    // Force layout + data restart → running after the ready replay.
    expect(instance.isSimulationRunning()).toBe(true);
    expect(btn(container, 'simulation').getAttribute('aria-label')).toBe('Pause simulation');

    fireEvent.click(btn(container, 'simulation'));
    expect(fake.calls.some((c) => c.method === 'pause')).toBe(true);
    expect(instance.isSimulationRunning()).toBe(false);
    expect(btn(container, 'simulation').getAttribute('aria-label')).toBe('Resume simulation');

    fireEvent.click(btn(container, 'simulation'));
    expect(instance.isSimulationRunning()).toBe(true);
    expect(btn(container, 'simulation').getAttribute('aria-label')).toBe('Pause simulation');

    // Store-driven flip (engine settle), not a button click.
    act(() => {
      fake.injectSimulationEnd();
    });
    expect(btn(container, 'simulation').getAttribute('aria-label')).toBe('Resume simulation');
  });

  it('screenshot no-op-disables after the capability sniff resolves null', async () => {
    // FakeEngine default: captureScreenshot resolves null (unsupported).
    const { container } = await mountGraph(<GraphToolbar />);
    expect(btn(container, 'screenshot').disabled).toBe(true);
  });

  it('screenshot downloads a captured blob via an object URL', async () => {
    const blob = new Blob(['png-bytes'], { type: 'image/png' });
    const fake = new FakeEngine({ screenshot: blob });
    const createObjectURL = vi.fn(() => 'blob:orbit-shot');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    try {
      const { container } = await mountGraph(<GraphToolbar />, { engine: fake });
      expect(btn(container, 'screenshot').disabled).toBe(false);

      fireEvent.click(btn(container, 'screenshot'));
      await flush();

      expect(createObjectURL).toHaveBeenCalledWith(blob);
      expect(anchorClick).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:orbit-shot');
      expect(btn(container, 'screenshot').disabled).toBe(false);
    } finally {
      anchorClick.mockRestore();
      delete (URL as unknown as Record<string, unknown>)['createObjectURL'];
      delete (URL as unknown as Record<string, unknown>)['revokeObjectURL'];
    }
  });

  it('fullscreen requests fullscreen on the containerRef element', async () => {
    const target = document.createElement('div');
    const request = vi.fn(() => Promise.resolve());
    target.requestFullscreen = request;
    const { container } = await mountGraph(<GraphToolbar containerRef={{ current: target }} />);

    fireEvent.click(btn(container, 'fullscreen'));
    expect(request).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// <GraphContextMenu>
// ---------------------------------------------------------------------------

describe('<GraphContextMenu>', () => {
  const menuOf = (c: HTMLElement): HTMLElement | null =>
    c.querySelector<HTMLElement>('[data-orbit-context-menu]');
  const itemOf = (c: HTMLElement, id: string): HTMLButtonElement | null =>
    c.querySelector<HTMLButtonElement>(`[data-orbit-context-menu-item="${id}"]`);

  it('opens on the contextMenu event at the given container-relative coords', async () => {
    const { fake, container } = await mountGraph(<GraphContextMenu />);
    expect(menuOf(container)).toBeNull();

    act(() => {
      fake.injectContextMenu(0, [40, 60]);
    });

    const menu = menuOf(container)!;
    expect(menu).not.toBeNull();
    expect(menu.style.position).toBe('absolute');
    expect(menu.style.left).toBe('40px');
    expect(menu.style.top).toBe('60px');
    expect(container.querySelector('[data-orbit-context-menu-heading]')!.textContent).toBe(
      'Alpha',
    );
  });

  it('default node items call the matching instance mutators', async () => {
    const { fake, instance, container } = await mountGraph(<GraphContextMenu />);
    const focusNode = vi.spyOn(instance, 'focusNode').mockImplementation(() => []);
    const selectNeighbors = vi.spyOn(instance, 'selectNeighbors').mockImplementation(() => {});
    const pinNode = vi.spyOn(instance, 'pinNode').mockImplementation(() => {});
    const hideNodes = vi.spyOn(instance, 'hideNodes').mockImplementation(() => {});
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    try {
      const open = (): void => {
        act(() => {
          fake.injectContextMenu(0, [10, 10]);
        });
      };

      open();
      fireEvent.click(itemOf(container, 'focus')!);
      expect(focusNode).toHaveBeenCalledWith('a');
      expect(menuOf(container)).toBeNull(); // activation closes the menu

      open();
      fireEvent.click(itemOf(container, 'select-neighbors')!);
      expect(selectNeighbors).toHaveBeenCalledWith('a');

      open();
      fireEvent.click(itemOf(container, 'pin')!);
      expect(pinNode).toHaveBeenCalledWith('a');

      open();
      fireEvent.click(itemOf(container, 'hide')!);
      expect(hideNodes).toHaveBeenCalledWith(['a']);

      open();
      fireEvent.click(itemOf(container, 'copy-id')!);
      expect(writeText).toHaveBeenCalledWith('a');
      await flush();
    } finally {
      delete (navigator as unknown as Record<string, unknown>)['clipboard'];
    }
  });

  it('pin flips to unpin when the node is pinned', async () => {
    const { fake, instance, container } = await mountGraph(<GraphContextMenu />);
    const open = (): void => {
      act(() => {
        fake.injectContextMenu(0, [0, 0]);
      });
    };

    open();
    expect(itemOf(container, 'pin')).not.toBeNull();
    expect(itemOf(container, 'unpin')).toBeNull();

    act(() => {
      instance.pinNode('a', [5, 5]);
    });
    open();
    expect(itemOf(container, 'pin')).toBeNull();
    const unpinNode = vi.spyOn(instance, 'unpinNode').mockImplementation(() => {});
    fireEvent.click(itemOf(container, 'unpin')!);
    expect(unpinNode).toHaveBeenCalledWith('a');
  });

  it('fold flips to unfold once the node is folded', async () => {
    const { fake, instance, container } = await mountGraph(<GraphContextMenu />);
    const open = (): void => {
      act(() => {
        fake.injectContextMenu(0, [0, 0]);
      });
    };

    open();
    // Unfolded: the containment item offers to collapse and reads distinctly
    // from 'expand', which fetches from the data source.
    expect(itemOf(container, 'fold')!.textContent).toBe('Collapse neighborhood');
    expect(itemOf(container, 'unfold')).toBeNull();
    const foldNode = vi.spyOn(instance, 'foldNode').mockImplementation(() => {});
    fireEvent.click(itemOf(container, 'fold')!);
    expect(foldNode).toHaveBeenCalledWith('a');
    foldNode.mockRestore();

    // Actually fold, so the item flips off the store's real state.
    act(() => {
      instance.foldNode('a');
    });
    open();
    expect(itemOf(container, 'fold')).toBeNull();
    expect(itemOf(container, 'unfold')!.textContent).toBe('Expand neighborhood');
    const unfoldNode = vi.spyOn(instance, 'unfoldNode').mockImplementation(() => {});
    fireEvent.click(itemOf(container, 'unfold')!);
    expect(unfoldNode).toHaveBeenCalledWith('a');
  });

  it('background target shows select all / clear selection / fit view', async () => {
    const { fake, instance, container } = await mountGraph(<GraphContextMenu />);
    const selectAll = vi.spyOn(instance, 'selectAll').mockImplementation(() => {});

    act(() => {
      fake.injectContextMenu(null, [8, 9]);
    });

    expect(itemOf(container, 'select-all')).not.toBeNull();
    expect(itemOf(container, 'clear-selection')).not.toBeNull();
    expect(itemOf(container, 'fit-view')).not.toBeNull();
    expect(container.querySelector('[data-orbit-context-menu-heading]')).toBeNull();

    fireEvent.click(itemOf(container, 'select-all')!);
    expect(selectAll).toHaveBeenCalledTimes(1);
  });

  it("'Expand neighbors' calls expandNode and shows a busy state while pending", async () => {
    const { fake, instance, container } = await mountGraph(<GraphContextMenu />);
    const expandNode = vi
      .spyOn(instance, 'expandNode')
      .mockImplementation(() => Promise.resolve({ added: 1 }));

    act(() => {
      fake.injectContextMenu(0, [0, 0]);
    });
    const expand = itemOf(container, 'expand')!;
    expect(expand).not.toBeNull();
    expect(expand.textContent).toBe('Expand neighbors');
    expect(expand.disabled).toBe(false);

    fireEvent.click(expand);
    expect(expandNode).toHaveBeenCalledWith('a');
    expect(menuOf(container)).toBeNull(); // activation closes the menu

    // While the node's expansion is in flight the item is busy + disabled.
    act(() => {
      instance.store.setState({ pendingExpansions: new Set(['a']) });
    });
    act(() => {
      fake.injectContextMenu(0, [0, 0]);
    });
    const busy = itemOf(container, 'expand')!;
    expect(busy.textContent).toBe('Expanding…');
    expect(busy.disabled).toBe(true);

    // The pending set draining re-enables the item LIVE (menu still open).
    act(() => {
      instance.store.setState({ pendingExpansions: new Set() });
    });
    expect(itemOf(container, 'expand')!.disabled).toBe(false);
    expect(itemOf(container, 'expand')!.textContent).toBe('Expand neighbors');
  });

  it("'Isolate' hard-scopes to the node's 1-hop ego network", async () => {
    const { fake, instance, container } = await mountGraph(<GraphContextMenu />);

    act(() => {
      fake.injectContextMenu(0, [0, 0]);
    });
    fireEvent.click(itemOf(container, 'isolate')!);

    expect(instance.store.getState().scope).toEqual({ seedIds: ['a'], hops: 1 });
    // a + its 1-hop neighbor b (edge a→b), resolved over the base adjacency.
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);
  });

  it("background 'Reset isolation' appears only under an active scope and clears it", async () => {
    const { fake, instance, container } = await mountGraph(<GraphContextMenu />);

    act(() => {
      fake.injectContextMenu(null, [0, 0]);
    });
    expect(itemOf(container, 'reset-isolation')).toBeNull(); // full scope

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    act(() => {
      instance.applyHostUpdate({ subgraph: { seedIds: ['a'] } });
    });
    act(() => {
      fake.injectContextMenu(null, [0, 0]);
    });
    const reset = itemOf(container, 'reset-isolation')!;
    expect(reset).not.toBeNull();

    fireEvent.click(reset);
    expect(instance.store.getState().scope).toBeNull();
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b', 'c']);
  });

  it('keyboard: opens focused, arrows rove, Enter activates, Escape restores focus', async () => {
    const { fake, instance, container } = await mountGraph(<GraphContextMenu />);
    const selectNeighbors = vi.spyOn(instance, 'selectNeighbors').mockImplementation(() => {});
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    try {
      outside.focus();
      expect(document.activeElement).toBe(outside);

      act(() => {
        fake.injectContextMenu(0, [10, 10]);
      });
      const items = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      expect(items.length).toBeGreaterThanOrEqual(2);
      expect(document.activeElement).toBe(items[0]); // opens focused

      fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(items[1]);
      fireEvent.keyDown(items[1]!, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(items[0]);
      fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });

      fireEvent.keyDown(items[1]!, { key: 'Enter' });
      expect(selectNeighbors).toHaveBeenCalledWith('a'); // items[1] = Select neighbors
      expect(menuOf(container)).toBeNull();
      expect(document.activeElement).toBe(outside); // focus returned

      act(() => {
        fake.injectContextMenu(0, [10, 10]);
      });
      expect(document.activeElement).not.toBe(outside);
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(menuOf(container)).toBeNull();
      expect(document.activeElement).toBe(outside); // Escape restores focus
    } finally {
      outside.remove();
    }
  });

  it('closes on outside pointerdown', async () => {
    const { fake, container } = await mountGraph(<GraphContextMenu />);
    act(() => {
      fake.injectContextMenu(0, [0, 0]);
    });
    expect(menuOf(container)).not.toBeNull();

    fireEvent.pointerDown(document.body);
    expect(menuOf(container)).toBeNull();
  });

  it('renderItems replaces the default items', async () => {
    const onSelect = vi.fn();
    const renderItems = vi.fn(
      (_ctx: {
        target: GraphContextMenuTarget;
        defaultItems: readonly GraphContextMenuItem[];
      }): GraphContextMenuItem[] => [{ id: 'custom', label: 'Custom action', onSelect }],
    );
    const { fake, container } = await mountGraph(<GraphContextMenu renderItems={renderItems} />);

    act(() => {
      fake.injectContextMenu(0, [0, 0]);
    });

    const menuItems = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(menuItems.map((el) => el.textContent)).toEqual(['Custom action']);

    const ctx = renderItems.mock.calls[0]![0];
    expect(ctx.target.kind).toBe('node');
    expect(ctx.defaultItems.length).toBeGreaterThan(0);

    fireEvent.click(menuItems[0]!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(menuOf(container)).toBeNull();
  });

  it('renders the node label as a text node (script payload stays inert)', async () => {
    const payload = '<script>window.__orbit_pwned = true</script>';
    const data: GraphSnapshot = {
      datasetKey: 'ds-xss',
      sourceRevision: 1,
      nodes: [{ id: 'x', attrs: { label: payload } }],
      edges: [],
    };
    const { fake, container } = await mountGraph(<GraphContextMenu />, { data });

    act(() => {
      fake.injectContextMenu(0, [0, 0]);
    });

    const heading = container.querySelector('[data-orbit-context-menu-heading]')!;
    expect(heading.textContent).toBe(payload);
    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as Record<string, unknown>)['__orbit_pwned']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// <GraphContextMenu> path pair
// ---------------------------------------------------------------------------

describe('<GraphContextMenu> path pair', () => {
  const menuOf = (c: HTMLElement): HTMLElement | null =>
    c.querySelector<HTMLElement>('[data-orbit-context-menu]');
  const itemOf = (c: HTMLElement, id: string): HTMLButtonElement | null =>
    c.querySelector<HTMLButtonElement>(`[data-orbit-context-menu-item="${id}"]`);

  it("'from here' stashes the anchor; 'to here' fires onFindPath(anchor, target) and consumes it", async () => {
    const onFindPath = vi.fn();
    const { fake, container } = await mountGraph(<GraphContextMenu onFindPath={onFindPath} />);
    const open = (index: number): void => {
      act(() => {
        fake.injectContextMenu(index, [0, 0]);
      });
    };

    // No anchor yet: only the 'from' half renders.
    open(0);
    expect(itemOf(container, 'find-path-from')).not.toBeNull();
    expect(itemOf(container, 'find-path-to')).toBeNull();

    fireEvent.click(itemOf(container, 'find-path-from')!);
    expect(menuOf(container)).toBeNull(); // activation closes the menu
    expect(onFindPath).not.toHaveBeenCalled(); // stashing is not resolving

    // Anchored: a DIFFERENT node offers 'to here'; firing carries the pair.
    open(1);
    fireEvent.click(itemOf(container, 'find-path-to')!);
    expect(onFindPath).toHaveBeenCalledTimes(1);
    expect(onFindPath).toHaveBeenCalledWith('a', 'b');

    // The completed pair consumed the anchor: 'to here' is gone again.
    open(2);
    expect(itemOf(container, 'find-path-to')).toBeNull();
  });

  it("'to here' never targets the anchor node itself; re-anchoring moves the 'from'", async () => {
    const onFindPath = vi.fn();
    const { fake, container } = await mountGraph(<GraphContextMenu onFindPath={onFindPath} />);
    const open = (index: number): void => {
      act(() => {
        fake.injectContextMenu(index, [0, 0]);
      });
    };

    open(0);
    fireEvent.click(itemOf(container, 'find-path-from')!);

    // Same node again: still anchorable, never its own target.
    open(0);
    expect(itemOf(container, 'find-path-from')).not.toBeNull();
    expect(itemOf(container, 'find-path-to')).toBeNull();

    // Re-anchor on b (last 'from' wins), then complete on c.
    fireEvent.click(itemOf(container, 'find-path-from')!);
    open(1);
    fireEvent.click(itemOf(container, 'find-path-from')!);
    open(2);
    fireEvent.click(itemOf(container, 'find-path-to')!);
    expect(onFindPath).toHaveBeenCalledWith('b', 'c');
  });

  it('without onFindPath neither item renders; background menus never carry the pair', async () => {
    const bare = await mountGraph(<GraphContextMenu />);
    act(() => {
      bare.fake.injectContextMenu(0, [0, 0]);
    });
    expect(itemOf(bare.container, 'find-path-from')).toBeNull();
    expect(itemOf(bare.container, 'find-path-to')).toBeNull();
    cleanup();

    const wired = await mountGraph(<GraphContextMenu onFindPath={vi.fn()} />);
    act(() => {
      wired.fake.injectContextMenu(null, [0, 0]); // background target
    });
    expect(itemOf(wired.container, 'find-path-from')).toBeNull();
    expect(itemOf(wired.container, 'find-path-to')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// <GraphSelectionActions>
// ---------------------------------------------------------------------------

describe('<GraphSelectionActions>', () => {
  const panelOf = (c: HTMLElement): HTMLElement | null =>
    c.querySelector<HTMLElement>('[data-orbit-selection-actions]');
  const btn = (c: HTMLElement, id: string): HTMLButtonElement =>
    c.querySelector<HTMLButtonElement>(`[data-orbit-selection-action="${id}"]`)!;

  it('appears only when the selection is non-empty and drives the mutators', async () => {
    const { instance, container } = await mountGraph(<GraphSelectionActions />);
    expect(panelOf(container)).toBeNull();

    act(() => {
      instance.selectNodes(['a', 'b']);
    });
    const panel = panelOf(container)!;
    expect(panel).not.toBeNull();
    expect(panel.querySelector('[data-orbit-selection-count]')!.textContent).toBe('2 selected');

    // No-op spies so the selection stays ['a','b'] across the clicks.
    const selectNeighbors = vi.spyOn(instance, 'selectNeighbors').mockImplementation(() => {});
    const invertSelection = vi.spyOn(instance, 'invertSelection').mockImplementation(() => {});
    const hideNodes = vi.spyOn(instance, 'hideNodes').mockImplementation(() => {});
    const pinNode = vi.spyOn(instance, 'pinNode').mockImplementation(() => {});
    const unpinNode = vi.spyOn(instance, 'unpinNode').mockImplementation(() => {});
    const clearSelection = vi.spyOn(instance, 'clearSelection'); // real — panel must vanish

    fireEvent.click(btn(container, 'select-neighbors'));
    expect(selectNeighbors).toHaveBeenCalledTimes(1);

    fireEvent.click(btn(container, 'invert'));
    expect(invertSelection).toHaveBeenCalledTimes(1);

    fireEvent.click(btn(container, 'hide'));
    expect(hideNodes).toHaveBeenCalledWith(['a', 'b']);

    fireEvent.click(btn(container, 'pin'));
    expect(pinNode).toHaveBeenCalledTimes(2);
    expect(pinNode).toHaveBeenCalledWith('a');
    expect(pinNode).toHaveBeenCalledWith('b');

    fireEvent.click(btn(container, 'unpin'));
    expect(unpinNode).toHaveBeenCalledTimes(2);
    expect(unpinNode).toHaveBeenCalledWith('a');
    expect(unpinNode).toHaveBeenCalledWith('b');

    fireEvent.click(btn(container, 'clear'));
    expect(clearSelection).toHaveBeenCalledTimes(1);
    expect(panelOf(container)).toBeNull(); // empty selection unmounts the panel
  });
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

describe('floating component placement', () => {
  const rootOf = (c: HTMLElement, marker: string): HTMLElement =>
    c.querySelector<HTMLElement>(`[${marker}]`)!;

  it('defaults to each component documented corner', async () => {
    const { container } = await mountGraph(
      <>
        <GraphToolbar />
        <GraphSelectionActions />
      </>,
    );
    const toolbar = rootOf(container, 'data-orbit-toolbar');
    expect(toolbar.style.position).toBe('absolute');
    expect(toolbar.style.top).toBe('12px');
    expect(toolbar.style.left).toBe('12px');
    // Only the TWO insets the corner needs are emitted — never all four.
    expect(toolbar.style.right).toBe('');
    expect(toolbar.style.bottom).toBe('');
  });

  it('`position` moves it, emitting only that corner two insets', async () => {
    const { container } = await mountGraph(<GraphToolbar position="bottom-right" />);
    const toolbar = rootOf(container, 'data-orbit-toolbar');
    expect(toolbar.style.bottom).toBe('12px');
    expect(toolbar.style.right).toBe('12px');
    expect(toolbar.style.top).toBe('');
    expect(toolbar.style.left).toBe('');
  });

  it('`offset` sets the distance from both anchored edges', async () => {
    const { container } = await mountGraph(<GraphToolbar position="top-right" offset={4} />);
    const toolbar = rootOf(container, 'data-orbit-toolbar');
    expect(toolbar.style.top).toBe('4px');
    expect(toolbar.style.right).toBe('4px');
  });

  /**
   * The regression this whole lane exists for: a `style` inset used to LAYER
   * over the default rather than resolve against it, so `{right}` left the
   * default `left` live, `left` won in LTR, and the caller's value sat in the
   * DOM doing nothing.
   */
  it('a `style` inset WINS over the one `position` implies (per axis)', async () => {
    const { container } = await mountGraph(
      <GraphToolbar position="top-left" style={{ right: 8 }} />,
    );
    const toolbar = rootOf(container, 'data-orbit-toolbar');
    expect(toolbar.style.right).toBe('8px');
    expect(toolbar.style.left).toBe(''); // dropped, not layered under
    expect(toolbar.style.top).toBe('12px'); // perpendicular anchor survives
  });

  it('a lone perpendicular override nudges without losing the other anchor', async () => {
    const { container } = await mountGraph(<GraphToolbar style={{ top: 40 }} />);
    const toolbar = rootOf(container, 'data-orbit-toolbar');
    expect(toolbar.style.top).toBe('40px');
    expect(toolbar.style.left).toBe('12px'); // horizontal default kept
  });

  /**
   * Asserted across EVERY placed component, not just one: the escape hatch
   * was documented on all four but implemented on two, so a Toolbar-only test
   * passed while `<GraphSimControls className>` still emitted inline
   * placement that beat the host's CSS.
   */
  it.each([
    ['data-orbit-toolbar', <GraphToolbar className="mine" position="top-right" />],
    ['data-orbit-simcontrols', <GraphSimControls className="mine" position="top-right" />],
    ['data-orbit-minimap', <GraphMinimap className="mine" position="top-left" />],
  ])('`className` drops the defaults INCLUDING placement (%s)', async (marker, element) => {
    const { container } = await mountGraph(element);
    const root = rootOf(container, marker);
    expect(root.className).toBe('mine');
    expect(root.style.position).toBe('');
    expect(root.style.top).toBe('');
    expect(root.style.right).toBe('');
    expect(root.style.left).toBe('');
    expect(root.style.bottom).toBe('');
  });

  it('the minimap keeps its MECHANICAL box under a class hook', async () => {
    const { container } = await mountGraph(<GraphMinimap className="mine" size={120} />);
    const root = rootOf(container, 'data-orbit-minimap');
    // Decorative defaults go; the thumbnail's own geometry cannot, or the
    // canvas collapses.
    expect(root.style.width).toBe('120px');
    expect(root.style.height).toBe('120px');
  });
});
