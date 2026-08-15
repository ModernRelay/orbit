import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  treeshake: true,
  // @cosmos.gl/graph is a regular dependency (auto-external), but the lazy-load
  // contract requires the runtime `import('@cosmos.gl/graph')` to survive
  // in dist verbatim — keep it explicitly external so neither esbuild nor the
  // rollup treeshake pass ever inlines it.
  external: ['@cosmos.gl/graph'],
});
