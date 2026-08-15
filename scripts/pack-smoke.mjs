#!/usr/bin/env node
/**
 * Packaging smoke test — gates the publishable artifacts, not the workspace:
 *
 * (a) discover non-private packages under packages/*
 * (b) `pnpm pack` each into `.smoke/`
 * (c) exports parity: dev exports keys === publishConfig.exports keys, the
 * packed manifest carries the publishConfig exports, and every dist
 * target exists inside the tarball
 * (d) fresh temp consumer: `npm install` all tarballs together (+ react)
 * (e) `node -e "await import(...)"` for every export subpath of every pkg
 * (f) `publint --strict` on each extracted tarball
 * (g) `attw --profile esm-only` on each tarball
 * (h) tree-shake/lazy-load fixtures bundled against the temp install
 * (i) `.smoke/report.json` summarizing every gate
 * (j) the packed inline worker asset is self-contained
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE = path.join(ROOT, '.smoke');
const BIN = path.join(ROOT, 'node_modules', '.bin');

const report = {
  startedAt: new Date().toISOString(),
  node: process.version,
  packages: {},
  gates: {},
};
const failures = [];

function pass(gateName, detail) {
  report.gates[gateName] = { ok: true, ...(detail ? { detail } : {}) };
  console.log(`ok   ${gateName}`);
}

function fail(gateName, message) {
  report.gates[gateName] = { ok: false, message };
  failures.push(`${gateName}: ${message}`);
  console.error(`FAIL ${gateName}: ${message}`);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/** Best human-readable message from an execFileSync error. */
function errText(err) {
  const parts = [err.stderr, err.stdout, err.message].filter((p) => typeof p === 'string' && p.trim() !== '');
  return (parts[0] ?? String(err)).trim().split('\n').slice(-12).join('\n');
}

function finish() {
  report.finishedAt = new Date().toISOString();
  report.ok = failures.length === 0;
  mkdirSync(SMOKE, { recursive: true });
  writeFileSync(path.join(SMOKE, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (failures.length > 0) {
    console.error(`\npack-smoke: ${failures.length} gate(s) failed`);
    process.exit(1);
  }
  console.log('\npack-smoke: all gates green');
}

// ---------------------------------------------------------------- (a) discover
const pkgs = [];
for (const name of readdirSync(path.join(ROOT, 'packages'))) {
  const dir = path.join(ROOT, 'packages', name);
  const manifestPath = path.join(dir, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.private) continue;
  pkgs.push({ dir, manifest, name: manifest.name });
}
if (pkgs.length === 0) {
  fail('discover', 'no non-private packages found under packages/*');
  finish();
}
pass('discover', pkgs.map((p) => p.name));

// ---------------------------------------------------------------- (b) pack
rmSync(SMOKE, { recursive: true, force: true });
mkdirSync(SMOKE, { recursive: true });
for (const pkg of pkgs) {
  try {
    const out = run('pnpm', ['pack', '--pack-destination', SMOKE], { cwd: pkg.dir });
    const tgzLine = out
      .trim()
      .split('\n')
      .reverse()
      .find((l) => l.trim().endsWith('.tgz'));
    if (!tgzLine) throw new Error(`could not find tarball path in pnpm pack output:\n${out}`);
    pkg.tarball = path.resolve(pkg.dir, tgzLine.trim());
    if (!existsSync(pkg.tarball)) throw new Error(`tarball does not exist: ${pkg.tarball}`);
    report.packages[pkg.name] = { tarball: path.basename(pkg.tarball) };
  } catch (err) {
    fail(`pack:${pkg.name}`, errText(err));
  }
}
if (failures.length > 0) finish();
pass('pack', pkgs.map((p) => path.basename(p.tarball)));

// ---------------------------------------------------------------- (c) parity
for (const pkg of pkgs) {
  const gateName = `exports-parity:${pkg.name}`;
  try {
    const devKeys = Object.keys(pkg.manifest.exports ?? {}).sort();
    const pubExports = pkg.manifest.publishConfig?.exports ?? {};
    const pubKeys = Object.keys(pubExports).sort();
    if (JSON.stringify(devKeys) !== JSON.stringify(pubKeys)) {
      throw new Error(`dev exports keys ${JSON.stringify(devKeys)} != publishConfig keys ${JSON.stringify(pubKeys)}`);
    }

    // The packed manifest must actually carry the publishConfig exports.
    const packedManifest = JSON.parse(run('tar', ['-xOf', pkg.tarball, 'package/package.json']));
    if (JSON.stringify(packedManifest.exports) !== JSON.stringify(pubExports)) {
      throw new Error(
        `packed exports ${JSON.stringify(packedManifest.exports)} != publishConfig.exports ${JSON.stringify(pubExports)}`,
      );
    }

    const entries = new Set(
      run('tar', ['-tf', pkg.tarball])
        .trim()
        .split('\n')
        .map((l) => l.trim()),
    );
    const missing = [];
    for (const target of Object.values(pubExports)) {
      const files = typeof target === 'string' ? [target] : Object.values(target);
      for (const file of files) {
        const tarPath = 'package/' + file.replace(/^\.\//, '');
        if (!entries.has(tarPath)) missing.push(tarPath);
      }
    }
    if (missing.length > 0) throw new Error(`missing from tarball: ${missing.join(', ')}`);
    pass(gateName, { exportKeys: pubKeys });
  } catch (err) {
    fail(gateName, errText(err));
  }
}
if (failures.length > 0) finish();

// ---------------------------------------------------------------- (d) install
const consumerDir = mkdtempSync(path.join(tmpdir(), 'orbit-smoke-'));
report.consumerDir = consumerDir;
writeFileSync(
  path.join(consumerDir, 'package.json'),
  JSON.stringify({ name: 'orbit-smoke-consumer', private: true, type: 'module' }, null, 2),
);
try {
  run(
    'npm',
    [
      'install',
      '--silent',
      '--no-audit',
      '--no-fund',
      ...pkgs.map((p) => p.tarball),
      'react',
      'react-dom',
    ],
    { cwd: consumerDir },
  );
  pass('consumer-install');
} catch (err) {
  fail('consumer-install', errText(err));
  finish();
}

// ---------------------------------------------------------------- (e) imports
for (const pkg of pkgs) {
  for (const key of Object.keys(pkg.manifest.publishConfig.exports)) {
    const specifier = pkg.name + (key === '.' ? '' : key.slice(1));
    const gateName = `import:${specifier}`;
    try {
      run(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(specifier)})`], {
        cwd: consumerDir,
      });
      pass(gateName);
    } catch (err) {
      fail(gateName, errText(err));
    }
  }
}

// ---------------------------------------------------------------- (f) publint
for (const pkg of pkgs) {
  const gateName = `publint:${pkg.name}`;
  try {
    const extractDir = path.join(SMOKE, 'extracted', path.basename(pkg.tarball, '.tgz'));
    mkdirSync(extractDir, { recursive: true });
    run('tar', ['-xzf', pkg.tarball, '-C', extractDir, '--strip-components=1']);
    const out = run(path.join(BIN, 'publint'), ['--strict'], { cwd: extractDir });
    pass(gateName, out.trim().split('\n').pop());
  } catch (err) {
    fail(gateName, errText(err));
  }
}

// ---------------------------------------------------------------- (g) attw
for (const pkg of pkgs) {
  const gateName = `attw:${pkg.name}`;
  try {
    run(path.join(BIN, 'attw'), ['--profile', 'esm-only', pkg.tarball], { cwd: ROOT });
    pass(gateName);
  } catch (err) {
    fail(gateName, errText(err));
  }
}

// ---------------------------------------------------------------- (h) treeshake
// Copy fixtures into the consumer dir so module resolution walks the temp
// node_modules (tarball installs), never the workspace sources.
const fixtureSrc = path.join(ROOT, 'fixtures', 'treeshake');
for (const file of ['react-root.ts', 'engine-lazy.ts', 'omnigraph-client.ts', 'data-root.ts']) {
  copyFileSync(path.join(fixtureSrc, file), path.join(consumerDir, file));
}

async function bundleFixture(entryFile, outName, external) {
  const outdir = path.join(SMOKE, 'bundles', outName);
  rmSync(outdir, { recursive: true, force: true });
  const result = await esbuild.build({
    entryPoints: [path.join(consumerDir, entryFile)],
    bundle: true,
    format: 'esm',
    splitting: true,
    outdir,
    external,
    metafile: true,
    logLevel: 'silent',
  });
  const outputs = {};
  for (const [outPath, meta] of Object.entries(result.metafile.outputs)) {
    if (outPath.endsWith('.map')) continue;
    outputs[outPath] = {
      text: readFileSync(path.resolve(ROOT, outPath), 'utf8'),
      inputs: Object.keys(meta.inputs),
      entryPoint: meta.entryPoint,
    };
  }
  return outputs;
}

try {
  const outputs = await bundleFixture('react-root.ts', 'react-root', ['react', 'react-dom', 'react/jsx-runtime']);
  // Sentinels that must never reach a root-only consumer bundle: FakeEngine
  // (`@modernrelay/orbit-core/testing`) and the packaged component entries of
  // orbit-react (./components/*).
  const sentinels = [
    'FakeEngine',
    'GraphToolbar',
    'GraphContextMenu',
    'GraphHistogram',
    'GraphTimeline',
    'GraphLegend',
    // Exploration entries (word-bounded: the root legitimately exports
    // useGraphSearch, which contains 'GraphSearch' as a substring only).
    'GraphSearch',
    'GraphMinimap',
    'GraphTooltip',
    'GraphInspector',
    // M5 equivalent views. The component names are joined by the
    // dedicated probe constants the entry modules export, so the gate fails on
    // ANY reachable byte of those chunks — not just the exported symbol name a
    // minifier could rename.
    'GraphTable',
    'GraphSimControls',
    '__ORBIT_TABLE_SENTINEL__',
    '__ORBIT_SIMCONTROLS_SENTINEL__',
  ];
  const offenders = [];
  for (const [outPath, o] of Object.entries(outputs)) {
    for (const sentinel of sentinels) {
      // Word-bounded: the root hooks legitimately export `useGraphTimeline`
      // etc., which contain component names as substrings.
      if (new RegExp(`\\b${sentinel}\\b`).test(o.text)) offenders.push(`${sentinel} in ${outPath}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(`sentinel leaked into react bundle: ${offenders.join(', ')}`);
  }
  pass('treeshake:react-root', { chunks: Object.keys(outputs), sentinels });
} catch (err) {
  fail('treeshake:react-root', errText(err));
}

try {
  const outputs = await bundleFixture('engine-lazy.ts', 'engine-lazy', ['react', 'react-dom']);
  const isCosmosInput = (input) => /node_modules\/@cosmos\.gl\//.test(input);
  const entries = Object.entries(outputs);
  // With splitting, dynamically-imported modules also carry an `entryPoint` in
  // the metafile — the real top-level entry is the one for our fixture file.
  const entryChunks = entries.filter(([, o]) => o.entryPoint?.endsWith('engine-lazy.ts'));
  const lazyChunks = entries.filter(([, o]) => !o.entryPoint?.endsWith('engine-lazy.ts'));
  if (entryChunks.length === 0) throw new Error('no entry chunk in metafile');
  const pollutedEntries = entryChunks.filter(([, o]) => o.inputs.some(isCosmosInput)).map(([p]) => p);
  if (pollutedEntries.length > 0) {
    throw new Error(`@cosmos.gl/graph bundled into entry chunk(s): ${pollutedEntries.join(', ')}`);
  }
  const cosmosLazy = lazyChunks.filter(([, o]) => o.inputs.some(isCosmosInput)).map(([p]) => p);
  if (cosmosLazy.length === 0) {
    throw new Error('no lazy chunk contains @cosmos.gl/graph — dynamic import did not survive packaging');
  }
  pass('treeshake:engine-lazy', { entryChunks: entryChunks.map(([p]) => p), cosmosLazyChunks: cosmosLazy });
} catch (err) {
  fail('treeshake:engine-lazy', errText(err));
}

try {
  const outputs = await bundleFixture('omnigraph-client.ts', 'omnigraph-client', []);
  // Client-bundle exclusion: the server-only entry of
  // orbit-omnigraph (the ONLY authenticated SDK construction) must never
  // reach a browser consumer that imports the root export loader.
  const sentinels = ['createOmnigraphServerClient'];
  const offenders = [];
  for (const [outPath, o] of Object.entries(outputs)) {
    for (const sentinel of sentinels) {
      if (o.text.includes(sentinel)) offenders.push(`${sentinel} in ${outPath}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(`sentinel leaked into omnigraph client bundle: ${offenders.join(', ')}`);
  }
  pass('treeshake:omnigraph-client', { chunks: Object.keys(outputs), sentinels });
} catch (err) {
  fail('treeshake:omnigraph-client', errText(err));
}

try {
  // Bundle-isolation: importing the orbit-data ROOT entry with
  // NO externals must succeed (the optional peers are not installed in the
  // temp consumer, so a leaked import would fail resolution outright) and the
  // output must not mention the optional format-parser module specifiers.
  const outputs = await bundleFixture('data-root.ts', 'data-root', []);
  const sentinels = ['apache-arrow', 'hyparquet'];
  const offenders = [];
  for (const [outPath, o] of Object.entries(outputs)) {
    for (const sentinel of sentinels) {
      if (o.text.includes(sentinel)) offenders.push(`${sentinel} in ${outPath}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(`optional format dep leaked into data root bundle: ${offenders.join(', ')}`);
  }
  pass('treeshake:data-root', { chunks: Object.keys(outputs), sentinels });
} catch (err) {
  fail('treeshake:data-root', errText(err));
}

// ------------------------------------------------- (j) worker self-contained
try {
  // The inline worker asset must carry ZERO imports:
  // bundlers inline/relocate worker URLs as raw assets, so a relative
  // `../chunk-*.js` import breaks in exactly the consumers the default
  // factory serves. Static shape gate over the PACKED core tarball.
  const { readFileSync: readFs } = await import('node:fs');
  const entryPath = path.join(consumerDir, 'node_modules', '@modernrelay', 'orbit-core', 'dist', 'worker', 'entry.js');
  const entrySrc = readFs(entryPath, 'utf8');
  const importLines = entrySrc
    .split('\n')
    .filter((l) => /^\s*import[\s("']/.test(l) || l.includes('import('));
  if (importLines.length > 0) {
    throw new Error(`worker entry is not self-contained: ${importLines[0].trim()}`);
  }
  pass('worker:self-contained-entry', { bytes: entrySrc.length });
} catch (err) {
  fail('worker:self-contained-entry', errText(err));
}

// ---------------------------------------------------------------- (i) report
if (failures.length === 0) rmSync(consumerDir, { recursive: true, force: true });
finish();
