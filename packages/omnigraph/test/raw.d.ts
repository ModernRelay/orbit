/**
 * Vite `?raw` imports (used by loader.test.ts to load the recorded HTTP
 * fixtures as verbatim text without node:fs — the workspace deliberately
 * ships no @types/node).
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
