#!/usr/bin/env node
/**
 * Node-safe probes (CI-runnable, no GPU/browser required).
 *
 * Writes probe records in the same shape as the Playwright GPU probes
 * (meta.browser: 'node') into apps/spike/results/records/:
 * - node-import-safety: `await import('@cosmos.gl/graph')` succeeds in Node
 * - range-updates: static scan of dist/index.d.ts — all buffer setters are
 * full-array, no ranged variants (offset/count) exist
 * - post-draw-frames: static scan of config.d.ts — no draw/render-phase
 * callback exists (only simulation/transition/interaction hooks)
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECORDS_DIR = path.join(ROOT, 'apps', 'spike', 'results', 'records');
const ENGINE_DIR = path.join(ROOT, 'packages', 'engine-cosmos');

const engineRequire = createRequire(path.join(ENGINE_DIR, 'package.json'));
const cosmosEntry = engineRequire.resolve('@cosmos.gl/graph');
const cosmosDistDir = path.dirname(cosmosEntry);
const cosmosPkg = JSON.parse(
  fs.readFileSync(path.join(cosmosDistDir, '..', 'package.json'), 'utf8'),
);

const sha256 = (filePath) =>
  createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const makeRecord = ({ capability, expected, observed, pass, notes }) => ({
  capability,
  expected,
  observed,
  pass,
  evidence: [],
  notes,
  status: 'measured',
  meta: {
    cosmosVersion: cosmosPkg.version,
    browser: 'node',
    os: process.platform,
    headful: false,
    gpu: process.env.PROBE_GPU ?? 'unspecified',
    date: new Date().toISOString(),
  },
});

const records = [];

// --- node-import-safety -------------------------------------------------------
{
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "await import('@cosmos.gl/graph');"],
    { cwd: ENGINE_DIR, encoding: 'utf8', timeout: 60_000 },
  );
  const pass = result.status === 0;
  records.push(
    makeRecord({
      capability: 'node-import-safety',
      expected:
        "await import('@cosmos.gl/graph') succeeds in plain Node (module scope guards typeof " +
        'window), so SSR/test imports of the adapter never crash.',
      observed: {
        exitCode: result.status,
        stderr: (result.stderr ?? '').trim().slice(0, 500) || null,
        nodeVersion: process.version,
      },
      pass,
      notes: `Spawned \`node --input-type=module -e "await import('@cosmos.gl/graph')"\` with cwd ${path.relative(
        ROOT,
        ENGINE_DIR,
      )}; pass = exit 0.`,
    }),
  );
}

// --- range-updates --------------------------------------------------------------
{
  const dtsPath = path.join(cosmosDistDir, 'index.d.ts');
  const dts = fs.readFileSync(dtsPath, 'utf8');
  const dtsHash = sha256(dtsPath);

  // Public setter signatures on the Graph class (4-space indented members).
  const setterRe = /^ {4}(set[A-Za-z0-9]+)\(([^)]*)\)/gm;
  const setters = [];
  const rangedVariants = [];
  for (const match of dts.matchAll(setterRe)) {
    const [, name, params] = match;
    setters.push({ name, params: params.replace(/\s+/g, ' ').trim() });
    if (/\b(offset|startIndex|count|range|fromIndex|toIndex)\b/i.test(params)) {
      rangedVariants.push(name);
    }
  }
  const pass = setters.length > 0 && rangedVariants.length === 0;
  records.push(
    makeRecord({
      capability: 'range-updates',
      expected:
        'Every buffer setter (setPointPositions, setPointColors, setLinks, ...) takes a full ' +
        'array; no ranged/partial-update variants (offset/count parameters) exist, so orbit ' +
        'must re-upload whole buffers on every change.',
      observed: {
        rangeUpdates: [],
        setterCount: setters.length,
        setters,
        rangedVariantsFound: rangedVariants,
        dtsSha256: dtsHash,
      },
      pass,
      notes: `Static scan of the resolved dist/index.d.ts (sha256 ${dtsHash}). All ${setters.length} set* signatures on the Graph class take full arrays; none declare offset/count/range parameters.`,
    }),
  );
}

// --- post-draw-frames --------------------------------------------------------------
{
  const cfgPath = path.join(cosmosDistDir, 'config.d.ts');
  const cfg = fs.readFileSync(cfgPath, 'utf8');
  const cfgHash = sha256(cfgPath);

  const callbackRe = /^ {4}(on[A-Z][A-Za-z0-9]*)\??:/gm;
  const callbacks = [...cfg.matchAll(callbackRe)].map((m) => m[1]);
  const drawPhaseHooks = callbacks.filter((name) => /draw|render|frame|paint/i.test(name));
  const pass = callbacks.length > 0 && drawPhaseHooks.length === 0;
  records.push(
    makeRecord({
      capability: 'post-draw-frames',
      expected:
        'The config callback inventory has no draw/render-phase hook (only simulation, ' +
        'transition, zoom, drag and pointer callbacks), so per-frame post-draw work must be ' +
        'scheduled externally (e.g. a requestAnimationFrame wrapper).',
      observed: {
        postDrawFrames: false,
        callbackInventory: callbacks,
        drawPhaseHooks,
        configDtsSha256: cfgHash,
      },
      pass,
      notes: `Static scan of the resolved dist/config.d.ts (sha256 ${cfgHash}). ${callbacks.length} on* callbacks found; none is draw/render/frame-phased. Simulation lifecycle hooks (onSimulationTick/Start/End/Pause/Unpause) are simulation-phased, not draw-phased.`,
    }),
  );
}

// --- write records -------------------------------------------------------------
fs.mkdirSync(RECORDS_DIR, { recursive: true });
let failed = 0;
for (const record of records) {
  const file = path.join(RECORDS_DIR, `${record.capability}.json`);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  const verdict = record.pass ? 'pass' : 'FAIL';
  if (!record.pass) failed += 1;
  console.log(`[probe-node] ${record.capability}: ${verdict} -> ${path.relative(ROOT, file)}`);
}

if (failed > 0) {
  console.error(`[probe-node] ${failed} probe(s) failed`);
  process.exit(1);
}
console.log(`[probe-node] ${records.length} records written (cosmos ${cosmosPkg.version})`);
