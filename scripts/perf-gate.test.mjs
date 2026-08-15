/**
 * Unit tests for the pure gate evaluator in scripts/perf-gate.mjs.
 * Run with `pnpm perf:gate`; these tests use no browser or GPU harness.
 * The `--enforce` process path remains a separate integration concern, while
 * this suite pins evaluator and exit-code semantics through pure functions.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  L_TIER_TARGETS,
  S_TIER_TARGETS,
  TIERS,
  TIER_TARGETS,
  enforceExitCode,
  evaluatePerfGate,
  isQualifyingProfile,
} from './perf-gate.mjs';

/** A qualifying reference profile (real GPU, headful). */
const QUALIFYING_PROFILE = {
  gpu: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)',
  headful: true,
  simulation: 'running',
};

/** Well-formed metrics with a controllable frame p95. */
function metricsWith({ frameP95, frameSamples = 132, brushP95 = 20, brushSamples = 40 } = {}) {
  return {
    frameMs: { samples: frameSamples, p50: 8, p95: frameP95, max: frameP95 + 5, mean: 9 },
    brushLatencyMs: { samples: brushSamples, p50: 12, p95: brushP95, max: brushP95 + 5, mean: 13 },
  };
}

function run(metrics, profile = QUALIFYING_PROFILE) {
  return evaluatePerfGate({ metrics, targets: L_TIER_TARGETS, profile });
}

function frameVerdict(result) {
  const v = result.verdicts.find((x) => x.metric === 'frameMs.p95');
  assert.ok(v, 'frameMs.p95 verdict present');
  return v;
}

// --- encoded targets -------------------------------------------------------

test('L tier is the cardinality (100K nodes / 250K edges) and L-lite names its deviation', () => {
  assert.equal(TIERS.L.nodes, 100_000);
  assert.equal(TIERS.L.edges, 250_000);
  assert.equal(TIERS.L.deviation, null);
  assert.equal(TIERS['L-lite'].edges, 25_000);
  assert.match(TIERS['L-lite'].deviation, /250K/);
});

test('the only gated target is the L active-frame p95 ≤ 33 ms; brush latency is reported-only', () => {
  const gated = L_TIER_TARGETS.filter((t) => t.maxMs !== null);
  assert.equal(gated.length, 1);
  assert.equal(gated[0].metric, 'frameMs.p95');
  assert.equal(gated[0].maxMs, 33);
  const brush = L_TIER_TARGETS.find((t) => t.metric === 'brushLatencyMs.p95');
  assert.equal(brush.maxMs, null);
});

// --- gate evaluation below / at / above the 33 ms budget --------------------

test('frame p95 below budget on a qualifying profile passes', () => {
  const result = run(metricsWith({ frameP95: 32.9 }));
  assert.equal(result.qualifying, true);
  assert.equal(result.overall, 'pass');
  const v = frameVerdict(result);
  assert.equal(v.pass, true);
  assert.equal(v.target, 33);
  assert.equal(v.measured, 32.9);
});

test('frame p95 exactly at 33 ms passes (gate is ≤, not <)', () => {
  const result = run(metricsWith({ frameP95: 33 }));
  assert.equal(result.overall, 'pass');
  assert.equal(frameVerdict(result).pass, true);
});

test('frame p95 above budget on a qualifying profile fails, with the verdict recorded', () => {
  const result = run(metricsWith({ frameP95: 33.01 }));
  assert.equal(result.overall, 'fail');
  const v = frameVerdict(result);
  assert.equal(v.pass, false);
  assert.equal(v.target, 33);
  assert.equal(v.measured, 33.01);
});

test('brush latency is recorded but never gates: target null, pass null, overall unaffected', () => {
  const result = run(metricsWith({ frameP95: 20, brushP95: 500, brushSamples: 40 }));
  const brush = result.verdicts.find((v) => v.metric === 'brushLatencyMs.p95');
  assert.equal(brush.target, null);
  assert.equal(brush.pass, null);
  assert.equal(brush.measured, 500);
  assert.match(brush.note, /reported-only/);
  assert.equal(result.overall, 'pass');
});

// --- qualifying-profile rule ------------------------------------------------

test('SwiftShader is not evidence: over-budget numbers yield not-qualifying, never fail', () => {
  const profile = {
    gpu: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))',
    headful: true,
    simulation: 'running',
  };
  assert.equal(isQualifyingProfile(profile), false);
  const result = run(metricsWith({ frameP95: 74.9 }), profile);
  assert.equal(result.qualifying, false);
  assert.equal(result.overall, 'not-qualifying');
});

test('a non-qualifying run can never pass, even under budget', () => {
  const result = run(metricsWith({ frameP95: 10 }), { ...QUALIFYING_PROFILE, headful: false });
  assert.equal(result.qualifying, false);
  assert.equal(result.overall, 'not-qualifying');
});

test('a missing or unavailable GPU renderer string disqualifies the profile', () => {
  assert.equal(isQualifyingProfile({ ...QUALIFYING_PROFILE, gpu: 'unavailable' }), false);
  assert.equal(isQualifyingProfile({ ...QUALIFYING_PROFILE, gpu: '' }), false);
  assert.equal(isQualifyingProfile(null), false);
  assert.equal(isQualifyingProfile(QUALIFYING_PROFILE), true);
});

// --- malformed / insufficient metrics ⇒ invalid, never pass ------------------

test('missing frameMs group is invalid', () => {
  const metrics = metricsWith({ frameP95: 10 });
  delete metrics.frameMs;
  const result = run(metrics);
  assert.equal(result.overall, 'invalid');
  const v = frameVerdict(result);
  assert.equal(v.pass, null);
  assert.match(v.note, /invalid/);
});

test('non-numeric p95 is invalid', () => {
  const metrics = metricsWith({ frameP95: 10 });
  metrics.frameMs.p95 = null;
  assert.equal(run(metrics).overall, 'invalid');
});

test('insufficient frame samples are invalid even when under budget', () => {
  const result = run(metricsWith({ frameP95: 10, frameSamples: 12 }));
  assert.equal(result.overall, 'invalid');
  assert.equal(frameVerdict(result).pass, null);
});

test('insufficient brush samples (skipped scrub steps) are invalid even with a passing frame p95', () => {
  const result = run(metricsWith({ frameP95: 10, brushSamples: 12 }));
  assert.equal(result.overall, 'invalid');
});

test('invalid takes precedence over not-qualifying (it can never pass either way)', () => {
  const result = run(metricsWith({ frameP95: 10, frameSamples: 0 }), {
    ...QUALIFYING_PROFILE,
    headful: false,
  });
  assert.equal(result.qualifying, false);
  assert.equal(result.overall, 'invalid');
});

test('no gated targets at all is invalid — an evaluation that gates nothing must not pass', () => {
  const reportedOnly = [{ metric: 'brushLatencyMs.p95', maxMs: null, minSamples: 20 }];
  const result = evaluatePerfGate({
    metrics: metricsWith({ frameP95: 10 }),
    targets: reportedOnly,
    profile: QUALIFYING_PROFILE,
  });
  assert.equal(result.overall, 'invalid');
  assert.equal(
    evaluatePerfGate({ metrics: metricsWith({ frameP95: 10 }), targets: [], profile: QUALIFYING_PROFILE })
      .overall,
    'invalid',
  );
});

// --- enforce-mode exit semantics (pure — no GPU harness spawned) -------------

test('--enforce exits 0 only for an evaluated pass', () => {
  assert.equal(enforceExitCode('pass'), 0);
  assert.equal(enforceExitCode('fail'), 1);
  assert.equal(enforceExitCode('not-qualifying'), 1);
  assert.equal(enforceExitCode('invalid'), 1);
});

// --- S tier + first-paint gate ----------------------------------------------

test('S tier is the cardinality (10K/25K) and gates ONLY first paint ≤ 500 ms', () => {
  assert.equal(TIERS.S.nodes, 10_000);
  assert.equal(TIERS.S.edges, 25_000);
  assert.equal(TIERS.S.deviation, null);
  const gated = S_TIER_TARGETS.filter((t) => t.maxMs !== null);
  assert.equal(gated.length, 1);
  assert.equal(gated[0].metric, 'firstPaintMs.p95');
  assert.equal(gated[0].maxMs, 500);
  assert.equal(TIER_TARGETS.S, S_TIER_TARGETS);
  assert.equal(TIER_TARGETS.L, L_TIER_TARGETS);
  assert.equal(TIER_TARGETS['L-lite'], L_TIER_TARGETS);
});

test('S first-paint under budget over 3 runs passes; over budget fails', () => {
  const profile = { ...QUALIFYING_PROFILE, runs: 3 };
  const mk = (p95) => ({
    ...metricsWith({ frameP95: 20 }),
    firstPaintMs: { samples: 3, p50: p95 - 20, p95, max: p95 + 5, mean: p95 - 10, cvPct: 4 },
  });
  const pass = evaluatePerfGate({ metrics: mk(480), targets: S_TIER_TARGETS, profile });
  assert.equal(pass.overall, 'pass');
  const fail = evaluatePerfGate({ metrics: mk(500.01), targets: S_TIER_TARGETS, profile });
  assert.equal(fail.overall, 'fail');
  // Boundary semantics differ BY SPEC WORDING: the S gate is "p95 <500 ms"
  // (strict — exactly 500 fails) while the L frame gate is "≤33 ms"
  // (exactly 33 passes, pinned in its own test above).
  const boundary = evaluatePerfGate({ metrics: mk(500), targets: S_TIER_TARGETS, profile });
  assert.equal(boundary.overall, 'fail');
  // Frame time at S is reported-only — an S run never gates on frames.
  const frame = pass.verdicts.find((v) => v.metric === 'frameMs.p95');
  assert.equal(frame.target, null);
});

// --- multi-run qualification (measurement protocol: n≥3 + CV) ----------------

test('fewer than 3 declared runs disqualifies — single-run numbers are not evidence', () => {
  const result = run(metricsWith({ frameP95: 20 }), { ...QUALIFYING_PROFILE, runs: 1 });
  assert.equal(result.qualifying, false);
  assert.equal(result.overall, 'not-qualifying');
  assert.ok(result.disqualifiers.some((r) => /n≥3/.test(r)));
});

test('a legacy artifact that declares NO run count is not run-disqualified (v2 compat)', () => {
  // QUALIFYING_PROFILE has no `runs` field — the rule applies only to
  // artifacts that declare their run count, preserving v2 compatibility.
  const result = run(metricsWith({ frameP95: 20 }));
  assert.equal(result.qualifying, true);
  assert.equal(result.overall, 'pass');
  assert.deepEqual(result.disqualifiers, []);
});

test('CV above the gated metric\'s bound disqualifies (high variance is not evidence)', () => {
  const metrics = metricsWith({ frameP95: 20 });
  metrics.frameMs.cvPct = 20.1; // L frameMs bound is 20
  const result = run(metrics, { ...QUALIFYING_PROFILE, runs: 3 });
  assert.equal(result.qualifying, false);
  assert.equal(result.overall, 'not-qualifying');
  assert.ok(result.disqualifiers.some((r) => /high variance/.test(r)));
  assert.match(frameVerdict(result).note, /high-variance/);
});

test('CV at or under the bound with n≥3 stays qualifying — and it never rescues a FAIL', () => {
  const ok = metricsWith({ frameP95: 20 });
  ok.frameMs.cvPct = 20; // exactly at the bound: not over
  const pass = run(ok, { ...QUALIFYING_PROFILE, runs: 3 });
  assert.equal(pass.overall, 'pass');
  assert.deepEqual(pass.disqualifiers, []);

  const bad = metricsWith({ frameP95: 74.9 });
  bad.frameMs.cvPct = 3;
  const fail = run(bad, { ...QUALIFYING_PROFILE, runs: 3 });
  assert.equal(fail.overall, 'fail'); // stable AND over budget = an honest fail
});

test('absent cvPct with maxCvPct declared does not variance-disqualify (runs rule owns that)', () => {
  const result = run(metricsWith({ frameP95: 20 }), { ...QUALIFYING_PROFILE, runs: 3 });
  assert.equal(result.overall, 'pass');
  assert.deepEqual(result.disqualifiers, []);
});
