import { describe, expect, it } from 'vitest';
import type { ExportRecord, Schema } from '@modernrelay/omnigraph';

import demoPg from '../../../fixtures/omnigraph/cluster/demo.pg?raw';
import schemaBody from '../../../fixtures/omnigraph/recorded/schema.json?raw';
import exportBody from '../../../fixtures/omnigraph/recorded/export.ndjson?raw';
import { classifyExportLine, normalizeNode, parsePgSchema } from '../src/index';

describe('recorded Omnigraph wire fixtures', () => {
  it('keeps the schema response in the server serializer format', () => {
    const recorded = JSON.parse(schemaBody) as {
      schema_source: Schema['schemaSource'];
      system_columns: Schema['systemColumns'];
      catalogue_source: Schema['catalogueSource'];
    };
    expect(recorded).toEqual({
      schema_source: demoPg,
      system_columns: { id: '__id', src: '__src', dst: '__dst' },
      // 0.14 exposes the virtual engine catalogue separately. It must not
      // be merged into the user graph schema consumed by Orbit's parser.
      catalogue_source: expect.stringContaining('node @Engine'),
    });
    expect(schemaBody).toBe(JSON.stringify(recorded));
  });

  it('preserves physical identity and numeric user ids from actual 0.14 exports', () => {
    const records = exportBody.trim().split('\n').map((line) => JSON.parse(line) as ExportRecord);
    for (const record of records) {
      expect(typeof record.id).toBe('string');
      expect(classifyExportLine(record).kind).not.toBe('unknown');
    }
    const signal = records.find((record) => 'type' in record && record.type === 'Signal' && record.id === 'signal-001');
    expect(signal).toBeDefined();
    const classified = classifyExportLine(signal);
    expect(classified.kind).toBe('node');
    if (classified.kind !== 'node') throw new Error('recorded Signal missing');
    const normalized = normalizeNode(classified, parsePgSchema(demoPg));
    expect(normalized.attrs!['id']).toBe(1);
    expect(normalized.attrs!['source']).toBeNull(); // omitted nullable wire property
    expect(normalized.attrs!['observed_at']).toBe('2017-06-09');
  });
});
