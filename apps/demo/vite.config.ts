import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Same-origin BFF pattern: omnigraph-server ships no CORS config,
// so the browser talks to the dev server's own origin under '/og' and the
// proxy forwards with the prefix stripped. Production deployments use an
// equivalent reverse proxy / BFF route.
//
// Point at any Omnigraph server without touching this file:
//   OMNIGRAPH_PROXY_TARGET=http://127.0.0.1:8081 \
//   OMNIGRAPH_PROXY_TOKEN="$SOME_BEARER" pnpm demo:dev
// The bearer token is injected server-side by the proxy and never reaches
// browser code because static bearer tokens are secret material.
const target = process.env.OMNIGRAPH_PROXY_TARGET ?? 'http://127.0.0.1:8199';
const token = process.env.OMNIGRAPH_PROXY_TOKEN;
// Default graph id shown in the demo's Omnigraph panel (e.g. 'spike' when
// proxying the intel deployment). Falls back to the fixture graph 'demo'.
const defaultGraph = process.env.OMNIGRAPH_PROXY_GRAPH;

export default defineConfig({
  plugins: [react()],
  define: {
    __OMNIGRAPH_DEFAULT_GRAPH__: JSON.stringify(defaultGraph ?? ''),
  },
  server: {
    port: 5199,
    strictPort: true,
    proxy: {
      '/og': {
        target,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/og/, ''),
        ...(token
          ? { headers: { Authorization: `Bearer ${token}` } }
          : {}),
      },
    },
  },
});
