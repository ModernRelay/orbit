import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGraphInstance } from '../src/instance';
import type { GraphInstance } from '../src/instance';
import { FakeEngine } from '../src/testing/FakeEngine';
import { container, snap } from './helpers';

class AsyncEngine extends FakeEngine {
  reads: Array<{ resolve: (p: Float32Array | null) => void; reject: (e: Error) => void }> = [];
  getPositionsAsync(): Promise<Float32Array | null> {
    return new Promise((resolve, reject) => { this.reads.push({ resolve, reject }); });
  }
}

const instances: GraphInstance[] = [];
async function setup(engine = new AsyncEngine()) {
  const instance = createGraphInstance({ engine: () => engine, fitViewOnFirstData: false });
  instances.push(instance);
  instance.applyHostUpdate({ data: snap(1, ['a', 'b']), labels: { enabled: false } });
  await instance.attach(container);
  return { instance, engine };
}
async function flush() {
  // copy admission → observer microtask → finally clearing the in-flight slot
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}
afterEach(() => { for (const i of instances.splice(0)) i.destroy(); });

describe('shared live position cache', () => {
  it('publishes unpositioned force nodes with one async read in flight at a bounded cadence', async () => {
    const { instance, engine } = await setup();
    instance.applyHostUpdate({ labels: { minZoom: 0, overlap: 'allow' } });
    const sync = vi.spyOn(engine, 'getPositions');
    const observer = vi.fn();
    const unsub = instance.subscribeOverview(observer);
    expect(engine.reads).toHaveLength(1);
    engine.emitFrame(1000);
    engine.emitFrame(2000);
    expect(engine.reads).toHaveLength(1);
    engine.reads[0]!.resolve(Float32Array.of(3, 4, 8, 9));
    await flush();
    expect([...instance.getOverviewScene()!.positions]).toEqual([3, 4, 8, 9]);
    expect(observer).toHaveBeenCalledTimes(2); // replay + admitted copy
    engine.emitFrame(2001);
    expect(engine.reads).toHaveLength(2);
    engine.reads[1]!.resolve(Float32Array.of(4, 5, 9, 10));
    await flush();
    engine.emitFrame(2050);
    expect(engine.reads).toHaveLength(2);
    engine.emitFrame(2101);
    expect(engine.reads).toHaveLength(3);
    expect(sync).not.toHaveBeenCalled();
    unsub();
    instance.applyHostUpdate({ labels: { enabled: false } });
    engine.reads[2]!.resolve(null);
    await flush();
    engine.emitFrame(10000);
    expect(engine.reads).toHaveLength(3);
  });

  it.each(['roster', 'same-roster positions', 'render'])('rejects a copy after a %s revision changes', async (change) => {
    const { instance, engine } = await setup();
    instance.subscribeOverview(() => {});
    if (change === 'roster') instance.applyHostUpdate({ data: snap(2, ['b', 'a']) });
    if (change === 'same-roster positions') instance.applyHostUpdate({ data: {
      ...snap(2, ['a', 'b']), nodes: [{ id: 'a', x: 20, y: 30 }, { id: 'b', x: 40, y: 50 }],
    } });
    if (change === 'render') instance.applyHostUpdate({ nodeSize: 17 });
    const expected = [...instance.getOverviewScene()!.positions];
    engine.reads[0]!.resolve(Float32Array.of(900, 900, 901, 901));
    await flush();
    expect([...instance.getOverviewScene()!.positions]).toEqual(expected);
  });

  it.each(['settle', 'drag', 'pause'])('keeps the final %s positions when an older copy resolves', async (event) => {
    const { instance, engine } = await setup();
    instance.subscribeOverview(() => {});
    engine.nudgePositions(30, 40);
    if (event === 'settle') engine.injectSimulationEnd();
    if (event === 'pause') instance.pauseSimulation();
    if (event === 'drag') engine.injectDragEnd(0, 100, 200);
    const final = [...instance.getOverviewScene()!.positions];
    expect(final[0]).toBe(event === 'drag' ? 100 : 30);
    engine.reads[0]!.resolve(Float32Array.of(900, 900, 901, 901));
    await flush();
    expect([...instance.getOverviewScene()!.positions]).toEqual(final);
    const reads = engine.reads.length;
    if (event !== 'drag') engine.emitFrame(10000);
    expect(engine.reads).toHaveLength(reads); // settled ticks never read
  });

  it('retires pre-loss copies even after the same adapter recovers', async () => {
    const { instance, engine } = await setup();
    instance.subscribeOverview(() => {});
    engine.injectContextLost();
    engine.injectContextRestored();
    engine.emitFrame(500);
    expect(engine.reads).toHaveLength(2);
    engine.reads[1]!.resolve(Float32Array.of(50, 60, 70, 80));
    await flush();
    engine.reads[0]!.resolve(Float32Array.of(900, 900, 901, 901));
    await flush();
    expect([...instance.getOverviewScene()!.positions]).toEqual([50, 60, 70, 80]);
  });

  it('rejects retired mount copies and does not notify after disposal', async () => {
    const engines: AsyncEngine[] = [];
    const instance = createGraphInstance({ engine: () => {
      const engine = new AsyncEngine(); engines.push(engine); return engine;
    } });
    instances.push(instance);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });
    await instance.attach(container);
    const listener = vi.fn();
    instance.subscribeOverview(listener);
    instance.detach();
    await instance.attach(container);
    engines[1]!.emitFrame(500);
    engines[1]!.reads[0]!.resolve(Float32Array.of(50, 60, 70, 80));
    await flush();
    engines[0]!.reads[0]!.resolve(Float32Array.of(900, 900, 901, 901));
    await flush();
    expect([...instance.getOverviewScene()!.positions]).toEqual([50, 60, 70, 80]);
    engines[1]!.emitFrame(1000);
    instance.destroy();
    const notifications = listener.mock.calls.length;
    engines[1]!.reads[1]!.resolve(Float32Array.of(90, 90, 91, 91));
    await flush();
    expect(listener).toHaveBeenCalledTimes(notifications);
    expect(instance.getOverviewScene()).toBeNull();
  });

  it('retains cache on failed or wrong-sized copies and retries on activity', async () => {
    const { instance, engine } = await setup();
    instance.subscribeOverview(() => {});
    const initial = instance.getOverviewScene();
    engine.reads[0]!.reject(new Error('copy unavailable'));
    await flush();
    expect(instance.getOverviewScene()).toBe(initial);
    engine.emitFrame(500);
    engine.reads[1]!.resolve(Float32Array.of(1, 2));
    await flush();
    expect(instance.getOverviewScene()).toBe(initial);
    engine.emitFrame(1000);
    expect(engine.reads).toHaveLength(3);
  });

  it('bounds the synchronous fallback and does no periodic work after settlement', async () => {
    const engine = new FakeEngine();
    const instance = createGraphInstance({ engine: () => engine });
    instances.push(instance);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });
    await instance.attach(container);
    const read = vi.spyOn(engine, 'getPositions');
    instance.subscribeOverview(() => {});
    expect(read).toHaveBeenCalledTimes(1);
    engine.emitFrame(499);
    expect(read).toHaveBeenCalledTimes(1);
    engine.emitFrame(500);
    expect(read).toHaveBeenCalledTimes(2);
    engine.injectSimulationEnd();
    const finalReads = read.mock.calls.length;
    for (let t = 1000; t < 10000; t += 16) engine.emitFrame(t);
    expect(read).toHaveBeenCalledTimes(finalReads);
  });

  it('uses declared fixed positions without sampling the engine', async () => {
    const { instance, engine } = await setup();
    instance.applyHostUpdate({ layout: 'fixed', data: {
      ...snap(2, ['a', 'b']), nodes: [{ id: 'a', x: 20, y: 30 }, { id: 'b', x: 40, y: 50 }],
    } });
    instance.subscribeOverview(() => {});
    engine.emitFrame(1000);
    expect(engine.reads).toHaveLength(0);
    expect([...instance.getOverviewScene()!.positions]).toEqual([20, 30, 40, 50]);
  });

  it('observes drag results even when automatic pinning is prevented', async () => {
    const { instance, engine } = await setup();
    instance.subscribeOverview(() => {});
    instance.on('nodeDragEnd', (_event, control) => { control.preventDefault(); });
    engine.injectDragEnd(0, 100, 200);
    expect([...instance.getOverviewScene()!.positions].slice(0, 2)).toEqual([100, 200]);
    expect(instance.store.getState().pins.size).toBe(0);
  });

  it('limits overview-only async sampling to 2 Hz', async () => {
    const { instance, engine } = await setup();
    instance.subscribeOverview(() => {});
    engine.reads[0]!.resolve(Float32Array.of(1, 2, 3, 4));
    await flush();
    engine.emitFrame(100);
    engine.emitFrame(499);
    expect(engine.reads).toHaveLength(1);
    engine.emitFrame(500);
    expect(engine.reads).toHaveLength(2);
  });

  it('uses the bounded synchronous lane above 10K nodes and switches back after shrinking', async () => {
    const { instance, engine } = await setup();
    instance.applyHostUpdate({
      data: snap(2, Array.from({ length: 10_001 }, (_, i) => `n${i}`)),
      labels: { minZoom: 0, overlap: 'allow' },
    });
    const sync = vi.spyOn(engine, 'getPositions');
    instance.subscribeOverview(() => {});
    expect(sync).toHaveBeenCalledTimes(1);
    expect(engine.reads).toHaveLength(0);
    engine.nudgePositions(20, 30);
    engine.emitFrame(100);
    engine.emitFrame(499);
    expect(sync).toHaveBeenCalledTimes(1);
    engine.emitFrame(500);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(instance.getOverviewScene()!.positions[0]).toBe(20);

    instance.applyHostUpdate({ data: snap(3, Array.from({ length: 10_000 }, (_, i) => `n${i}`)) });
    sync.mockClear(); // roster replacement may preserve live positions with an event read
    engine.emitFrame(600);
    expect(engine.reads).toHaveLength(1);
    const positions = new Float32Array(20_000).fill(40);
    engine.reads[0]!.resolve(positions);
    await flush();
    expect(instance.getOverviewScene()!.positions[0]).toBe(40);
    engine.emitFrame(699);
    expect(engine.reads).toHaveLength(1);
    engine.emitFrame(700);
    expect(engine.reads).toHaveLength(2);
    expect(sync).not.toHaveBeenCalled();
  });

  it('rejects a pending small-scene copy after growing and shrinking back to the same count', async () => {
    const { instance, engine } = await setup();
    instance.subscribeOverview(() => {});
    expect(engine.reads).toHaveLength(1);

    instance.applyHostUpdate({ data: snap(2, Array.from({ length: 10_001 }, (_, i) => `n${i}`)) });
    engine.emitFrame(500);
    expect(instance.getOverviewScene()!.count).toBe(10_001);

    instance.applyHostUpdate({ data: {
      ...snap(3, ['a', 'b']),
      nodes: [{ id: 'a', x: 20, y: 30 }, { id: 'b', x: 40, y: 50 }],
    } });
    const expected = [...instance.getOverviewScene()!.positions];
    // Length alone cannot reject this old copy: the current roster has the
    // original two IDs again, but belongs to a different scene generation.
    engine.reads[0]!.resolve(Float32Array.of(900, 900, 901, 901));
    await flush();
    expect([...instance.getOverviewScene()!.positions]).toEqual(expected);

    engine.emitFrame(1000);
    expect(engine.reads).toHaveLength(2);
    engine.reads[1]!.resolve(Float32Array.of(21, 31, 41, 51));
    await flush();
    expect([...instance.getOverviewScene()!.positions]).toEqual([21, 31, 41, 51]);
  });

  it('rejects a copy after unpinning even when the render revision is unchanged', async () => {
    const { instance, engine } = await setup();
    instance.pinNode('a', [5, 6]);
    instance.subscribeOverview(() => {});
    const render = instance.getRevisions().render;
    instance.unpinNode('a');
    expect(instance.getRevisions().render).toBe(render);
    const expected = [...instance.getOverviewScene()!.positions];
    engine.reads[0]!.resolve(Float32Array.of(900, 900, 901, 901));
    await flush();
    expect([...instance.getOverviewScene()!.positions]).toEqual(expected);
  });

  it.each([false, true])('never samples a deferred old engine roster (async=%s)', async (async) => {
    const engine = async ? new AsyncEngine({ manualFrames: true }) : new FakeEngine({ manualFrames: true });
    const instance = createGraphInstance({ engine: () => engine });
    instances.push(instance);
    instance.applyHostUpdate({ data: { ...snap(1, ['a', 'b']), nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 0 }] } });
    await instance.attach(container);
    engine.stepFrame();
    instance.applyHostUpdate({ data: { ...snap(2, ['b', 'a']), nodes: [{ id: 'b', x: 100, y: 100 }, { id: 'a', x: 200, y: 200 }] } });
    const read = vi.spyOn(engine, 'getPositions');
    instance.subscribeOverview(() => {});
    await flush();
    expect([...instance.getOverviewScene()!.positions]).toEqual([100, 100, 200, 200]);
    expect(read).not.toHaveBeenCalled();
    if (engine instanceof AsyncEngine) expect(engine.reads).toHaveLength(0);
    engine.stepFrame();
    if (engine instanceof AsyncEngine) {
      expect(engine.reads).toHaveLength(1);
      engine.reads[0]!.resolve(engine.getPositions());
      await flush();
    } else expect(read).toHaveBeenCalledTimes(1);
    expect([...instance.getOverviewScene()!.positions]).toEqual([100, 100, 200, 200]);
  });

  it('pausing an already fixed scene does not replace declared positions with pre-draw GPU state', async () => {
    const engine = new AsyncEngine();
    const instance = createGraphInstance({ engine: () => engine });
    instances.push(instance);
    instance.applyHostUpdate({ layout: 'fixed', data: { ...snap(1, ['a', 'b']), nodes: [{ id: 'a', x: 100, y: 100 }, { id: 'b', x: 200, y: 200 }] } });
    await instance.attach(container);
    instance.subscribeOverview(() => {});
    const read = vi.spyOn(engine, 'getPositions').mockReturnValue(Float32Array.of(0, 0, 0, 0));
    instance.pauseSimulation();
    expect(read).not.toHaveBeenCalled();
    expect([...instance.getOverviewScene()!.positions]).toEqual([100, 100, 200, 200]);
  });

  it('does not bank an unapplied roster when a force simulation is paused', async () => {
    const engine = new FakeEngine({ manualFrames: true });
    const instance = createGraphInstance({ engine: () => engine });
    instances.push(instance);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });
    await instance.attach(container);
    engine.stepFrame();
    instance.subscribeOverview(() => {});
    instance.applyHostUpdate({ data: { ...snap(2, ['a', 'b']), nodes: [{ id: 'a', x: 100, y: 100 }, { id: 'b', x: 200, y: 200 }] } });
    const read = vi.spyOn(engine, 'getPositions');
    instance.pauseSimulation();
    expect(read).not.toHaveBeenCalled();
    expect([...instance.getOverviewScene()!.positions]).toEqual([100, 100, 200, 200]);
  });

  it('projects final pause positions without waiting for another engine frame', async () => {
    const { instance, engine } = await setup();
    instance.applyHostUpdate({ labels: { minZoom: 0, overlap: 'allow' } });
    engine.injectSimulationEnd();
    instance.resumeSimulation();
    const positions = vi.fn();
    instance.labels.subscribePositions(positions);
    engine.nudgePositions(30, 40);
    instance.pauseSimulation();
    expect(positions.mock.lastCall![0].map((p: { x: number; y: number }) => [p.x, p.y])).toEqual([[30, 40], [40, 40]]);
  });

  it('shares accepted snapshots with labels without per-sample re-ranking or store writes', async () => {
    const { instance, engine } = await setup();
    instance.applyHostUpdate({ labels: { minZoom: 0, overlap: 'allow' } });
    engine.injectSimulationEnd(); // populate candidates from seeded engine positions
    instance.resumeSimulation();
    const positions = vi.fn();
    instance.labels.subscribePositions(positions);
    instance.subscribeOverview(() => {});
    const publish = vi.fn();
    const unsubStore = instance.store.subscribe(publish);
    engine.reads[0]!.resolve(Float32Array.of(3, 4, 8, 9));
    await flush();
    expect(positions.mock.lastCall![0].map((p: { x: number; y: number }) => [p.x, p.y])).toEqual([[3, 4], [8, 9]]);
    expect(publish).not.toHaveBeenCalled();
    unsubStore();
  });
});
