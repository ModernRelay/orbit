/**
 * Vite `?raw` imports (used by loader.test.ts to load the recorded HTTP
 * fixtures as verbatim text).
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
