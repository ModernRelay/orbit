import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5299,
    strictPort: true,
  },
  // Pre-bundle the engine at server start so the first probe page load never
  // races a mid-session "optimized dependencies changed" full reload.
  optimizeDeps: {
    include: ['@cosmos.gl/graph'],
  },
});
