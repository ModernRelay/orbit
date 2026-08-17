import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(scriptDir, '..', 'apps', 'demo', 'dist', 'assets');
const candidates = (await readdir(assetsDir)).filter(
  (name) => /^entry-[\w-]+\.js$/.test(name),
);

let workerAsset = null;
for (const name of candidates) {
  const file = path.join(assetsDir, name);
  const [info, source] = await Promise.all([stat(file), readFile(file, 'utf8')]);
  if (info.size >= 1_000 && source.includes('derive-columnar')) {
    workerAsset = { name, size: info.size };
    break;
  }
}

if (workerAsset === null) {
  throw new Error(
    'workspace worker smoke: Vite emitted no non-empty default worker asset containing derive-columnar',
  );
}

console.log(
  `workspace worker smoke: ${workerAsset.name} (${workerAsset.size} bytes)`,
);
