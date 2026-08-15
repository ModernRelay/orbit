/**
 * Minimal Node.js typings for the Playwright-side probe code.
 *
 * The spike deliberately carries no @types/node dependency (the workspace
 * lockfile is frozen for this milestone); these declarations cover exactly
 * the surface the probes use.
 */

declare module 'node:fs' {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function writeFileSync(path: string, data: string): void;
  export function copyFileSync(src: string, dest: string): void;
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string): string;
  export function relative(from: string, to: string): string;
  export function isAbsolute(p: string): boolean;
  export const sep: string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

// eslint-disable-next-line no-var
declare var process: {
  env: Record<string, string | undefined>;
  platform: string;
};
