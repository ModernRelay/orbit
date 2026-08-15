/** Shared Playwright helpers for the probes. */
import type { Page } from '@playwright/test';

export const APP_URL = 'http://localhost:5299/';

export async function openWorkbench(page: Page): Promise<void> {
  await page.goto(APP_URL);
  await page.waitForFunction(() => typeof window.__spike !== 'undefined');
}

/**
 * Wait until the workbench frame counter advances by `frames`, or until
 * `timeoutMs` elapses (the render loop may legitimately be quiescent).
 * Returns the number of frames actually observed.
 */
export async function waitFrames(page: Page, frames: number, timeoutMs = 5000): Promise<number> {
  return page.evaluate(
    async ({ frames: want, timeoutMs: limit }) => {
      const start = window.__spike.frameCount();
      const t0 = performance.now();
      return new Promise<number>((resolve) => {
        const poll = (): void => {
          const elapsed = window.__spike.frameCount() - start;
          if (elapsed >= want || performance.now() - t0 > limit) {
            resolve(elapsed);
          } else {
            setTimeout(poll, 10);
          }
        };
        poll();
      });
    },
    { frames, timeoutMs },
  );
}

/**
 * Move the pointer to (x, y) and give cosmos's hover detector (which runs at
 * most every 4 frames, only while the pointer is over the canvas) time to
 * pick the hovered item up before a click.
 */
export async function hoverAt(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y, { steps: 3 });
  // Nudge a redraw in case the loop is idle, then allow >4 frames.
  await page.evaluate(() => {
    window.__spike.graph?.render();
  });
  await waitFrames(page, 10, 1500);
  await page.waitForTimeout(50);
}

export interface RGBALike {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function isRed(c: RGBALike): boolean {
  return c.a > 128 && c.r > 110 && c.r > c.b + 50 && c.r > c.g + 50;
}

export function isBlue(c: RGBALike): boolean {
  return c.a > 128 && c.b > 110 && c.b > c.r + 50 && c.b > c.g + 50;
}

export function approxEquals(a: RGBALike, b: RGBALike, tolerance = 28): boolean {
  return (
    Math.abs(a.r - b.r) <= tolerance &&
    Math.abs(a.g - b.g) <= tolerance &&
    Math.abs(a.b - b.b) <= tolerance
  );
}

export function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((x, y) => x - y);
  const pos = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[pos] ?? NaN;
}
