/**
 * M0 spike workbench entrypoint.
 *
 * IMPORTANT: `./instrument` must stay the first import so its
 * `requestAnimationFrame` wrapper is installed before cosmos is evaluated
 * and schedules its render loop.
 */
import {
  frameCount,
  rafRegistrations,
  onFrame,
  registerFrameSampler,
  readSampler,
  stopSampler,
  samplePixels,
} from './instrument';
import type { FrameSample, RGBA } from './instrument';
import { Graph } from '@cosmos.gl/graph';
import type { GraphConfig } from '@cosmos.gl/graph';
import * as fixtures from './fixtures';

export interface PointClickEvent {
  index: number;
  position: [number, number];
  t: number;
}

export interface CanvasClickEvent {
  /** `null` when the click hit the background (cosmos reports `undefined`). */
  index: number | null;
  t: number;
}

export interface LinkClickEvent {
  linkIndex: number;
  t: number;
}

export interface LinkHoverEvent {
  type: 'over' | 'out';
  linkIndex: number | null;
  t: number;
}

export interface SimEvent {
  type: 'start' | 'end' | 'pause' | 'unpause';
  t: number;
}

export interface ContextEvent {
  type: string;
  t: number;
}

export interface Sinks {
  pointClicks: PointClickEvent[];
  clicks: CanvasClickEvent[];
  linkClicks: LinkClickEvent[];
  linkHovers: LinkHoverEvent[];
  simEvents: SimEvent[];
  contextEvents: ContextEvent[];
}

export interface CommitState {
  positions: Float32Array;
  colors: Float32Array;
  links: Float32Array;
}

export interface SampleNextFrameOptions {
  /** Trigger `graph.render(undefined, 0)` to force a draw. Default `true`. */
  forceRender?: boolean;
  timeoutMs?: number;
}

export interface SpikeApi {
  graph: Graph | null;
  sinks: Sinks;
  lastConfig: GraphConfig | null;
  /** Scratch slot for probes that need to stash data between evaluate calls. */
  state: Record<string, unknown>;
  fixtures: typeof fixtures;
  init(config?: GraphConfig): Promise<void>;
  destroy(): void;
  applyCommit(state: CommitState): void;
  pin(indices: number[] | null): void;
  track(indices: number[]): void;
  readTracked(): number[];
  spaceToScreen(index: number): [number, number];
  spaceToScreenXY(x: number, y: number): [number, number];
  screenToSpace(x: number, y: number): [number, number];
  loseContext(): boolean;
  restoreContext(): boolean;
  frameCount(): number;
  /** requestAnimationFrame CALL count — a stopped loop schedules nothing. */
  rafRegistrations(): number;
  onFrame(hook: (frame: number, time: number) => void): () => void;
  samplePixels(coords: Array<[number, number]>): RGBA[];
  sampleNextFrame(coords: Array<[number, number]>, opts?: SampleNextFrameOptions): Promise<RGBA[] | null>;
  registerFrameSampler(coords: Array<[number, number]>): number;
  readSampler(id: number): FrameSample[];
  stopSampler(id: number): void;
}

function emptySinks(): Sinks {
  return {
    pointClicks: [],
    clicks: [],
    linkClicks: [],
    linkHovers: [],
    simEvents: [],
    contextEvents: [],
  };
}

let graph: Graph | null = null;
let sinks: Sinks = emptySinks();
let lastConfig: GraphConfig | null = null;
let loseContextExt: { loseContext(): void; restoreContext(): void } | null = null;

function now(): number {
  return performance.now();
}

function requireGraph(): Graph {
  if (!graph) throw new Error('__spike.init() has not been called');
  return graph;
}

function destroy(): void {
  if (graph) {
    try {
      graph.destroy();
    } catch {
      // A dead device (e.g. after context loss) may throw on teardown.
    }
    graph = null;
  }
  loseContextExt = null;
  const app = document.querySelector('#app');
  if (app) app.innerHTML = '';
}

async function init(config: GraphConfig = {}): Promise<void> {
  destroy();
  sinks = emptySinks();
  api.sinks = sinks;
  lastConfig = config;
  api.lastConfig = config;

  const div = document.querySelector('#app');
  if (!(div instanceof HTMLDivElement)) throw new Error('#app div not found');

  const merged: GraphConfig = {
    pixelRatio: 1,
    randomSeed: 42,
    transitionDuration: 0,
    ...config,
    onPointClick: (index, position) => {
      sinks.pointClicks.push({ index, position, t: now() });
    },
    onClick: (index) => {
      sinks.clicks.push({ index: index ?? null, t: now() });
    },
    onLinkClick: (linkIndex) => {
      sinks.linkClicks.push({ linkIndex, t: now() });
    },
    onLinkMouseOver: (linkIndex) => {
      sinks.linkHovers.push({ type: 'over', linkIndex, t: now() });
    },
    onLinkMouseOut: () => {
      sinks.linkHovers.push({ type: 'out', linkIndex: null, t: now() });
    },
    onSimulationStart: () => {
      sinks.simEvents.push({ type: 'start', t: now() });
    },
    onSimulationEnd: () => {
      sinks.simEvents.push({ type: 'end', t: now() });
    },
    onSimulationPause: () => {
      sinks.simEvents.push({ type: 'pause', t: now() });
    },
    onSimulationUnpause: () => {
      sinks.simEvents.push({ type: 'unpause', t: now() });
    },
  };

  graph = new Graph(div, merged);
  api.graph = graph;
  await graph.ready;

  const canvas = div.querySelector('canvas');
  if (canvas) {
    canvas.addEventListener('webglcontextlost', (e) => {
      // An embedding app must preventDefault to allow restoration.
      e.preventDefault();
      sinks.contextEvents.push({ type: 'lost', t: now() });
    });
    canvas.addEventListener('webglcontextrestored', () => {
      sinks.contextEvents.push({ type: 'restored', t: now() });
    });
  }
}

/**
 * Apply a full A/B scene swap as one synchronous batch (positions, colors,
 * links, then a snapping render) — the atomic-commit pattern under test.
 */
function applyCommit(state: CommitState): void {
  const g = requireGraph();
  g.setPointPositions(state.positions, true);
  g.setPointColors(state.colors);
  g.setLinks(state.links);
  g.render(undefined, 0);
}

function getWebglContext(): WebGLRenderingContext | WebGL2RenderingContext | null {
  const canvas = document.querySelector('#app canvas');
  if (!(canvas instanceof HTMLCanvasElement)) return null;
  return (
    (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
    (canvas.getContext('webgl') as WebGLRenderingContext | null)
  );
}

function loseContext(): boolean {
  const gl = getWebglContext();
  if (!gl) return false;
  const ext = gl.getExtension('WEBGL_lose_context');
  if (!ext) return false;
  loseContextExt = ext;
  ext.loseContext();
  return true;
}

function restoreContext(): boolean {
  if (!loseContextExt) return false;
  try {
    loseContextExt.restoreContext();
    return true;
  } catch {
    return false;
  }
}

function spaceToScreen(index: number): [number, number] {
  const g = requireGraph();
  const positions = g.getPointPositions();
  const x = positions[index * 2];
  const y = positions[index * 2 + 1];
  if (x === undefined || y === undefined) {
    throw new Error(`no point at index ${String(index)}`);
  }
  return g.spaceToScreenPosition([x, y]);
}

function sampleNextFrame(
  coords: Array<[number, number]>,
  opts: SampleNextFrameOptions = {},
): Promise<RGBA[] | null> {
  const timeoutMs = opts.timeoutMs ?? 1500;
  return new Promise((resolve) => {
    let done = false;
    const off = onFrame(() => {
      if (done) return;
      done = true;
      off();
      resolve(samplePixels(coords));
    });
    if (opts.forceRender !== false && graph) {
      try {
        graph.render(undefined, 0);
      } catch {
        // Rendering can throw after context loss; the timeout handles it.
      }
    }
    window.setTimeout(() => {
      if (!done) {
        done = true;
        off();
        resolve(null);
      }
    }, timeoutMs);
  });
}

const api: SpikeApi = {
  graph,
  sinks,
  lastConfig,
  state: {},
  fixtures,
  init,
  destroy,
  applyCommit,
  pin: (indices) => {
    requireGraph().setPinnedPoints(indices);
  },
  track: (indices) => {
    requireGraph().trackPointPositionsByIndices(indices);
  },
  readTracked: () => requireGraph().getTrackedPointPositionsArray(),
  spaceToScreen,
  spaceToScreenXY: (x, y) => requireGraph().spaceToScreenPosition([x, y]),
  screenToSpace: (x, y) => requireGraph().screenToSpacePosition([x, y]),
  loseContext,
  restoreContext,
  frameCount,
  rafRegistrations,
  onFrame,
  samplePixels,
  sampleNextFrame,
  registerFrameSampler,
  readSampler,
  stopSampler,
};

window.__spike = api;
console.log('[spike] workbench ready');
