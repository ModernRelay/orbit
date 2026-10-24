import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

/** Run against an isolated install of packed packages, never workspace exports. */
export async function verifyQuickstart({ root, consumerDir, outdir }) {
  const sourceDir = path.join(root, 'fixtures', 'quickstart');
  const guide = readFileSync(path.join(root, 'docs', 'core', 'getting-started.md'), 'utf8');
  for (const file of ['App.tsx', 'main.tsx']) {
    const marker = `<!-- quickstart:${file} -->`;
    const start = guide.indexOf(marker);
    const block = start < 0 ? null : /^\s*```tsx\n([\s\S]*?)\n```/.exec(guide.slice(start + marker.length));
    const source = readFileSync(path.join(sourceDir, file), 'utf8');
    if (block === null || block[1] + '\n' !== source) {
      throw new Error(`getting-started.md must contain the exact fixtures/quickstart/${file} source after ${marker}`);
    }
    copyFileSync(path.join(sourceDir, file), path.join(consumerDir, file));
  }

  // Native TS checks the published declarations and the browser entry together.
  execFileSync(process.execPath, [
    path.join(root, 'packages', 'core', 'node_modules', 'typescript', 'bin', 'tsc'),
    '--ignoreConfig', '--strict', '--noEmit', '--target', 'ES2022',
    '--module', 'ESNext', '--moduleResolution', 'Bundler', '--jsx', 'react-jsx',
    'App.tsx', 'main.tsx',
  ], { cwd: consumerDir, encoding: 'utf8', stdio: 'pipe' });

  // Keep a runnable browser harness for real GPU QA. All modules resolve from
  // the fresh consumer, including the real Cosmos adapter and its lazy import.
  mkdirSync(outdir, { recursive: true });
  await esbuild.build({
    absWorkingDir: consumerDir,
    entryPoints: ['main.tsx'], outdir,
    bundle: true, splitting: true, format: 'esm', platform: 'browser',
    jsx: 'automatic', logLevel: 'silent',
  });
  copyFileSync(path.join(sourceDir, 'index.html'), path.join(outdir, 'index.html'));

  // Execute the same example with a deterministic engine; imports remain
  // external so this also checks the installed packages' runtime exports.
  await esbuild.build({
    absWorkingDir: consumerDir,
    entryPoints: ['App.tsx'], outfile: path.join(consumerDir, 'App.js'),
    format: 'esm', jsx: 'automatic', logLevel: 'silent',
  });
  copyFileSync(path.join(sourceDir, 'smoke.mjs'), path.join(consumerDir, 'quickstart-smoke.mjs'));
  const output = execFileSync(process.execPath, ['quickstart-smoke.mjs'], {
    cwd: consumerDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  return { browserHarness: outdir, checks: output.trim() };
}
