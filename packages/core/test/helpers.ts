/**
 * Shared FakeEngine-backed harness for instance-level suites
 * (instance.test.ts, recovery.test.ts).
 */

import { createGraphInstance } from '../src/instance';
import type { GraphInstance } from '../src/instance';
import { FakeEngine } from '../src/testing/index';
import type { FakeEngineOptions, RecordedCall } from '../src/testing/index';
import type { GraphSnapshot } from '../src/types';

export const container = {} as unknown as HTMLElement;

export type NAttrs = { label: string };
export type EAttrs = { weight: number };

export function snap(
  rev: number | string,
  ids: readonly string[],
  links: ReadonlyArray<readonly [string, string]> = [],
  datasetKey = 'ds',
): GraphSnapshot<NAttrs, EAttrs> {
  return {
    datasetKey,
    sourceRevision: rev,
    nodes: ids.map((id) => ({ id, attrs: { label: id.toUpperCase() } })),
    edges: links.map(([source, target]) => ({ source, target, attrs: { weight: 1 } })),
  };
}

export interface MakeInstanceOptions {
  fitViewOnFirstData?: boolean;
  /** Passed to every FakeEngine the factory constructs. */
  engineOptions?: FakeEngineOptions;
}

export interface InstanceHarness {
  instance: GraphInstance<NAttrs, EAttrs>;
  engines: FakeEngine[];
  factoryCalls: () => number;
}

export function makeInstance(opts: MakeInstanceOptions = {}): InstanceHarness {
  const engines: FakeEngine[] = [];
  let factoryCalls = 0;
  const instance = createGraphInstance<NAttrs, EAttrs>({
    engine: () => {
      factoryCalls++;
      const e = new FakeEngine(opts.engineOptions ?? {});
      engines.push(e);
      return e;
    },
    ...(opts.fitViewOnFirstData !== undefined
      ? { fitViewOnFirstData: opts.fitViewOnFirstData }
      : {}),
  });
  return { instance, engines, factoryCalls: () => factoryCalls };
}

export function callsOf(engine: FakeEngine, method: string): RecordedCall[] {
  return engine.calls.filter((c) => c.method === method);
}
