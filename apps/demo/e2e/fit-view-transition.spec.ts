import { expect, test } from '@playwright/test';

// Serve a blank same-origin page so this regression exercises the real
// adapter/Cosmos pair without the demo's own camera and simulation controls.
const engineUrl = `/@fs${new URL('../../../packages/engine-cosmos/src/CosmosEngine.ts', import.meta.url).pathname}`;

for (const scenario of [
  { name: 'shrinking', before: 1000, after: 10, zoom: 1.5 },
  { name: 'expanding', before: 10, after: 1000, zoom: 0.8 },
]) {
  test(`fitView uses ${scenario.name} transition destinations and respects maxZoom`, async ({ page }) => {
    await page.route('**/__engine_fit_test__', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }),
    );
    await page.goto('/__engine_fit_test__');
    const result = await page.evaluate(async ({ url, before, after }) => {
      const { CosmosEngine } = await import(url) as typeof import('@modernrelay/orbit-engine-cosmos');
      const host = document.createElement('div');
      host.style.cssText = 'width:1000px;height:1000px';
      document.body.appendChild(host);
      const engine = new CosmosEngine({
        initialConfig: { enableSimulation: false, rescalePositions: false, transitionDuration: 1000 },
      });
      const frames = () => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      try {
        await engine.mount(host, {});
        engine.commit({
          revision: 1,
          structure: { pointCount: 2, positions: Float32Array.of(0, 0, before, before), links: new Uint32Array() },
        });
        await frames();
        engine.commit({
          revision: 2,
          structure: { pointCount: 2, positions: Float32Array.of(0, 0, after, after), links: new Uint32Array() },
        });
        const atFit = Array.from(engine.getPositions()!);
        engine.fitView({ maxZoom: 1.5, durationMs: 0 });
        await frames();
        return { atFit, viewport: engine.getViewport() };
      } finally {
        engine.destroy();
        host.remove();
      }
    }, { url: engineUrl, before: scenario.before, after: scenario.after });

    // Confirm the test reached a transition: the GPU still holds the old
    // positions, while the fit must center and size for the destination.
    expect(result.atFit).toEqual([0, 0, scenario.before, scenario.before]);
    expect(result.viewport?.zoom).toBeCloseTo(scenario.zoom, 5);
    expect(result.viewport?.x).toBeCloseTo(scenario.after / 2, 5);
    expect(result.viewport?.y).toBeCloseTo(scenario.after / 2, 5);
  });
}
