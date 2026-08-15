/**
 * edge-picking facade: the route is fixed ONCE at ready from
 * `capabilities.linkPicking` (never method sniffing). Native route maps host
 * onLinkClick/onLinkHover to typed edge payloads; the fallback route arms a
 * LinkPickIndex grid ONLY while the simulation is settled and answers the
 * pointer samplers with identical typed events.
 *
 * FakeEngine geometry notes: screen == space (identity screenToSpace), and
 * seeded positions put node i at ((i % 100) * 10, floor(i / 100) * 10)
 * a(0,0), b(10,0), c(20,0) for the 3-node fixture.
 */

import { describe, expect, it } from 'vitest';

import { container, makeInstance, snap } from './helpers';
import type { InstanceHarness } from './helpers';
import { EdgePickingFacade, medianLinkWidthPx } from '../src/edgePicking';
import type { FakeEngine } from '../src/testing/index';

interface ReadyHarness extends InstanceHarness {
  engine: FakeEngine;
}

async function setup(opts: { linkPicking: boolean }): Promise<ReadyHarness> {
  const h = makeInstance({ engineOptions: { capabilities: { linkPicking: opts.linkPicking } } });
  await h.instance.attach(container);
  h.instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c'], [['a', 'b']]) });
  return { ...h, engine: h.engines[0]! };
}

describe('native route (capabilities.linkPicking === true)', () => {
  it('maps host onLinkClick/onLinkHover to typed edge payloads — ids, not indices', async () => {
    const { instance, engine } = await setup({ linkPicking: true });
    const clicks: Array<{ id: string; source: string; target: string }> = [];
    const hovers: Array<string | null> = [];
    instance.on('edgeClick', (p) => {
      clicks.push({ id: p.edge.id, source: p.edge.source, target: p.edge.target });
    });
    instance.on('edgeHover', (p) => hovers.push(p.edge === null ? null : p.edge.id));

    engine.injectLinkHover(0);
    expect(instance.store.getState().hover.edgeId).toBe('a→b#0');
    engine.injectLinkClick(0);
    engine.injectLinkHover(null);

    expect(clicks).toEqual([{ id: 'a→b#0', source: 'a', target: 'b' }]);
    expect(hovers).toEqual(['a→b#0', null]);
    expect(instance.store.getState().hover.edgeId).toBeNull();
  });

  it('keeps the fallback machinery inert: samplers return null and emit nothing, even after settle', async () => {
    const { instance, engine } = await setup({ linkPicking: true });
    const events: string[] = [];
    instance.on('edgeClick', () => events.push('click'));
    instance.on('edgeHover', () => events.push('hover'));

    engine.injectSimulationEnd(); // would arm the fallback grid on that route

    expect(instance.pickEdgeAt([5, 2])).toBeNull();
    expect(instance.sampleEdgeHover([5, 2])).toBeNull();
    expect(instance.sampleEdgeClick([5, 2])).toBeNull();
    expect(events).toEqual([]);
    expect(instance.store.getState().hover.edgeId).toBeNull();
  });

  it('route is fixed at ready: flipping the capability record afterwards changes nothing', async () => {
    const { instance, engine } = await setup({ linkPicking: true });
    engine.capabilities.linkPicking = false; // monkey-patch AFTER ready

    engine.injectSimulationEnd();
    expect(instance.pickEdgeAt([5, 2])).toBeNull(); // still native — no grid

    // Host link events still map (native adapters keep emitting them).
    const clicks: string[] = [];
    instance.on('edgeClick', (p) => clicks.push(p.edge.id));
    engine.injectLinkClick(0);
    expect(clicks).toEqual(['a→b#0']);
  });
});

describe('fallback route (capabilities.linkPicking === false)', () => {
  it('queries return null while the simulation is hot; settle arms over the per-event readback', async () => {
    const { instance, engine } = await setup({ linkPicking: false });

    // The initial data commit restarted the simulation → disarmed.
    expect(instance.pickEdgeAt([5, 2])).toBeNull();

    // Drift while hot, then settle: the grid must index the SETTLED snapshot.
    engine.nudgePositions(0, 100);
    engine.injectSimulationEnd();

    expect(instance.pickEdgeAt([5, 102])?.id).toBe('a→b#0');
    expect(instance.pickEdgeAt([5, 2])).toBeNull(); // pre-settle spot is stale
  });

  it('disarms on a restarting structural commit and re-arms on the next settle', async () => {
    const { instance, engine } = await setup({ linkPicking: false });
    engine.injectSimulationEnd();
    expect(instance.pickEdgeAt([5, 2])?.id).toBe('a→b#0');

    // Structural change under layout 'force' → commit carries restart → hot.
    instance.applyHostUpdate({
      data: snap(2, ['a', 'b', 'c'], [
        ['a', 'b'],
        ['b', 'c'],
      ]),
    });
    expect(instance.pickEdgeAt([5, 2])).toBeNull();

    engine.injectSimulationEnd();
    expect(instance.pickEdgeAt([5, 2])?.id).toBe('a→b#0');
    expect(instance.pickEdgeAt([15, 2])?.id).toBe('b→c#0');
  });

  it('tolerance is max(4px-equivalent, half median link width), live against the width channel', async () => {
    const { instance, engine } = await setup({ linkPicking: false });
    engine.injectSimulationEnd();

    // Default tolerance 4px: 8px off the segment misses, 2px hits.
    expect(instance.pickEdgeAt([5, 8])).toBeNull();
    expect(instance.pickEdgeAt([5, 2])?.id).toBe('a→b#0');

    // Median width 20 → tolerance 10px. A buffer-only commit (no restart, no
    // structure) must NOT disarm — the wider pick works without a re-settle.
    instance.applyHostUpdate({ linkWidth: 20 });
    expect(instance.pickEdgeAt([5, 8])?.id).toBe('a→b#0');
    expect(instance.pickEdgeAt([5, 11])).toBeNull(); // still bounded
  });

  it('sampleEdgeHover writes hover.edgeId and emits transitions only; sampleEdgeClick emits typed edgeClick', async () => {
    const { instance, engine } = await setup({ linkPicking: false });
    const hovers: Array<string | null> = [];
    const clicks: string[] = [];
    instance.on('edgeHover', (p) => hovers.push(p.edge === null ? null : p.edge.id));
    instance.on('edgeClick', (p) => clicks.push(p.edge.id));

    // Disarmed: samples resolve null and never emit spurious transitions.
    expect(instance.sampleEdgeHover([5, 2])).toBeNull();
    expect(hovers).toEqual([]);

    engine.injectSimulationEnd();

    expect(instance.sampleEdgeHover([5, 2])?.id).toBe('a→b#0');
    expect(instance.store.getState().hover.edgeId).toBe('a→b#0');
    instance.sampleEdgeHover([4, 1]); // same edge — no re-emit
    expect(hovers).toEqual(['a→b#0']);

    expect(instance.sampleEdgeClick([5, 2])?.id).toBe('a→b#0');
    expect(clicks).toEqual(['a→b#0']);

    instance.sampleEdgeHover([200, 200]); // off-graph — transition to null
    expect(hovers).toEqual(['a→b#0', null]);
    expect(instance.store.getState().hover.edgeId).toBeNull();
  });

  it('a hot sample clears a stale edge hover exactly once', async () => {
    const { instance, engine } = await setup({ linkPicking: false });
    engine.injectSimulationEnd();
    instance.sampleEdgeHover([5, 2]);
    expect(instance.store.getState().hover.edgeId).toBe('a→b#0');

    const hovers: Array<string | null> = [];
    instance.on('edgeHover', (p) => hovers.push(p.edge === null ? null : p.edge.id));

    // Restart disarms; the next sample reports null → one transition.
    instance.applyHostUpdate({ data: snap(3, ['a', 'b', 'c', 'd'], [['a', 'b']]) });
    expect(instance.sampleEdgeHover([5, 2])).toBeNull();
    expect(instance.sampleEdgeHover([5, 2])).toBeNull();
    expect(hovers).toEqual([null]);
  });

  it('route is fixed at ready: flipping the capability to true keeps the fallback live', async () => {
    const { instance, engine } = await setup({ linkPicking: false });
    engine.capabilities.linkPicking = true; // monkey-patch AFTER ready

    engine.injectSimulationEnd();
    expect(instance.pickEdgeAt([5, 2])?.id).toBe('a→b#0'); // still fallback
  });

  it('host onLink* events remain a harmless pass-through on the fallback route', async () => {
    const { instance, engine } = await setup({ linkPicking: false });
    const clicks: string[] = [];
    instance.on('edgeClick', (p) => clicks.push(p.edge.id));
    engine.injectLinkClick(0);
    expect(clicks).toEqual(['a→b#0']);
  });
});

describe('EdgePickingFacade unit behavior', () => {
  const identity = (p: readonly [number, number]): readonly [number, number] => p;

  it('applies the visibility mask per candidate at query time (pass-through stub)', () => {
    const facade = new EdgePickingFacade({ route: 'fallback', screenToSpace: identity });
    // Two parallel horizontal links: link 0 at y=0, link 1 at y=2.
    const positions = new Float32Array([0, 0, 10, 0, 0, 2, 10, 2]);
    const links = new Uint32Array([0, 1, 2, 3]);
    facade.arm(positions, links);
    expect(facade.armed).toBe(true);

    expect(facade.pickLinkAt([5, 0])).toBe(0); // nearest wins unmasked
    facade.setLinkVisibilityMask((l) => l !== 0);
    expect(facade.pickLinkAt([5, 0])).toBe(1); // masked candidate skipped
    facade.setLinkVisibilityMask(() => false);
    expect(facade.pickLinkAt([5, 0])).toBeNull();
    facade.setLinkVisibilityMask(null);
    expect(facade.pickLinkAt([5, 0])).toBe(0); // mask cleared
  });

  it('converts tolerance through screenToSpace of two points 4px apart', () => {
    // space = screen / 10 → 4px ≙ 0.4 space units.
    const facade = new EdgePickingFacade({
      route: 'fallback',
      screenToSpace: (p) => [p[0] / 10, p[1] / 10],
    });
    const positions = new Float32Array([0, 0, 1, 0]); // 1 space unit long
    const links = new Uint32Array([0, 1]);
    facade.arm(positions, links);

    expect(facade.pickLinkAt([5, 3])).toBe(0); // 0.3 space ≤ 0.4 tolerance
    expect(facade.pickLinkAt([5, 5])).toBeNull(); // 0.5 space > 0.4
  });

  it('builds chunked under the slice budget: queries null until the build commits; disarm abandons it', () => {
    const scheduled: Array<() => void> = [];
    let t = 0;
    const makeFacade = (): EdgePickingFacade =>
      new EdgePickingFacade({
        route: 'fallback',
        screenToSpace: identity,
        buildBudgetMs: 0, // every budget check yields
        schedule: (fn) => scheduled.push(fn),
        now: () => t++,
      });

    // Enough links to cross the 4096-link budget-check interval.
    const pointCount = 128;
    const linkCount = 5000;
    const positions = new Float32Array(2 * pointCount);
    for (let i = 0; i < pointCount; i++) {
      positions[2 * i] = i;
      positions[2 * i + 1] = 0;
    }
    const links = new Uint32Array(2 * linkCount);
    for (let l = 0; l < linkCount; l++) {
      links[2 * l] = l % pointCount;
      links[2 * l + 1] = (l * 7 + 1) % pointCount;
    }

    const facade = makeFacade();
    facade.arm(positions, links);
    expect(facade.armed).toBe(false); // build still in flight
    expect(facade.pickLinkAt([1, 0])).toBeNull();
    expect(scheduled.length).toBeGreaterThan(0);
    while (scheduled.length > 0) scheduled.shift()!();
    expect(facade.armed).toBe(true);
    expect(facade.pickLinkAt([1, 0])).not.toBeNull();

    // Disarm mid-build: the abandoned generator never commits a grid.
    const facade2 = makeFacade();
    facade2.arm(positions, links);
    expect(facade2.armed).toBe(false);
    facade2.disarm();
    while (scheduled.length > 0) scheduled.shift()!();
    expect(facade2.armed).toBe(false);
    expect(facade2.pickLinkAt([1, 0])).toBeNull();
  });

  it('native-route facades ignore arm() entirely', () => {
    const facade = new EdgePickingFacade({ route: 'native', screenToSpace: identity });
    facade.arm(new Float32Array([0, 0, 10, 0]), new Uint32Array([0, 1]));
    expect(facade.armed).toBe(false);
    expect(facade.pickLinkAt([5, 0])).toBeNull();
  });

  it('medianLinkWidthPx: 0 for empty/null, upper median otherwise', () => {
    expect(medianLinkWidthPx(null)).toBe(0);
    expect(medianLinkWidthPx(new Float32Array(0))).toBe(0);
    expect(medianLinkWidthPx(new Float32Array([3]))).toBe(3);
    expect(medianLinkWidthPx(new Float32Array([1, 9, 5]))).toBe(5);
    expect(medianLinkWidthPx(new Float32Array([4, 2]))).toBe(4); // upper median
    expect(medianLinkWidthPx(new Float32Array([NaN, NaN]))).toBe(0);
  });
});
