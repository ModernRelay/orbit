/**
 * security fixture suite — the shared script-payload dataset
 * (fixtures/security/payload-dataset.ts) rendered through <Graph> with the
 * packaged overlay components mounted. Asserts the untrusted-content
 * rule end-to-end: every attr-derived string reaches the DOM as literal
 * text, no element is ever created from a payload, and the executable
 * payloads never run (`window.__xss` stays undefined).
 *
 * Wave-2 note: <GraphToolbar>/<GraphContextMenu>/<GraphSelectionActions>/
 * <GraphNavigator> land concurrently with this suite. A module-scope feature
 * probe detects components still in their 'not implemented' stub state and
 * TODO-skips ONLY their sub-cases via it.skipIf — the orchestrator re-runs
 * the suite at integration, where every case must run.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { Graph } from '../src/index';
import { ANNOUNCE_INTERVAL_MS } from '../src/LiveRegion';
import { GraphToolbar } from '../src/components/Toolbar/index';
import { GraphContextMenu } from '../src/components/ContextMenu/index';
import { GraphSelectionActions } from '../src/components/SelectionActions/index';
import { GraphNavigator } from '../src/components/Navigator/index';
import {
  ALL_PAYLOADS,
  PAYLOAD_SENTINEL,
  SCRIPT_PAYLOADS,
  expectInert,
  payloadDataset,
} from '../../../fixtures/security/payload-dataset';

// ---------------------------------------------------------------------------
// Wave-2 feature probe: render each component inside a real <Graph> once at
// module scope. A throw whose message carries the stub's 'not implemented'
// marker → TODO-skip that component's sub-cases; any OTHER failure means the
// component exists and its real test below must surface the fault.
// ---------------------------------------------------------------------------

function probeImplemented(element: ReactElement): boolean {
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    render(
      <Graph engine={() => new FakeEngine()} data={payloadDataset}>
        {element}
      </Graph>,
    );
    return true;
  } catch (err) {
    return !String(err).includes('not implemented');
  } finally {
    errSpy.mockRestore();
    cleanup();
  }
}

const IMPLEMENTED = {
  toolbar: probeImplemented(<GraphToolbar />),
  contextMenu: probeImplemented(<GraphContextMenu />),
  selectionActions: probeImplemented(<GraphSelectionActions />),
  navigator: probeImplemented(<GraphNavigator />),
};

// ---------------------------------------------------------------------------
// Harness: <Graph> over the payload dataset with a primed label lane — the
// t=0 sim-hot tick banks the FakeEngine's seeded grid, the settle re-rank
// publishes every payload node as a label candidate (10 nodes < default 64).
// ---------------------------------------------------------------------------

async function mountPayloadGraph(children?: ReactNode): Promise<{
  engine: FakeEngine;
  container: HTMLElement;
}> {
  const engine = new FakeEngine();
  const { container } = render(
    <Graph
      engine={() => engine}
      data={payloadDataset}
      labels={{ minZoom: 0 }}
      accessibility={{ label: 'Payload graph' }}
    >
      {children}
    </Graph>,
  );
  await act(async () => {}); // attach resolves → ready + initial commit
  act(() => {
    engine.emitFrame(0); // sim-hot tick primes the CPU position cache
    engine.injectSimulationEnd(); // settle: bank + re-rank → candidates
  });
  return { engine, container };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // Localize a hypothetical executed payload to the test that executed it.
  delete (globalThis as Record<string, unknown>)[PAYLOAD_SENTINEL];
});

describe('security fixture', () => {
  it('label lane renders every payload as a literal text node — zero element children', async () => {
    const { container } = await mountPayloadGraph();

    for (const node of payloadDataset.nodes) {
      const el = container.querySelector(`[data-orbit-label="${node.id}"]`);
      expect(el, `label div for ${node.id}`).not.toBeNull();
      expect(el!.textContent).toBe(node.attrs!.label); // literal, undecoded
      expect(el!.children.length).toBe(0); // text node only — never markup
    }
    expectInert(container);
    expect((globalThis as Record<string, unknown>)[PAYLOAD_SENTINEL]).toBeUndefined();
  });

  it.skipIf(!IMPLEMENTED.contextMenu)(
    // TODO-skip until wave 2 lands <GraphContextMenu> (probe: stub throws).
    'context menu shows the node text literally on an injected contextMenu event',
    async () => {
      const { engine } = await mountPayloadGraph(<GraphContextMenu />);

      act(() => {
        // Engine index 0 = the accepted-base first node (script-tag payload).
        engine.injectContextMenu(0, [12, 24]);
      });

      // The menu's node text is the raw payload — rendered literally…
      expect(document.body.textContent).toContain(SCRIPT_PAYLOADS.scriptTag);
      // …and never parsed (document-wide, covering portaled menus).
      expectInert(document.body);
    },
  );

  it.skipIf(!IMPLEMENTED.navigator)(
    // TODO-skip until wave 2 lands <GraphNavigator> (probe: stub throws).
    'navigator items render hostile accessible labels literally',
    async () => {
      await mountPayloadGraph(<GraphNavigator />);

      // Default accessible label = attrs.label ?? id → the raw payloads must
      // appear as literal text, not as parsed markup.
      expect(document.body.textContent).toContain(SCRIPT_PAYLOADS.scriptTag);
      expect(document.body.textContent).toContain(SCRIPT_PAYLOADS.imgOnerror);
      expectInert(document.body);
    },
  );

  it.skipIf(!IMPLEMENTED.toolbar || !IMPLEMENTED.selectionActions)(
    // TODO-skip until wave 2 lands <GraphToolbar>/<GraphSelectionActions>.
    'toolbar and selection actions stay inert with the hostile dataset mounted',
    async () => {
      const { container } = await mountPayloadGraph(
        <>
          <GraphToolbar />
          <GraphSelectionActions />
        </>,
      );
      expectInert(container);
      expectInert(document.body);
    },
  );

  it('live region announcements are text-only', async () => {
    vi.useFakeTimers();
    const { container, engine } = await mountPayloadGraph();

    act(() => {
      engine.injectPointClick(0); // select the script-tag node → store change
    });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_INTERVAL_MS + 1);
    });

    const region = container.querySelector('[data-orbit-live-region]')!;
    expect(region.textContent).not.toBe(''); // it DID announce
    expect(region.children.length).toBe(0); // literal text nodes only
    expectInert(container);
  });

  it('full overlay composition over the payload dataset stays inert end-to-end', async () => {
    // Mount every component wave 2 has delivered so far (stubs excluded by
    // the probe; the integration re-run exercises the full set).
    const { engine, container } = await mountPayloadGraph(
      <>
        {IMPLEMENTED.toolbar ? <GraphToolbar /> : null}
        {IMPLEMENTED.contextMenu ? <GraphContextMenu /> : null}
        {IMPLEMENTED.selectionActions ? <GraphSelectionActions /> : null}
        {IMPLEMENTED.navigator ? <GraphNavigator /> : null}
      </>,
    );

    if (IMPLEMENTED.contextMenu) {
      act(() => {
        engine.injectContextMenu(0, [10, 10]);
      });
    }

    // Every payload string reached the DOM as literal text (label lane at
    // minimum; navigator/menu add more literal surfaces when mounted)…
    for (const payload of ALL_PAYLOADS) {
      expect(document.body.textContent).toContain(payload);
    }
    // …and nowhere did any of them become live markup or execute.
    expectInert(container);
    expectInert(document.body);
    expect((globalThis as Record<string, unknown>)[PAYLOAD_SENTINEL]).toBeUndefined();
  });
});
