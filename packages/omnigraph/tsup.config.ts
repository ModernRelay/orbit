import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', server: 'src/server.ts', 'codegen-cli': 'src/codegen-cli.ts' },
  format: ['esm'],
  dts: { entry: { index: 'src/index.ts', server: 'src/server.ts' } },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  treeshake: true,
});
