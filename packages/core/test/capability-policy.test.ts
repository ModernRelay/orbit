import { describe, expect, it } from 'vitest';

import {
  assertCapabilityMethodParity,
  normalizeCommitForCapabilities,
  resolveEnginePolicy,
} from '../src/capabilityPolicy';
import type { EnginePolicy } from '../src/capabilityPolicy';
import type {
  EngineBufferChannel,
  EngineCapabilities,
  EngineCommit,
  GraphEngine,
} from '../src/engine/index';
import { FakeEngine } from '../src/testing/index';

function caps(overrides: Partial<EngineCapabilities> = {}): EngineCapabilities {
  return {
    linkPicking: false,
    rangeUpdates: [],
    trackedPositions: false,
    simulation: true,
    ...overrides,
  };
}

describe('resolveEnginePolicy', () => {
  it('selects native modes from a fully capable record', () => {
    const policy = resolveEnginePolicy(
      caps({
        linkPicking: true,
        edgeArrows: true,
        pointImages: true,
        rangeUpdates: ['pointColor', 'pointSize'],
      }),
      { edgeArrows: true, images: true },
    );
    expect(policy.edgeArrows).toBe('native');
    expect(policy.images).toBe('native');
    expect(policy.linkPicking).toBe('native');
    expect([...policy.rangedChannels].sort()).toEqual(['pointColor', 'pointSize']);
    expect(policy.degradations).toEqual([]);
  });

  it('selects fallback modes from an incapable record', () => {
    const policy = resolveEnginePolicy(caps(), {});
    expect(policy.edgeArrows).toBe('inert');
    expect(policy.images).toBe('placeholder');
    expect(policy.linkPicking).toBe('cpu-fallback');
    expect(policy.rangedChannels.size).toBe(0);
  });

  it("resolves quiescence from idleFrames and defaults absent to 'free-running' with NO degradation entry", () => {
    // stop-at-rest is capability-gated observability, never a warning
    // nothing is host-requested, so an idle spinner must not add a
    // degradation row.
    expect(resolveEnginePolicy(caps({ idleFrames: 'stops' }), {}).quiescence).toBe('stops');
    expect(resolveEnginePolicy(caps({ idleFrames: 'free-running' }), {}).quiescence).toBe(
      'free-running',
    );
    const absent = resolveEnginePolicy(caps(), {});
    expect(absent.quiescence).toBe('free-running');
    expect(absent.degradations).toEqual([]);
  });

  it('treats absent optional capability flags exactly like false', () => {
    const withoutFlags = resolveEnginePolicy(caps(), { edgeArrows: true, images: true });
    const withFalse = resolveEnginePolicy(
      caps({ edgeArrows: false, pointImages: false }),
      { edgeArrows: true, images: true },
    );
    expect(withoutFlags.edgeArrows).toBe('inert');
    expect(withoutFlags.images).toBe('placeholder');
    expect(withFalse.edgeArrows).toBe(withoutFlags.edgeArrows);
    expect(withFalse.images).toBe(withoutFlags.images);
  });

  it('is frozen: mutating the input capabilities afterwards changes nothing', () => {
    const record = caps({ rangeUpdates: ['pointColor'] });
    const policy = resolveEnginePolicy(record, { edgeArrows: true });

    expect(policy.edgeArrows).toBe('inert');
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.degradations)).toBe(true);

    // Mutate the input record after resolution — the policy must not drift.
    (record as { edgeArrows?: boolean }).edgeArrows = true;
    (record as { pointImages?: boolean }).pointImages = true;
    (record as { linkPicking: boolean }).linkPicking = true;
    (record.rangeUpdates as EngineBufferChannel[]).push('pointSize');

    expect(policy.edgeArrows).toBe('inert');
    expect(policy.images).toBe('placeholder');
    expect(policy.linkPicking).toBe('cpu-fallback');
    expect(policy.rangedChannels.has('pointSize')).toBe(false);
    expect(policy.rangedChannels.has('pointColor')).toBe(true);
    expect(policy.degradations).toHaveLength(1);

    // Direct assignment to the frozen record throws under strict mode.
    expect(() => {
      (policy as { edgeArrows: EnginePolicy['edgeArrows'] }).edgeArrows = 'native';
    }).toThrow(TypeError);
  });

  it('emits exactly one degradation per requested-but-unsupported feature', () => {
    const policy = resolveEnginePolicy(caps(), { edgeArrows: true, images: true });
    expect(policy.degradations).toHaveLength(2);
    expect(policy.degradations.map((d) => d.feature).sort()).toEqual(['edgeArrows', 'images']);
    for (const d of policy.degradations) {
      expect(d.reason.length).toBeGreaterThan(0);
    }

    const onlyArrows = resolveEnginePolicy(caps(), { edgeArrows: true });
    expect(onlyArrows.degradations.map((d) => d.feature)).toEqual(['edgeArrows']);
  });

  it('emits zero degradations when features are unrequested or supported', () => {
    // Unsupported but never requested: silent (fallback mode, no warning).
    expect(resolveEnginePolicy(caps(), {}).degradations).toEqual([]);
    expect(
      resolveEnginePolicy(caps(), { edgeArrows: false, images: false }).degradations,
    ).toEqual([]);
    // Requested and supported: nothing degraded.
    expect(
      resolveEnginePolicy(caps({ edgeArrows: true, pointImages: true }), {
        edgeArrows: true,
        images: true,
      }).degradations,
    ).toEqual([]);
  });
});

describe('assertCapabilityMethodParity', () => {
  it('returns [] on FakeEngine (default and trackedPositions profiles)', () => {
    expect(assertCapabilityMethodParity(new FakeEngine())).toEqual([]);
    expect(
      assertCapabilityMethodParity(
        new FakeEngine({ capabilities: { trackedPositions: true, linkPicking: true } }),
      ),
    ).toEqual([]);
  });

  it('flags trackedPositions declared while getPositions is absent', () => {
    const broken = {
      capabilities: caps({ trackedPositions: true }),
    } as unknown as GraphEngine;
    const mismatches = assertCapabilityMethodParity(broken);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain('trackedPositions');
    expect(mismatches[0]).toContain('getPositions');
  });

  it('flags a missing capabilities record instead of throwing', () => {
    const bare = {} as unknown as GraphEngine;
    const mismatches = assertCapabilityMethodParity(bare);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain('capabilities');
  });
});

describe('normalizeCommitForCapabilities', () => {
  const atlasCommit = (): EngineCommit => ({
    revision: 7,
    buffers: { pointSize: new Float32Array([4]) },
    config: { linkArrows: true, backgroundColor: '#000' },
    resources: {
      imageAtlas: { removeSlots: [2] },
      pointImageIndex: new Float32Array([-1]),
    },
  });

  it('strips resources and config.linkArrows for an incapable engine', () => {
    const commit = atlasCommit();
    const { commit: normalized, dropped } = normalizeCommitForCapabilities(commit, caps());

    expect(normalized).not.toBe(commit);
    expect(normalized.resources).toBeUndefined();
    expect(normalized.config).toEqual({ backgroundColor: '#000' });
    expect('linkArrows' in (normalized.config ?? {})).toBe(false);
    expect(dropped).toEqual(['resources', 'config.linkArrows']);

    // Non-stripped payload rides through untouched (same references).
    expect(normalized.revision).toBe(7);
    expect(normalized.buffers).toBe(commit.buffers);

    // The input commit is never mutated.
    expect(commit.resources).toBeDefined();
    expect(commit.config?.linkArrows).toBe(true);
  });

  it('drops config entirely when the strip empties it', () => {
    const commit: EngineCommit = { revision: 1, config: { linkArrows: false } };
    const { commit: normalized, dropped } = normalizeCommitForCapabilities(commit, caps());
    expect(normalized.config).toBeUndefined();
    expect('config' in normalized).toBe(false);
    expect(dropped).toEqual(['config.linkArrows']);
  });

  it('preserves identity for a capable engine', () => {
    const commit = atlasCommit();
    const capable = caps({ edgeArrows: true, pointImages: true });
    const { commit: normalized, dropped } = normalizeCommitForCapabilities(commit, capable);
    expect(normalized).toBe(commit);
    expect(dropped).toEqual([]);
  });

  it('preserves identity when the commit carries nothing gated', () => {
    const commit: EngineCommit = {
      revision: 3,
      config: { backgroundColor: '#111', renderLinks: true },
    };
    const { commit: normalized, dropped } = normalizeCommitForCapabilities(commit, caps());
    expect(normalized).toBe(commit);
    expect(dropped).toEqual([]);
  });

  it('strips each gated payload independently', () => {
    const arrowsOnly = caps({ edgeArrows: true });
    const { commit: normalized, dropped } = normalizeCommitForCapabilities(
      atlasCommit(),
      arrowsOnly,
    );
    expect(dropped).toEqual(['resources']);
    expect(normalized.resources).toBeUndefined();
    expect(normalized.config?.linkArrows).toBe(true);

    const imagesOnly = caps({ pointImages: true });
    const result = normalizeCommitForCapabilities(atlasCommit(), imagesOnly);
    expect(result.dropped).toEqual(['config.linkArrows']);
    expect(result.commit.resources).toBeDefined();
  });
});
