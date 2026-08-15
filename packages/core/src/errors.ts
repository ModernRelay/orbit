/**
 * Typed error taxonomy for public operation failures.
 *
 * Structural fatality rule: a *transient* context loss never mints a
 * GraphError — it is a status transition ('lost') plus a 'context-lost'
 * warning diagnostic, and the 'error' event does not fire. A GraphError with
 * code 'context-lost' is constructed ONLY on terminal recovery failure, where
 * it is always fatal. This keeps fatality structural rather than conditional.
 */

/** Reserved for resource admission-control failures. */
export interface ResourceAdmissionReport {
  reason: string;
  estimatedBytes?: number;
  limitBytes?: number;
}

/** Instance-level faults, delivered via the 'error' event's `detail`. */
export type GraphError =
  | { code: 'engine-unsupported'; detail: string }
  | { code: 'resource-limit'; detail: ResourceAdmissionReport; fatal: boolean }
  /** Minted only on terminal context-recovery failure — always fatal. */
  | { code: 'context-lost' }
  | {
      code: 'service-failed';
      service: 'search' | 'expansion' | 'metrics' | 'path' | 'crossfilter';
      cause: unknown;
    };

/**
 * Operation-scoped failures: rejected promises / thrown calls.
 * All ten codes are typed now even where their subsystems are post-v0.2
 * the union is the public contract, the wiring arrives with each subsystem.
 */
export type GraphOperationError =
  | { code: 'export-too-large'; elementCount: number; limit: number }
  | { code: 'export-materialization-too-large'; rowCount: number; limit: number }
  | { code: 'queue-overflow'; queuedBytes: number; limit: number }
  | { code: 'invalid-view-state'; detail: string }
  | { code: 'invalid-ingest-sequence'; expected: number; received: number; conflict: boolean }
  | { code: 'ingest-session-closed' }
  | { code: 'stale-revision'; expected: number; actual: number }
  | { code: 'overlay-id-conflict'; overlayId: string }
  | { code: 'resource-limit'; detail: ResourceAdmissionReport }
  | { code: 'aborted'; cause?: unknown };

/** Lifecycle phase an instance-level error occurred in. */
export type ErrorPhase = 'mount' | 'running' | 'recovery';

/** Spec fatality matrix as a pure decision function. */
export function isFatalGraphError(error: GraphError, phase: ErrorPhase): boolean {
  switch (error.code) {
    case 'engine-unsupported':
      return true;
    case 'context-lost':
      // Only ever constructed for terminal recovery failure.
      return true;
    case 'resource-limit':
      return error.fatal;
    case 'service-failed':
      return false;
    default: {
      const exhaustive: never = error;
      void exhaustive;
      void phase;
      return true;
    }
  }
}

/**
 * Spec rule for a resource-limit producer deciding `fatal`: rejection is
 * fatal before the first accepted scene or during terminal recovery; a later
 * inadmissible declarative update keeps the previous scene (non-fatal).
 */
export function resourceLimitFatal(phase: ErrorPhase, hasAcceptedScene: boolean): boolean {
  return phase === 'recovery' || !hasAcceptedScene;
}

/** Error class carried by rejected/thrown operations; `.detail` is typed. */
export class OrbitOperationError extends Error {
  override readonly name = 'OrbitOperationError';
  readonly detail: GraphOperationError;

  constructor(detail: GraphOperationError, message?: string) {
    super(message ?? `orbit operation failed: ${detail.code}`);
    this.detail = detail;
  }
}

/** Human-readable Error for a GraphError (used as the 'error' event payload). */
export function graphErrorToError(graphError: GraphError, cause?: Error): Error {
  if (cause) return cause;
  switch (graphError.code) {
    case 'engine-unsupported':
      return new Error(`orbit engine unsupported: ${graphError.detail}`);
    case 'resource-limit':
      return new Error(`orbit resource limit: ${graphError.detail.reason}`);
    case 'context-lost':
      return new Error('orbit: WebGL context lost and could not be recovered');
    case 'service-failed':
      return new Error(`orbit service failed: ${graphError.service}`);
  }
}
