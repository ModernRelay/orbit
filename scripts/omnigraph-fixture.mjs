#!/usr/bin/env node
/**
 * omnigraph-fixture.mjs — regenerates the real-data Omnigraph fixtures under
 * fixtures/omnigraph/ (see fixtures/omnigraph/README.md).
 *
 * What it does, end to end:
 * 1. Recreates the local cluster graph from fixtures/omnigraph/cluster/
 * (`omnigraph cluster import` + `cluster apply` — apply CREATES
 * cluster/graphs/demo.omni from demo.pg). Graph state is wiped first so
 * every run starts from the same empty graph.
 * 2. Generates deterministic seed data (seeded PRNG, no wall-clock input):
 * 300 nodes across 5 types + 500 edges across 6 types, including hostile
 * strings (script-tag payload, quotes/backslashes), non-ASCII text, and
 * dates spanning 2015–2026. Written to fixtures/omnigraph/seed.ndjson in
 * the `omnigraph load` line format:
 * node {"type":"<NodeType>","data":{...}}
 * edge {"edge":"<EdgeName>","from":"<src key>","to":"<dst key>","data":{...}}
 * Every edge carries an explicit deterministic data.id so `--mode merge`
 * is a true upsert (idempotent re-runs; no @card violations).
 * 3. Boots `omnigraph-server --cluster... --unauthenticated` on 127.0.0.1:8199,
 * waits for /healthz, and records the raw HTTP responses (verbatim bytes,
 * via curl) for exactly the requests the @modernrelay/omnigraph SDK 0.8.0
 * issues (graph-scoped paths are prefixed /graphs/<graphId>):
 * recorded/health.json GET /healthz
 * recorded/schema.json GET /graphs/demo/schema
 * recorded/commits.json GET /graphs/demo/commits?branch=main
 * recorded/snapshot.json GET /graphs/demo/snapshot
 * recorded/export.ndjson POST /graphs/demo/export body {}
 * recorded/export-partial.ndjson POST /graphs/demo/export body {"type_names":["Correlates","Signal"]}
 * then kills the server.
 * 4. Writes recorded/manifest.json (recordedAt, serverVersion, graphId,
 * branch, headBefore/headAfter around the export, per-table rowCounts,
 * and the verified edge-before-node export line ordering).
 *
 * Requirements: the `omnigraph` CLI and `omnigraph-server` binaries (0.8.x)
 * on PATH, plus curl. When the binaries are absent the script prints a SKIP
 * message and exits 0 — CI never regenerates fixtures; it consumes the
 * committed recordings.
 *
 * Usage: node scripts/omnigraph-fixture.mjs
 * Idempotent: re-running produces the same seed data and equivalent
 * recordings (commit ids/timestamps differ per run; row data does not).
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'omnigraph');
const CLUSTER_DIR = path.join(FIXTURE_DIR, 'cluster');
const RECORDED_DIR = path.join(FIXTURE_DIR, 'recorded');
const SEED_FILE = path.join(FIXTURE_DIR, 'seed.ndjson');
const STORE = path.join(CLUSTER_DIR, 'graphs', 'demo.omni');

const GRAPH_ID = 'demo';
const BRANCH = 'main';
const ACTOR = 'fixture-bot';
const BIND = '127.0.0.1:8199';
const BASE = `http://${BIND}`;
// Header the SDK's transport sends on every request.
const ACCEPT = 'Accept: application/json, application/x-ndjson';

// ── helpers ──────────────────────────────────────────────────────────────────

function hasBinary(bin, args) {
  const r = spawnSync(bin, args, { stdio: 'ignore' });
  return !r.error;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
  }
  return r.stdout;
}

/** curl the server and return the raw response body (verbatim bytes). */
function curl(args) {
  return run('curl', ['-sS', '--fail-with-body', ...args]);
}

function record(file, body) {
  if (!body || body.length === 0) throw new Error(`refusing to record empty body for ${file}`);
  writeFileSync(path.join(RECORDED_DIR, file), body);
  console.log(`  recorded/${file} (${Buffer.byteLength(body)} bytes)`);
}

/** mulberry32 — tiny deterministic PRNG; the fixed seed makes seed.ndjson stable. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── deterministic seed data ──────────────────────────────────────────────────

function generateSeed() {
  const rand = mulberry32(0x5eed0611);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
  const pad = (n, w = 3) => String(n).padStart(w, '0');
  // Dates span years (2015–2026) — exercises temporal dimensions.
  const dateStr = () =>
    `${int(2015, 2026)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`;
  const dateTimeStr = () =>
    `${dateStr()}T${pad(int(0, 23), 2)}:${pad(int(0, 59), 2)}:${pad(int(0, 59), 2)}.${pad(int(0, 999), 3)}Z`;

  const lines = [];
  const node = (type, data) => lines.push(JSON.stringify({ type, data }));
  const edge = (name, from, to, data) =>
    lines.push(JSON.stringify({ edge: name, from, to, ...(data ? { data } : {}) }));

  // -- nodes (300 total) ------------------------------------------------------
  const firstNames = [
    'Ada', 'Grace', 'Alan', 'Edsger', 'Barbara', 'Zoë', 'Søren', 'Fatima',
    'José', 'Nadia', '田中', 'Приёмов', 'Björk', 'Chidi', 'Meera', 'Łukasz',
  ];
  const lastNames = [
    'Lovelace', 'Hopper', 'Turing', 'Dijkstra', 'Liskov', 'Müller', 'Kierkegaard',
    'al-Zahra', 'García', '太郎', 'Ó Briain', 'Þórsdóttir', 'Okafor', 'Nguyễn',
  ];
  const topics = [
    'ingestion backpressure', 'columnar snapshots', 'edge identity', 'schema drift',
    'revision stamps', 'graph overlays', 'search admission', 'typed attrs',
    'wire encodings', 'branch quiescence', 'export streaming', 'legend domains',
    'category scales — 图例', 'naïve dedupe', 'crème-fraîche caching', 'Ω-bounds',
  ];

  const actors = [];
  for (let i = 1; i <= 30; i++) {
    const slug = `actor-${pad(i)}`;
    actors.push(slug);
    node('Actor', {
      slug,
      name: `${pick(firstNames)} ${pick(lastNames)}`,
      // optional String: ~1/3 null
      email: rand() < 0.34 ? null : `user${i}@example.test`,
      joined_at: dateStr(),
    });
  }

  const decisions = [];
  const statuses = ['proposed', 'accepted', 'rejected', 'superseded'];
  const urgencies = ['low', 'normal', 'high', 'critical'];
  for (let i = 1; i <= 60; i++) {
    const slug = `decision-${pad(i)}`;
    decisions.push(slug);
    let title = `Decide on ${pick(topics)} (#${i})`;
    // Hostile payloads — downstream renderers must never execute/interpret these.
    if (i === 13) title = `Adopt <script>alert("orbit-xss")</script> immediately`;
    if (i === 27) title = `Quote "everything" & <b>escape</b> \\ backslash — ok?`;
    node('Decision', {
      slug,
      title,
      body: rand() < 0.3 ? null : `Rationale for ${slug}: ${pick(topics)}.`,
      status: pick(statuses),
      urgency: pick(urgencies),
      decided_at: rand() < 0.25 ? null : dateStr(),
      updated_at: dateTimeStr(),
    });
  }

  const traces = [];
  const traceKinds = ['note', 'discussion', 'experiment', 'review', 'meeting', 'document'];
  for (let i = 1; i <= 90; i++) {
    const slug = `trace-${pad(i)}`;
    traces.push(slug);
    node('Trace', {
      slug,
      title: `Trace ${i}: ${pick(topics)}`,
      body: rand() < 0.4 ? null : `Observed ${pick(topics)} during ${pick(traceKinds)}.`,
      kind: pick(traceKinds),
      recorded_at: dateTimeStr(),
      // I64 — one value pinned at Number.MAX_SAFE_INTEGER because HTTP emits
      // native JSON numbers; this is the largest losslessly-parseable value).
      word_count: i === 42 ? 9007199254740991 : int(50, 20000),
      source: rand() < 0.5 ? null : `https://example.test/traces/${slug}`,
    });
  }

  const signals = [];
  const categories = ['competitor', 'market', 'regulatory', 'technology', 'customer'];
  for (let i = 1; i <= 60; i++) {
    const slug = `signal-${pad(i)}`;
    signals.push(slug);
    // F64 — fractional values incl. exact 0 and a subnormal-ish tiny value.
    const strength =
      i === 1 ? 0 : i === 2 ? 1e-9 : Math.round(rand() * 1e6) / 1e6;
    node('Signal', {
      slug,
      title: `Signal ${i}: ${pick(topics)}`,
      body: rand() < 0.45 ? null : `Market movement around ${pick(topics)}.`,
      category: pick(categories),
      strength,
      observed_at: dateStr(),
      source: rand() < 0.4 ? null : `https://example.test/signals/${i}`,
    });
  }

  const artifacts = [];
  const artifactKinds = ['doc', 'presentation', 'proposal', 'spec', 'report', 'memo'];
  for (let i = 1; i <= 60; i++) {
    const slug = `artifact-${pad(i)}`;
    artifacts.push(slug);
    node('Artifact', {
      slug,
      title: `Artifact ${i}: ${pick(topics)}`,
      kind: pick(artifactKinds),
      url: rand() < 0.35 ? null : `https://example.test/artifacts/naïve-${i}?q=图`,
      created_at: dateStr(),
      revision: int(1, 40),
    });
  }

  // -- edges (500 total, explicit deterministic ids) --------------------------
  // OwnedBy 60 — @card(1..1): exactly one owner per decision.
  decisions.forEach((d, i) => edge('OwnedBy', d, actors[i % actors.length], { id: `own-${pad(i + 1, 4)}` }));
  // RecordedBy 90 — @card(1..1): exactly one recorder per trace.
  traces.forEach((t, i) => edge('RecordedBy', t, actors[(i * 7) % actors.length], { id: `rec-${pad(i + 1, 4)}` }));
  // ParticipatedIn 120 — includes two deliberate parallel edges (same
  // endpoints as part-0001, distinct ids) to exercise parallel-edge handling.
  const firstPair = [pick(actors), pick(decisions)];
  for (let i = 1; i <= 120; i++) {
    const [from, to] = i >= 119 ? firstPair : i === 1 ? firstPair : [pick(actors), pick(decisions)];
    edge('ParticipatedIn', from, to, { id: `part-${pad(i, 4)}` });
  }
  // Supports 110 — optional F64 edge property (~20% null).
  for (let i = 1; i <= 110; i++) {
    edge('Supports', pick(traces), pick(decisions), {
      id: `sup-${pad(i, 4)}`,
      weight: rand() < 0.2 ? null : Math.round(rand() * 1000) / 1000,
    });
  }
  // Triggered 70.
  for (let i = 1; i <= 70; i++) {
    edge('Triggered', pick(signals), pick(decisions), { id: `trig-${pad(i, 4)}` });
  }
  // Correlates 50 — @unique(src, dst): deduped pairs, no self-loops.
  const seen = new Set();
  let corr = 0;
  while (corr < 50) {
    const a = pick(signals);
    const b = pick(signals);
    if (a === b || seen.has(`${a}|${b}`)) continue;
    seen.add(`${a}|${b}`);
    corr += 1;
    edge('Correlates', a, b, {
      id: `corr-${pad(corr, 4)}`,
      confidence: Math.round(rand() * 100) / 100,
    });
  }

  return lines.join('\n') + '\n';
}

// ── pipeline ─────────────────────────────────────────────────────────────────

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = spawnSync('curl', ['-sf', `${BASE}/healthz`], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.includes('"ok"')) return;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`omnigraph-server did not become healthy on ${BASE} within ${timeoutMs}ms`);
}

function newestCommitId(commitsJson) {
  const parsed = JSON.parse(commitsJson);
  const first = parsed.commits?.[0]; // newest first
  if (!first?.graph_commit_id) throw new Error('commits response had no commits');
  return first.graph_commit_id;
}

async function main() {
  if (!hasBinary('omnigraph', ['version']) || !hasBinary('omnigraph-server', ['--help'])) {
    console.log(
      'SKIP: omnigraph / omnigraph-server binaries not found on PATH — ' +
        'fixture regeneration needs them (see fixtures/omnigraph/README.md). ' +
        'The committed recordings remain authoritative.',
    );
    return;
  }

  // 1. Recreate the graph from the declarative cluster config.
  console.log('== cluster: wiping graph state and re-applying config ==');
  rmSync(path.join(CLUSTER_DIR, 'graphs'), { recursive: true, force: true });
  rmSync(path.join(CLUSTER_DIR, '__cluster'), { recursive: true, force: true });
  run('omnigraph', ['cluster', 'validate', '--config', CLUSTER_DIR]);
  // Cluster control commands stopped accepting --as (omnigraph >= 0.9: the
  // actor flag applies to direct-engine/actor-bound operations only).
  run('omnigraph', ['cluster', 'import', '--config', CLUSTER_DIR, '--json']);
  run('omnigraph', ['cluster', 'apply', '--config', CLUSTER_DIR, '--json']);
  if (!existsSync(STORE)) throw new Error(`cluster apply did not create ${STORE}`);

  // 2. Seed data.
  console.log('== seed: generating deterministic data and loading ==');
  const seed = generateSeed();
  writeFileSync(SEED_FILE, seed);
  const loadOut = run('omnigraph', [
    'load', '--data', SEED_FILE, '--mode', 'merge',
    '--store', STORE, '--as', ACTOR, '--json',
  ]);
  const loaded = JSON.parse(loadOut);
  console.log(`  loaded ${loaded.nodes_loaded} nodes, ${loaded.edges_loaded} edges`);
  if (loaded.nodes_loaded !== 300 || loaded.edges_loaded !== 500) {
    throw new Error(`unexpected load counts: ${loadOut}`);
  }

  // 3. Serve and record.
  console.log(`== server: booting on ${BIND} ==`);
  mkdirSync(RECORDED_DIR, { recursive: true });
  const server = spawn(
    'omnigraph-server',
    ['--cluster', CLUSTER_DIR, '--unauthenticated', '--bind', BIND],
    { cwd: ROOT, stdio: 'ignore' },
  );
  try {
    await waitForHealth();
    const g = (p) => `${BASE}/graphs/${GRAPH_ID}${p}`; // SDK graph-scoped routing

    const health = curl(['-H', ACCEPT, `${BASE}/healthz`]);
    record('health.json', health);

    record('schema.json', curl(['-H', ACCEPT, g('/schema')]));

    // Branch head before the export stream…
    const commitsBefore = curl(['-H', ACCEPT, g(`/commits?branch=${BRANCH}`)]);
    record('commits.json', commitsBefore);

    const snapshot = curl(['-H', ACCEPT, g('/snapshot')]);
    record('snapshot.json', snapshot);

    // Full export — SDK: og.export → POST /export with body {}.
    const exportFull = curl([
      '-X', 'POST', g('/export'),
      '-H', 'Content-Type: application/json', '-H', ACCEPT, '-d', '{}',
    ]);
    record('export.ndjson', exportFull);

    // Partial export by type — SDK: og.export({ typeNames: [...] }) → snake_cased body.
    const exportPartial = curl([
      '-X', 'POST', g('/export'),
      '-H', 'Content-Type: application/json', '-H', ACCEPT,
      '-d', '{"type_names":["Correlates","Signal"]}',
    ]);
    record('export-partial.ndjson', exportPartial);

    // …and after it (equal heads produce a stable sourceRevision).
    const commitsAfter = curl(['-H', ACCEPT, g(`/commits?branch=${BRANCH}`)]);

    // 4. Verify + manifest.
    console.log('== verify: export ordering and manifest ==');
    const exportLines = exportFull.trimEnd().split('\n');
    const lastEdgeIdx = exportLines.reduce((acc, l, i) => (l.startsWith('{"edge"') ? i : acc), -1);
    const firstNodeIdx = exportLines.findIndex((l) => l.startsWith('{"type"'));
    if (lastEdgeIdx === -1 || firstNodeIdx === -1 || lastEdgeIdx > firstNodeIdx) {
      throw new Error(
        `export ordering violated: expected all edge:* lines before node:* lines ` +
          `(lastEdge=${lastEdgeIdx}, firstNode=${firstNodeIdx})`,
      );
    }
    if (exportLines.length !== 800) {
      throw new Error(`expected 800 export lines (300 nodes + 500 edges), got ${exportLines.length}`);
    }

    const snap = JSON.parse(snapshot);
    const rowCounts = Object.fromEntries(snap.tables.map((t) => [t.table_key, t.row_count]));
    const manifest = {
      recordedAt: new Date().toISOString(),
      serverVersion: JSON.parse(health).version,
      graphId: GRAPH_ID,
      branch: BRANCH,
      headBefore: newestCommitId(commitsBefore),
      headAfter: newestCommitId(commitsAfter),
      rowCounts,
      exportLineCount: exportLines.length,
      edgeLinesBeforeNodeLines: true,
      notes:
        'Raw HTTP bodies recorded verbatim from omnigraph-server against the requests ' +
        'the @modernrelay/omnigraph SDK issues (graph-scoped paths under /graphs/demo). ' +
        'export.ndjson streams tables in lexicographic table-key order, so all edge:* ' +
        'lines precede node:* lines (verified). headBefore == headAfter: the branch was ' +
        'quiescent across the export, the stable case for the source revision stamp.',
    };
    record('manifest.json', JSON.stringify(manifest, null, 2) + '\n');

    console.log('OK: fixtures regenerated');
  } finally {
    server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
