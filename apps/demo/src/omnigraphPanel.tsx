/**
 * Omnigraph section of the demo's Data panel.
 *
 * Transport security: the browser never talks to `omnigraph-server` directly.
 * The server ships no CORS configuration, so requests go to the demo's own
 * origin under a configurable base path (default `/og`) and the vite dev
 * proxy forwards them to `http://127.0.0.1:8199` with the prefix stripped:
 * the same-origin BFF pattern. That gives the SDK client constructed here a
 * safe same-origin transport (the demo is the host app and supplies no token;
 * `OmnigraphOptions.token` is optional and the fixture server runs
 * `--unauthenticated`), which is exactly what the adapter's browser entry
 * accepts. Authenticated construction stays confined to
 * `@modernrelay/orbit-omnigraph/server`.
 *
 * Load path: `createOmnigraphSource().load()` streams one
 * `og.export()` pass into a `purpose:'replace'` IngestSession on the live
 * graph instance. This module wraps that session to
 * - harvest every accepted node into an id → node map (the status bar's
 * hover lookup — the store publishes counts, not node payloads), and
 * - inject a client-computed `degree` attr for size scaling: export streams
 * all `edge:*` lines before `node:*` lines (lexicographic table-key
 * order), so endpoint degrees are complete before any node arrives.
 * `degree` is demo-host enrichment, NOT adapter output.
 *
 * Typed attrs: node/edge attr shapes come from the codegen artifact
 * `./omnigraph-types.generated.ts` (`orbit-omnigraph-codegen` over the
 * fixture schema).
 */

import type { ChangeEvent, ReactNode } from 'react';

import { Omnigraph } from '@modernrelay/omnigraph';
import type {
  BeginIngestOptions,
  GraphNode,
  IngestSession,
  NodeId,
  Revisions,
} from '@modernrelay/orbit-core';
import { createOmnigraphSource } from '@modernrelay/orbit-omnigraph';
import type {
  IngestTarget,
  OmnigraphLoadProgress,
  OmnigraphLoadResult,
} from '@modernrelay/orbit-omnigraph';

import type { EdgeAttrs, NodeAttrs } from './omnigraph-types.generated';
import * as S from './styles';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Generated attrs plus the demo-host `degree` enrichment (module doc). */
export type OmnigraphDisplayNodeAttrs = NodeAttrs & { degree?: number };
export type OmnigraphDisplayEdgeAttrs = EdgeAttrs;

/** The three coordinates of a load, editable in the panel. */
export interface OmnigraphFormState {
  /** Same-origin proxy prefix, or a full http(s) URL for advanced use. */
  basePath: string;
  graphId: string;
  branch: string;
}

/**
 * Defaults match the recorded fixture manifest (graph `demo`, branch `main`)
 * unless the dev server was launched pointing at another deployment — then
 * `OMNIGRAPH_PROXY_GRAPH` (exposed by vite.config as a define) wins, so the
 * panel opens ready to load whatever the proxy actually fronts.
 */
export const OMNIGRAPH_FORM_DEFAULT: OmnigraphFormState = {
  basePath: '/og',
  graphId:
    (typeof __OMNIGRAPH_DEFAULT_GRAPH__ !== 'undefined' && __OMNIGRAPH_DEFAULT_GRAPH__) || 'demo',
  branch: 'main',
};

/** Live meter state: loader progress plus host-tracked phase and elapsed. */
export interface OmnigraphMeter extends OmnigraphLoadProgress {
  phase: 'loading' | 'committed' | 'error';
  elapsedMs: number;
}

/** The GraphHandle/GraphInstance slice the load driver needs. */
export interface OmnigraphIngestHost<N, E> {
  beginIngest(opts: BeginIngestOptions): IngestSession<N, E>;
  getRevisions(): Revisions;
}

export interface OmnigraphRunOutcome {
  result: OmnigraphLoadResult;
  /** Every accepted node (with injected `degree`), keyed by type-qualified id. */
  nodeById: ReadonlyMap<NodeId, GraphNode<OmnigraphDisplayNodeAttrs>>;
}

// ---------------------------------------------------------------------------
// Load driver
// ---------------------------------------------------------------------------

/** Small batches so the ~800-line fixture still animates the live meter. */
const DEMO_BATCH_SIZE = 200;

function resolveBaseUrl(basePath: string): string {
  const trimmed = basePath.trim();
  if (/^https?:\/\//.test(trimmed)) return trimmed;
  return window.location.origin + (trimmed.startsWith('/') ? trimmed : `/${trimmed}`);
}

/**
 * Wrap the host session for the loader: accumulate endpoint degrees from the
 * edge batches (which stream first — module doc), inject them into node
 * attrs, and harvest the nodes for hover lookups.
 */
function wrapSession(
  session: IngestSession,
  collected: Map<NodeId, GraphNode<OmnigraphDisplayNodeAttrs>>,
  degree: Map<NodeId, number>,
): IngestSession {
  return {
    get state() {
      return session.state;
    },
    get overlayId() {
      return session.overlayId;
    },
    append: (batch) => {
      if (batch.edges !== undefined) {
        for (const edge of batch.edges) {
          degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
          degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
        }
      }
      if (batch.nodes === undefined || batch.nodes.length === 0) {
        return session.append(batch);
      }
      const nodes = batch.nodes.map((node) => ({
        ...node,
        attrs: { ...node.attrs, degree: degree.get(node.id) ?? 0 },
      }));
      for (const node of nodes) {
        // The adapter guarantees schema-normalized attrs with an injected
        // type discriminator; the generated shapes describe exactly that.
        collected.set(node.id, node as GraphNode<OmnigraphDisplayNodeAttrs>);
      }
      return session.append({ ...batch, nodes });
    },
    commit: () => session.commit(),
    abort: (reason?: unknown) => session.abort(reason),
  };
}

/**
 * Run one export-backed load of `form`'s graph/branch into `host`
 * via a same-origin SDK client. Resolves with the revision-stamped result and
 * the harvested node map; rejects with the session aborted and the instance
 * untouched.
 */
export async function runOmnigraphLoad<N, E>(
  host: OmnigraphIngestHost<N, E>,
  form: OmnigraphFormState,
  onProgress: (p: OmnigraphLoadProgress) => void,
  signal?: AbortSignal,
): Promise<OmnigraphRunOutcome> {
  const client = new Omnigraph({ baseUrl: resolveBaseUrl(form.basePath) });
  const collected = new Map<NodeId, GraphNode<OmnigraphDisplayNodeAttrs>>();
  const degree = new Map<NodeId, number>();
  const target: IngestTarget = {
    // The generics meet reality here: the loader appends schema-normalized
    // `GraphNode<Record<string, unknown>>` values into the host's session.
    beginIngest: (opts) => wrapSession(host.beginIngest(opts) as unknown as IngestSession, collected, degree),
    getRevisions: () => host.getRevisions(),
  };
  const source = createOmnigraphSource({
    client,
    graphId: form.graphId,
    branch: form.branch,
    batchSize: DEMO_BATCH_SIZE,
    onProgress,
  });
  const result = await source.load(target, signal);
  return { result, nodeById: collected };
}

// ---------------------------------------------------------------------------
// Panel UI
// ---------------------------------------------------------------------------

/** Errors that smell like "nothing is answering behind the proxy". */
const CONNECTION_ERROR =
  /NetworkError|InternalServerError|Failed to fetch|Load failed|status 0|status 5\d\d|ECONNREFUSED|proxy error/i;

const abbrevHead = (head: string): string => (head.length > 8 ? `${head.slice(0, 8)}…` : head);

const fmtBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const fmtInt = (n: number): string => n.toLocaleString('en-US');

export interface OmnigraphPanelProps {
  form: OmnigraphFormState;
  onFormChange: (form: OmnigraphFormState) => void;
  meter: OmnigraphMeter | null;
  result: OmnigraphLoadResult | null;
  error: string | null;
  onLoad: () => void;
}

function Field({
  label,
  testId,
  value,
  disabled,
  onValue,
}: {
  label: string;
  testId: string;
  value: string;
  disabled: boolean;
  onValue: (value: string) => void;
}) {
  return (
    <label style={S.ogField}>
      {label}
      <input
        style={S.ogInput}
        data-testid={testId}
        value={value}
        disabled={disabled}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onValue(e.currentTarget.value)}
      />
    </label>
  );
}

function MeterRow({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <>
      <span style={S.statusMuted}>{label}</span>
      <span style={S.streamMeterValue} data-testid={testId}>
        {children}
      </span>
    </>
  );
}

/** The 'Omnigraph' sub-section of the Data panel (rendered by App). */
export function OmnigraphPanel({ form, onFormChange, meter, result, error, onLoad }: OmnigraphPanelProps) {
  const loading = meter !== null && meter.phase === 'loading';
  return (
    <div style={S.ogSection} data-testid="omnigraph-panel">
      <div style={S.dataPanelTitle}>omnigraph</div>
      <div style={S.ogFieldRow}>
        <Field
          label="path"
          testId="og-base-path"
          value={form.basePath}
          disabled={loading}
          onValue={(basePath) => onFormChange({ ...form, basePath })}
        />
        <Field
          label="graph"
          testId="og-graph-id"
          value={form.graphId}
          disabled={loading}
          onValue={(graphId) => onFormChange({ ...form, graphId })}
        />
        <Field
          label="branch"
          testId="og-branch"
          value={form.branch}
          disabled={loading}
          onValue={(branch) => onFormChange({ ...form, branch })}
        />
      </div>
      <div style={S.dataPanelRow}>
        <button
          type="button"
          className="demo-btn"
          style={S.button}
          data-testid="og-load"
          disabled={loading}
          onClick={onLoad}
        >
          Load from Omnigraph
        </button>
      </div>
      {meter !== null && (
        <div style={S.streamMeter} data-testid="og-meter" data-phase={meter.phase}>
          <MeterRow label="lines" testId="og-lines">
            {fmtInt(meter.lines)}
          </MeterRow>
          <MeterRow label="nodes" testId="og-nodes">
            {fmtInt(meter.nodes)}
          </MeterRow>
          <MeterRow label="edges" testId="og-edges">
            {fmtInt(meter.edges)}
          </MeterRow>
          <MeterRow label="bytes" testId="og-bytes">
            {fmtBytes(meter.bytes)}
          </MeterRow>
          <MeterRow label="elapsed" testId="og-elapsed">
            {(meter.elapsedMs / 1000).toFixed(1)}s
          </MeterRow>
          <MeterRow label="state" testId="og-state">
            {meter.phase}
          </MeterRow>
        </div>
      )}
      {result !== null && (
        <div style={S.ogResult} data-testid="og-result">
          <div data-testid="og-dataref">
            <span style={S.statusMuted}>dataRef </span>
            {result.dataRef.graphId} · {result.dataRef.branch} @ {abbrevHead(result.dataRef.headBefore)}
            {result.dataRef.headAfter !== result.dataRef.headBefore && (
              <> → {abbrevHead(result.dataRef.headAfter)}</>
            )}
          </div>
          <div>
            <span style={S.statusMuted}>loaded </span>
            <span data-testid="og-count-summary">
              {fmtInt(result.counts.nodes)} nodes · {fmtInt(result.counts.edges)} edges
            </span>
            <span style={S.statusMuted}> · server {result.serverVersion}</span>
          </div>
          {result.warnings.map((warning) => (
            <div key={warning} style={S.ogWarning}>
              {warning}
            </div>
          ))}
        </div>
      )}
      {error !== null && (
        <div style={S.ogError} data-testid="og-error" role="alert">
          {error}
          {CONNECTION_ERROR.test(error) && (
            <div style={S.ogHint}>
              graph server unreachable — start the fixture server:{' '}
              <code style={S.ogCode}>
                omnigraph-server --cluster fixtures/omnigraph/cluster --unauthenticated --bind
                127.0.0.1:8199
              </code>{' '}
              (run <code style={S.ogCode}>node scripts/omnigraph-fixture.mjs</code> first if
              fixtures/omnigraph/cluster/graphs/ is missing)
            </div>
          )}
        </div>
      )}
    </div>
  );
}
