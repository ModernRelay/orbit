/** A fictional, deterministic supplier investigation. All data stays in this tab. */
import type {
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  LabelConfig,
} from '@modernrelay/orbit-core';

export interface Entity extends Record<string, unknown> {
  label: string;
  type: 'Company' | 'Product' | 'Facility' | 'Incident' | 'Report';
  country: string;
  status: string;
  summary: string;
}

export interface Relationship extends Record<string, unknown> {
  type: 'SUPPLIES' | 'BUILDS' | 'OPERATES' | 'AFFECTS' | 'DOCUMENTS';
  evidence: string;
  confidence: number;
  observedAt: string;
}

function node(id: string, label: string, type: Entity['type'], country: string,
  status: string, summary: string, x: number, y: number): GraphNode<Entity> {
  return { id, x, y, attrs: { label, type, country, status, summary } };
}

export const catalogNodes: readonly GraphNode<Entity>[] = [
  node('atlas', 'Atlas Mobility', 'Company', 'DE', 'Investigating', 'Assembles the Atlas commuter bicycle.', 0, 0),
  node('harbor', 'Harbor Cells', 'Company', 'NL', 'At risk', 'Primary battery supplier; a port delay is under review.', -170, -70),
  node('cedar', 'Cedar Frames', 'Company', 'PL', 'Verified', 'Supplies recycled aluminum frames.', -160, 100),
  node('bike', 'Atlas commuter bicycle', 'Product', 'DE', 'In production', 'Production depends on five specialist suppliers.', 170, 0),
  node('delay', 'Harbor port delay', 'Incident', 'NL', 'Open', 'Fictional transport disruption reported on September 4.', -280, -170),
  node('report', 'Port operations bulletin', 'Report', 'NL', 'Reviewed', 'Primary evidence for the disruption hypothesis.', -410, -170),
  node('ember', 'Ember Electronics', 'Company', 'TW', 'Verified', 'Controller supplier; starts outside the loaded graph.', 80, -210),
  node('lumen', 'Lumen Lighting', 'Company', 'CZ', 'Verified', 'Lighting supplier.', 240, -180),
  node('northstar', 'Northstar Rubber', 'Company', 'FR', 'Monitoring', 'Tire supplier with a pending capacity assessment.', 300, 100),
  node('foundry', 'Atlas assembly plant', 'Facility', 'DE', 'Operational', 'Final assembly facility.', 90, 190),
  node('battery', 'Battery module', 'Product', 'NL', 'At risk', 'Module supplied by Harbor Cells.', -180, -260),
  node('frame', 'Recycled frame', 'Product', 'PL', 'Available', 'Frame manufactured by Cedar Frames.', -180, 250),
];

function edge(id: string, source: string, target: string, type: Relationship['type'],
  evidence: string, confidence = 0.95): GraphEdge<Relationship> {
  return { id, source, target, attrs: { type, evidence, confidence, observedAt: '2026-09-04' } };
}

export const catalogEdges: readonly GraphEdge<Relationship>[] = [
  edge('harbor-atlas', 'harbor', 'atlas', 'SUPPLIES', 'Supplier register: battery contract'),
  edge('cedar-atlas', 'cedar', 'atlas', 'SUPPLIES', 'Supplier register: frame contract'),
  edge('ember-atlas', 'ember', 'atlas', 'SUPPLIES', 'Supplier register: controller contract'),
  edge('lumen-atlas', 'lumen', 'atlas', 'SUPPLIES', 'Supplier register: lighting contract'),
  edge('northstar-atlas', 'northstar', 'atlas', 'SUPPLIES', 'Supplier register: tire contract', 0.8),
  edge('atlas-bike', 'atlas', 'bike', 'BUILDS', 'Product catalog'),
  edge('delay-harbor', 'delay', 'harbor', 'AFFECTS', 'Port operations bulletin', 0.82),
  edge('report-delay', 'report', 'delay', 'DOCUMENTS', 'Bulletin paragraph 3'),
  edge('atlas-foundry', 'atlas', 'foundry', 'OPERATES', 'Facility register'),
  edge('harbor-battery', 'harbor', 'battery', 'BUILDS', 'Product catalog'),
  edge('cedar-frame', 'cedar', 'frame', 'BUILDS', 'Product catalog'),
];

const seedIds = new Set(['atlas', 'harbor', 'cedar', 'bike', 'delay', 'report']);
export const seedSnapshot: GraphSnapshot<Entity, Relationship> = {
  datasetKey: 'storybook:supply-chain',
  sourceRevision: '2026-09-04',
  nodes: catalogNodes.filter((n) => seedIds.has(n.id)),
  edges: catalogEdges.filter((e) => seedIds.has(e.source) && seedIds.has(e.target)),
};

export const sourceReference = {
  source: 'fictional-supplier-catalog',
  revision: '2026-09-04',
  query: 'Atlas Mobility supply chain',
};

export const labelOf = (n: GraphNode<Entity>): string => n.attrs?.label ?? n.id;
export const labels: LabelConfig<Entity> = { minZoom: 0, maxVisible: 20, getText: labelOf };
const colors: Record<Entity['type'], string> = {
  Company: '#68a7ff', Product: '#6cdbb0', Facility: '#e5bd65', Incident: '#ed8392', Report: '#b59cf3',
};
export const colorOf = (n: GraphNode<Entity>): string => colors[n.attrs?.type ?? 'Company'];

/** Real asynchronous work with cooperative cancellation; no fetch or credentials. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new DOMException('The fixture request was cancelled.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
