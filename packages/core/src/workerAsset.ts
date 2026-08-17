/**
 * Construct the built-in module worker from a package-root-relative asset.
 *
 * This file deliberately lives at src/ root: workspace consumers resolve
 * package exports to src/index.ts, while published consumers execute the
 * bundled dist/index.js. In both layouts `./worker/entry.js` is therefore
 * adjacent at the same relative path, and Vite can statically discover the
 * direct Worker(new URL(...)) expression in workspace builds.
 */
export function createDefaultWorker(): Worker {
  return new Worker(new URL('./worker/entry.js', import.meta.url), { type: 'module' });
}
