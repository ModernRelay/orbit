/** Explicit inspection subjects: read attributes and adjacency without moving
 * the camera or rewriting selection. The legacy selected-single API stays in
 * index.tsx; this is the reusable analyst surface. */
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import type { GraphNode } from '@modernrelay/orbit-core';
import { useResolvedInstance } from '../shared';
import { cellText } from '../Table/model';
import type { GraphInspectorProps } from './index';

const panel: CSSProperties = {
  padding: 12, borderRadius: 8, colorScheme: 'dark', background: '#171920', color: '#e8eaf0',
  overflow: 'auto', minWidth: 0, font: '13px/1.5 system-ui, sans-serif',
};
const cell: CSSProperties = { padding: '4px 8px', textAlign: 'left', overflowWrap: 'anywhere' };
function label(node: GraphNode<any> | undefined, id: string): string {
  return cellText(node?.attrs?.label ?? id);
}

export function PassiveInspector(props: GraphInspectorProps): ReactElement {
  const instance = useResolvedInstance(props.instance, '<GraphInspector>');
  const subscribe = useCallback((onChange: () => void) => instance.store.subscribe(onChange), [instance]);
  const snapshot = useCallback(() => {
    const r = instance.store.getState().revisions;
    return `${r.model}:${r.scope}`;
  }, [instance]);
  const version = useSyncExternalStore(subscribe, snapshot, snapshot);
  const subject = props.subject ?? null;
  const subjectKey = JSON.stringify(subject);
  const [page, setPage] = useState<{ instance: typeof instance; key: string; cursor: string } | null>(null);
  const pageKey = `${version}:${subjectKey}:${props.typeField ?? 'type'}`;
  const cursor = page?.key === pageKey && page.instance === instance ? page.cursor : undefined;
  const node = subject?.kind === 'node' ? instance.getNode(subject.id) : undefined;
  const edge = subject?.kind === 'edge' ? instance.getEdge(subject.id) : undefined;
  const nodeId = node?.id;
  const neighborhood = useMemo(() => nodeId === undefined ? null : instance.getNeighborhood(nodeId, {
    limit: 50, edgeLimit: 200, relationshipTypeField: props.typeField ?? 'type',
    ...(cursor === undefined ? {} : { cursor }),
  }), [instance, nodeId, version, props.typeField, cursor]);
  const nodeIds = subject?.kind === 'selection' ? [...new Set(subject.nodeIds)] : [];
  const compared = nodeIds.slice(0, 20).map((id) => ({ id, node: instance.getNode(id) }));
  const fields = [...new Set(compared.flatMap(({ node: n }) => Object.keys(n?.attrs ?? {})))].slice(0, 40);
  const attrs = Object.entries((node ?? edge)?.attrs ?? {});
  const title = subject?.kind === 'selection' ? `${nodeIds.length} nodes selected`
    : edge !== undefined ? `${label(instance.getNode(edge.source), edge.source)} → ${label(instance.getNode(edge.target), edge.target)}`
      : node !== undefined ? label(node, node.id) : 'Nothing to inspect';
  return <section data-orbit-inspector="" role="complementary" aria-label={props.label ?? 'Graph inspector'}
    className={props.className} style={{ ...panel, ...(props.layout === 'panel' ? {} : {
      position: 'absolute', top: 12, bottom: 12, width: 280,
      [props.dock === 'left' ? 'left' : 'right']: 12,
    }), ...props.style }}>
    <h3 data-orbit-inspector-title="" style={{ margin: '0 0 8px', overflowWrap: 'anywhere' }}>{title}</h3>
    {subject === null ? <p data-orbit-inspector-empty="">Select a row or inspect a node or relationship.</p> : null}
    {subject !== null && subject.kind !== 'selection' && node === undefined && edge === undefined
      ? <p role="status">This {subject.kind} is not loaded in the current source.</p> : null}
    {subject?.kind === 'selection' ? <>
      <p>Comparing {compared.length} of {nodeIds.length} selected nodes. {fields.length} attribute columns.</p>
      <div style={{ overflowX: 'auto' }}><table aria-label="Selected node comparison"><thead><tr>
        <th style={cell}>Node</th>{fields.map((field) => <th key={field} style={cell}>{field}</th>)}
      </tr></thead><tbody>{compared.map(({ id, node: n }) => <tr key={id}><th style={cell}>
        <button type="button" disabled={props.onInspect === undefined} onClick={() => props.onInspect?.({ kind: 'node', id })}>{label(n, id)}</button>
      </th>{fields.map((field) => <td key={field} style={cell}>{cellText(n?.attrs?.[field])}</td>)}</tr>)}</tbody></table></div>
    </> : null}
    {node !== undefined || edge !== undefined ? <>
      <p>{node?.id ?? edge?.id}{edge !== undefined ? ` · ${cellText(edge.attrs?.[props.typeField ?? 'type']) || 'relationship'}` : ''}</p>
      {node !== undefined && props.renderAttrs !== undefined ? props.renderAttrs(node) : <table data-orbit-inspector-attrs="" style={{ width: '100%', tableLayout: 'fixed' }}>
        <tbody>{attrs.map(([key, value]) => <tr key={key} data-orbit-inspector-attr={key}>
          <th style={cell}>{key}</th><td style={cell}>{cellText(value)}</td>
        </tr>)}</tbody></table>}
    </> : null}
    {edge !== undefined ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button type="button" disabled={props.onInspect === undefined} onClick={() => props.onInspect?.({ kind: 'node', id: edge.source })}>Inspect source</button>
      <button type="button" disabled={props.onInspect === undefined} onClick={() => props.onInspect?.({ kind: 'node', id: edge.target })}>Inspect target</button>
    </div> : null}
    {neighborhood !== null ? <>
      <h4>Relationships · {neighborhood.totalNeighbors} neighbors</h4>
      <ul style={{ paddingLeft: 20 }}>{neighborhood.nodes.map((neighbor) => <li key={neighbor.id}>
        <button type="button" disabled={props.onInspect === undefined} data-orbit-inspector-neighbor={neighbor.id}
          onClick={() => props.onInspect?.({ kind: 'node', id: neighbor.id })}>{label(neighbor, neighbor.id)}</button>
        {' · '}{neighborhood.visibility.get(neighbor.id)}
      </li>)}</ul>
      <div style={{ display: 'flex', gap: 8 }}>
        {cursor !== undefined ? <button type="button" onClick={() => setPage(null)}>First neighbors</button> : null}
        {neighborhood.nextCursor !== undefined ? <button type="button" onClick={() => setPage({ instance, key: pageKey, cursor: neighborhood.nextCursor! })}>More neighbors</button> : null}
      </div>
      <ul style={{ paddingLeft: 20 }}>{neighborhood.edges.map((relation, index) => <li key={relation.id ?? index}>
        <button type="button" disabled={props.onInspect === undefined || relation.id === undefined} onClick={() => {
          if (relation.id !== undefined) props.onInspect?.({ kind: 'edge', id: relation.id });
        }}>{cellText(relation.attrs?.[props.typeField ?? 'type']) || 'Relationship'}: {label(instance.getNode(relation.source), relation.source)} → {label(instance.getNode(relation.target), relation.target)}</button>
      </li>)}</ul>
      {neighborhood.edgesTruncated ? <p>Showing a bounded sample of {neighborhood.totalEdges} relationships.</p> : null}
    </> : null}
  </section>;
}
