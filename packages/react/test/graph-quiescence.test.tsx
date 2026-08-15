/**
 * React-side quiescence invariant: a full component tree at rest
 * (labels, tooltip, minimap,
 * sim controls, navigator) registers zero requestAnimationFrame callbacks.
 * Every per-frame consumer rides the core onFrame fan-out or subscription
 * channels; the Minimap polls on a wall-clock interval, and Lasso's
 * sanctioned one-shot rAF exists only during an active pointer gesture.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createGraphInstance } from '@modernrelay/orbit-core';
import type { GraphInstance, GraphSnapshot } from '@modernrelay/orbit-core';
import { FakeEngine, installRafAudit } from '@modernrelay/orbit-core/testing';
import type { RafAudit } from '@modernrelay/orbit-core/testing';
import { GraphProvider } from '../src/GraphProvider';
import { GraphMinimap } from '../src/components/Minimap/index';
import { GraphNavigator } from '../src/components/Navigator/index';
import { GraphSimControls } from '../src/components/SimControls/index';
import { GraphTooltip } from '../src/components/Tooltip/index';

const snapshot: GraphSnapshot = {
  datasetKey: 'quiet',
  sourceRevision: 1,
  nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  edges: [{ source: 'a', target: 'b' }],
};

let audit: RafAudit | null = null;
let instance: GraphInstance | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  instance?.destroy();
  instance = null;
  audit?.uninstall();
  audit = null;
  vi.useRealTimers();
});

describe('component tree quiescence', () => {
  it('a mounted tree at rest registers ZERO rAF callbacks over 5s', async () => {
    const engine = new FakeEngine();
    instance = createGraphInstance({ engine: () => engine });
    const host = document.createElement('div');
    document.body.appendChild(host);
    await instance.attach(host);
    instance.applyHostUpdate({ data: snapshot });
    engine.injectSimulationEnd(); // settle

    render(
      <GraphProvider instance={instance}>
        <GraphMinimap />
        <GraphNavigator />
        <GraphSimControls />
        <GraphTooltip />
      </GraphProvider>,
    );

    audit = installRafAudit(globalThis as unknown as Window);
    vi.advanceTimersByTime(5_000);

    expect(audit.registrations()).toBe(0);
    host.remove();
  });
});
