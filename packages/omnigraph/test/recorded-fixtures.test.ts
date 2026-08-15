import { describe, expect, it } from 'vitest';

import demoPg from '../../../fixtures/omnigraph/cluster/demo.pg?raw';
import schemaBody from '../../../fixtures/omnigraph/recorded/schema.json?raw';

describe('recorded Omnigraph wire fixtures', () => {
  it('keeps the schema response in the server serializer format', () => {
    expect(schemaBody).toBe(JSON.stringify({ schema_source: demoPg }));
  });
});
