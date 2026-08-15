# Tree-shake fixtures

Entry points bundled by `scripts/pack-smoke.mjs` (gate h) against a temp
`npm install` of the packed tarballs — not against workspace sources.

- `react-root.ts` — imports only `Graph` from `@modernrelay/orbit-react`.
  Assertions: the bundle must not contain `FakeEngine` (proves the
  `@modernrelay/orbit-core/testing` entry is not pulled in and `sideEffects:
  false` + per-entry chunks hold up under tree shaking), and must not contain
  any packaged component sentinel — `GraphToolbar` / `GraphContextMenu` /
  `GraphHistogram` / `GraphTimeline` / `GraphLegend` / `GraphSearch` /
  `GraphMinimap` / `GraphTooltip` / `GraphInspector` / `GraphTable` /
  `GraphSimControls`, plus the `__ORBIT_TABLE_SENTINEL__` /
  `__ORBIT_SIMCONTROLS_SENTINEL__` probe constants those two entry modules
  export. The `@modernrelay/orbit-react/components/*` entries are separate
  chunks the root never pulls in.
- `omnigraph-client.ts` — imports only `createOmnigraphSource` from
  `@modernrelay/orbit-omnigraph` (the browser entry). Assertion: the bundle
  must not contain `createOmnigraphServerClient`; the server-only entry
  holding authenticated SDK construction must never reach a client bundle.
- `engine-lazy.ts` — imports `CosmosEngine` from
  `@modernrelay/orbit-engine-cosmos`. Bundled with `splitting: true`.
  Assertion (via esbuild metafile): the entry chunk contains no modules from
  `node_modules/@cosmos.gl/`, while at least one lazy chunk does — proving the
  runtime `import('@cosmos.gl/graph')` survived packaging as a dynamic import.

These files are not part of any package build; they are compiled only by the
smoke script, after being copied into the temp consumer so module resolution
hits the tarball install rather than the workspace.
