/**
 * Minimal ambient declarations for the node builtins `codegen-cli.ts` (and
 * the codegen tests) use. The workspace deliberately ships no `@types/node`
 * (the package's runtime surface is browser-safe), so the CLI — the one
 * node-only file besides the server entry — declares exactly the slice it
 * needs. Shapes match the Node 18+ runtime.
 */

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
}

declare module 'node:path' {
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare module 'node:process' {
  interface WritableLike {
    write(chunk: string): boolean;
  }
  const process: {
    argv: string[];
    exitCode: number | undefined;
    stdout: WritableLike;
    stderr: WritableLike;
  };
  export default process;
}
