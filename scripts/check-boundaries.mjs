#!/usr/bin/env node
/**
 * Import-boundary checks:
 * - orbit-core must not import react, react-dom, @cosmos.gl/*, or any sibling orbit package.
 * - @cosmos.gl/* may only be imported by orbit-engine-cosmos.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const violations = [];

function walk(dir, fn) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, fn);
    else if (/\.(ts|tsx|mts|cts)$/.test(name)) fn(p);
  }
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(file) {
  const src = readFileSync(file, 'utf8');
  const specs = [];
  for (const m of src.matchAll(IMPORT_RE)) specs.push(m[1] ?? m[2]);
  return specs;
}

function check(dir, isForbidden, why) {
  walk(join(ROOT, dir), (file) => {
    for (const spec of importsOf(file)) {
      if (spec && isForbidden(spec)) {
        violations.push(`${relative(ROOT, file)}: '${spec}' (${why})`);
      }
    }
  });
}

check('packages/core/src', (s) =>
  s === 'react' || s === 'react-dom' || s.startsWith('react/') || s.startsWith('react-dom/') ||
  s.startsWith('@cosmos.gl/') ||
  s.startsWith('@modernrelay/orbit-react') || s.startsWith('@modernrelay/orbit-engine-cosmos') ||
  s.startsWith('@modernrelay/orbit-data') || s.startsWith('@modernrelay/orbit-omnigraph'),
  'core is framework- and engine-free');

check('packages/react/src', (s) => s.startsWith('@cosmos.gl/'), 'only engine-cosmos may import cosmos');

if (violations.length) {
  console.error('Boundary violations:\n' + violations.map((v) => '  ' + v).join('\n'));
  process.exit(1);
}
console.log('boundaries OK');
