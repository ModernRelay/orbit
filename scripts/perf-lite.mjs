#!/usr/bin/env node
/**
 * perf-harness-lite — the LOCAL real-GPU half.
 *
 * Drives the demo app HEADFUL through Playwright (same GPU-evidence policy as
 * the probe suite: SwiftShader/software-rasterizer results are not
 * evidence; CI never runs this — it runs the op-count gate in
 * packages/core/test/perf-gate.test.ts instead).
 *
 * Scenario per run: load the demo (S sizes the INITIAL declarative fixture to
 * the tier via ?declNodes= — that load is the S first-paint measurement),
 * read `__orbitPerf.firstPaint()` (navigation-start → first applied engine
 * upload, with the lastCommitMs phase decomposition), stream the
 * deterministic feed at the requested `--tier` and `--family`, then scrub a
 * histogram drag-brush across the `score` dimension for SCRUB_STEPS steps.
 * Per step it measures brush→publish latency through the demo's dev-only
 * `?perf=1` hook (`window.__orbitPerf`): t0 = performance.now() sampled
 * in-page immediately before dispatching the pointer move, t1 = the store
 * publication of the resulting render revision (the boundary — the engine
 * commit is issued synchronously inside that publish). Frame times are
 * sampled by an in-page rAF loop across the scrub window with the force
 * simulation RUNNING (active frames, the performance-relevant regime).
 *
 * Multi-run protocol: single runs on an in-use desktop are not evidence, so
 * `--runs N` repeats the whole scenario in
 * fresh browser contexts. Headline stats are MEDIANS of per-run quantiles
 * using the same aggregation protocol, with `cvPct` = sample CV
 * across per-run p95s. The evaluator disqualifies runs<3 and CV over the per-metric
 * bound — see scripts/perf-gate.mjs.
 *
 * Tier fixtures:
 * - `--tier S`: 10K nodes / 25K edges. First paint is
 * measured on the DECLARATIVE fixture sized via ?declNodes=
 * (edge calibration ±<1%, actual counts disclosed in the
 * artifact); the scrub runs on the streamed feed at the
 * exact tier cardinalities.
 * - `--tier L` (default): 100K nodes / 250K edges,
 * reached via the
 * demo feed's `?nodeShare=` split knob
 * (rows=350000&nodeShare=2/7 → exactly 100K/250K). First
 * paint is reported-only here (the initial 3000-node
 * declarative fixture — NOT tier-sized).
 * - `--tier L-lite`: 100K nodes / 25K edges (`?rows=125000`, default
 * split), the historical reduced fixture. The artifact is LABELED
 * `tier: 'L-lite'` with an explicit `tierDeviation`; its
 * verdicts apply the L-tier budgets, and a pass is NOT
 * L-tier evidence.
 *
 * Browsers: `--browser chromium` (default) or `--browser webkit` (probe
 * WebKit WebGL support for this scenario is unproven; a run that cannot
 * reach ready/committed exits with a loud deviation note, and JS heap
 * sampling is Chromium-only either way).
 *
 * Gate: after measuring, the pure evaluator in scripts/perf-gate.mjs stamps
 * per-metric {target, measured,
 * pass} plus {qualifying, disqualifiers, overall} into the artifact.
 * Encoded targets per tier (TIER_TARGETS): L gates frameMs.p95 ≤ 33 ms, S
 * gates firstPaintMs.p95 < 500 ms (strict); brushLatencyMs.p95 stays
 * reported-only. An over-budget run on a qualifying profile prints a loud
 * stderr callout.
 *
 * Exit semantics: default is evidence-collection mode — exit 0 regardless of
 * verdict (the verdict lives in the artifact). With --enforce the process
 * exits nonzero unless overall === 'pass'; guard-skips also exit nonzero
 * under --enforce, because an enforcement run that measured nothing must not
 * look green. CI never runs this scenario either way.
 *
 * Output: .evidence/perf/filter-latency-<date>-<tier>-<family>[-webkit].json
 * (local-only; .evidence is gitignored) and a console summary. Guard-skips
 * (exit 0 without --enforce) when Playwright or its browsers are unavailable.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TIERS,
  TIER_TARGETS,
  enforceExitCode,
  evaluatePerfGate,
} from './perf-gate.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_DIR = path.join(REPO_ROOT, 'apps', 'demo');
const EVIDENCE_DIR = path.join(REPO_ROOT, '.evidence', 'perf'); // local-only (gitignored)

const PORT = 5209;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCRUB_STEPS = 40;
const STEP_TIMEOUT_MS = 2_000;
/** Declarative-generator edge factor calibrated so declNodes=10000 lands
 * within 1% of the S tier's 25K edges (measured 24 862 — the artifact
 * discloses the actual count as a deviation). */
const S_DECL_EDGE_FACTOR = 2.44;

const FAMILIES = ['clustered', 'sparse', 'powerlaw'];
const BROWSERS = ['chromium', 'webkit'];

function parseArgs(argv) {
  const opts = { tier: 'L', family: 'clustered', browser: 'chromium', runs: 1, enforce: false };
  const take = (i) => argv[i];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--enforce') {
      opts.enforce = true;
    } else if (arg === '--tier') {
      opts.tier = take((i += 1));
    } else if (arg.startsWith('--tier=')) {
      opts.tier = arg.slice('--tier='.length);
    } else if (arg === '--family') {
      opts.family = take((i += 1));
    } else if (arg.startsWith('--family=')) {
      opts.family = arg.slice('--family='.length);
    } else if (arg === '--browser') {
      opts.browser = take((i += 1));
    } else if (arg.startsWith('--browser=')) {
      opts.browser = arg.slice('--browser='.length);
    } else if (arg === '--runs') {
      opts.runs = Number.parseInt(take((i += 1)), 10);
    } else if (arg.startsWith('--runs=')) {
      opts.runs = Number.parseInt(arg.slice('--runs='.length), 10);
    } else {
      throw new Error(
        `unknown argument '${arg}' (usage: perf-lite.mjs [--tier S|L|L-lite] ` +
          `[--family clustered|sparse|powerlaw] [--browser chromium|webkit] ` +
          `[--runs N] [--enforce])`,
      );
    }
  }
  if (typeof opts.tier !== 'string' || !(opts.tier in TIERS)) {
    throw new Error(
      `unknown tier '${opts.tier}' — known tiers: ${Object.keys(TIERS).join(', ')}`,
    );
  }
  if (!FAMILIES.includes(opts.family)) {
    throw new Error(`unknown family '${opts.family}' — known families: ${FAMILIES.join(', ')}`);
  }
  if (!BROWSERS.includes(opts.browser)) {
    throw new Error(`unknown browser '${opts.browser}' — known browsers: ${BROWSERS.join(', ')}`);
  }
  if (!Number.isInteger(opts.runs) || opts.runs < 1 || opts.runs > 20) {
    throw new Error(`--runs must be an integer in 1..20 (got ${opts.runs})`);
  }
  return opts;
}

/** Rows + nodeShare query pair hitting the tier's EXACT cardinalities via
 * the demo feed's `?nodeShare=` split knob (apps/demo/src/streamFeed.ts).
 * Refuses when rounding cannot reproduce the declared tier. */
function tierFeedParams(tierName) {
  const tier = TIERS[tierName];
  const rows = tier.nodes + tier.edges;
  const nodeShare = tier.nodes / rows;
  const feedNodes = Math.max(1, Math.round(rows * nodeShare));
  if (feedNodes !== tier.nodes) {
    throw new Error(
      `tier ${tierName}: rounding cannot reproduce ${tier.nodes} nodes from rows=${rows} ` +
        `(got ${feedNodes}) — adjust TIERS or the share precision`,
    );
  }
  return { rows, nodeShare };
}

const READY_DOT = '[data-testid="status-dot"][title="ready"]';

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo];
  const b = sorted[hi];
  return a + (b - a) * (pos - lo);
}

const round2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: round2(quantile(sorted, 0.5)),
    p95: round2(quantile(sorted, 0.95)),
    max: round2(sorted[sorted.length - 1] ?? null),
    mean: round2(sorted.length > 0 ? sorted.reduce((s, v) => s + v, 0) / sorted.length : null),
  };
}

/** Sample CV (n−1 stddev / mean, %) across per-run values — the run-to-run
 * stability number the evaluator's maxCvPct bound reads. Null below n=2. */
function cvPct(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (mean === 0) return null;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.round((Math.sqrt(variance) / mean) * 1000) / 10;
}

const median = (values) => quantile([...values].sort((a, b) => a - b), 0.5);

/**
 * Headline stats across runs: MEDIAN of per-run quantiles (the published
 * protocol — pooling would hide inter-run drift, which is exactly what cvPct
 * must catch), cvPct over per-run p95s, samples = pooled count.
 */
function aggregateRunStats(runStatsList) {
  return {
    runs: runStatsList.length,
    samples: runStatsList.reduce((s, r) => s + r.samples, 0),
    p50: round2(median(runStatsList.map((r) => r.p50))),
    p95: round2(median(runStatsList.map((r) => r.p95))),
    max: round2(Math.max(...runStatsList.map((r) => r.max))),
    mean: round2(median(runStatsList.map((r) => r.mean))),
    cvPct: cvPct(runStatsList.map((r) => r.p95)),
  };
}

/** Resolve the requested Playwright browser type through the demo package
 * (guard-skip when unavailable). */
function resolveBrowserType(name) {
  try {
    const require = createRequire(path.join(DEMO_DIR, 'package.json'));
    const pw = require('@playwright/test');
    return pw[name] ?? null;
  } catch {
    return null;
  }
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`dev server did not come up at ${url} within ${timeoutMs}ms`);
}

function pageUrlFor(opts, feed) {
  const params = new URLSearchParams({
    rows: String(feed.rows),
    nodeShare: String(feed.nodeShare),
    family: opts.family,
    perf: '1',
  });
  if (opts.tier === 'S') {
    // S first-paint is measured on a TIER-SIZED declarative fixture.
    params.set('declNodes', String(TIERS.S.nodes));
    params.set('declEdgeFactor', String(S_DECL_EDGE_FACTOR));
  }
  return `${BASE_URL}/?${params.toString()}`;
}

/** One full scenario pass in a fresh context. Returns the per-run record. */
async function measureRun(browser, opts, feed, runIndex) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(pageUrlFor(opts, feed));
    await page.waitForSelector(READY_DOT, { timeout: 120_000 });

    // --- first paint: navigation-start → first applied engine upload, with
    // the phase decomposition, read BEFORE streaming (the stream remount
    // resets the probe). Gated at S (tier-sized declarative fixture);
    // reported-only elsewhere (the initial 3000-node fixture).
    await page.waitForFunction(() => window.__orbitPerf?.firstPaint() !== null, {
      timeout: 30_000,
    });
    const firstPaint = await page.evaluate(() => {
      const fp = window.__orbitPerf.firstPaint();
      return { totalMs: Math.round(fp.totalMs * 100) / 100, phases: fp.phases ?? null };
    });

    const readCount = (testId) =>
      page
        .locator(`[data-testid="${testId}"]`)
        .textContent()
        .then((t) => Number.parseInt((t ?? '0').replace(/,/g, ''), 10));
    const declNodes = await readCount('node-count');
    const declEdges = await readCount('edge-count');

    // --- environment metadata (same fields as the matrix) ---
    const gpu = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      if (gl === null) return 'unavailable';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(
        ext !== null ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      );
    });

    // --- stream the tier fixture through the replace feed ---
    const tier = TIERS[opts.tier];
    console.log(
      `perf-lite: [run ${runIndex + 1}/${opts.runs}] streaming the ${opts.tier} feed ` +
        `(${tier.nodes.toLocaleString('en-US')} nodes / ${tier.edges.toLocaleString('en-US')} edges, ` +
        `family ${opts.family}) …`,
    );
    await page.getByTestId('stream-feed').click();
    await page.waitForSelector('[data-testid="stream-meter"][data-phase="committed"]', {
      timeout: 300_000,
    });
    await page.waitForSelector(READY_DOT, { timeout: 60_000 });
    // Let the remounted instance settle (crossfilter build + first frames).
    await page.waitForFunction(() => window.__orbitPerf !== undefined, { timeout: 30_000 });
    await page.waitForTimeout(2_000);

    const nodeCount = await readCount('node-count');
    const edgeCount = await readCount('edge-count');

    // --- memory components at settle: JS heap (Chromium-only — WebKit
    // has no performance.memory) + the instance's own estimates.
    const memoryAtSettle = await page.evaluate(() => {
      const snap = window.__orbitPerf.perfSnapshot();
      const heap = performance.memory?.usedJSHeapSize;
      return {
        jsHeapBytes: typeof heap === 'number' ? heap : null,
        estimatedCpuBytes: snap.estimatedCpuBytes,
        estimatedGpuBytes: snap.estimatedGpuBytes ?? null,
      };
    });

    // --- longtask observer across the scrub window (Chromium; WebKit
    // does not support the 'longtask' entry type — recorded as null) ---
    await page.evaluate(() => {
      window.__perfLongtasks = null;
      try {
        window.__perfLongtasks = [];
        const observer = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__perfLongtasks.push(e.duration);
        });
        observer.observe({ type: 'longtask' });
        window.__perfLtObserver = observer;
      } catch {
        window.__perfLongtasks = null; // unsupported engine
      }
    });

    // --- frame sampler: in-page rAF deltas across the scrub window ---
    // NOTE: this sampler is its own rAF chain, so it measures the
    // BROWSER's frame scheduling under main-thread pressure — which is the
    // active-frame budget — not cosmos draw counts. It self-sustains
    // even though cosmos >= 3.4 idle-stops, because page rAF keeps firing
    // for any registered callback while the tab is visible.
    await page.evaluate(() => {
      window.__perfFrames = [];
      window.__perfFramesStop = false;
      let last = performance.now();
      const loop = (t) => {
        window.__perfFrames.push(t - last);
        last = t;
        if (!window.__perfFramesStop) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });

    // --- histogram scrub: hold the drag and sweep right then left over the
    // packaged component's brushable plot area ---
    const box = await page
      .locator('[data-testid="histogram-panel"] [data-orbit-histogram-plot]')
      .boundingBox();
    if (box === null) throw new Error('histogram plot not visible');
    const y = box.y + box.height * 0.5;
    const xAt = (f) => box.x + box.width * f;

    console.log(
      `perf-lite: [run ${runIndex + 1}/${opts.runs}] scrubbing ${SCRUB_STEPS} brush steps …`,
    );
    await page.mouse.move(xAt(0.2), y);
    await page.mouse.down();
    await page.mouse.move(xAt(0.35), y, { steps: 3 });
    await page.waitForTimeout(300); // initial brush settles (not measured)

    const latencies = [];
    let skipped = 0;
    for (let step = 0; step < SCRUB_STEPS; step++) {
      // Sweep 0.35→0.85 over the first half of the steps, then back.
      const half = SCRUB_STEPS / 2;
      const f =
        step < half ? 0.35 + (0.5 * (step + 1)) / half : 0.85 - (0.5 * (step + 1 - half)) / half;
      const before = await page.evaluate(() => {
        const p = window.__orbitPerf;
        p.clear();
        return { rev: p.renderRevision(), t: performance.now() };
      });
      await page.mouse.move(xAt(f), y);
      try {
        const handle = await page.waitForFunction(
          (rev) => {
            const p = window.__orbitPerf;
            return p.marks.find((m) => m.render > rev) ?? null;
          },
          before.rev,
          { polling: 'raf', timeout: STEP_TIMEOUT_MS },
        );
        const mark = await handle.jsonValue();
        latencies.push(mark.t - before.t);
      } catch {
        skipped += 1; // the move landed inside the same quantized brush value
      }
    }
    await page.mouse.up();

    const frames = await page.evaluate(() => {
      window.__perfFramesStop = true;
      return window.__perfFrames;
    });
    const jsHeapAfterScrub = await page.evaluate(() => {
      const heap = performance.memory?.usedJSHeapSize;
      return typeof heap === 'number' ? heap : null;
    });
    const longTasks = await page.evaluate(() => {
      window.__perfLtObserver?.disconnect();
      const list = window.__perfLongtasks;
      if (list === null) return null;
      return {
        count: list.length,
        maxMs: list.length > 0 ? Math.round(Math.max(...list) * 100) / 100 : 0,
      };
    });

    // --- idle/re-arm probe: park the sim, count NEW rAF registrations
    // over 2s (frame discipline: zero at rest — natural settle takes
    // minutes at L, so the probe parks it), then wake and require ≥1.
    // The harness's own frame sampler is already stopped above.
    const discipline = await page.evaluate(async () => {
      window.__orbitPerf.pauseSimulation();
      await new Promise((r) => setTimeout(r, 800)); // trailing ticks drain
      let registrations = 0;
      const orig = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => {
        registrations += 1;
        return orig(cb);
      };
      await new Promise((r) => setTimeout(r, 2_000));
      const idleRafRegistrations = registrations;
      registrations = 0;
      window.__orbitPerf.resumeSimulation();
      await new Promise((r) => setTimeout(r, 1_000));
      const reArmRegistrations = registrations;
      window.requestAnimationFrame = orig;
      return { idleRafRegistrations, reArmRegistrations };
    });

    if (latencies.length < SCRUB_STEPS / 2) {
      throw new Error(
        `run ${runIndex + 1}: only ${latencies.length}/${SCRUB_STEPS} scrub steps produced a ` +
          'brush publication — the drag likely missed the histogram plot area',
      );
    }

    return {
      firstPaint,
      declFixture: { nodes: declNodes, edges: declEdges },
      nodes: nodeCount,
      edges: edgeCount,
      gpu,
      latencies,
      frames,
      skipped,
      memory: { ...memoryAtSettle, jsHeapAfterScrubBytes: jsHeapAfterScrub },
      longTasks,
      discipline,
    };
  } finally {
    await context.close();
  }
}

async function main(opts) {
  const tier = TIERS[opts.tier];
  const feed = tierFeedParams(opts.tier);

  const browserType = resolveBrowserType(opts.browser);
  if (browserType === null) {
    console.log(
      `perf-lite: SKIPPED — @playwright/test (or browser '${opts.browser}') is not resolvable from apps/demo.`,
    );
    if (opts.enforce) {
      console.error('perf-lite: --enforce with nothing measured cannot pass — exiting nonzero.');
      process.exitCode = 1;
    }
    return;
  }

  console.log(`perf-lite: starting vite (apps/demo) on :${PORT} …`);
  const vite = spawn(
    'pnpm',
    ['exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: DEMO_DIR, stdio: 'ignore', detached: true },
  );
  const killVite = () => {
    try {
      process.kill(-vite.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  };

  let browser = null;
  try {
    await waitForServer(BASE_URL, 30_000);

    try {
      // HEADFUL: this is real-GPU evidence, per the GPU-evidence policy.
      browser = await browserType.launch({ headless: false });
    } catch (err) {
      console.log(
        `perf-lite: SKIPPED — could not launch a headful ${opts.browser} (${err.message}).`,
      );
      if (opts.enforce) {
        console.error('perf-lite: --enforce with nothing measured cannot pass — exiting nonzero.');
        process.exitCode = 1;
      }
      return;
    }

    // Warm-up (unmeasured): the first page load pays the dev server's cold
    // transform and the GPU context init — ~700 ms of harness, not Orbit
    // (measured: 1006 ms cold vs 279/337 ms warm at S). One throwaway load
    // keeps run 1 comparable to the rest; the artifact discloses it.
    console.log('perf-lite: warm-up load (unmeasured) …');
    {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      await page.goto(pageUrlFor(opts, feed));
      await page.waitForSelector(READY_DOT, { timeout: 120_000 });
      await context.close();
    }

    console.log(`perf-lite: ${opts.runs} run(s), URL ${pageUrlFor(opts, feed)}`);
    const runs = [];
    while (runs.length < opts.runs) {
      try {
        runs.push(await measureRun(browser, opts, feed, runs.length));
      } catch (err) {
        // WebKit is a PROBE (WebGL support unproven): fail loudly with the
        // documented-deviation note instead of a bare stack.
        if (opts.browser === 'webkit') {
          throw new Error(
            `webkit probe failed (${err.message}) — if this is a WebGL capability gap, ` +
              'record it as a documented deviation in the measurement protocol',
          );
        }
        throw err;
      }
    }

    // --- aggregate + artifact ---
    const date = new Date();
    const day = date.toISOString().slice(0, 10);
    const environment = {
      os: `${process.platform} ${os.release()}`,
      arch: process.arch,
      // The published reference profile runs gates manually on the M5 Pro.
      // Override with PERF_MACHINE_CLASS
      // when the CPU model string is not the honest class name.
      machineClass: process.env.PERF_MACHINE_CLASS ?? os.cpus()[0]?.model ?? 'unknown',
      node: process.version,
      browser: `${opts.browser} ${browser.version()}`,
      gpu: process.env.PERF_GPU ?? runs[0].gpu,
      headful: true,
      simulation: 'running',
      runs: runs.length,
    };
    const metrics = {
      brushLatencyMs: aggregateRunStats(runs.map((r) => stats(r.latencies))),
      frameMs: aggregateRunStats(runs.map((r) => stats(r.frames))),
      firstPaintMs: {
        ...stats(runs.map((r) => r.firstPaint.totalMs)),
        cvPct: cvPct(runs.map((r) => r.firstPaint.totalMs)),
      },
    };
    const targets = TIER_TARGETS[opts.tier];
    // Stamp target/measured/pass per metric plus
    // qualifying/disqualifiers/overall into the artifact — never a silent
    // number again.
    const gate = evaluatePerfGate({ metrics, targets, profile: environment });

    // The S first-paint fixture is the DECLARATIVE generator, so disclose
    // the actual counts whenever they miss the tier cardinalities.
    const decl = runs[0].declFixture;
    const declDeviation =
      opts.tier === 'S' && (decl.nodes !== tier.nodes || decl.edges !== tier.edges)
        ? `first-paint fixture: declarative generator produced ${decl.nodes}/${decl.edges} ` +
          `vs the S tier ${tier.nodes}/${tier.edges} (declEdgeFactor=${S_DECL_EDGE_FACTOR} calibration)`
        : null;

    const artifact = {
      kind: 'orbit-perf-lite/filter-latency',
      // v2: gate verdicts + honest tier labeling.
      // v3: generator family + seed, firstPaint{total+phases},
      // machineClass, multi-run protocol (per-run records + median-of-p95
      // headlines + cvPct), memory components, explicit
      // gate.disqualifiers.
      version: 3,
      date: date.toISOString(),
      policy:
        'Local real-GPU evidence only (GPU-evidence policy): produced headful by ' +
        'scripts/perf-lite.mjs; CI runs the operation-count gate ' +
        '(packages/core/test/perf-gate.test.ts), never this scenario.',
      environment,
      scenario: {
        tier: opts.tier,
        tierTarget: { nodes: tier.nodes, edges: tier.edges },
        tierDeviation: tier.deviation ?? declDeviation, // null when the fixture IS the tier
        family: opts.family,
        seed: 2026, // the demo stream button's fixed first-click seed
        rows: feed.rows,
        nodes: runs[0].nodes,
        edges: runs[0].edges,
        firstPaintFixture: {
          kind: 'declarative-initial',
          nodes: decl.nodes,
          edges: decl.edges,
          gated: opts.tier === 'S',
        },
        dimension: 'score',
        bins: 30,
        scrubSteps: SCRUB_STEPS,
        skippedSteps: runs.reduce((s, r) => s + r.skipped, 0),
        latencyDefinition:
          't0 = in-page performance.now() immediately before the pointer-move dispatch; ' +
          't1 = store publication of the resulting render revision (engine commit issued ' +
          'synchronously within that publish). Includes CDP dispatch overhead (~1-3 ms).',
        aggregation:
          'headline p50/p95 = MEDIAN of per-run quantiles; cvPct = sample CV across ' +
          'per-run p95s (firstPaintMs: across per-run totals); samples = pooled count',
        warmup:
          'one unmeasured full page load before run 1 (dev-server transform + GPU ' +
          'context init are harness cost, not Orbit first paint)',
      },
      brushLatencyMs: metrics.brushLatencyMs,
      frameMs: metrics.frameMs,
      firstPaintMs: metrics.firstPaintMs,
      // Frame discipline (reported-only; the deterministic half lives in
      // packages/core/test/frame-discipline.test.ts): longtask entries during
      // the scrub (null = engine without 'longtask' support), rAF
      // registrations over a 2s parked-sim window (0 = the gated clock is
      // honest at tier scale), and the ≥1-frame re-arm on wake.
      frameDiscipline: {
        idleRafRegistrationsMax: Math.max(...runs.map((r) => r.discipline.idleRafRegistrations)),
        reArmedAllRuns: runs.every((r) => r.discipline.reArmRegistrations >= 1),
        longTasks: runs[0].longTasks === null
          ? null
          : {
              countMax: Math.max(...runs.map((r) => r.longTasks.count)),
              maxMs: Math.max(...runs.map((r) => r.longTasks.maxMs)),
            },
      },
      runs: runs.map((r, i) => ({
        run: i + 1,
        firstPaint: r.firstPaint,
        brushLatencyMs: {
          ...stats(r.latencies),
          raw: r.latencies.map((v) => round2(v)),
        },
        frameMs: stats(r.frames),
        skippedSteps: r.skipped,
        memory: r.memory,
        longTasks: r.longTasks,
        discipline: r.discipline,
      })),
      gate: {
        qualifying: gate.qualifying,
        disqualifiers: gate.disqualifiers,
        overall: gate.overall,
        verdicts: gate.verdicts,
      },
    };

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const browserSuffix = opts.browser === 'chromium' ? '' : `-${opts.browser}`;
    const outPath = path.join(
      EVIDENCE_DIR,
      `filter-latency-${day}-${opts.tier}-${opts.family}${browserSuffix}.json`,
    );
    fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

    console.log(`perf-lite: wrote ${path.relative(REPO_ROOT, outPath)}`);
    console.log(
      `perf-lite: brush→publish p50 ${artifact.brushLatencyMs.p50}ms / p95 ${artifact.brushLatencyMs.p95}ms; ` +
        `frame p50 ${artifact.frameMs.p50}ms / p95 ${artifact.frameMs.p95}ms (cv ${artifact.frameMs.cvPct ?? 'n/a'}%); ` +
        `first paint p95 ${artifact.firstPaintMs.p95}ms — ${runs.length} run(s) on ${artifact.environment.gpu}`,
    );
    console.log(
      `perf-lite: discipline — idle rAF max ${artifact.frameDiscipline.idleRafRegistrationsMax}/2s, ` +
        `re-armed ${artifact.frameDiscipline.reArmedAllRuns}, longtasks ${
          artifact.frameDiscipline.longTasks === null
            ? 'n/a'
            : `${artifact.frameDiscipline.longTasks.countMax} (max ${artifact.frameDiscipline.longTasks.maxMs}ms)`
        }`,
    );
    const verdictSummary = gate.verdicts
      .map((v) =>
        v.target === null
          ? `${v.metric} ${v.measured}ms (reported-only)`
          : `${v.metric} ${v.measured}ms vs ${v.strict === true ? '<' : '≤'}${v.target}ms ${v.pass === true ? 'PASS' : v.pass === false ? 'FAIL' : 'n/a'}`,
      )
      .join('; ');
    console.log(
      `perf-lite: gate ${gate.overall} (qualifying=${gate.qualifying}, tier=${opts.tier}, family=${opts.family}) — ${verdictSummary}`,
    );
    for (const reason of gate.disqualifiers) {
      console.log(`perf-lite:   disqualifier: ${reason}`);
    }

    if (gate.overall === 'fail' && gate.qualifying) {
      // Make a qualifying failure impossible to overlook in the console;
      // the local artifact records the same verdict.
      console.error('');
      console.error('perf-lite: *****************************************************************');
      console.error('perf-lite: **  PERF GATE FAIL on a QUALIFYING profile  **');
      for (const v of gate.verdicts) {
        if (v.pass === false) {
          console.error(
            `perf-lite: **    ${v.metric}: measured ${v.measured} ms vs target ${v.strict === true ? '<' : '≤'}${v.target} ms`,
          );
        }
      }
      console.error('perf-lite: **  The local artifact records this verdict; optimization      **');
      console.error('perf-lite: **  remains required before the run can pass.                  **');
      console.error('perf-lite: *****************************************************************');
      console.error('');
    }

    if (opts.enforce) {
      process.exitCode = enforceExitCode(gate.overall);
    }
  } finally {
    if (browser !== null) await browser.close();
    killVite();
  }
}

Promise.resolve()
  .then(() => main(parseArgs(process.argv.slice(2))))
  .catch((err) => {
    console.error(`perf-lite: FAILED — ${err.message}`);
    process.exitCode = 1;
  });
