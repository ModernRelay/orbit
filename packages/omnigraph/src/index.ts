/**
 * @modernrelay/orbit-omnigraph — browser-safe entry.
 *
 * Adapter modules only: identity codec, `.pg` schema model,
 * export-line normalization, and the v1 export loader,
 * which accepts exclusively a **preconfigured** SDK client. Authenticated SDK
 * client construction lives exclusively in
 * `@modernrelay/orbit-omnigraph/server` — never here: this entry
 * exposes no `baseUrl`/`token` option anywhere.
 */

// Identity codec
export { encodeSourceId, decodeSourceId, encodeSyntheticEdgeId } from './idCodec';
export type { DecodedSourceId } from './idCodec';

// .pg schema model
export {
  parsePgSchema,
  edgeEndpointTypes,
  schemaFingerprint,
  bigIntKeyWarnings,
} from './pgSchema';
export type {
  PgSchema,
  PgNodeType,
  PgEdgeType,
  PgInterfaceType,
  PgProperty,
  PgType,
  PgScalarName,
  BigIntKeyWarning,
} from './pgSchema';

// Export-line normalization
export {
  classifyExportLine,
  normalizeNode,
  normalizeEdge,
  ORBIT_TYPE_KEY,
  UnknownEdgeTypeError,
  InvalidExportLineError,
} from './normalize';
export type { ClassifiedExportLine, NodeExportLine, EdgeExportLine } from './normalize';

// v1 export loader
export { createOmnigraphSource, OmnigraphDriftError } from './loader';
export type { OmnigraphSource } from './loader';
export type {
  OmnigraphSourceOptions,
  OmnigraphDriftPolicy,
  OmnigraphLoadProgress,
  OmnigraphLoadResult,
  OmnigraphLoadCounts,
  OmnigraphDataRef,
  IngestTarget,
} from './types';

// Stored-query search service.
export { createOmnigraphSearchService } from './searchService';
export type {
  OmnigraphSearchServiceOptions,
  OmnigraphSearchRow,
  OmnigraphSearchTypeOf,
} from './searchService';
