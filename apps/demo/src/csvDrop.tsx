/**
 * CSV drop lane.
 *
 * ONE edges CSV with `source`/`target` columns → `prepareGraphData` with
 * `deriveNodes: true` (nodes synthesized from endpoints, first-occurrence
 * order; extra columns become edge attrs and show up in the column
 * summaries). The prepared snapshot is applied DECLARATIVELY by <App> — the
 * datasetKey derives from the file name, so every distinct file is a full
 * dataset swap, and the summaries render as one panel line.
 *
 * Two ways in, one handler:
 * - drag a.csv anywhere over the window — a full-window overlay appears
 * while the drag is active and the window-level `drop` listener takes the
 * first file (the overlay itself is pointer-inert);
 * - the panel's "Choose CSV…" button / hidden file input — the input is the
 * e2e seam (`page.setInputFiles` on `[data-testid="csv-file-input"]`).
 *
 * Errors stay inline (the caller renders them next to the summary line)
 * a bad file never takes the running graph down.
 */

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import { prepareGraphData } from '@modernrelay/orbit-data';
import type { ColumnSummary, PreparedGraph } from '@modernrelay/orbit-data';

import * as S from './styles';

export interface CsvDropResult {
  fileName: string;
  /** Default-generic prepared output — derived nodes carry NO attrs (builder
   * contract), so the caller may safely apply it under its own attr generics. */
  prepared: PreparedGraph;
  /** One-line summaries digest for the panel. */
  summaryLine: string;
}

/** `weight (50/50 · 0–6)`-style fragment for one summarized column. */
function summarizeColumn(name: string, s: ColumnSummary): string {
  const bits: string[] = [`${s.count - s.nullCount}/${s.count}`];
  if (s.min !== undefined && s.max !== undefined) bits.push(`${s.min}–${s.max}`);
  else if (s.approximateUnique !== undefined) bits.push(`${s.approximateUnique} uniq`);
  return `${name} (${bits.join(' · ')})`;
}

/** Parse + prepare one edges CSV (edges-only lane, `deriveNodes: true`).
 * The mapping is fixed to `source`/`target` header columns; anything else
 * rides along as edge attrs and gets a column summary. */
export async function loadCsvEdgesFile(file: File): Promise<CsvDropResult> {
  const prepared = await prepareGraphData(
    { edges: file, deriveNodes: true },
    { edges: { source: 'source', target: 'target' } },
    {
      // File name = dataset identity: a different file is a full swap.
      datasetKey: `csv:${file.name}`,
      sourceRevision: file.lastModified === 0 ? 1 : file.lastModified,
      format: 'csv',
    },
  );
  const { snapshot, summaries } = prepared;
  const edgeCols = Object.keys(summaries.edges);
  const colBits = edgeCols.slice(0, 4).map((c) => summarizeColumn(c, summaries.edges[c]!));
  const summaryLine =
    `${file.name}: ${snapshot.nodes.length} nodes · ${snapshot.edges.length} edges` +
    (colBits.length > 0 ? ` · ${colBits.join(', ')}` : '') +
    ` · fp ${prepared.mappingFingerprint.slice(0, 8)}`;
  return { fileName: file.name, prepared, summaryLine };
}

export function CsvDropZone(props: {
  /** Last successful load's summary line (null = nothing loaded yet). */
  summary: string | null;
  /** Last failed load's message (null = no error). */
  error: string | null;
  onFile: (file: File) => void;
}): ReactElement {
  const { onFile } = props;
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Window-level drag lane: dragenter/leave pairs are depth-counted (they
  // fire per element crossed), dragover MUST preventDefault or the browser
  // navigates to the dropped file, and drop takes the first file.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent): boolean =>
      e.dataTransfer !== null && Array.from(e.dataTransfer.types).includes('Files');
    const onEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      depth += 1;
      setDragActive(true);
    };
    const onOver = (e: DragEvent): void => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onLeave = (): void => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragActive(false);
    };
    const onDrop = (e: DragEvent): void => {
      depth = 0;
      setDragActive(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (file !== undefined) onFile(file);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [onFile]);

  const onInputChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (file !== undefined) onFile(file);
    e.target.value = ''; // re-selecting the same file must fire change again
  };

  return (
    <section style={S.csvPanel} data-testid="csv-panel" aria-label="CSV data">
      <div style={S.dataPanelTitle}>csv</div>
      <div style={S.csvHint}>
        drop an edges .csv (source,target[,attrs…]) anywhere — nodes derive from endpoints
      </div>
      <div style={S.dataPanelRow}>
        <button
          type="button"
          className="demo-btn"
          style={S.button}
          data-testid="csv-choose"
          onClick={() => inputRef.current?.click()}
        >
          Choose CSV…
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        aria-label="Load edges CSV file"
        data-testid="csv-file-input"
        style={S.csvHiddenInput}
        tabIndex={-1}
        onChange={onInputChange}
      />
      {props.summary !== null && (
        <div style={S.csvSummary} data-testid="csv-summary">
          {props.summary}
        </div>
      )}
      {props.error !== null && (
        <div style={S.ogError} data-testid="csv-error">
          {props.error}
        </div>
      )}
      {dragActive && (
        <div style={S.csvDropOverlay} data-testid="csv-drop-overlay">
          <div style={S.csvDropOverlayInner}>drop CSV to load</div>
        </div>
      )}
    </section>
  );
}
