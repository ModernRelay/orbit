/** Guided CSV preparation. A successful import is the only dataset write. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, ReactElement } from 'react';
import { prepareGraphData, previewCsv } from '@modernrelay/orbit-data';
import type { ColumnSummary, GraphColumnMapping, GraphPrepareProgress, PreparedGraph } from '@modernrelay/orbit-data';
import * as S from './styles';

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_NODES = 100_000;
const MAX_EDGES = 250_000;
const PREVIEW_BYTES = 256 * 1024;

export interface CsvDropResult {
  fileName: string;
  prepared: PreparedGraph;
  summaryLine: string;
}

type Preview = Awaited<ReturnType<typeof previewCsv>>;
interface Draft {
  edges: File;
  edgePreview: Preview;
  nodes: File | null;
  nodePreview: Preview | null;
  source: string;
  target: string;
  edgeId: string;
  nodeId: string;
}

const fieldStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 140, flex: 1 };
const inputStyle: CSSProperties = { ...S.button, width: '100%', color: 'var(--fg)', background: 'var(--app-bg)' };
const cellStyle: CSSProperties = { borderBottom: '1px solid var(--panel-border)', padding: '6px 10px', textAlign: 'left', maxWidth: 240, overflowWrap: 'anywhere' };

function ColumnField(props: {
  label: string; columns: readonly string[]; value: string; onChange: (value: string) => void; optional?: boolean;
}): ReactElement {
  return <label style={fieldStyle}>
    {props.label}
    <select style={inputStyle} value={props.value} onChange={(event) => props.onChange(event.target.value)}>
      {props.optional && <option value="">Generate automatically</option>}
      {props.columns.map((column) => <option key={column} value={column}>{column}</option>)}
    </select>
  </label>;
}

function PreviewTable({ preview, label }: { preview: Preview; label: string }): ReactElement {
  return <div style={{ overflow: 'auto', maxHeight: 200, border: '1px solid var(--panel-border)', borderRadius: 6 }}>
    <table aria-label={label} style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
      <thead><tr>{preview.columns.map((column) => <th key={column} scope="col" style={cellStyle}>{column}</th>)}</tr></thead>
      <tbody>{preview.rows.map((row, index) => <tr key={index}>
        {preview.columns.map((column) => <td key={column} style={cellStyle}>{String(row[column] ?? '')}</td>)}
      </tr>)}</tbody>
    </table>
  </div>;
}

function summarizeColumn(name: string, summary: ColumnSummary): string {
  const range = summary.min !== undefined && summary.max !== undefined
    ? ` · ${summary.min}–${summary.max}` : '';
  return `${name} (${summary.count - summary.nullCount}/${summary.count}${range})`;
}

function assertFileSize(edges: File, nodes: File | null): void {
  if (edges.size + (nodes?.size ?? 0) > MAX_BYTES) {
    throw new Error('These files exceed the 128 MiB import limit. Choose smaller files.');
  }
}

async function readPreview(file: File, signal: AbortSignal): Promise<Preview> {
  const preview = await previewCsv(file, { signal, maxRows: 5, maxBytes: PREVIEW_BYTES });
  if (preview.columns.length === 0) throw new Error(`${file.name} has no CSV header. Add a header row naming each column.`);
  if (preview.rows.length === 0) throw new Error(`${file.name} has no data rows.`);
  return preview;
}

export function CsvDropZone(props: {
  summary: string | null;
  onPrepared: (result: CsvDropResult) => void;
}): ReactElement {
  const [dragActive, setDragActive] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [phase, setPhase] = useState<'preview' | 'preparing' | null>(null);
  const [progress, setProgress] = useState<GraphPrepareProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const nodeInputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog !== null && !dialog.open) dialog.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  const startRequest = useCallback((): AbortController => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setError(null);
    setNotice(null);
    setProgress(null);
    return controller;
  }, []);

  const onFile = useCallback((file: File) => {
    const controller = startRequest();
    setDraft(null);
    setOpen(true);
    setPhase('preview');
    void (async () => {
      assertFileSize(file, null);
      const preview = await readPreview(file, controller.signal);
      if (controller.signal.aborted) return;
      const source = preview.columns.includes('source') ? 'source' : preview.columns[0]!;
      const target = preview.columns.includes('target') ? 'target' : preview.columns.find((name) => name !== source) ?? source;
      setDraft({ edges: file, edgePreview: preview, nodes: null, nodePreview: null, source, target, edgeId: '', nodeId: '' });
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setPhase(null);
    });
  }, [startRequest]);

  const onNodesFile = (file: File): void => {
    if (draft === null) return;
    const controller = startRequest();
    setPhase('preview');
    void (async () => {
      assertFileSize(draft.edges, file);
      const preview = await readPreview(file, controller.signal);
      if (controller.signal.aborted) return;
      setDraft((current) => current === null ? null : {
        ...current, nodes: file, nodePreview: preview,
        nodeId: preview.columns.includes('id') ? 'id' : preview.columns[0]!,
      });
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setPhase(null);
    });
  };

  const cancel = (): void => {
    controllerRef.current?.abort();
    setPhase(null);
    setOpen(false);
    setDraft(null);
    setError(null);
    setNotice('Import cancelled. Your current graph is unchanged.');
  };

  const importGraph = (): void => {
    if (draft === null || phase !== null) return;
    const controller = startRequest();
    setPhase('preparing');
    const mapping: GraphColumnMapping = {
      edges: { source: draft.source, target: draft.target, ...(draft.edgeId ? { id: draft.edgeId } : {}) },
      ...(draft.nodes !== null ? { nodes: { id: draft.nodeId } } : {}),
    };
    // The mapping belongs to the source coordinate: changing it must not look
    // like an idempotent replay of a previous import of the same file.
    const identity = JSON.stringify([draft.edges.name, draft.edges.size, draft.edges.lastModified,
      draft.nodes === null ? null : [draft.nodes.name, draft.nodes.size, draft.nodes.lastModified], mapping]);
    void prepareGraphData(
      draft.nodes === null ? { edges: draft.edges, deriveNodes: true } : { edges: draft.edges, nodes: draft.nodes },
      mapping,
      {
        datasetKey: `csv:${draft.edges.name}`, sourceRevision: identity, format: 'csv',
        signal: controller.signal, maxBytes: MAX_BYTES, maxNodes: MAX_NODES, maxEdges: MAX_EDGES,
        onProgress: (value) => { if (!controller.signal.aborted) setProgress(value); },
      },
    ).then((prepared) => {
      if (controller.signal.aborted) return;
      const fileName = draft.nodes === null ? draft.edges.name : `${draft.edges.name} + ${draft.nodes.name}`;
      const columns = Object.entries(prepared.summaries.edges).slice(0, 4).map(([name, summary]) => summarizeColumn(name, summary));
      props.onPrepared({ fileName, prepared,
        summaryLine: `${fileName}: ${prepared.snapshot.nodes.length.toLocaleString('en-US')} nodes · ${prepared.snapshot.edges.length.toLocaleString('en-US')} edges` +
          (columns.length > 0 ? ` · ${columns.join(', ')}` : '') });
      setOpen(false);
      setDraft(null);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setPhase(null);
    });
  };

  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent): boolean => event.dataTransfer !== null && Array.from(event.dataTransfer.types).includes('Files');
    const onEnter = (event: DragEvent): void => { if (hasFiles(event)) { depth++; setDragActive(true); } };
    const onOver = (event: DragEvent): void => { if (hasFiles(event)) event.preventDefault(); };
    const onLeave = (): void => { depth = Math.max(0, depth - 1); if (depth === 0) setDragActive(false); };
    const onDrop = (event: DragEvent): void => {
      depth = 0; setDragActive(false);
      if (!hasFiles(event)) return;
      event.preventDefault();
      const file = event.dataTransfer?.files[0];
      if (file !== undefined) onFile(file);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter); window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave); window.removeEventListener('drop', onDrop);
    };
  }, [onFile]);

  const takeFile = (event: ChangeEvent<HTMLInputElement>, receive: (file: File) => void): void => {
    const file = event.target.files?.[0];
    if (file !== undefined) receive(file);
    event.target.value = '';
  };
  const updateMapping = (key: 'source' | 'target' | 'edgeId' | 'nodeId', value: string): void => {
    setDraft((current) => current === null ? null : { ...current, [key]: value }); setError(null);
  };

  return <section style={S.csvPanel} data-testid="csv-panel" aria-label="CSV data">
    <style>{'.csv-import-dialog::backdrop { background: rgba(0,0,0,.55); } .csv-import-dialog button:focus-visible, .csv-import-dialog select:focus-visible { outline: 2px solid #58a6ff; outline-offset: 2px; }'}</style>
    <div style={S.dataPanelTitle}>Import your data</div>
    <div style={S.csvHint}>Drop an edges CSV, preview its columns, and choose how to connect your graph.</div>
    <button type="button" className="demo-btn" style={S.button} data-testid="csv-choose" onClick={() => inputRef.current?.click()}>Choose CSV…</button>
    <input ref={inputRef} type="file" accept=".csv,text/csv" aria-label="Load edges CSV file" data-testid="csv-file-input"
      style={S.csvHiddenInput} tabIndex={-1} onChange={(event) => takeFile(event, onFile)} />
    {props.summary !== null && <div style={S.csvSummary} data-testid="csv-summary">{props.summary}</div>}
    {notice !== null && <div role="status" style={S.csvHint}>{notice}</div>}
    <dialog ref={dialogRef} className="csv-import-dialog" aria-labelledby="csv-import-title" onCancel={(event) => { event.preventDefault(); cancel(); }}
      style={{ ...S.csvDialog }}>
      <h2 id="csv-import-title" style={{ margin: 0, fontSize: 20 }}>Import CSV graph</h2>
      <p style={S.csvHint}>Up to 128 MiB total, 100,000 nodes and 250,000 edges. Your graph stays unchanged until the import succeeds.</p>
      <div style={S.dataPanelRow}>
        <button type="button" style={S.button} onClick={() => inputRef.current?.click()}>Choose different edges file</button>
        <button type="button" style={S.button} onClick={cancel}>{phase === 'preparing' ? 'Cancel import' : 'Cancel'}</button>
      </div>
      {draft !== null && <fieldset disabled={phase !== null} style={{ border: 0, padding: 0, margin: '16px 0 0', minWidth: 0 }}>
        <legend style={{ padding: '0 0 10px', fontWeight: 600, overflowWrap: 'anywhere' }}>Edges: {draft.edges.name}</legend>
        <PreviewTable preview={draft.edgePreview} label="Edges preview" />
        <p style={S.csvHint}>Previewing up to five rows. Other columns are kept as attributes.</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          <ColumnField label="Source column" columns={draft.edgePreview.columns} value={draft.source} onChange={(value) => updateMapping('source', value)} />
          <ColumnField label="Target column" columns={draft.edgePreview.columns} value={draft.target} onChange={(value) => updateMapping('target', value)} />
          <ColumnField label="Edge ID column" columns={draft.edgePreview.columns} value={draft.edgeId} optional onChange={(value) => updateMapping('edgeId', value)} />
        </div>
        <div style={{ marginTop: 18 }}>
          <button type="button" style={S.button} onClick={() => nodeInputRef.current?.click()}>{draft.nodes === null ? 'Add nodes CSV (optional)' : 'Change nodes CSV'}</button>
          <input ref={nodeInputRef} type="file" accept=".csv,text/csv" aria-label="Load nodes CSV file" data-testid="csv-nodes-input" style={S.csvHiddenInput} tabIndex={-1}
            onChange={(event) => takeFile(event, onNodesFile)} />
          {draft.nodes === null ? <p style={S.csvHint}>Without a nodes file, nodes are created from the edge endpoints.</p> : <>
            <p style={{ overflowWrap: 'anywhere' }}>Nodes: {draft.nodes.name}</p>
            {draft.nodePreview !== null && <>
              <PreviewTable preview={draft.nodePreview} label="Nodes preview" />
              <div style={{ margin: '12px 0' }}><ColumnField label="Node ID column" columns={draft.nodePreview.columns} value={draft.nodeId} onChange={(value) => updateMapping('nodeId', value)} /></div>
            </>}
            <button type="button" style={S.button} onClick={() => { setDraft({ ...draft, nodes: null, nodePreview: null, nodeId: '' }); setError(null); }}>Remove nodes file</button>
          </>}
        </div>
      </fieldset>}
      {phase !== null && <div role="status" aria-live="polite" data-testid="csv-progress" style={{ marginTop: 16 }}>
        {phase === 'preview' ? 'Reading preview…' : progress === null ? 'Preparing graph…' :
          `Preparing graph… ${(progress.bytes / 1048576).toFixed(1)} MiB read · ${progress.nodes.toLocaleString('en-US')} nodes · ${progress.edges.toLocaleString('en-US')} edges`}
      </div>}
      {error !== null && <div role="alert" style={{ ...S.ogError, marginTop: 14 }} data-testid="csv-error">{error}</div>}
      <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" style={S.button} disabled={draft === null || phase !== null} onClick={importGraph}>Import graph</button>
      </div>
    </dialog>
    {dragActive && <div style={S.csvDropOverlay} data-testid="csv-drop-overlay"><div style={S.csvDropOverlayInner}>Drop CSV to preview</div></div>}
  </section>;
}
