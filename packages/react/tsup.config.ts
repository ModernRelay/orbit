import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'components/Toolbar': 'src/components/Toolbar/index.tsx',
    'components/ContextMenu': 'src/components/ContextMenu/index.tsx',
    'components/SelectionActions': 'src/components/SelectionActions/index.tsx',
    'components/Navigator': 'src/components/Navigator/index.tsx',
    'components/Histogram': 'src/components/Histogram/index.tsx',
    'components/Timeline': 'src/components/Timeline/index.tsx',
    'components/Legend': 'src/components/Legend/index.tsx',
    'components/Search': 'src/components/Search/index.tsx',
    'components/Minimap': 'src/components/Minimap/index.tsx',
    'components/Tooltip': 'src/components/Tooltip/index.tsx',
    'components/Inspector': 'src/components/Inspector/index.tsx',
    'components/Explorer': 'src/components/Explorer/index.tsx',
    'components/Table': 'src/components/Table/index.tsx',
    'components/SimControls': 'src/components/SimControls/index.tsx',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  treeshake: true,
  // react/react-dom are peerDependencies but also devDependencies (for tests);
  // tsup only auto-externalizes deps/peers, and the devDep entry would win for
  // resolution — keep them explicitly external so no React code is bundled.
  external: ['react', 'react-dom', 'react/jsx-runtime'],
});
