/**
 * Bundle-isolation fixture: a consumer that imports only the
 * ROOT entry of orbit-data. Bundled by scripts/pack-smoke.mjs against the
 * packed tarballs with NO externals; the resulting bundle must not contain
 * the 'apache-arrow' or 'hyparquet' module specifiers — the optional format
 * parsers live behind the ./arrow and ./parquet entries and must never be
 * pulled in by the root export.
 */
import { prepareGraphData, loadPrepared } from '@modernrelay/orbit-data';

// Reference the imports so they survive bundling.
console.log(typeof prepareGraphData, typeof loadPrepared);
