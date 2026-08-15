/**
 * theme tokens: resolveTheme base/partial/compat merges, the
 * engine-config token subset, store publication, and mutedAlpha driving the
 * dim alphas.
 */

import { describe, expect, it } from 'vitest';

import { GRAPH_THEME_DARK, GRAPH_THEME_LIGHT, resolveTheme } from '../src/instance';
import type { GraphTheme } from '../src/types';
import { container, makeInstance, snap } from './helpers';

describe('resolveTheme', () => {
  it('defaults to the dark base', () => {
    expect(resolveTheme(undefined)).toEqual(GRAPH_THEME_DARK);
    expect(GRAPH_THEME_DARK).toEqual({
      background: '#0b0e14',
      nodeDefault: '#94a3b8',
      edgeDefault: 'rgba(255,255,255,0.15)',
      labelFg: '#e6e9f0',
      accent: '#3b82f6',
      mutedAlpha: 0.15,
      emphasisRing: '#7aa2f7',
    });
  });

  it('resolves a named base', () => {
    expect(resolveTheme({ base: 'light' })).toEqual(GRAPH_THEME_LIGHT);
    expect(resolveTheme({ base: 'dark' })).toEqual(GRAPH_THEME_DARK);
    expect(GRAPH_THEME_LIGHT).toEqual({
      background: '#ffffff',
      nodeDefault: '#475569',
      edgeDefault: 'rgba(15,23,42,0.18)',
      labelFg: '#0f172a',
      accent: '#2563eb',
      mutedAlpha: 0.2,
      emphasisRing: '#2563eb',
    });
  });

  it('merges partial overrides over the named base ("light but brand accent" is one token)', () => {
    expect(resolveTheme({ base: 'light', accent: '#ff00aa' })).toEqual({
      ...GRAPH_THEME_LIGHT,
      accent: '#ff00aa',
    });
    expect(resolveTheme({ mutedAlpha: 0.5 })).toEqual({ ...GRAPH_THEME_DARK, mutedAlpha: 0.5 });
  });

  it('passes a full GraphTheme through verbatim', () => {
    const full: GraphTheme = {
      background: '#111111',
      nodeDefault: '#222222',
      edgeDefault: '#333333',
      labelFg: '#444444',
      accent: '#555555',
      mutedAlpha: 0.42,
      emphasisRing: '#666666',
    };
    expect(resolveTheme(full)).toEqual(full);
  });

  it('keeps the v0.1 {background} shorthand compatible (partial over dark)', () => {
    expect(resolveTheme({ background: '#101010' })).toEqual({
      ...GRAPH_THEME_DARK,
      background: '#101010',
    });
  });
});

describe('theme flow through the instance', () => {
  it('publishes store.theme on change (dark default until then)', async () => {
    const { instance } = makeInstance();
    expect(instance.store.getState().theme).toEqual(GRAPH_THEME_DARK);

    await instance.attach(container);
    let notified = 0;
    instance.store.subscribe((next, prev) => {
      if (next.theme !== prev.theme) notified++;
    });

    instance.applyHostUpdate({ theme: { base: 'light' } });
    expect(notified).toBe(1);
    expect(instance.store.getState().theme).toEqual(GRAPH_THEME_LIGHT);

    // Resolved-equal theme input: no publication, no commit churn.
    instance.applyHostUpdate({ theme: { base: 'light' } });
    expect(notified).toBe(1);
  });

  it('flows exactly the engine-relevant token subset into EngineConfigUpdate', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;

    // Mount replay already painted the dark defaults.
    const mountConfig = engine.commits[0]!.config!;
    expect(mountConfig.backgroundColor).toBe(GRAPH_THEME_DARK.background);
    expect(mountConfig.defaultPointColor).toBe(GRAPH_THEME_DARK.nodeDefault);
    expect(mountConfig.defaultLinkColor).toBe(GRAPH_THEME_DARK.edgeDefault);

    const before = engine.commits.length;
    instance.applyHostUpdate({ theme: { base: 'light' } });
    expect(engine.commits.length).toBe(before + 1);
    const commit = engine.lastCommit!;
    expect(commit.config).toEqual({
      backgroundColor: GRAPH_THEME_LIGHT.background,
      defaultPointColor: GRAPH_THEME_LIGHT.nodeDefault,
      defaultLinkColor: GRAPH_THEME_LIGHT.edgeDefault,
      emphasisRingColor: GRAPH_THEME_LIGHT.emphasisRing,
    });
    expect(commit.buffers).toBeUndefined(); // config-only, never a reprojection

    // Only the CHANGED tokens flow on a partial follow-up.
    instance.applyHostUpdate({ theme: { base: 'light', background: '#eeeeee' } });
    expect(engine.lastCommit!.config).toEqual({ backgroundColor: '#eeeeee' });
  });

  it('mutedAlpha drives the dim alphas (default 0.15, retinted on theme change)', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;

    instance.applyHostUpdate({
      data: snap(1, ['a', 'b', 'c'], [['a', 'b']]),
      nodeColor: 'red',
      filter: { nodes: { op: 'neq', field: 'id', value: 'b' }, mode: 'dim' },
    });
    let colors = engine.lastCommit!.buffers!.pointColor!;
    expect(colors[4 * 1 + 3]).toBeCloseTo(GRAPH_THEME_DARK.mutedAlpha, 5); // b dimmed
    expect(colors[4 * 0 + 3]).toBe(1); // a untouched

    // A mutedAlpha token change recomposes the dim lanes from the cached
    // base — one buffers commit, no re-projection of RGB.
    const before = engine.commits.length;
    instance.applyHostUpdate({ theme: { mutedAlpha: 0.5 } });
    expect(engine.commits.length).toBe(before + 1);
    colors = engine.lastCommit!.buffers!.pointColor!;
    expect(colors[4 * 1 + 3]).toBeCloseTo(0.5, 5);
    expect(colors[4 * 0 + 3]).toBe(1);
    const red = [colors[0], colors[1], colors[2]];
    expect(red).toEqual([1, 0, 0]); // base RGB untouched

    // The store published the resolved theme.
    expect(instance.store.getState().theme.mutedAlpha).toBe(0.5);
  });

  it('I5: no-accessor mask bases derive from the ACTIVE theme, not a hardcoded gray', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;

    // No nodeColor/linkColor accessor — the mask must synthesize bases.
    instance.applyHostUpdate({
      data: snap(1, ['a', 'b', 'c'], [['a', 'b'], ['a', 'c']]),
      filter: { nodes: { op: 'neq', field: 'id', value: 'b' }, mode: 'dim' },
    });

    // Node base = dark theme nodeDefault #94a3b8, NOT the legacy 0.66 gray.
    let colors = engine.lastCommit!.buffers!.pointColor!;
    expect(colors[0]).toBeCloseTo(148 / 255, 3);
    expect(colors[1]).toBeCloseTo(163 / 255, 3);
    expect(colors[2]).toBeCloseTo(184 / 255, 3);
    expect(colors[4 * 0 + 3]).toBe(1); // a visible at full alpha
    expect(colors[4 * 1 + 3]).toBeCloseTo(GRAPH_THEME_DARK.mutedAlpha, 5); // b dimmed

    // Edge base keeps the theme's TRANSLUCENCY: edgeDefault rgba(255,255,255,0.15)
    // → a visible edge composes to 0.15, never snaps to opaque 1.
    let links = engine.lastCommit!.buffers!.linkColor!;
    expect(links[4 * 1 + 0]).toBeCloseTo(1, 5); // white from the theme token…
    expect(links[4 * 1 + 3]).toBeCloseTo(0.15, 3); // …at theme alpha
    // (dim-mode nodes stay visible, so does not cascade edge alphas
    // the lane keeps the theme translucency on every edge, never opaque.)
    expect(links[4 * 0 + 3]).toBeCloseTo(0.15, 3);

    // Theme change WHILE MASKED rebuilds the synthesized bases from the new
    // tokens — light nodeDefault #475569, edgeDefault rgba(15,23,42,0.18).
    instance.applyHostUpdate({ theme: { base: 'light' } });
    colors = engine.lastCommit!.buffers!.pointColor!;
    expect(colors[0]).toBeCloseTo(0x47 / 255, 3);
    expect(colors[1]).toBeCloseTo(0x55 / 255, 3);
    expect(colors[2]).toBeCloseTo(0x69 / 255, 3);
    expect(colors[4 * 0 + 3]).toBe(1);
    expect(colors[4 * 1 + 3]).toBeCloseTo(GRAPH_THEME_LIGHT.mutedAlpha, 5);
    links = engine.lastCommit!.buffers!.linkColor!;
    expect(links[4 * 1 + 3]).toBeCloseTo(0.18, 3);

    // Clearing the filter recommits the theme-colored base at full lane
    // alpha — visually the pre-mask state, not a gray repaint.
    instance.applyHostUpdate({ filter: null });
    colors = engine.lastCommit!.buffers!.pointColor!;
    expect(colors[4 * 1 + 0]).toBeCloseTo(0x47 / 255, 3);
    expect(colors[4 * 1 + 3]).toBe(1);
  });

  it('I5: theme change never clobbers a PROJECTED base (accessor wins)', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;

    instance.applyHostUpdate({
      data: snap(1, ['a', 'b'], [['a', 'b']]),
      nodeColor: 'red',
      filter: { nodes: { op: 'neq', field: 'id', value: 'b' }, mode: 'dim' },
    });
    instance.applyHostUpdate({ theme: { base: 'light' } });
    const colors = engine.lastCommit!.buffers!.pointColor!;
    expect([colors[0], colors[1], colors[2]]).toEqual([1, 0, 0]); // still red
    expect(colors[4 * 1 + 3]).toBeCloseTo(GRAPH_THEME_LIGHT.mutedAlpha, 5); // dim retinted
  });
});
