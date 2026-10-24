# @modernrelay/orbit-data

Prepare supplied rows, CSV, JSON, Arrow, or Parquet for Orbit. This package does
not fetch URLs or touch the DOM. The root entry includes rows/CSV/JSON; optional
Arrow and Parquet parsers stay in their own entry points.

## Import a graph

```ts
import { prepareGraphData } from '@modernrelay/orbit-data';

const controller = new AbortController();
const prepared = await prepareGraphData(
  { nodes: nodeFile, edges: edgeFile }, // Blob/File, ArrayBuffer, or async byte streams
  {
    nodes: { id: 'person_id', includeFields: ['name', 'team'] },
    edges: { id: 'relationship_id', source: 'from', target: 'to' },
  },
  {
    datasetKey: 'relationships',
    sourceRevision: 'upload-1', // change when the data changes
    format: 'csv',
    signal: controller.signal,
    maxBytes: 128 * 1024 * 1024,
    maxNodes: 100_000,
    maxEdges: 250_000,
    onProgress: ({ phase, bytes, nodes, edges }) => {
      console.log(phase, bytes, nodes, edges);
    },
  },
);
// Pass prepared.snapshot to <Graph data={...}> or instance.applyHostUpdate.
// prepared.summaries contains column profiles; mappingFingerprint identifies the mapping.
```

Use `{ edges, deriveNodes: true }` when only an edge table exists. Node IDs are
derived in first endpoint occurrence order. Separate node/edge arrays and async
row iterables use the same mappings with `format: 'rows'`. A JSON byte source uses
`{ document }`, `format: 'json'`, and `mapping.documentPaths: { nodes: 'graph.nodes',
edges: 'graph.edges' }`.

Identity columns remain strings in CSV, preserving IDs such as `001`. Other
CSV columns infer numeric values from the first 1,000 records; empty cells are
absent. Explicit `includeFields` is an exact attribute allowlist; by default,
all non-identity columns become attributes. Missing IDs and invalid mappings
reject with row/column context. Duplicate IDs and dangling endpoints in object
snapshots remain core's validation responsibility.

For Arrow install `apache-arrow` and import `prepareArrowGraphData` from
`@modernrelay/orbit-data/arrow`. It accepts Arrow tables or IPC bytes. For Parquet
install `hyparquet` and import `prepareParquetGraphData` from
`@modernrelay/orbit-data/parquet`; each node/edge source is a file's bytes. Both
accept the same mapping and controls, without a `format` option.

## Preview before choosing columns

```ts
import { previewCsv } from '@modernrelay/orbit-data';

const preview = await previewCsv(file, {
  signal: controller.signal,
  maxRows: 5,           // default
  maxBytes: 256 * 1024, // default examined-byte budget
});
// preview.columns -> mapping selectors
// preview.rows -> raw strings, including quoted newlines and leading-zero IDs
```

Preview uses the same CSV record parser and closes its iterator once the sample
is ready. `truncated: true` means the sample cap was reached; it does not inspect
another row to determine whether the file ends there. A record that cannot be
completed within the byte budget rejects. Bytes after the sample are not
validated. Reopen single-use streams for the actual preparation.

## Limits, progress, and cancellation

- Limits are optional positive safe integers; omitting them preserves the
  unrestricted default. `maxBytes` counts supplied byte chunks across **both**
  inputs, including headers. Row objects and existing Arrow tables have no wire
  bytes and report zero. `maxNodes`/`maxEdges` count admitted rows before core
  validation; duplicates count, while derived nodes count unique endpoint IDs.
- Limits reject with a `RangeError` naming the cap. They do not publish partial
  graphs. Byte limits describe input size, **not** a JavaScript heap limit:
  JSON parsing and Parquet decompression can require additional memory.
- Progress reports cumulative `{ phase, bytes, nodes, edges }`, at most once per
  100 ms plus a final `complete` event. Phases are `reading`, `preparing`, and
  `complete`; not every phase must produce a callback on a short load.
- Preparation yields tasks during row processing so browser input, cancellation,
  and progress painting can run. Cancellation rejects with `AbortError`, including
  cancellation during Parquet decoding. Synchronous parser calls cannot be
  interrupted mid-call; cancellation is checked immediately afterward. Stalled
  asynchronous reads stop being awaited, and their iterator is asked to close;
  an uncooperative producer may finish its own pending I/O later.

## Opt-in columnar output

```ts
const prepared = await prepareGraphData(input, mapping, {
  datasetKey: 'relationships', sourceRevision: 'upload-1', output: 'columnar',
}); // PreparedColumnarGraph; snapshot is ColumnarGraphSnapshot
```

All five formats support columnar output. The builder writes attribute columns
without retaining object graph nodes/edges. Strings use dictionaries, numbers
use Float64 arrays, and booleans use byte arrays. Missing, undefined, null, and
non-finite numeric cells become explicit null bits; an all-null column uses a
nullable Float64 array. Values keep their primitive type: a mixed string/number
column is an error. Summaries and mapping fingerprints match the object lane.

Nested arrays/objects, bigint attributes in raw row inputs, and `__proto__`
attributes reject with a remedy to use `output: 'object'`. Arrow/Parquet integer
normalization still applies before column construction. Unknown endpoints also
reject because typed endpoint indices cannot represent them. Supply the missing
nodes, derive nodes, or use the default object path for core's dangling-edge
diagnostics. Synthesized edge IDs use the same canonical helper as core.

Buffers and dictionaries are newly allocated. Inputs are never modified or
detached; snapshots use `bufferOwnership: 'borrowed'` for repeatable admission.
Callers may explicitly choose transfer ownership when handing a result to core.
Core currently materializes columnar rows during acceptance, so a smaller
prepared result does not imply a smaller final running graph or faster rendering.

## Save and reuse object artifacts

```ts
import { serializePrepared, loadPrepared } from '@modernrelay/orbit-data';

const bytes = serializePrepared(preparedObject);
const restored = loadPrepared(bytes); // validates the v1 object artifact
```

The default object API and version-1 artifact format are unchanged. Columnar
outputs are deliberately not accepted by the v1 serializer; keep their typed
buffers in memory or prepare object output when an existing JSON artifact is
required.

## Measure preparation

From the repository root run `node scripts/bench-data-preparation.mjs`. It runs
three fresh processes for each output with identical 100K-node/250K-edge row
streams and reports elapsed time, process peak RSS, and retained heap plus typed
buffers after GC. These are CPU preparation measurements, not GPU qualification.
The report explicitly evaluates whether columnar is faster and whether its
retained memory is lower; neither result is assumed.

One [recorded run](benchmarks/preparation-node24-darwin-arm64.json) on Node
24.15.0/macOS arm64 measured these medians across three fresh processes:

| Metric | Object | Columnar |
|---|---:|---:|
| Preparation | 628 ms | 702 ms |
| Retained heap + typed buffers | 70.2 MiB | 18.5 MiB |
| Process peak RSS | 277.0 MiB | 281.9 MiB |

Retained result memory was about 74% lower, but preparation was slower and peak
RSS did not improve. Timing varied (columnar 691–914 ms), so these are observations
for this synthetic workload, not speed guarantees or end-to-end graph benchmarks.
