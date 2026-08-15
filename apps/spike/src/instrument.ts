/**
 * Frame instrumentation for the M0 spike workbench.
 *
 * This module MUST be imported (and therefore evaluated) before cosmos so the
 * `requestAnimationFrame` wrapper is in place before the engine schedules its
 * render loop. Every rAF callback is wrapped; after the wrapped callback runs
 * (i.e. after cosmos has drawn into its WebGL canvas, but within the SAME
 * rAF tick — before the browser composites and potentially clears the drawing
 * buffer) our frame hooks run. That is the atomic-commit capture method: a
 * synchronous `drawImage(webglCanvas)` into an offscreen 2D canvas inside the
 * same tick snapshots exactly what this frame will present.
 */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface FrameSample {
  /** Monotonic frame counter value at capture time. */
  frame: number;
  /** rAF timestamp of the tick. */
  time: number;
  /** One 3x3-block-averaged color per requested coordinate. */
  colors: RGBA[];
}

type FrameHook = (frame: number, time: number) => void;

let frameCounter = 0;
let registrationCounter = 0;
let lastTickTime = -1;
const frameHooks = new Set<FrameHook>();

const nativeRaf = window.requestAnimationFrame.bind(window);

// Install the wrapper immediately at module-evaluation time.
window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
  // Registrations count SCHEDULING (each requestAnimationFrame call), while
  // frameCount counts unique delivered ticks — the quiescence claim
  // is about registrations: a truly stopped loop schedules nothing at all.
  registrationCounter += 1;
  return nativeRaf((time: DOMHighResTimeStamp) => {
    // Multiple callbacks can share one tick; count unique ticks only.
    if (time !== lastTickTime) {
      lastTickTime = time;
      frameCounter += 1;
    }
    const frame = frameCounter;
    callback(time);
    // The producer (cosmos) has drawn. Sample synchronously, same tick.
    for (const hook of Array.from(frameHooks)) {
      try {
        hook(frame, time);
      } catch {
        // A failing hook must never break the render loop.
      }
    }
  });
};

/** Number of unique rAF ticks observed since page load. */
export function frameCount(): number {
  return frameCounter;
}

/** Number of requestAnimationFrame CALLS (scheduling events) since load. */
export function rafRegistrations(): number {
  return registrationCounter;
}

/**
 * Register a hook that runs after every wrapped rAF callback (post-draw,
 * same tick). Returns an unsubscribe function. Note: if several rAF
 * callbacks are queued in one tick the hook runs once per callback with the
 * same `frame` value — dedupe on `frame` if you need per-tick semantics.
 */
export function onFrame(hook: FrameHook): () => void {
  frameHooks.add(hook);
  return () => {
    frameHooks.delete(hook);
  };
}

let scratchCanvas: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;

function findWebglCanvas(): HTMLCanvasElement | null {
  const el = document.querySelector('#app canvas');
  return el instanceof HTMLCanvasElement ? el : null;
}

const INVALID: RGBA = { r: -1, g: -1, b: -1, a: -1 };

/**
 * Sample per-coordinate 3x3-block average RGBA from the workbench WebGL
 * canvas via a synchronous `drawImage` into an offscreen 2D canvas.
 *
 * Coordinates are in canvas pixels (the workbench pins `pixelRatio: 1`, so
 * CSS px == canvas px). Returns `{r:-1,g:-1,b:-1,a:-1}` per coord when no
 * canvas is available. An `a` of 0 means the capture read a transparent
 * (already-presented / cleared) buffer — call this from inside a frame hook
 * (same rAF tick as the draw) for a valid capture.
 */
export function samplePixels(coords: ReadonlyArray<readonly [number, number]>): RGBA[] {
  const src = findWebglCanvas();
  if (!src || src.width === 0 || src.height === 0) {
    return coords.map(() => ({ ...INVALID }));
  }
  if (!scratchCanvas) {
    scratchCanvas = document.createElement('canvas');
  }
  if (scratchCanvas.width !== src.width || scratchCanvas.height !== src.height) {
    scratchCanvas.width = src.width;
    scratchCanvas.height = src.height;
    scratchCtx = null;
  }
  if (!scratchCtx) {
    scratchCtx = scratchCanvas.getContext('2d', { willReadFrequently: true });
  }
  const ctx = scratchCtx;
  if (!ctx) {
    return coords.map(() => ({ ...INVALID }));
  }
  ctx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
  try {
    ctx.drawImage(src, 0, 0);
  } catch {
    return coords.map(() => ({ ...INVALID }));
  }
  const w = scratchCanvas.width;
  const h = scratchCanvas.height;
  return coords.map(([x, y]) => {
    const x0 = Math.max(0, Math.min(w - 3, Math.round(x) - 1));
    const y0 = Math.max(0, Math.min(h - 3, Math.round(y) - 1));
    const data = ctx.getImageData(x0, y0, 3, 3).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let i = 0; i < 9; i += 1) {
      r += data[i * 4] ?? 0;
      g += data[i * 4 + 1] ?? 0;
      b += data[i * 4 + 2] ?? 0;
      a += data[i * 4 + 3] ?? 0;
    }
    return {
      r: Math.round(r / 9),
      g: Math.round(g / 9),
      b: Math.round(b / 9),
      a: Math.round(a / 9),
    };
  });
}

interface SamplerState {
  coords: Array<[number, number]>;
  samples: FrameSample[];
  unsubscribe: () => void;
}

const samplers = new Map<number, SamplerState>();
let nextSamplerId = 1;

/**
 * Record one classification sample per frame (per unique rAF tick) at the
 * given coordinates until stopped. Returns a sampler id.
 */
export function registerFrameSampler(coords: Array<[number, number]>): number {
  const id = nextSamplerId;
  nextSamplerId += 1;
  const samples: FrameSample[] = [];
  let lastSampledFrame = -1;
  const unsubscribe = onFrame((frame, time) => {
    if (frame === lastSampledFrame) return;
    lastSampledFrame = frame;
    samples.push({ frame, time, colors: samplePixels(coords) });
  });
  samplers.set(id, { coords, samples, unsubscribe });
  return id;
}

/** Read the samples collected so far by a sampler. */
export function readSampler(id: number): FrameSample[] {
  return samplers.get(id)?.samples ?? [];
}

/** Stop a sampler. Its samples remain readable via `readSampler`. */
export function stopSampler(id: number): void {
  samplers.get(id)?.unsubscribe();
}
