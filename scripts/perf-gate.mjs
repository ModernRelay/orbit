#!/usr/bin/env node
/**
 * perf-gate — pure gate evaluation for perf-lite artifacts.
 *
 * No I/O, no GPU, no Playwright. `evaluatePerfGate` takes measured stats and
 * returns per-metric verdicts plus an overall outcome, so scripts/perf-lite.mjs
 * can stamp `target` / `measured` / `pass` per metric and `qualifying` /
 * `overall` into every artifact it writes, and scripts/perf-gate.test.mjs
 * (node:test, wired into the root `check` chain) can pin the semantics without
 * spawning the headful harness. CI never runs the GPU scenario; only this
 * evaluator's unit tests run everywhere.
 *
 * Encoded targets (L tier):
 * - `frameMs.p95` ≤ 33 ms — the initial L-tier active-frame release gate on
 * the published reference desktop.
 * - `brushLatencyMs.p95` — REPORTED-ONLY. Filter latency measures the brush
 * event through the committed engine revision, but has no numeric gate: the
 * only initial release gates are the
 * S first-paint and L active-frame budgets. Narrower operation budgets
 * graduate from hypothesis to release gate only after the harness publishes
 * raw artifacts. Gate evaluation therefore reports pass/fail against the L
 * active-frame gate only. The verdict records the
 * measurement with `target: null`, `pass: null`.
 *
 * Qualifying profile: local
 * real-GPU evidence only — headful, never SwiftShader or another software
 * rasterizer. A non-qualifying run is overall 'not-qualifying': never 'pass'
 * AND never 'fail' — its numbers are not evidence in either direction.
 * Malformed or insufficient metrics are 'invalid' and can never pass.
 */

/**
 * Published tier cardinalities. `L-lite` is the honest under-tier escape
 * hatch: the same generator family and L-tier node count, but only 10% of the
 * edge budget; the artifact discloses that difference via `deviation`.
 */
export const TIERS = Object.freeze({
  S: Object.freeze({ nodes: 10_000, edges: 25_000, deviation: null }),
  L: Object.freeze({ nodes: 100_000, edges: 250_000, deviation: null }),
  'L-lite': Object.freeze({
    nodes: 100_000,
    edges: 25_000,
    deviation:
      '25K edges vs the L-tier 250K (10% of the edge budget) — under-tier fixture; ' +
      'a pass against the L budgets here is NOT L-tier evidence',
  }),
});

/**
 * Target descriptors consumed by `evaluatePerfGate`. `metric` is
 * '<statsGroup>.<stat>' into the artifact metrics; `maxMs: null` marks a
 * reported-only budget (recorded, never gated); `minSamples` guards against
 * truncated windows — below it the run is 'invalid', never 'pass'.
 */
export const L_TIER_TARGETS = Object.freeze([
  Object.freeze({
    metric: 'frameMs.p95',
    maxMs: 33,
    // At least one frame per scrub step by construction (each step waits on a
    // rendered revision); fewer means the sampling window was truncated.
    minSamples: 40,
    // Run-to-run stability bound over per-run p95s (measurement protocol:
    // n≥3 + CV). PROVISIONAL calibration: browser frame p95 on the in-use
    // M5 Pro reference machine showed ~15% CV across clean 3-run sets
    // — 20% flags genuinely wild
    // sets (the 68→100 ms pair) without disqualifying every honest run.
    maxCvPct: 20,
    label: 'L-tier active-frame p95',
    source: 'initial release gate: L active-frame p95 ≤33 ms on the reference desktop',
  }),
  Object.freeze({
    metric: 'brushLatencyMs.p95',
    maxMs: null,
    // Matches perf-lite's own floor: at least SCRUB_STEPS/2 steps must publish.
    minSamples: 20,
    label: 'filter (brush→publish) latency p95',
    source:
      'filter latency measures brush event through committed engine revision; ' +
      'no numeric release gate is defined yet',
  }),
]);

/**
 * S-tier target descriptors. The S release gate is FIRST PAINT: p95 <500 ms
 * on the published reference desktop. `firstPaintMs` stats aggregate PER-RUN
 * totals (one first paint per run), so p95 needs the multi-run protocol — single runs are
 * disqualified via the runs<3 profile rule, not via minSamples.
 * Frame time and brush latency at S are reported-only (names no S-tier
 * numbers for them).
 */
export const S_TIER_TARGETS = Object.freeze([
  Object.freeze({
    metric: 'firstPaintMs.p95',
    maxMs: 500,
    // wording is STRICT here ("p95 <500 ms") — unlike the L frame gate's
    // "≤33 ms". Exactly 500.00 must fail.
    strict: true,
    minSamples: 1, // one sample per run; the runs<3 disqualifier guards depth
    // PROVISIONAL calibration like the L frame bound: clean warm-load 3-run
    // sets on the reference machine measured 6.4% and 13.2% CV on ~300 ms
    // loads (dev-server jitter) — 15% admits honest sets while the cold
    // compile pathology (74% before the warm-up load) stays disqualified.
    maxCvPct: 15,
    label: 'S-tier first-paint p95',
    source: 'initial release gate: S first-paint p95 <500 ms on the reference desktop',
  }),
  Object.freeze({
    metric: 'frameMs.p95',
    maxMs: null,
    minSamples: 40,
    label: 'S-tier active-frame p95 (reported-only)',
    source: 'the active-frame release gate is defined at the L tier only',
  }),
  Object.freeze({
    metric: 'brushLatencyMs.p95',
    maxMs: null,
    minSamples: 20,
    label: 'filter (brush→publish) latency p95',
    source: 'filter latency is reported with no numeric release gate yet',
  }),
]);

/** Gate targets per tier name (perf-lite picks by --tier). */
export const TIER_TARGETS = Object.freeze({
  S: S_TIER_TARGETS,
  L: L_TIER_TARGETS,
  'L-lite': L_TIER_TARGETS,
});

/** GPU renderer strings that are software rasterizers, i.e. not evidence. */
const SOFTWARE_RASTERIZER_RE =
  /swiftshader|llvmpipe|softpipe|software rasterizer|basic render/i;

/**
 * Reasons a run's environment profile fails the documented reference-profile
 * rule (the measurement protocol "Evidence policy": local real-GPU
 * evidence only — headful, no software rasterizer). Empty array ⇒ qualifying.
 */
export function profileDisqualifiers(profile) {
  if (profile === null || typeof profile !== 'object') {
    return ['no environment profile recorded'];
  }
  const reasons = [];
  if (profile.headful !== true) {
    reasons.push('not headful (real-GPU evidence policy requires a headful browser)');
  }
  const gpu = typeof profile.gpu === 'string' ? profile.gpu.trim() : '';
  if (gpu === '' || gpu === 'unavailable') {
    reasons.push('no GPU renderer string recorded');
  } else if (SOFTWARE_RASTERIZER_RE.test(gpu)) {
    reasons.push(`software rasterizer is not evidence: ${gpu}`);
  }
  // Measurement protocol: single runs on an in-use desktop are not evidence;
  // gates need n≥3 with the CV recorded.
  // Absent field = a pre-multi-run artifact (v2); the rule applies only to
  // artifacts that declare their run count.
  if (typeof profile.runs === 'number' && profile.runs < 3) {
    reasons.push(
      `only ${profile.runs} run${profile.runs === 1 ? '' : 's'} — gate evidence needs n≥3 ` +
        '(measurement protocol: median of per-run p95s + CV)',
    );
  }
  return reasons;
}

export function isQualifyingProfile(profile) {
  return profileDisqualifiers(profile).length === 0;
}

/**
 * Pure gate evaluation.
 *
 * @param {object} input
 * @param {object} input.metrics Artifact stats groups, e.g.
 * `{ frameMs: {samples, p50, p95,...}, brushLatencyMs: {...} }`.
 * @param {readonly object[]} input.targets Target descriptors (see
 * L_TIER_TARGETS).
 * @param {object} input.profile `{ gpu, headful,... }` environment profile.
 * @returns {{ verdicts: {metric, target, measured, samples, pass, note}[],
 * qualifying: boolean,
 * overall: 'pass'|'fail'|'not-qualifying'|'invalid' }}
 *
 * Overall precedence: 'invalid' (malformed/insufficient metrics, or nothing
 * gated at all — an evaluation that measured nothing must never pass) beats
 * 'not-qualifying' (wrong profile: not 'pass', but not 'fail' either) beats
 * the measured 'fail'/'pass'. Per-metric `pass` is the raw ≤-comparison
 * (`measured <= target`, so exactly-on-budget passes); it is `null` for
 * reported-only or unevaluable metrics.
 */
export function evaluatePerfGate({ metrics, targets, profile }) {
  const disqualifiers = [...profileDisqualifiers(profile)];
  const groups = metrics !== null && typeof metrics === 'object' ? metrics : {};
  const list = Array.isArray(targets) ? targets : [];

  const verdicts = [];
  let invalid = false;
  let gatedCount = 0;
  let failedCount = 0;

  for (const spec of list) {
    const [groupName, statName] = String(spec.metric).split('.');
    const group =
      groups[groupName] !== null && typeof groups[groupName] === 'object'
        ? groups[groupName]
        : null;
    const measuredRaw = group === null ? undefined : group[statName];
    const samplesRaw = group === null ? undefined : group.samples;
    const measured =
      typeof measuredRaw === 'number' && Number.isFinite(measuredRaw) ? measuredRaw : null;
    const samples =
      typeof samplesRaw === 'number' && Number.isFinite(samplesRaw) ? samplesRaw : null;
    const target = typeof spec.maxMs === 'number' && Number.isFinite(spec.maxMs) ? spec.maxMs : null;
    const minSamples = typeof spec.minSamples === 'number' ? spec.minSamples : 1;

    const verdict = { metric: spec.metric, target, measured, samples, pass: null, note: null };
    if (spec.strict === true) verdict.strict = true; // gate comparison is <, not ≤
    if (measured === null) {
      invalid = true;
      verdict.note = 'invalid: metric missing or non-numeric';
    } else if (samples === null || samples < minSamples) {
      invalid = true;
      verdict.note = `invalid: insufficient samples (${samples ?? 'none'} < ${minSamples} required)`;
    } else if (target === null) {
      verdict.note =
        'reported-only: names no numeric budget for this metric (no release gate yet)';
    } else {
      gatedCount += 1;
      // Per-target boundary semantics: `strict` gates with < (the S
      // first-paint "p95 <500 ms"); default gates with ≤ (the L "≤33 ms"
      // exactly-on-budget passes).
      verdict.pass = spec.strict === true ? measured < target : measured <= target;
      if (verdict.pass === false) failedCount += 1;
      // Run-to-run variance bound: a gated metric whose per-run spread blows
      // the CV bound is NOT evidence in either direction (same class as a
      // software rasterizer) — not-qualifying, never pass or fail. Absent
      // cvPct (single run / legacy artifact) is handled by the runs<3
      // profile rule, not here.
      const cvRaw = group === null ? undefined : group.cvPct;
      const cv = typeof cvRaw === 'number' && Number.isFinite(cvRaw) ? cvRaw : null;
      const maxCv =
        typeof spec.maxCvPct === 'number' && Number.isFinite(spec.maxCvPct)
          ? spec.maxCvPct
          : null;
      if (cv !== null && maxCv !== null && cv > maxCv) {
        disqualifiers.push(
          `high variance: ${spec.metric} cv ${cv}% > ${maxCv}% across runs — not evidence`,
        );
        verdict.note = `high-variance (cv ${cv}% > ${maxCv}%): verdict recorded but not evidence`;
      }
    }
    verdicts.push(verdict);
  }

  const qualifying = disqualifiers.length === 0;
  let overall;
  if (invalid || gatedCount === 0) overall = 'invalid';
  else if (!qualifying) overall = 'not-qualifying';
  else overall = failedCount > 0 ? 'fail' : 'pass';

  return { verdicts, qualifying, disqualifiers, overall };
}

/**
 * Enforce-mode exit semantics (`perf-lite --enforce`): only an evaluated
 * 'pass' exits 0 — 'fail', 'not-qualifying', and 'invalid' all exit nonzero.
 * Default (no --enforce) evidence-collection mode never consults this.
 */
export function enforceExitCode(overall) {
  return overall === 'pass' ? 0 : 1;
}
