/**
 * Lazy-load fixture: a consumer that imports CosmosEngine statically.
 * Bundled by scripts/pack-smoke.mjs with code splitting; @cosmos.gl/graph
 * must land in a lazily-loaded chunk, never in the entry chunk (bundle-isolation rule:
 * cosmos loads at mount time, not import time).
 */
import { CosmosEngine } from '@modernrelay/orbit-engine-cosmos';

// Reference the import so it survives bundling.
console.log(typeof CosmosEngine);
