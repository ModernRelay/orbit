/**
 * @modernrelay/orbit-data — prepared-data adapters.
 *
 * Root entry: built-in lanes only (row objects, streaming CSV, JSON
 * document) plus the versioned artifact round-trip. Arrow and Parquet are
 * SEPARATE entry points (`@modernrelay/orbit-data/arrow` / `/parquet`) and
 * are deliberately NOT re-exported here — importing the root must never pull
 * an optional format parser into the bundle.
 *
 * Framework-agnostic and Node-import-safe: no DOM, no network — the package
 * consumes supplied bytes/streams and never fetches a URL (enforced by the
 * repo purity lint block, eslint.config.mjs).
 */

export { prepareGraphData } from './prepare';
export {
  serializePrepared,
  loadPrepared,
  validatePreparedEnvelope,
  PREPARED_ARTIFACT_FORMAT_VERSION,
} from './artifact';
export { computeMappingFingerprint, canonicalJson, fnv1a64Hex } from './fingerprint';
export type {
  GraphRowSource,
  GraphByteSource,
  GraphTabularSource,
  GraphPrepareInput,
  GraphColumnMapping,
  GraphPrepareFormat,
  GraphPrepareOptions,
  ColumnSummary,
  PreparedGraph,
  PreparedGraphSummaries,
} from './types';
