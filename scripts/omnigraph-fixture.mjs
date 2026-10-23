#!/usr/bin/env node
/**
 * Regenerate genuine OmniGraph 0.14 HTTP recordings from a fresh temporary
 * cluster. Existing stores are never opened or deleted. Use --serve to keep
 * the seeded fixture running for the demo/live tests without rewriting files.
 *
 * OMNIGRAPH_BIN and OMNIGRAPH_SERVER_BIN select separately installed binaries;
 * the CLI and server must both be exactly 0.14.0. No global installation or
 * production service is changed. See fixtures/omnigraph/README.md.
 */
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'omnigraph');
const RECORDED_DIR = path.join(FIXTURE_DIR, 'recorded');
const CLI = process.env.OMNIGRAPH_BIN || 'omnigraph';
const SERVER = process.env.OMNIGRAPH_SERVER_BIN || 'omnigraph-server';
const VERSION = '0.14.0';
const CONTRACT = '0.14';
const HEADER = 'Omnigraph-Http-Api';
const GRAPH_ID = 'demo';
const BRANCH = 'main';
const PORT = Number(process.env.OMNIGRAPH_FIXTURE_PORT || 8199);
const BIND = `127.0.0.1:${PORT}`;
const BASE = `http://${BIND}`;
const SERVE = process.argv.includes('--serve');

function run(cmd, args, env = process.env) {
  const result = spawnSync(cmd, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function request(route, init = {}) {
  const response = await fetch(`${BASE}${route}`, {
    ...init,
    headers: { Accept: 'application/json, application/x-ndjson', [HEADER]: CONTRACT, ...init.headers },
    signal: AbortSignal.timeout(10000),
  });
  if (response.headers.get(HEADER) !== CONTRACT) throw new Error(`${route}: missing ${HEADER}: ${CONTRACT}`);
  const body = await response.text();
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status} ${body}`);
  return { body, status: response.status, apiContract: response.headers.get(HEADER) };
}

async function requireFreePort() {
  const probe = createServer();
  probe.listen(PORT, '127.0.0.1');
  await once(probe, 'listening');
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
}

function newestCommitId(body) {
  const id = JSON.parse(body).head_commit_id;
  if (typeof id !== 'string') throw new Error('commits response had no head');
  return id;
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
  const edge = (name, from, to, { id, ...data }) =>
    lines.push(JSON.stringify({ edge: name, id, from, to, data }));

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
      // Schema-owned id is ordinary nullable data, not the row identity.
      id: i % 3 === 0 ? null : i,
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
  // Correlates 50 — @unique(@src, @dst): deduped pairs, no self-loops.
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

// ── Fresh local cluster, served load, and wire recordings ─────────────────────

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--serve')) throw new Error('Usage: node scripts/omnigraph-fixture.mjs [--serve]');
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid OMNIGRAPH_FIXTURE_PORT');
  const version = JSON.parse(run(CLI, ['version', '--json']));
  if (version.version !== VERSION || version.http_contract !== CONTRACT || version.protocols?.target !== 2) {
    throw new Error(`Fixture regeneration requires OmniGraph ${VERSION}; set OMNIGRAPH_BIN and OMNIGRAPH_SERVER_BIN to the pinned release.`);
  }
  run(SERVER, ['--help']);
  await requireFreePort();
  const cluster = mkdtempSync(path.join(tmpdir(), 'orbit-omnigraph-014-'));
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let server;
  let serverClosed;
  let serverLog = '';
  try {
    // Isolate the final 0.14 target configuration from any operator defaults or
    // credentials on the host. Loopback access is explicitly anonymous.
    const operatorHome = path.join(cluster, 'operator');
    mkdirSync(operatorHome);
    writeFileSync(path.join(operatorHome, 'config.yaml'), [
      'version: 1', 'targets:', '  fixture:', '    kind: server',
      `    endpoint: ${BASE}`, '    auth: { provider: anonymous }', '',
    ].join('\n'));
    const runCli = (args) => run(CLI, args, { ...process.env, OMNIGRAPH_HOME: operatorHome });
    runCli(['config', 'validate']);
    for (const file of ['cluster.yaml', 'demo.pg', 'queries.gq']) cpSync(path.join(FIXTURE_DIR, 'cluster', file), path.join(cluster, file));
    console.log(`Preparing fresh OmniGraph ${VERSION} fixture in ${cluster}`);
    runCli(['cluster', 'validate', '--config', cluster, '--json']);
    runCli(['lint', '--schema', path.join(cluster, 'demo.pg'), '--query', path.join(cluster, 'queries.gq'), '--json']);
    runCli(['cluster', 'plan', '--target', cluster, '--config', cluster, '--json']);
    const applied = JSON.parse(runCli(['cluster', 'apply', '--target', cluster, '--config', cluster, '--as', 'fixture-bot', '--json']));
    if (applied.status !== 'complete') throw new Error('Fixture bootstrap did not finish');
    // This uniquely-owned local root has no other readers/writers. The synchronous
    // apply process has exited after durable completion, so no native I/O remains.
    // Release only its observed exact retained lock before starting the server.
    const observed = JSON.parse(runCli(['cluster', 'observe', '--target', cluster, '--config', cluster, '--json']));
    const lock = observed.state_observations?.lock_id;
    if (typeof lock !== 'string') throw new Error('Expected the completed bootstrap writer lock');
    runCli(['cluster', 'force-unlock', lock, '--target', cluster, '--json']);

    server = spawn(SERVER, ['--cluster', cluster, '--unauthenticated', '--bind', BIND], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    serverClosed = once(server, 'close');
    for (const output of [server.stdout, server.stderr]) output.on('data', (chunk) => { serverLog = (serverLog + chunk).slice(-16000); });
    const deadline = Date.now() + 20000;
    while (true) {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Fixture server exited: ${serverLog}`);
      try { await request('/readyz'); break; } catch (error) {
        if (Date.now() > deadline) throw new Error(`Fixture did not become ready: ${error}\n${serverLog}`);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    const health = await request('/healthz');
    if (JSON.parse(health.body).version !== VERSION) throw new Error(`Expected server ${VERSION}, got ${health.body}`);
    const discovery = await request('/healthz', { method: 'HEAD' });
    const seed = generateSeed();
    const seedPath = path.join(cluster, 'seed.ndjson');
    writeFileSync(seedPath, seed);
    const loaded = JSON.parse(runCli(['load', '--data', seedPath, '--mode', 'merge', '--target', 'fixture', '--graph', GRAPH_ID, '--json']));
    const total = (tables) => (tables ?? []).reduce((sum, table) => sum + table.entities_loaded, 0);
    if (total(loaded.nodes) !== 300 || total(loaded.edges) !== 500) throw new Error(`Unexpected load counts: ${JSON.stringify(loaded)}`);
    console.log(`FIXTURE_READY ${BASE} · 300 nodes · 500 edges`);
    if (SERVE) {
      await Promise.race([
        new Promise((resolve) => { if (shutdown.signal.aborted) resolve(); else shutdown.signal.addEventListener('abort', resolve, { once: true }); }),
        serverClosed.then(() => { throw new Error(`Fixture server exited unexpectedly: ${serverLog}`); }),
      ]);
      return;
    }

    const graph = (route) => `/graphs/${GRAPH_ID}${route}`;
    const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const schema = await request(graph('/schema'));
    const commits = await request(graph(`/commits?branch=${BRANCH}&limit=1`));
    const snapshot = await request(graph('/snapshot'));
    const full = await request(graph('/export'), json({}));
    const partial = await request(graph('/export'), json({ type_names: ['Correlates', 'Signal'] }));
    const search = await request(graph('/queries/search_signals'), json({ branch: BRANCH, params: { q: 'Signal 1:' } }));
    const after = await request(graph(`/commits?branch=${BRANCH}&limit=1`));
    const lines = full.body.trimEnd().split('\n').map((line) => JSON.parse(line));
    const firstNode = lines.findIndex((line) => line.type !== undefined);
    if (lines.length !== 800 || firstNode !== 500 || lines.slice(firstNode).some((line) => line.edge !== undefined)) throw new Error('Expected 500 edge lines followed by 300 node lines');
    if (lines.some((line) => typeof line.id !== 'string')) throw new Error('Export is missing top-level entity identity');
    if (newestCommitId(commits.body) !== newestCommitId(after.body)) throw new Error('Fixture head moved during recording');
    const hit = JSON.parse(search.body).rows?.[0]?.s;
    if (hit?.['@id'] !== 'signal-001' || hit?.id !== 1) throw new Error(`Search identity contract changed: ${search.body}`);
    const manifest = {
      recordedAt: new Date().toISOString(), serverVersion: VERSION, httpApiContract: CONTRACT,
      graphId: GRAPH_ID, branch: BRANCH,
      headBefore: newestCommitId(commits.body), headAfter: newestCommitId(after.body),
      rowCounts: Object.fromEntries(JSON.parse(snapshot.body).datasets.map((table) => [`${table.entity_kind}:${table.type_name}`, table.entity_count])),
      exportLineCount: lines.length, edgeLinesBeforeNodeLines: true,
      notes: 'Verbatim OmniGraph 0.14.0 HTTP bodies from a fresh isolated local cluster. Identity is top-level id in export and @id in query node values; nullable data properties are omitted. The branch was quiescent during recording.',
    };
    mkdirSync(RECORDED_DIR, { recursive: true });
    const recordings = {
      'health.json': health.body, 'schema.json': schema.body, 'commits.json': commits.body,
      'snapshot.json': snapshot.body, 'export.ndjson': full.body, 'export-partial.ndjson': partial.body,
      'search.json': search.body,
      'http.json': JSON.stringify({ requestHeader: { [HEADER]: CONTRACT }, discovery: { method: 'HEAD', path: '/healthz', status: discovery.status, responseHeader: { [HEADER]: discovery.apiContract } } }, null, 2) + '\n',
      'manifest.json': JSON.stringify(manifest, null, 2) + '\n',
    };
    for (const [file, body] of Object.entries(recordings)) {
      if (!body) throw new Error(`Refusing empty recording ${file}`);
      writeFileSync(path.join(RECORDED_DIR, file), body);
      console.log(`Recorded ${file} (${Buffer.byteLength(body)} bytes)`);
    }
    writeFileSync(path.join(FIXTURE_DIR, 'seed.ndjson'), seed);
    console.log('OK: OmniGraph 0.14 fixtures regenerated');
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (server !== undefined && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      const timeout = setTimeout(() => server.kill('SIGKILL'), 10000);
      try { await serverClosed; } finally { clearTimeout(timeout); }
    }
    rmSync(cluster, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
