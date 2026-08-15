#!/usr/bin/env node
/**
 * XL acceptance decomposition benchmark.
 *
 * Worker columnar acceptance has landed. This benchmark measures its cargo
 * in-process alongside the old and new main-side costs, deterministically in
 * Node against the BUILT core barrel. It covers XL-scale columnar input
 * (1M nodes / 2.5M edges) — structural validation, materialization, full
 * acceptance through the real instance over FakeEngine, a brush step at
 * that scale, the engaged ladder steps, and heap growth. It does not measure
 * worker scheduling or transfer overlap, browser/GPU work, or frame times.
 *
 * Run: pnpm --filter @modernrelay/orbit-core build && node scripts/xl-bench.mjs
 * Output: .evidence/perf/xl-mainlane-<date>.json
 * (local-only; .evidence is gitignored).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(REPO_ROOT, 'packages', 'core', 'dist', 'index.js');
const TESTING = path.join(REPO_ROOT, 'packages', 'core', 'dist', 'testing.js');
const EVIDENCE_DIR = path.join(REPO_ROOT, '.evidence', 'perf'); // local-only (gitignored)

const NODES = 1_000_000;
const EDGES = 2_500_000;
const RUNS = 3;
const CLUSTERS = 12;

const {
  createGraphInstance,
  validateColumnarStructure,
  materializeColumnarSnapshot,
  acceptColumnar,
  buildAcceptedFromColumnar,
  encodeStringTable,
  validateSnapshot,
} = await import(CORE);
const { FakeEngine } = await import(TESTING);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Clustered-family XL columnar snapshot (typed columns — the intended lane). */
function buildSnapshot(seed) {
  const rng = mulberry32(seed);
  const ids = new Array(NODES);
  const scores = new Float64Array(NODES);
  const clusterCodes = new Uint32Array(NODES);
  for (let i = 0; i < NODES; i++) {
    ids[i] = `n${i}`;
    scores[i] = Math.round(rng() * 1000) / 10;
    clusterCodes[i] = i % CLUSTERS;
  }
  const source = new Uint32Array(EDGES);
  const target = new Uint32Array(EDGES);
  for (let e = 0; e < EDGES; e++) {
    const t = 1 + Math.floor(rng() * (NODES - 1));
    const earlierPeers = Math.floor(t / CLUSTERS);
    const intra = earlierPeers > 0 && rng() >= 0.12;
    source[e] = intra
      ? t - CLUSTERS * (1 + Math.floor(rng() * earlierPeers))
      : Math.floor(rng() * t);
    target[e] = t;
  }
  const edgeIds = new Array(EDGES);
  for (let e = 0; e < EDGES; e++) edgeIds[e] = `e${e}`;
  return {
    kind: 'columnar',
    datasetKey: 'xl-bench',
    sourceRevision: seed,
    nodes: {
      ids: { kind: 'string', dictionary: ids, codes: Uint32Array.from({ length: NODES }, (_, i) => i) },
      columns: {
        score: { kind: 'f64', data: scores },
      },
      length: NODES,
    },
    edges: {
      ids: {
        kind: 'string',
        dictionary: edgeIds,
        codes: Uint32Array.from({ length: EDGES }, (_, e) => e),
      },
      source,
      target,
      columns: {},
      length: EDGES,
    },
  };
}

const round1 = (v) => Math.round(v * 10) / 10;
const heapMb = () => Math.round(process.memoryUsage().heapUsed / 1_048_576);

async function oneRun(seed) {
  const buildT0 = performance.now();
  const snapshot = buildSnapshot(seed);
  const buildMs = performance.now() - buildT0;
  const heapAfterBuild = heapMb();

  // Phase decomposition (the same functions the instance calls).
  const vT0 = performance.now();
  const issues = validateColumnarStructure(snapshot);
  const validateMs = performance.now() - vT0;
  if (issues.length > 0) throw new Error(`fixture invalid: ${issues[0].detail}`);
  const mT0 = performance.now();
  const materialized = materializeColumnarSnapshot(snapshot);
  const materializeMs = performance.now() - mT0;
  const heapAfterMaterialize = heapMb();
  if (materialized.nodes.length !== NODES) throw new Error('materialize lost rows');

  // --- worker-path decomposition: what MOVES off the main thread and
  // what the new main-side path costs. In production `acceptColumnar` runs
  // in the worker; here it runs in-process to measure the WORK, not the
  // thread overlap.
  const ovT0 = performance.now();
  const oracleAccepted = validateSnapshot(materialized);
  const objectValidateMs = performance.now() - ovT0; // OLD main-side cost
  if (oracleAccepted.nodes.length !== NODES) throw new Error('oracle lost rows');

  const encT0 = performance.now();
  encodeStringTable(snapshot.nodes.ids.dictionary);
  encodeStringTable(snapshot.edges.ids.dictionary);
  const encodeMs = performance.now() - encT0; // NEW main-side wire cost

  const acT0 = performance.now();
  const acceptance = acceptColumnar(snapshot);
  const acceptColumnarMs = performance.now() - acT0; // OFF-THREAD in prod

  const baT0 = performance.now();
  const built = buildAcceptedFromColumnar(snapshot, acceptance);
  const buildAcceptedMs = performance.now() - baT0; // NEW main-side cost
  if (built.nodes.length !== NODES) throw new Error('buildAccepted lost rows');

  // End-to-end acceptance through the real instance (fresh snapshot — the
  // instance path re-validates and re-materializes internally).
  const engine = new FakeEngine();
  const instance = createGraphInstance({ engine: () => engine, fitViewOnFirstData: false });
  await instance.attach({ nodeType: 1 }); // headless dummy container
  const fresh = buildSnapshot(seed);
  const aT0 = performance.now();
  instance.applyHostUpdate({
    data: fresh,
    crossfilter: [{ key: 'score', kind: 'numeric', get: (n) => n.attrs?.score ?? null, bins: 30 }],
  });
  const acceptMs = performance.now() - aT0;
  const heapAfterAccept = heapMb();

  const snap = instance.getPerfSnapshot();
  const session = instance.getCrossfilterSession();
  let brushMs = null;
  if (session !== null) {
    const bT0 = performance.now();
    await session.setBrush('score', { min: 20, max: 60 });
    brushMs = performance.now() - bT0;
  }

  const result = {
    fixtureBuildMs: round1(buildMs),
    validateMs: round1(validateMs),
    materializeMs: round1(materializeMs),
    // OLD main block (execution 'main'): materialize + object validation.
    // NEW main block (worker path): encode + buildAccepted (+ validateMs).
    // OFF-thread: acceptColumnar.
    objectValidateMs: round1(objectValidateMs),
    encodeMs: round1(encodeMs),
    acceptColumnarMs: round1(acceptColumnarMs),
    buildAcceptedMs: round1(buildAcceptedMs),
    mainBlockOldMs: round1(materializeMs + objectValidateMs),
    mainBlockNewMs: round1(encodeMs + buildAcceptedMs),
    acceptEndToEndMs: round1(acceptMs),
    brushStepMs: brushMs === null ? null : round1(brushMs),
    lastCommitMs: snap.lastCommitMs ?? null,
    activeDegradations: snap.activeDegradations,
    estimatedCpuBytes: snap.estimatedCpuBytes,
    estimatedGpuBytes: snap.estimatedGpuBytes ?? null,
    nodeCount: snap.nodeCount,
    edgeCount: snap.edgeCount,
    heapMb: {
      afterFixtureBuild: heapAfterBuild,
      afterMaterialize: heapAfterMaterialize,
      afterAccept: heapAfterAccept,
    },
  };
  instance.destroy();
  return result;
}

const runs = [];
for (let i = 0; i < RUNS; i++) {
  console.log(`xl-bench: run ${i + 1}/${RUNS} (1M nodes / 2.5M edges, clustered) …`);
  runs.push(await oneRun(1337 + i));
  if (global.gc) global.gc();
}

const median = (key) => {
  const vals = runs.map((r) => r[key]).sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
};

const date = new Date();
const artifact = {
  kind: 'orbit-xl-mainlane-bench',
  version: 1,
  date: date.toISOString(),
  tierDisclosure:
    'Node-only XL decomposition: worker columnar acceptance is measured in-process ' +
    'alongside old and new main-side costs. The run uses FakeEngine and does not measure ' +
    'worker scheduling or transfer overlap, browser/GPU work, or frame times.',
  environment: {
    node: process.version,
    machineClass: process.env.PERF_MACHINE_CLASS ?? os.cpus()[0]?.model ?? 'unknown',
    os: `${process.platform} ${os.release()}`,
  },
  scenario: {
    nodes: NODES,
    edges: EDGES,
    family: 'clustered',
    seeds: runs.map((_, i) => 1337 + i),
    runs: RUNS,
  },
  medians: {
    validateMs: median('validateMs'),
    materializeMs: median('materializeMs'),
    acceptEndToEndMs: median('acceptEndToEndMs'),
    brushStepMs: median('brushStepMs'),
    mainBlockOldMs: median('mainBlockOldMs'),
    mainBlockNewMs: median('mainBlockNewMs'),
    acceptColumnarMs: median('acceptColumnarMs'),
  },
  runs,
};

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
const outPath = path.join(EVIDENCE_DIR, `xl-mainlane-${date.toISOString().slice(0, 10)}.json`);
fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`xl-bench: wrote ${path.relative(REPO_ROOT, outPath)}`);
console.log(
  `xl-bench: medians — validate ${artifact.medians.validateMs}ms, materialize ${artifact.medians.materializeMs}ms, ` +
    `accept ${artifact.medians.acceptEndToEndMs}ms, brush ${artifact.medians.brushStepMs}ms; ` +
    `degradations ${JSON.stringify(runs[0].activeDegradations)}`,
);
console.log(
  `xl-bench: acceptance main-block OLD ${artifact.medians.mainBlockOldMs}ms → NEW ${artifact.medians.mainBlockNewMs}ms ` +
    `(off-thread acceptColumnar ${artifact.medians.acceptColumnarMs}ms)`,
);
