import { PreparationControl } from './control';
import { csvRecords } from './csv';
import { byteChunks } from './sources';
import type { GraphByteSource } from './types';

export interface CsvPreviewOptions {
  signal?: AbortSignal;
  /** Maximum bytes examined, default 256 KiB. A record exceeding it rejects. */
  maxBytes?: number;
  /** Maximum data records returned, default 5. */
  maxRows?: number;
}

export interface CsvPreview {
  columns: readonly string[];
  /** Raw strings preserve identifiers and do not guess types from a short sample. */
  rows: readonly Readonly<Record<string, string>>[];
  /** True means the sample cap was reached; remaining input was not inspected. */
  truncated: boolean;
}

export async function previewCsv(source: GraphByteSource, options: CsvPreviewOptions = {}): Promise<CsvPreview> {
  const maxRows = options.maxRows ?? 5;
  if (!Number.isSafeInteger(maxRows) || maxRows <= 0) throw new TypeError('previewCsv: maxRows must be a positive safe integer');
  const maxBytes = options.maxBytes ?? 256 * 1024;
  const control = new PreparationControl({ datasetKey: 'preview', sourceRevision: 0, maxBytes, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  // Subdivide large Blob/ArrayBuffer chunks before parsing. Stop as soon as
  // the sample is ready instead of materializing an entire input chunk.
  async function* chunks(): AsyncGenerator<Uint8Array> {
    let read = 0;
    for await (const chunk of byteChunks(source, options.signal)) {
      for (let offset = 0; offset < chunk.byteLength;) {
        const length = Math.min(chunk.byteLength - offset, 4096, Math.max(1, maxBytes - read));
        control.read(length);
        read += length;
        yield chunk.subarray(offset, offset + length);
        offset += length;
      }
    }
  }
  const records = csvRecords(chunks());
  try {
    const header = await records.next();
    control.check();
    if (header.done) return { columns: [], rows: [], truncated: false };
    const columns = [...header.value];
    const rows: Record<string, string>[] = [];
    while (rows.length < maxRows) {
      const record = await records.next();
      control.check();
      if (record.done) return { columns, rows, truncated: false };
      rows.push(Object.fromEntries(columns.flatMap((name, index) =>
        record.value[index] === undefined ? [] : [[name, record.value[index]!]],
      )));
    }
    return { columns, rows, truncated: true };
  } finally {
    await records.return(undefined);
  }
}
