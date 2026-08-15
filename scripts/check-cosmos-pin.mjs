#!/usr/bin/env node
/**
 * Keep the adapter and the browser probe app on the same exact Cosmos build.
 * A range would let the two workspaces resolve different engines over time,
 * invalidating the probe results used to describe adapter behavior.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COSMOS_PACKAGE = '@cosmos.gl/graph';
const MANIFESTS = [
  'packages/engine-cosmos/package.json',
  'apps/spike/package.json',
];
const EXACT_SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

async function readPin(relativePath) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(ROOT, relativePath), 'utf8'));
  } catch (error) {
    throw new Error(`could not read ${relativePath}: ${error.message}`);
  }

  const version = manifest.dependencies?.[COSMOS_PACKAGE];
  if (typeof version !== 'string') {
    throw new Error(
      `${relativePath} must declare ${COSMOS_PACKAGE} in dependencies`,
    );
  }
  if (!EXACT_SEMVER_RE.test(version)) {
    throw new Error(
      `${relativePath} must pin ${COSMOS_PACKAGE} to an exact version; found ${JSON.stringify(version)}`,
    );
  }

  return { relativePath, version };
}

try {
  const pins = await Promise.all(MANIFESTS.map(readPin));
  const [expected, ...rest] = pins;
  const mismatch = rest.find(({ version }) => version !== expected.version);

  if (mismatch) {
    throw new Error(
      `${expected.relativePath} pins ${COSMOS_PACKAGE}@${expected.version}, but ` +
        `${mismatch.relativePath} pins ${COSMOS_PACKAGE}@${mismatch.version}; update both manifests together`,
    );
  }

  console.log(
    `[cosmos-pin] OK: ${COSMOS_PACKAGE}@${expected.version} is exactly pinned in ${MANIFESTS.join(' and ')}`,
  );
} catch (error) {
  console.error(`[cosmos-pin] ERROR: ${error.message}`);
  process.exitCode = 1;
}
