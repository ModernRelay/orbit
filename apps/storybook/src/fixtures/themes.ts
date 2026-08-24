/**
 * Copied from apps/demo (styles.ts + App.tsx theme constants) — keep in sync
 * by hand. Theme inputs are partial-over-base: only the stated tokens differ
 * from orbit's built-in dark/light bases.
 */

import type { ThemeInput } from '@modernrelay/orbit-core';

export const BACKGROUND = '#0b0e14';
export const LIGHT_BACKGROUND = '#f6f8fa';

export const DARK_THEME: ThemeInput = { base: 'dark', background: BACKGROUND };
export const LIGHT_THEME: ThemeInput = { base: 'light', background: LIGHT_BACKGROUND };

export const LINK_COLOR = 'rgba(255,255,255,0.15)';
export const LINK_COLOR_LIGHT = 'rgba(0,0,0,0.15)';

export interface ActiveTheme {
  base: 'dark' | 'light';
  theme: ThemeInput;
  background: string;
  linkColor: string;
}

/** Resolve the Storybook global toolbar value into orbit theme pieces. */
export function themeFromGlobals(globals: Record<string, unknown>): ActiveTheme {
  const base = globals['theme'] === 'light' ? 'light' : 'dark';
  return base === 'light'
    ? { base, theme: LIGHT_THEME, background: LIGHT_BACKGROUND, linkColor: LINK_COLOR_LIGHT }
    : { base, theme: DARK_THEME, background: BACKGROUND, linkColor: LINK_COLOR };
}
