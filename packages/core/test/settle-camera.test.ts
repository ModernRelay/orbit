/**
 * Settle camera + simulation presets.
 *
 * The first-data fit frames the SEED ring; the force simulation then
 * contracts the graph to a fraction of that frame, so the camera follows the
 * first settle: periodic animated refits riding the engine frame fan-out,
 * a final fit at quiescence, cancelled by any user camera input. Presets
 * resolve to frozen configs; omitted simulation resolves to 'calm' (the
 * engine's own defaults keep visible motion alive for tens of seconds).
 */

import { describe, expect, it } from 'vitest';

import { container, makeInstance, snap } from './helpers';
import { SIMULATION_PRESETS } from '../src/types';
import type { RecordedCall } from '../src/testing/index';

const DATA = snap(1, ['a', 'b', 'c'], [
  ['a', 'b'],
  ['b', 'c'],
]);

function fitCalls(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === 'fitView');
}

async function mounted(opts: Parameters<typeof makeInstance>[0] = {}) {
  const h = makeInstance(opts);
  await h.instance.attach(container);
  h.instance.applyHostUpdate({ data: DATA });
  const engine = h.engines[0]!;
  return { h, engine };
}

describe('simulation presets', () => {
  it('omitted simulation resolves to the calm preset in the engine config', async () => {
    const { engine } = await mounted();
    const configs = engine.commits
      .map((c) => c.config?.simulation)
      .filter((s): s is NonNullable<typeof s> => s !== undefined);
    expect(configs.length).toBeGreaterThan(0);
    expect(configs[configs.length - 1]).toEqual(SIMULATION_PRESETS.calm);
  });

  it('a preset name resolves to its frozen config and repeats are no-ops', async () => {
    const { h, engine } = await mounted();
    h.instance.applyHostUpdate({ simulation: 'spread' });
    const afterFirst = engine.commits.length;
    const last = engine.commits[afterFirst - 1]!;
    expect(last.config?.simulation).toBe(SIMULATION_PRESETS.spread);
    // the same preset again resolves to the same frozen object — no commit
    h.instance.applyHostUpdate({ simulation: 'spread' });
    expect(engine.commits.length).toBe(afterFirst);
  });
});

describe('settle camera', () => {
  it("default 'follow': periodic fits ride the frame fan-out, quiescence fits once more, then silence", async () => {
    const { engine } = await mounted();
    const initialFits = fitCalls(engine.cameraCalls).length;
    expect(initialFits).toBe(1); // fitViewOnFirstData

    for (let i = 0; i < 55; i++) engine.emitFrame();
    expect(fitCalls(engine.cameraCalls).length).toBe(initialFits + 1);
    const followFit = fitCalls(engine.cameraCalls)[initialFits]!;
    expect(followFit.args[0]).toEqual({ durationMs: 650 });

    for (let i = 0; i < 55; i++) engine.emitFrame();
    expect(fitCalls(engine.cameraCalls).length).toBe(initialFits + 2);

    engine.injectSimulationEnd();
    const afterSettle = fitCalls(engine.cameraCalls);
    expect(afterSettle.length).toBe(initialFits + 3);
    expect(afterSettle[afterSettle.length - 1]!.args[0]).toEqual({ durationMs: 800 });

    // dead after quiescence: further frames fit nothing
    for (let i = 0; i < 200; i++) engine.emitFrame();
    expect(fitCalls(engine.cameraCalls).length).toBe(initialFits + 3);
  });

  it("'once': no periodic fits, exactly one at first quiescence", async () => {
    const { engine } = await mounted({ fitViewOnSettle: 'once' });
    const initialFits = fitCalls(engine.cameraCalls).length;
    for (let i = 0; i < 200; i++) engine.emitFrame();
    expect(fitCalls(engine.cameraCalls).length).toBe(initialFits);
    engine.injectSimulationEnd();
    expect(fitCalls(engine.cameraCalls).length).toBe(initialFits + 1);
    engine.injectSimulationEnd(); // later settles (reheats) fit nothing
    expect(fitCalls(engine.cameraCalls).length).toBe(initialFits + 1);
  });

  it('false: first-data fit only — frames and quiescence add nothing', async () => {
    const { engine } = await mounted({ fitViewOnSettle: false });
    const initialFits = fitCalls(engine.cameraCalls).length;
    for (let i = 0; i < 200; i++) engine.emitFrame();
    engine.injectSimulationEnd();
    expect(fitCalls(engine.cameraCalls).length).toBe(initialFits);
  });

  it('the frame cap retires the follow', async () => {
    const { engine } = await mounted();
    const initialFits = fitCalls(engine.cameraCalls).length;
    for (let i = 0; i < 481; i++) engine.emitFrame();
    const atCap = fitCalls(engine.cameraCalls).length;
    expect(atCap).toBe(initialFits + 8); // 480/55 → 8 periodic fits
    for (let i = 0; i < 200; i++) engine.emitFrame();
    expect(fitCalls(engine.cameraCalls).length).toBe(atCap);
    // quiescence after the cap adds no fit either — the follow is gone
    engine.injectSimulationEnd();
    expect(fitCalls(engine.cameraCalls).length).toBe(atCap);
  });

  it('user camera input cancels the follow (public setViewport)', async () => {
    const { h, engine } = await mounted();
    const initialFits = fitCalls(engine.cameraCalls).length;
    h.instance.setViewport({ zoom: 2 });
    for (let i = 0; i < 200; i++) engine.emitFrame();
    engine.injectSimulationEnd();
    expect(fitCalls(engine.cameraCalls).length).toBe(initialFits);
  });

  it('an explicit host fitView cancels the follow but still fits', async () => {
    const { h, engine } = await mounted();
    const initialFits = fitCalls(engine.cameraCalls).length;
    h.instance.fitView();
    const afterHostFit = fitCalls(engine.cameraCalls).length;
    expect(afterHostFit).toBe(initialFits + 1);
    for (let i = 0; i < 200; i++) engine.emitFrame();
    engine.injectSimulationEnd();
    expect(fitCalls(engine.cameraCalls).length).toBe(afterHostFit);
  });

  it('the fixed layout never arms the follow', async () => {
    const h = makeInstance();
    await h.instance.attach(container);
    h.instance.applyHostUpdate({ layout: 'fixed', data: DATA });
    const engine = h.engines[0]!;
    const initialFits = fitCalls(engine.cameraCalls).length;
    for (let i = 0; i < 200; i++) engine.emitFrame();
    engine.injectSimulationEnd();
    expect(fitCalls(engine.cameraCalls).length).toBe(initialFits);
  });
});
