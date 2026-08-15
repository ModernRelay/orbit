/**
 * Probe record writer shared by all GPU probes.
 *
 * Writes one JSON record per capability into `apps/spike/results/records/`
 * and copies evidence files into `.evidence/m0/<capability>/` (local-only,
 * gitignored).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ProbeMeta {
  cosmosVersion: string;
  browser: string;
  os: string;
  headful: boolean;
  gpu: string;
  date: string;
}

export interface ProbeRecord {
  capability: string;
  expected: string;
  observed: unknown;
  pass: boolean;
  evidence: string[];
  notes: string;
  status: 'measured';
  meta: ProbeMeta;
}

export interface ProbeRecordInput {
  capability: string;
  expected: string;
  observed: unknown;
  pass: boolean;
  /** Absolute paths of evidence files (screenshots, dumps). */
  evidence?: string[];
  notes?: string;
  browser?: string;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RECORDS_DIR = path.join(REPO_ROOT, 'apps', 'spike', 'results', 'records');
const EVIDENCE_ROOT = path.join(REPO_ROOT, '.evidence', 'm0'); // local-only (gitignored)

function readCosmosVersion(): string {
  const pkgPath = path.join(
    REPO_ROOT,
    'apps',
    'spike',
    'node_modules',
    '@cosmos.gl',
    'graph',
    'package.json',
  );
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
  return pkg.version ?? 'unknown';
}

/**
 * Absolute evidence directory for a capability (created on demand).
 * Playwright screenshots should be written straight into this directory.
 */
export function evidenceDir(capability: string): string {
  const dir = path.join(EVIDENCE_ROOT, capability);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Convenience: absolute path for one evidence file of a capability. */
export function evidencePath(capability: string, filename: string): string {
  return path.join(evidenceDir(capability), filename);
}

/** Write a JSON evidence artifact and return its absolute path. */
export function writeEvidenceJson(capability: string, filename: string, data: unknown): string {
  const p = evidencePath(capability, filename);
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
  return p;
}

/**
 * Persist a probe record. Evidence files outside the capability's evidence
 * directory are copied in; stored evidence paths are repo-relative.
 */
export function recordProbe(input: ProbeRecordInput): ProbeRecord {
  const capDir = evidenceDir(input.capability);
  const evidence: string[] = [];
  for (const src of input.evidence ?? []) {
    const dest = path.join(capDir, path.basename(src));
    if (path.resolve(src) !== path.resolve(dest)) {
      fs.copyFileSync(src, dest);
    }
    evidence.push(path.relative(REPO_ROOT, dest).split(path.sep).join('/'));
  }

  const record: ProbeRecord = {
    capability: input.capability,
    expected: input.expected,
    observed: input.observed,
    pass: input.pass,
    evidence,
    notes: input.notes ?? '',
    status: 'measured',
    meta: {
      cosmosVersion: readCosmosVersion(),
      browser: input.browser ?? 'chromium',
      os: process.platform,
      headful: !!process.env.PROBE_HEADFUL,
      gpu: process.env.PROBE_GPU ?? 'unspecified',
      date: new Date().toISOString(),
    },
  };

  fs.mkdirSync(RECORDS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(RECORDS_DIR, `${input.capability}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}
