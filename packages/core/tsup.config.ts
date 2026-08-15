import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      engine: 'src/engine/index.ts',
      testing: 'src/testing/index.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2022',
    treeshake: true,
  },
  // The inline worker asset ships INSIDE core — WorkerLane's
  // default factory resolves dist/worker/entry.js next to the built module.
  // Built SELF-CONTAINED (own pass, no shared chunks): bundlers treat the
  // worker URL as a raw asset and inline/relocate it, so a relative
  // `../chunk-*.js` import breaks for consumers relying on the inline
  // default. pack-smoke gates the no-imports shape.
  {
    entry: { 'worker/entry': 'src/worker/entry.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false, // the first pass owns dist cleaning
    target: 'es2022',
    splitting: false,
    treeshake: true,
    noExternal: [/.*/],
  },
]);
