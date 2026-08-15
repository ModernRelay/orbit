/**
 * Tree-shake fixture: a consumer that renders a Graph and nothing else.
 * Bundled by scripts/pack-smoke.mjs against the packed tarballs; the resulting
 * bundle must NOT contain:
 *  - 'FakeEngine'        (the `@modernrelay/orbit-core/testing` entry stays out), or
 *  - any packaged component sentinel — 'GraphToolbar', 'GraphContextMenu',
 *    'GraphTable', 'GraphSimControls', … plus the '__ORBIT_TABLE_SENTINEL__' /
 *    '__ORBIT_SIMCONTROLS_SENTINEL__' probe constants (the ./components/*
 *    entries of orbit-react stay out — importing the react ROOT must not pull
 *    packaged component code). The full list lives in the gate.
 */
import { Graph } from '@modernrelay/orbit-react';

// Reference the import so it survives bundling.
console.log(typeof Graph);
