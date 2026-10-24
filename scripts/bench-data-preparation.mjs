#!/usr/bin/env node
/** CPU preparation comparison, not a GPU/render performance qualification.
 * Run: node scripts/bench-data-preparation.mjs [--nodes 100000 --edges 250000 --runs 3]
 * Each output uses identical generated row streams in a fresh --expose-gc process.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';

const self = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(self), '..');
const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const index = args.indexOf(flag);
  const result = index < 0 ? fallback : Number(args[index + 1]);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${flag} must be a positive integer`);
  return result;
};
const nodes = value('--nodes', 100_000);
const edges = value('--edges', 250_000);
const runs = value('--runs', 3);

if (args.includes('--child')) {
  const output = args[args.indexOf('--output') + 1];
  const modulePath = args[args.indexOf('--module') + 1];
  const { prepareGraphData } = await import(pathToFileURL(modulePath));
  async function* nodeRows() {
    for (let i = 0; i < nodes; i++) yield { id: `n${i}`, label: `Group ${i % 64}`, score: i % 1000, active: (i & 1) === 0 };
  }
  async function* edgeRows() {
    for (let i = 0; i < edges; i++) yield { id: `e${i}`, source: `n${i % nodes}`, target: `n${(i + 1) % nodes}`, weight: (i % 10) / 10, kind: `kind${i % 4}` };
  }
  global.gc();
  const before = process.memoryUsage();
  const start = performance.now();
  const prepared = await prepareGraphData({ nodes: nodeRows(), edges: edgeRows() }, {
    nodes: { id: 'id' }, edges: { id: 'id', source: 'source', target: 'target' },
  }, { datasetKey: 'benchmark', sourceRevision: 1, output });
  const elapsedMs = performance.now() - start;
  global.gc();
  const after = process.memoryUsage();
  const actualNodes = prepared.snapshot.nodes.length;
  const actualEdges = prepared.snapshot.edges.length;
  if (actualNodes !== nodes || actualEdges !== edges) throw new Error('Cardinality mismatch');
  // Keep the result reachable through the final memory sample.
  console.log(JSON.stringify({ output, elapsedMs, peakRssBytes: process.resourceUsage().maxRSS * 1024,
    retainedHeapAndBuffersDelta: after.heapUsed + after.arrayBuffers - before.heapUsed - before.arrayBuffers,
    baselineRssBytes: before.rss, nodes: actualNodes, edges: actualEdges, mappingFingerprint: prepared.mappingFingerprint }));
} else {
  const temp = mkdtempSync(path.join(tmpdir(), 'orbit-data-bench-'));
  try {
    const bundle = path.join(temp, 'data.mjs');
    await build({ entryPoints: [path.join(root, 'packages/data/src/index.ts')], bundle: true, platform: 'node', format: 'esm', outfile: bundle });
    const samples = [];
    for (let i = 0; i < runs; i++) {
      for (const output of ['object', 'columnar']) {
        const child = spawnSync(process.execPath, ['--expose-gc', self, '--child', '--module', bundle,
          '--nodes', String(nodes), '--edges', String(edges), '--output', output], { encoding: 'utf8' });
        if (child.status !== 0) throw new Error(child.stderr || child.stdout || String(child.error));
        samples.push(JSON.parse(child.stdout));
      }
    }
    const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const summary = Object.fromEntries(['object', 'columnar'].map((output) => {
      const rows = samples.filter((s) => s.output === output);
      return [output, Object.fromEntries(['elapsedMs', 'peakRssBytes', 'retainedHeapAndBuffersDelta'].map((key) =>
        [key, { min: Math.min(...rows.map((r) => r[key])), median: median(rows.map((r) => r[key])), max: Math.max(...rows.map((r) => r[key])) }]))];
    }));
    console.log(JSON.stringify({ benchmark: 'CPU-only prepared row streams', measuredAt: new Date().toISOString(), cpu: cpus()[0]?.model, node: process.version,
      platform: process.platform, arch: process.arch, nodes, edges, runs,
      qualification: 'Not a GPU/render benchmark; core may materialize columnar output later.',
      verdict: { retainedMemoryLower: summary.columnar.retainedHeapAndBuffersDelta.median < summary.object.retainedHeapAndBuffersDelta.median,
        preparationFaster: summary.columnar.elapsedMs.median < summary.object.elapsedMs.median }, summary, samples }, null, 2));
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
