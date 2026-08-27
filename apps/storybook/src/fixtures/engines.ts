/**
 * Engine factories for stories.
 *
 * Cosmos = real WebGL (the visual catalog). FakeEngine = headless double for
 * component stories and play functions — its inject* methods drive hover,
 * click, context-menu, and viewport events without a GPU.
 */

import { FakeEngine } from '@modernrelay/orbit-core/testing';
import type { FakeEngineOptions } from '@modernrelay/orbit-core/testing';
import { CosmosEngine } from '@modernrelay/orbit-engine-cosmos';

export const cosmosEngine = () => new CosmosEngine();

export interface FakeEngineHolder {
  /** pass to <Graph engine> — one engine per mounted Graph */
  factory: () => FakeEngine;
  /** the most recently constructed engine (for play-function inject* calls) */
  current: () => FakeEngine | null;
}

export function makeFakeEngineHolder(opts?: FakeEngineOptions): FakeEngineHolder {
  let engine: FakeEngine | null = null;
  return {
    factory: () => {
      engine = opts === undefined ? new FakeEngine() : new FakeEngine(opts);
      return engine;
    },
    current: () => engine,
  };
}
