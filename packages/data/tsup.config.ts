import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', arrow: 'src/arrow.ts', parquet: 'src/parquet.ts' },
  format: ['esm'],
  dts: { entry: { index: 'src/index.ts', arrow: 'src/arrow.ts', parquet: 'src/parquet.ts' } },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  treeshake: true,
});
