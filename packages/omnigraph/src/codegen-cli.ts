#!/usr/bin/env node
/**
 * `orbit-omnigraph-codegen` — minimal `.pg` → TypeScript codegen CLI.
 *
 * orbit-omnigraph-codegen <schema.pg> [-o out.ts]
 * orbit-omnigraph-codegen --from-server <baseUrl> --graph <id> [-o out.ts]
 *
 * The first form reads a `.pg` file; the second fetches the active schema
 * from a running omnigraph-server via a plain **unauthenticated** SDK client
 * (`og.schema.get()` returns the raw `.pg` source). Authenticated client
 * construction stays exclusively in the `/server` entry; point
 * this tool at an `--unauthenticated` server or a same-origin proxy.
 *
 * Without `-o`, the generated module goes to stdout.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { Omnigraph } from '@modernrelay/omnigraph';
import { generateTypesFromPgSource } from './codegen';

const USAGE = `Usage:
  orbit-omnigraph-codegen <schema.pg> [-o <out.ts>]
  orbit-omnigraph-codegen --from-server <baseUrl> --graph <id> [-o <out.ts>]

Generates TypeScript typed attrs from a .pg schema — read from a
file, or fetched from a running omnigraph-server (unauthenticated client).
Writes to stdout unless -o is given.
`;

interface CliArgs {
  schemaPath?: string;
  out?: string;
  fromServer?: string;
  graph?: string;
}

function parseArgs(argv: readonly string[]): CliArgs | string {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case '-h':
      case '--help':
        return 'help';
      case '-o':
      case '--out': {
        const v = argv[++i];
        if (v === undefined) return `missing value for ${arg}`;
        args.out = v;
        break;
      }
      case '--from-server': {
        const v = argv[++i];
        if (v === undefined) return 'missing value for --from-server';
        args.fromServer = v;
        break;
      }
      case '--graph': {
        const v = argv[++i];
        if (v === undefined) return 'missing value for --graph';
        args.graph = v;
        break;
      }
      default:
        if (arg.startsWith('-')) return `unknown option '${arg}'`;
        if (args.schemaPath !== undefined) return `unexpected argument '${arg}'`;
        args.schemaPath = arg;
    }
  }
  if (args.fromServer !== undefined && args.schemaPath !== undefined) {
    return 'pass a schema file OR --from-server, not both';
  }
  if (args.fromServer !== undefined && args.graph === undefined) {
    return '--from-server requires --graph <id> (schema reads are graph-scoped)';
  }
  if (args.fromServer === undefined && args.schemaPath === undefined) {
    return 'no schema given';
  }
  return args;
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (typeof parsed === 'string') {
    process.stderr.write(`orbit-omnigraph-codegen: ${parsed}\n\n${USAGE}`);
    return 2;
  }

  let source: string;
  let provenance: string;
  if (parsed.fromServer !== undefined && parsed.graph !== undefined) {
    const og = new Omnigraph({ baseUrl: parsed.fromServer, graphId: parsed.graph });
    const schema = await og.schema.get();
    source = schema.schemaSource;
    provenance = `Source: ${parsed.fromServer} (graph '${parsed.graph}', GET /schema)`;
  } else if (parsed.schemaPath !== undefined) {
    source = readFileSync(parsed.schemaPath, 'utf8');
    provenance = `Source: ${parsed.schemaPath}`;
  } else {
    // Unreachable: parseArgs guarantees one of the two.
    return 2;
  }

  const output = generateTypesFromPgSource(source, { header: provenance });
  if (parsed.out !== undefined) {
    writeFileSync(parsed.out, output);
    process.stderr.write(`orbit-omnigraph-codegen: wrote ${parsed.out}\n`);
  } else {
    process.stdout.write(output);
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`orbit-omnigraph-codegen: ${message}\n`);
    process.exitCode = 1;
  },
);
