// Simulation param sweep: metrics + settle screenshot per combo (untracked).
// Usage: node run-sweep.mjs <outDir>
import { chromium } from '@playwright/test';

const OUT = process.argv[2] ?? 'sweep-out';
const BASE = 'http://localhost:5199/sweep.html';

// Sweep grid: current default first, then damping/decay/gravity/repulsion moves.
const COMBOS = [
  { id: 'cosmos-default', rep: 1, grav: 0.25, fric: 0.85, decay: 5000 },
  { id: 'calm-a', rep: 1.4, grav: 0.15, fric: 0.55, decay: 1400 },
  { id: 'calm-b', rep: 1.4, grav: 0.15, fric: 0.6, decay: 1000 },
  { id: 'calm-c', rep: 1.6, grav: 0.12, fric: 0.5, decay: 800 },
  { id: 'spread-a', rep: 2, grav: 0.1, fric: 0.6, decay: 1400 },
  { id: 'tight-a', rep: 0.8, grav: 0.3, fric: 0.55, decay: 1200 },
];

const browser = await chromium.launch({
  headless: false,
  args: ['--window-size=1320,880', '--window-position=80,80'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

const results = [];
for (const c of COMBOS) {
  const url = `${BASE}?n=800&clusters=6&rep=${c.rep}&grav=${c.grav}&fric=${c.fric}&decay=${c.decay}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__sweep && window.__sweep.ready === true', null, { timeout: 30_000 });
  // mid-flight snapshot for motion judging
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/${c.id}-mid.png` });
  // wait for settle (or 20s cap)
  await page
    .waitForFunction('window.__sweep.settled === true', null, { timeout: 14_000 })
    .catch(() => {});
  await page.waitForTimeout(400);
  const m = await page.evaluate('window.__sweep.metrics()');
  const settleMs = await page.evaluate('window.__sweep.settleMs');
  const motion = await page.evaluate('window.__sweep.motion');
  // seconds until max displacement stays under 1.5 space units/s
  let stillAt = -1;
  for (let i = 0; i < motion.length - 2; i++) {
    if (motion[i] < 1.5 && motion[i + 1] < 1.5 && motion[i + 2] < 1.5) { stillAt = (i * 0.5).toFixed(1); break; }
  }
  await page.screenshot({ path: `${OUT}/${c.id}-end.png` });
  results.push({ ...c, settleMs, stillAt, motion: motion.filter((_, i) => i % 2 === 0).slice(0, 14), ...m });
  console.log(JSON.stringify(results[results.length - 1]));
}
await browser.close();
console.log('--- summary ---');
for (const r of results) {
  console.log(
    `${r.id.padEnd(16)} still@${String(r.stillAt).padStart(5)}s settleFlag=${String(r.settleMs).padStart(6)}ms fill=${r.fillX}x${r.fillY} motion=${JSON.stringify(r.motion)}`,
  );
}
