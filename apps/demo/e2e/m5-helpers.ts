/**
 * Shared helpers for the M5 semantic-exploration specs.
 *
 * Not a spec file (Playwright's default testMatch only picks up `*.spec.ts`).
 *
 * ## Why the screenshot diffs are stable
 * The M5 mode runs `layout="fixed"` over a fixture whose positions are a pure
 * function of (cluster index, member index), with every simulation force
 * zeroed and the engine simulation explicitly paused by the demo — so the
 * rendered picture is a function of the fixture and the camera alone.
 * {@link stableShot} proves that per capture: it re-shoots until two
 * consecutive PNGs are BYTE-IDENTICAL, which is only possible once the
 * renderer has quiesced. Diffs are then compared as a differing-pixel RATIO
 * decoded in-page (no committed baselines — a byte baseline would be a
 * per-platform artifact, and stability requirement is about the diff
 * being a function of the interaction, not of the machine).
 *
 * ## Screen geometry
 * M5 disables the mount-time fit and states a home camera instead
 * (`M5_HOME_VIEW` = space center at ×0.33), so space point (x, y) lands at
 * `(640 + (x − 2048)·0.33, 400 − (y − 2048)·0.33)` in the 1280×800 viewport
 * the Playwright config pins. The fixture is six 24-node discs on a ring of
 * radius 600 space units, so each cluster's HUB node (member 0, at the disc
 * center) has a fixed screen position — those are the right-click targets
 * below, and the ring's hollow center is the background target.
 */

import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** A PNG capture. Sourced from Playwright's own return type so the helper
 * carries no @types/node dependency of its own (the demo package has none). */
export type Shot = Awaited<ReturnType<Page['screenshot']>>;

export const READY_DOT = '[data-testid="status-dot"][title="ready"]';
export const ZOOM_VALUE = '[data-testid="zoom-value"]';
export const CONTEXT_MENU = '[data-orbit-context-menu]';
export const MENU_HEADING = '[data-orbit-context-menu-heading]';

/** Canvas-only region: clear of the left panel column, the top toolbar and
 * search box, the right dock, and the bottom chart strip. */
export const M5_CLIP = { x: 380, y: 175, width: 500, height: 450 };

/** Cluster hub positions in screen px (see module doc). Y is flipped in
 * cosmos, so cluster 1 (60°) sits ABOVE the center. */
export const M5_CLUSTER_SCREEN: Readonly<Record<string, readonly [number, number]>> = {
  alpha: [838, 400],
  bravo: [739, 229],
  coral: [541, 229],
  delta: [442, 400],
  ember: [541, 571],
  fjord: [739, 571],
};

/** The ring's hollow center — a right-click here is always a background hit. */
export const M5_BACKGROUND_POINT: readonly [number, number] = [640, 400];

/** Any diff at or above this ratio is a REAL visual change (same-state
 * captures diff at exactly 0 once quiesced). */
export const CHANGED_MIN = 0.001;
/** A restored picture must land under this ratio (5× below CHANGED_MIN). */
export const RESTORED_MAX = 0.0002;

/**
 * Enter the M5 mode from a fresh page. Reduced motion is emulated FIRST so
 * every camera move (the mount fit included) is instant — coerces
 * durations to 0, which removes easing from the captured frames.
 */
export async function enterSemantic(
  page: Page,
  opts: { layout?: 'fixed' | 'force' } = {},
): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.waitForSelector(READY_DOT, { timeout: 60_000 });
  await page.getByTestId('semantic-mode').click();
  await page.waitForSelector('[data-testid="m5-panel"]', { timeout: 30_000 });
  if (opts.layout === 'force') {
    await page.getByTestId('m5-layout-force').check();
  }
  await page.waitForSelector(READY_DOT, { timeout: 60_000 });
  await expect(page.locator(ZOOM_VALUE)).toHaveText(/×/, { timeout: 15_000 });
  // 144 nodes / 171 edges is the fixture's full roster (see semantic.tsx).
  await expect(page.getByTestId('node-count')).toHaveText('144', { timeout: 20_000 });
  await expect(page.getByTestId('edge-count')).toHaveText('171');
  // The force variant renders every frame while the sim is hot (idle-stopping
  // on cosmos >= 3.4 helps only settled scenes); pause before
  // interacting so SwiftShader never starves Playwright's input events.
  const pause = page.getByRole('button', { name: 'Pause simulation' });
  if ((await pause.count()) > 0) await pause.click();
}

/**
 * A PNG of the canvas clip taken once the renderer has quiesced: shoot until
 * two consecutive captures are byte-identical (the frozen fixed layout makes
 * that reachable). Throws with a clear message if it never settles.
 */
export async function stableShot(page: Page, attempts = 12): Promise<Shot> {
  let previous = await page.screenshot({ clip: M5_CLIP });
  for (let i = 0; i < attempts; i++) {
    await page.waitForTimeout(150);
    const next = await page.screenshot({ clip: M5_CLIP });
    if (next.equals(previous)) return next;
    previous = next;
  }
  throw new Error(`canvas never quiesced after ${attempts} captures`);
}

/**
 * Fraction of pixels differing between two PNGs beyond a per-channel
 * threshold, decoded and compared inside the page (no Node image dependency).
 */
export async function diffRatio(page: Page, a: Shot, b: Shot): Promise<number> {
  return await page.evaluate(
    async ([left, right]: readonly string[]) => {
      const load = async (b64: string): Promise<ImageBitmap> =>
        createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const [ia, ib] = await Promise.all([load(left!), load(right!)]);
      const w = Math.min(ia.width, ib.width);
      const h = Math.min(ia.height, ib.height);
      const ca = new OffscreenCanvas(w, h);
      const cb = new OffscreenCanvas(w, h);
      const xa = ca.getContext('2d')!;
      const xb = cb.getContext('2d')!;
      xa.drawImage(ia, 0, 0);
      xb.drawImage(ib, 0, 0);
      const da = xa.getImageData(0, 0, w, h).data;
      const db = xb.getImageData(0, 0, w, h).data;
      let diff = 0;
      for (let i = 0; i < da.length; i += 4) {
        const delta = Math.max(
          Math.abs(da[i]! - db[i]!),
          Math.abs(da[i + 1]! - db[i + 1]!),
          Math.abs(da[i + 2]! - db[i + 2]!),
        );
        if (delta > 24) diff++;
      }
      return diff / (w * h);
    },
    [a.toString('base64'), b.toString('base64')],
  );
}

/** Attach a capture to the report so a failed diff still ships its evidence. */
export async function attachShot(
  testInfo: { attach: (name: string, opts: { body: Shot; contentType: string }) => Promise<void> },
  name: string,
  body: Shot,
): Promise<void> {
  await testInfo.attach(name, { body, contentType: 'image/png' });
}

/** Dismiss an open context menu (no-op when none is open). */
export async function closeMenu(page: Page): Promise<void> {
  if ((await page.locator(CONTEXT_MENU).count()) > 0) {
    await page.keyboard.press('Escape');
    await expect(page.locator(CONTEXT_MENU)).toHaveCount(0);
  }
}

/**
 * Right-click a NODE and return the menu heading (the node's label). Aims at
 * the given screen point and spirals a few px outward — the fixture's disc
 * centers are deterministic, but a point's on-screen radius is only a few px.
 */
export async function openNodeMenu(
  page: Page,
  at: readonly [number, number],
): Promise<string> {
  const offsets: readonly (readonly [number, number])[] = [
    [0, 0], [4, 0], [-4, 0], [0, 4], [0, -4], [8, 8], [-8, -8], [12, -6], [-12, 6],
    [16, 0], [-16, 0], [0, 16], [0, -16], [20, 12], [-20, -12],
  ];
  for (const [dx, dy] of offsets) {
    await closeMenu(page);
    await page.mouse.click(at[0] + dx, at[1] + dy, { button: 'right' });
    await page.waitForTimeout(150);
    const menu = page.locator(CONTEXT_MENU);
    if ((await menu.count()) === 0) continue;
    const heading = menu.locator(MENU_HEADING);
    if ((await heading.count()) === 0) continue; // background menu — keep hunting
    return (await heading.textContent()) ?? '';
  }
  throw new Error(`no node context menu near ${at[0]},${at[1]}`);
}

/** Right-click the ring's hollow center → the background menu. */
export async function openBackgroundMenu(page: Page): Promise<void> {
  await closeMenu(page);
  await page.mouse.click(M5_BACKGROUND_POINT[0], M5_BACKGROUND_POINT[1], { button: 'right' });
  const menu = page.locator(CONTEXT_MENU);
  await expect(menu).toBeVisible({ timeout: 5_000 });
  await expect(menu.locator(MENU_HEADING)).toHaveCount(0);
}

/** Numeric text of a `data-testid` readout. */
export async function readNumber(page: Page, testId: string): Promise<number> {
  const text = (await page.getByTestId(testId).textContent()) ?? '';
  return Number.parseInt(text.replace(/,/g, ''), 10);
}

/**
 * Press Tab until the focused element matches `selector`, purely by keyboard.
 * Returns the number of presses; throws when the bound is exhausted — which is
 * itself the finding (the surface is not keyboard-reachable).
 */
export async function tabUntil(page: Page, selector: string, max = 220): Promise<number> {
  for (let presses = 1; presses <= max; presses++) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate(
      (sel: string) => document.activeElement?.matches(sel) === true,
      selector,
    );
    if (hit) return presses;
  }
  throw new Error(`focus never reached "${selector}" within ${max} Tab presses`);
}
