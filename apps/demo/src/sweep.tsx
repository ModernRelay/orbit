/**
 * Simulation parameter sweep harness (untracked working file).
 *
 * ?n=800&clusters=6&rep=1&grav=0.25&fric=0.85&decay=5000&dist=10&spring=1
 *
 * Exposes window.__sweep = { ready, settled, settleMs, metrics() } where
 * metrics() reports the graph bounding box vs the visible viewport rect in
 * space units — the "fill fraction" a user actually sees, no pixel reading.
 */

import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { SimulationConfig } from '@modernrelay/orbit-core';
import { CosmosEngine } from '@modernrelay/orbit-engine-cosmos';
import { Graph } from '@modernrelay/orbit-react';
import type { GraphHandle } from '@modernrelay/orbit-react';
import { generateGraph } from './generate';
import type { DemoEdgeAttrs, DemoNodeAttrs } from './generate';
import { clusterColor } from './styles';

const q = new URLSearchParams(window.location.search);
const num = (k: string, d: number): number => {
  const v = Number(q.get(k));
  return Number.isFinite(v) && q.get(k) !== null ? v : d;
};

const N = num('n', 800);
const SIMULATION: SimulationConfig = {
  repulsion: num('rep', 1),
  gravity: num('grav', 0.25),
  friction: num('fric', 0.85),
  decay: num('decay', 5000),
  linkDistance: num('dist', 10),
  linkSpring: num('spring', 1),
};

const data = generateGraph({
  seed: 7,
  nodes: N,
  clusters: num('clusters', 6),
  intraEdgeFactor: 1.6,
  interEdgeProb: 0.06,
  datasetKey: 'sweep',
  sourceRevision: 1,
});

let engine: CosmosEngine | null = null;
const engineFactory = () => (engine = new CosmosEngine());
const nodeColor = (n: { attrs?: DemoNodeAttrs }): string => clusterColor(n.attrs?.cluster ?? 0);
const nodeSize = (n: { attrs?: DemoNodeAttrs }): number =>
  2 + Math.sqrt(n.attrs?.degree ?? 0);

function App(): React.ReactNode {
  const ref = useRef<GraphHandle<DemoNodeAttrs, DemoEdgeAttrs> | null>(null);

  useEffect(() => {
    const w = window as unknown as {
      __sweep?: {
        ready: boolean;
        settled: boolean;
        settleMs: number;
        metrics: () => unknown;
      };
    };
    const started = performance.now();
    const sweep = {
      ready: false,
      settled: false,
      settleMs: -1,
      metrics: () => {
        const inst = ref.current?.instance;
        const eng = engine;
        if (!inst || !eng) return null;
        const pos = eng.getPositions();
        const vp = eng.getViewport();
        if (!pos || !vp) return null;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < pos.length; i += 2) {
          const x = pos[i]!, y = pos[i + 1]!;
          if (Number.isNaN(x) || Number.isNaN(y)) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        // visible space rect from viewport: zoom = px per space unit
        const w2 = window.innerWidth / vp.zoom;
        const h2 = window.innerHeight / vp.zoom;
        return {
          graphW: Math.round(maxX - minX),
          graphH: Math.round(maxY - minY),
          visW: Math.round(w2),
          visH: Math.round(h2),
          fillX: Math.round(((maxX - minX) / w2) * 100) / 100,
          fillY: Math.round(((maxY - minY) / h2) * 100) / 100,
          zoom: Math.round(vp.zoom * 1000) / 1000,
          running: inst.isSimulationRunning(),
        };
      },
    };
    w.__sweep = sweep;
    // visible-motion tracker: max node displacement per second, sampled 500ms
    let prevPos: Float32Array | null = null;
    let lastSample = 0;
    (sweep as unknown as { motion: number[] }).motion = [];
    const motionIv = setInterval(() => {
      const eng = engine;
      if (!eng) return;
      const pos = eng.getPositions();
      if (!pos) return;
      const now = performance.now();
      if (prevPos !== null && prevPos.length === pos.length) {
        let maxD = 0;
        for (let i = 0; i < pos.length; i += 2) {
          const dx = pos[i]! - prevPos[i]!;
          const dy = pos[i + 1]! - prevPos[i + 1]!;
          const d = Math.hypot(dx, dy);
          if (d > maxD) maxD = d;
        }
        const perSec = (maxD * 1000) / Math.max(1, now - lastSample);
        (sweep as unknown as { motion: number[] }).motion.push(Math.round(perSec * 100) / 100);
      }
      prevPos = pos.slice();
      lastSample = now;
    }, 500);
    const iv = setInterval(() => {
      const inst = ref.current?.instance;
      if (inst === undefined) return;
      sweep.ready = true;
      if (!sweep.settled && sweep.settleMs < 0 && !inst.isSimulationRunning()) {
        // first quiescence after mount
        if (performance.now() - started > 1500) {
          sweep.settled = true;
          sweep.settleMs = Math.round(performance.now() - started);
        }
      }
    }, 100);
    return () => { clearInterval(iv); clearInterval(motionIv); };
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Graph<DemoNodeAttrs, DemoEdgeAttrs>
        ref={ref}
        engine={engineFactory}
        data={data}
        nodeColor={nodeColor}
        nodeSize={nodeSize}
        linkColor="rgba(255,255,255,0.15)"
        layout="force"
        simulation={SIMULATION}
        theme={{ base: 'dark', background: '#0b0e14' }}
        fitViewOnFirstData
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
