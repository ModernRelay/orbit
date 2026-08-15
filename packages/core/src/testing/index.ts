/**
 * Public test seam: FakeEngine — headless, recording, with
 * event-injection helpers. Semver-stable: consumer suites depend on it.
 */
export { FakeEngine } from './FakeEngine';
export type { FakeEngineOptions, RecordedCall } from './FakeEngine';
// Convenience: the payload type of injectEngineDiagnostic.
export type { EngineDiagnostic } from '../engine/index';
// stage-4 instrumentation: `memberVisits` counts every
// per-member cluster iteration and `derivations` every stage-4 recomputation.
// Snapshot → act → compare pins "zero per-frame member iterations while hot"
// and "a stage-5 mask change never re-derives".
export { clusterProbe, resetClusterProbe } from '../clusters';
// Quiescence instrument: counts rAF SCHEDULING calls (a stopped
// loop registers nothing) separately from delivered ticks.
export { installRafAudit } from './rafAudit';
export type { RafAudit } from './rafAudit';
export { createWorkerDouble } from './workerDouble';
export type { WorkerDouble } from './workerDouble';
