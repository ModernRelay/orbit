/**
 * error taxonomy — pure-function contract tests.
 */

import { describe, expect, it } from 'vitest';

import {
  OrbitOperationError,
  graphErrorToError,
  isFatalGraphError,
  resourceLimitFatal,
} from '../src/errors';
import type { ErrorPhase, GraphError } from '../src/errors';

const PHASES: readonly ErrorPhase[] = ['mount', 'running', 'recovery'];

describe('isFatalGraphError', () => {
  const rows: ReadonlyArray<{ label: string; error: GraphError; fatal: boolean }> = [
    {
      label: 'engine-unsupported',
      error: { code: 'engine-unsupported', detail: 'no WebGL2' },
      fatal: true,
    },
    {
      label: 'context-lost (terminal recovery failure only)',
      error: { code: 'context-lost' },
      fatal: true,
    },
    {
      label: 'resource-limit fatal:true',
      error: { code: 'resource-limit', detail: { reason: 'too many points' }, fatal: true },
      fatal: true,
    },
    {
      label: 'resource-limit fatal:false',
      error: { code: 'resource-limit', detail: { reason: 'too many points' }, fatal: false },
      fatal: false,
    },
    {
      label: 'service-failed',
      error: { code: 'service-failed', service: 'search', cause: new Error('boom') },
      fatal: false,
    },
  ];

  for (const { label, error, fatal } of rows) {
    for (const phase of PHASES) {
      it(`${label} @ ${phase} → ${fatal}`, () => {
        expect(isFatalGraphError(error, phase)).toBe(fatal);
      });
    }
  }
});

describe('resourceLimitFatal', () => {
  it('is fatal during recovery regardless of an accepted scene', () => {
    expect(resourceLimitFatal('recovery', false)).toBe(true);
    expect(resourceLimitFatal('recovery', true)).toBe(true);
  });

  it('is fatal before the first accepted scene', () => {
    expect(resourceLimitFatal('mount', false)).toBe(true);
    expect(resourceLimitFatal('running', false)).toBe(true);
  });

  it('keeps the previous scene (non-fatal) for a later inadmissible update', () => {
    expect(resourceLimitFatal('mount', true)).toBe(false);
    expect(resourceLimitFatal('running', true)).toBe(false);
  });
});

describe('OrbitOperationError', () => {
  it('is an Error with a stable name and an intact typed detail', () => {
    const detail = { code: 'stale-revision', expected: 4, actual: 2 } as const;
    const err = new OrbitOperationError(detail);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OrbitOperationError);
    expect(err.name).toBe('OrbitOperationError');
    expect(err.detail).toBe(detail);
    expect(err.message).toBe('orbit operation failed: stale-revision');
  });

  it('prefers an explicit message over the code-derived default', () => {
    const err = new OrbitOperationError(
      { code: 'aborted', cause: 'destroyed' },
      'fitView() called on a destroyed GraphInstance',
    );
    expect(err.message).toBe('fitView() called on a destroyed GraphInstance');
    expect(err.detail).toEqual({ code: 'aborted', cause: 'destroyed' });
  });
});

describe('graphErrorToError', () => {
  it('formats a message per code', () => {
    expect(graphErrorToError({ code: 'engine-unsupported', detail: 'no WebGL2' }).message).toBe(
      'orbit engine unsupported: no WebGL2',
    );
    expect(
      graphErrorToError({
        code: 'resource-limit',
        detail: { reason: 'byte budget exceeded' },
        fatal: true,
      }).message,
    ).toBe('orbit resource limit: byte budget exceeded');
    expect(graphErrorToError({ code: 'context-lost' }).message).toBe(
      'orbit: WebGL context lost and could not be recovered',
    );
    expect(
      graphErrorToError({ code: 'service-failed', service: 'metrics', cause: null }).message,
    ).toBe('orbit service failed: metrics');
  });

  it('passes an explicit cause through by identity', () => {
    const cause = new Error('the real one');
    expect(graphErrorToError({ code: 'context-lost' }, cause)).toBe(cause);
    expect(graphErrorToError({ code: 'engine-unsupported', detail: 'x' }, cause)).toBe(cause);
  });
});
