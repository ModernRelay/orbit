/**
 * history random-walk under BOTH ownership modes, plus the
 * "never serialized" negatives for path highlight and expansion records.
 *
 * The walk interleaves the semantic mutation surface — expandNode/retractExpansion,
 * group collapse toggles, persistent pins and drag pins, hide/show,
 * selection, and crossfilter brushes — then walks
 * the stack all the way down and all the way back up. The invariant is
 * ROUND-TRIP IDENTITY of a deep-normalized store projection.
 *
 * Ownership modes:
 * - 'uncontrolled' — the instance owns selection / groups / pinnedNodeIds;
 * ops write directly and the undoable ones record.
 * - 'controlled' — the host owns those three lanes; ops fire INTENTS and
 * the rig reflects them back through props (the React binding's job).
 * Host-owned state is not undoable, so those lanes simply stay put during
 * the walk — the round-trip identity must still hold exactly.
 *
 * Group toggles are deliberately part of the walk even though they are host
 * CONFIG statements, not history dimensions (instance.ts: "Group ops are host-
 * config statements … they never record undo entries"): the point is that a
 * non-recording lane interleaved with recording ones never corrupts the walk.
 */

import { describe, expect, it } from 'vitest';

import { createGraphInstance } from '../src/instance';
import type { GraphInstance } from '../src/instance';
import { FakeEngine } from '../src/testing/index';
import type {
  CrossfilterSession,
  DimensionSpec,
  ExpansionResponse,
  ExpansionService,
  GraphSnapshot,
  GroupSpec,
  NodeId,
  ResolvedGroup,
} from '../src/types';

type NA = { bucket: number };
type EA = Record<string, never>;
type Response = ExpansionResponse<NA, EA>;

const container = {} as unknown as HTMLElement;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_IDS = ['a', 'b', 'c', 'd', 'e', 'f'] as const;

function snapshot(): GraphSnapshot<NA, EA> {
  return {
    datasetKey: 'walk',
    sourceRevision: 1,
    nodes: BASE_IDS.map((id, i) => ({ id, attrs: { bucket: i % 3 } })),
    edges: [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'd' },
      { source: 'd', target: 'e' },
      { source: 'e', target: 'f' },
      { source: 'f', target: 'a' },
    ],
  };
}

const node = (id: string, bucket: number) => ({ id, attrs: { bucket } });

/** Canned neighbors: x is owned by BOTH a and b (the multi-owner survivor
 * case), y only by c — so collapse exceptions actually fire during a walk. */
const EXPANSIONS: Record<string, Response> = {
  a: {
    nodes: [node('x', 0)],
    edges: [{ id: 'a-x', source: 'a', target: 'x', attrs: {} as EA }],
  },
  b: {
    nodes: [node('x', 0)],
    edges: [{ id: 'b-x', source: 'b', target: 'x', attrs: {} as EA }],
  },
  c: {
    nodes: [node('y', 1)],
    edges: [{ id: 'c-y', source: 'c', target: 'y', attrs: {} as EA }],
  },
};

function tableService(): ExpansionService<NA, EA> {
  return {
    revisionDependencies: ['source'],
    neighbors: (seedIds) => Promise.resolve(EXPANSIONS[seedIds[0]!] ?? {}),
  };
}

const BUCKET_DIM: DimensionSpec<NA> = {
  key: 'bucket',
  kind: 'numeric',
  get: (n) => n.attrs?.bucket,
};

const GROUPS: readonly GroupSpec[] = [
  { id: 'GA', memberIds: ['a', 'b'], collapsed: false },
  { id: 'GB', memberIds: ['d', 'e'], collapsed: false },
];

// ---------------------------------------------------------------------------
// Deep-normalized store projection — the round-trip comparison surface.
// Revisions and diagnostics are excluded on purpose: a walk legitimately
// advances render/scope clocks, and the invariant is about STATE, not clocks.
// ---------------------------------------------------------------------------

interface Projection {
  selection: { nodeIds: readonly string[]; edgeIds: readonly string[]; groupIds: readonly string[] };
  hiddenNodeIds: readonly string[];
  pins: ReadonlyArray<readonly [string, number, number]>;
  pinnedNodeIds: readonly string[];
  groups: ReadonlyArray<{
    id: string;
    collapsed: boolean;
    derived: boolean;
    memberIds: readonly string[];
  }>;
  scope: { seedIds: readonly string[]; hops: number | null } | null;
  visible: { nodes: number; edges: number };
  nodeCount: number;
  edgeCount: number;
  sceneNodeIds: readonly string[];
  visibleNodeIds: readonly string[];
  pendingExpansions: readonly string[];
  history: { undoDepth: number; redoDepth: number };
}

function project(instance: GraphInstance<NA, EA>): Projection {
  const s = instance.store.getState();
  return {
    selection: {
      nodeIds: [...s.selection.nodeIds],
      edgeIds: [...s.selection.edgeIds],
      groupIds: [...s.selection.groupIds],
    },
    hiddenNodeIds: [...s.hiddenNodeIds].sort(),
    pins: [...s.pins.entries()]
      .map(([id, xy]) => [id, xy[0], xy[1]] as const)
      .sort((p, q) => (p[0] < q[0] ? -1 : 1)),
    pinnedNodeIds: [...s.pinnedNodeIds].sort(),
    groups: s.groups.map((g: ResolvedGroup) => ({
      id: g.id,
      collapsed: g.collapsed,
      derived: g.derived,
      memberIds: [...g.memberIds],
    })),
    scope: s.scope === null ? null : { seedIds: [...s.scope.seedIds], hops: s.scope.hops ?? null },
    visible: { ...s.visible },
    nodeCount: s.nodeCount,
    edgeCount: s.edgeCount,
    sceneNodeIds: [...instance.getSceneNodeIds()],
    visibleNodeIds: [...instance.getVisibleNodeIds()],
    pendingExpansions: [...s.pendingExpansions].sort(),
    history: { ...s.history },
  };
}

// ---------------------------------------------------------------------------
// Rig — one instance per walk, with the controlled-mode reflect wired.
// ---------------------------------------------------------------------------

type Mode = 'uncontrolled' | 'controlled';

interface Rig {
  instance: GraphInstance<NA, EA>;
  engine: FakeEngine;
  session: CrossfilterSession;
  /** Applies any pending intents back through props (controlled only). */
  reflect: () => void;
}

async function makeRig(mode: Mode): Promise<Rig> {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance<NA, EA>({
    engine: () => {
      const e = new FakeEngine();
      engines.push(e);
      return e;
    },
    fitViewOnFirstData: false,
    services: { expansion: tableService() },
  });
  await instance.attach(container);
  instance.applyHostUpdate({
    data: snapshot(),
    nodeColor: 'red',
    linkColor: 'blue',
    crossfilter: [BUCKET_DIM],
  });

  let pendingSelection: readonly NodeId[] | null = null;
  let pendingPinned: readonly NodeId[] | null = null;
  let pendingGroups: readonly GroupSpec[] | null = null;

  if (mode === 'controlled') {
    // the FIRST host update carrying a lane latches it controlled, and
    // the latch must precede the walk — commands recorded pre-latch are
    // skipped by the apply path, which would make the walk untestable.
    instance.applyHostUpdate({ selection: [], pinnedNodeIds: [], groups: GROUPS });
    instance.on('selectionChange', (p) => {
      pendingSelection = [...p.nodeIds];
    });
    instance.on('pinnedChange', (p) => {
      pendingPinned = [...p.pinnedNodeIds];
    });
    instance.on('groupsChange', (p) => {
      pendingGroups = p.groups.map((g) => ({
        id: g.id,
        memberIds: [...g.memberIds],
        collapsed: g.collapsed,
      }));
    });
  } else {
    // ANY host update carrying `groups` latches the lane controlled
    // permanently, so an uncontrolled rig must define its groups through the
    // OP path (`groupNodes` routes via groupsInternalWrite and never latches).
    for (const g of GROUPS) instance.groupNodes(g);
    expect(instance.store.getState().groups.map((g) => g.id)).toEqual(GROUP_IDS);
  }

  const reflect = (): void => {
    if (mode !== 'controlled') return;
    if (pendingSelection === null && pendingPinned === null && pendingGroups === null) return;
    instance.applyHostUpdate({
      ...(pendingSelection !== null ? { selection: pendingSelection } : {}),
      ...(pendingPinned !== null ? { pinnedNodeIds: pendingPinned } : {}),
      ...(pendingGroups !== null ? { groups: pendingGroups } : {}),
    });
    pendingSelection = null;
    pendingPinned = null;
    pendingGroups = null;
  };

  const session = instance.getCrossfilterSession()!;
  return { instance, engine: engines[0]!, session, reflect };
}

/** Group ids the walk toggles; controlled mode drives the same ids by prop. */
const GROUP_IDS = GROUPS.map((g) => g.id);

/**
 * Settle the expansion lane's TRAILING publication.
 *
 * `expandNode` resolves the caller promise in a `.then` and does its
 * cleanup publish — `pendingExpansions` plus the folded depth
 * notification — in the `.finally` chained after it (instance.ts
 * expandNode). The caller therefore resumes one microtask BEFORE the store
 * reflects the completed expansion's ledger/depth. Data and scene are already
 * published at that point; only those two published fields lag. Walks settle
 * here so the round-trip comparison measures history, not that ordering.
 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function runWalk(rig: Rig, mode: Mode, seed: number, steps: number): Promise<void> {
  const rng = mulberry32(seed);
  const { instance, session, reflect } = rig;
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rng() * list.length)]!;
  const collapsedByGroup = new Map<string, boolean>(GROUP_IDS.map((id) => [id, false]));

  for (let i = 0; i < steps; i++) {
    switch (Math.floor(rng() * 7)) {
      case 0:
        await instance.expandNode(pick(['a', 'b', 'c']));
        await settle();
        break;
      case 1:
        instance.retractExpansion(pick(['a', 'b', 'c']));
        break;
      case 2: {
        const id = pick(GROUP_IDS);
        const next = !(collapsedByGroup.get(id) ?? false);
        collapsedByGroup.set(id, next);
        if (mode === 'controlled') {
          instance.applyHostUpdate({
            groups: GROUPS.map((g) => ({
              ...g,
              collapsed: collapsedByGroup.get(g.id) ?? false,
            })),
          });
        } else {
          instance.setGroupCollapsed(id, next);
        }
        break;
      }
      case 3:
        if (rng() < 0.5) instance.pinNodes([pick(BASE_IDS)]);
        else instance.unpinNodes([pick(BASE_IDS)]);
        reflect();
        break;
      case 4:
        if (rng() < 0.5) instance.hideNodes([pick(BASE_IDS)]);
        else instance.showNodes([pick(BASE_IDS)]);
        break;
      case 5: {
        const lo = Math.floor(rng() * 3);
        await session.setBrush('bucket', rng() < 0.25 ? null : { min: lo, max: lo + 1 });
        break;
      }
      default: {
        if (rng() < 0.35) {
          instance.pinNode(pick(BASE_IDS), [rng() * 10, rng() * 10]);
        } else {
          instance.selectNodes([pick(BASE_IDS), pick(BASE_IDS)]);
          reflect();
        }
        break;
      }
    }
  }
}

function undoAll(instance: GraphInstance<NA, EA>): number {
  let n = 0;
  while (instance.undo()) {
    n++;
    if (n > 500) throw new Error('undo did not terminate');
  }
  return n;
}

function redoAll(instance: GraphInstance<NA, EA>): number {
  let n = 0;
  while (instance.redo()) {
    n++;
    if (n > 500) throw new Error('redo did not terminate');
  }
  return n;
}

// ---------------------------------------------------------------------------

const WALKS = 40;
const STEPS = 16;

describe('history random-walk (both ownership modes)', () => {
  for (const mode of ['uncontrolled', 'controlled'] as const) {
    it(`${mode}: undo-all then redo-all restores an identical store snapshot across ${String(WALKS)} walks`, async () => {
      let totalUndos = 0;
      let movedWalks = 0;
      let collapsedWalks = 0;
      let expandedWalks = 0;

      for (let w = 0; w < WALKS; w++) {
        const seed = 0x5121_4000 + w;
        const rig = await makeRig(mode);
        try {
          await runWalk(rig, mode, seed, STEPS);
          const atEnd = project(rig.instance);
          expect(atEnd.history.redoDepth, `seed ${String(seed)}: fresh walk has no redo branch`).toBe(
            0,
          );
          if (atEnd.groups.some((g) => g.collapsed)) collapsedWalks++;
          if (atEnd.nodeCount > BASE_IDS.length) expandedWalks++;

          const undos = undoAll(rig.instance);
          totalUndos += undos;
          expect(
            rig.instance.store.getState().history.undoDepth,
            `seed ${String(seed)}: stack drained`,
          ).toBe(0);
          const atBottom = project(rig.instance);
          if (JSON.stringify(atBottom) !== JSON.stringify(atEnd)) movedWalks++;

          const redos = redoAll(rig.instance);
          expect(redos, `seed ${String(seed)}: redo count matches undo count`).toBe(undos);

          expect(project(rig.instance), `seed ${String(seed)}: round-trip identity`).toEqual(atEnd);
        } finally {
          rig.instance.destroy();
        }
      }

      // The walks must actually be walks: entries recorded, the bottom of the
      // stack differs from the top for most seeds, and the stage-3 rewrite +
      // expansion lanes were genuinely live while the stack was walked.
      expect(totalUndos).toBeGreaterThan(WALKS * 3);
      expect(movedWalks).toBeGreaterThan(WALKS / 2);
      expect(collapsedWalks).toBeGreaterThan(WALKS / 4);
      expect(expandedWalks).toBeGreaterThan(WALKS / 4);
    }, 60_000);
  }

  it('uncontrolled: group toggles interleave as NON-recording steps (config lane, not a history dimension)', async () => {
    const rig = await makeRig('uncontrolled');
    try {
      rig.instance.hideNodes(['c']);
      const depthBefore = rig.instance.store.getState().history.undoDepth;
      rig.instance.setGroupCollapsed('GA', true);
      expect(rig.instance.store.getState().groups.find((g) => g.id === 'GA')!.collapsed).toBe(true);
      expect(rig.instance.store.getState().history.undoDepth).toBe(depthBefore);

      // Undoing the hide leaves the group collapsed: the config lane is
      // untouched by the walk, which is exactly why round-trip identity holds.
      expect(rig.instance.undo()).toBe(true);
      expect(rig.instance.store.getState().hiddenNodeIds.size).toBe(0);
      expect(rig.instance.store.getState().groups.find((g) => g.id === 'GA')!.collapsed).toBe(true);
    } finally {
      rig.instance.destroy();
    }
  });

  it('controlled: pin/selection ops fire intents only — the store moves solely through props', async () => {
    const rig = await makeRig('controlled');
    try {
      const before = project(rig.instance);
      rig.instance.pinNodes(['a']);
      rig.instance.selectNodes(['b']);
      // Intents fired; nothing written yet.
      expect(project(rig.instance).pinnedNodeIds).toEqual(before.pinnedNodeIds);
      expect(project(rig.instance).selection.nodeIds).toEqual(before.selection.nodeIds);
      expect(rig.instance.store.getState().history.undoDepth).toBe(0);

      rig.reflect();
      expect(project(rig.instance).pinnedNodeIds).toEqual(['a']);
      expect(project(rig.instance).selection.nodeIds).toEqual(['b']);
      // Host-owned state is not undoable.
      expect(rig.instance.store.getState().history.undoDepth).toBe(0);
    } finally {
      rig.instance.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Never-serialized negatives.
// ---------------------------------------------------------------------------

/** The complete published store surface. A new key must be added here
 * consciously — that is the whole point of pinning it. */
const STORE_KEYS = [
  'diagnostics',
  'edgeCount',
  // node folds: anchor → hidden count. Deliberately published — a fold
  // changes no id and no label text, so nothing else signals that
  // fold-derived chrome went stale.
  'folds',
  'groups',
  'history',
  'hiddenNodeIds',
  'hover',
  'nodeCount',
  'overlayIds',
  'pendingExpansions',
  'pins',
  'pinnedNodeIds',
  'revisions',
  'scope',
  'search',
  'selection',
  'simulationRunning',
  'status',
  'theme',
  'timeline',
  'viewport',
  'visible',
].sort();

/** JSON of the store with Map/Set normalized — the serializable surface. */
function serializeStore(instance: GraphInstance<NA, EA>): string {
  const s = instance.store.getState();
  return JSON.stringify({
    ...s,
    pins: [...s.pins.entries()],
    pinnedNodeIds: [...s.pinnedNodeIds],
    hiddenNodeIds: [...s.hiddenNodeIds],
    pendingExpansions: [...s.pendingExpansions],
  });
}

describe('expansion records and path highlights are never serialized', () => {
  it('getViewState() excludes both transient lanes', async () => {
    const rig = await makeRig('uncontrolled');
    try {
      // Assert the exclusion directly against the serialized surface.
      expect(typeof rig.instance.getViewState).toBe('function');

      await rig.instance.expandNode('a');
      await rig.instance.expandNode('b');
      await settle();
      const path = await rig.instance.findPath('a', 'd', { direction: 'either' });
      expect(path).not.toBeNull();
      expect(rig.instance.getActivePath()).not.toBeNull();

      const state = rig.instance.store.getState();
      expect(Object.keys(state).sort()).toEqual(STORE_KEYS);

      // The REAL surface: no expansion-record shapes, no path lane.
      const serialized = JSON.stringify(rig.instance.getViewState());
      expect(serialized).not.toContain('expandedId');
      expect(serialized).not.toContain('addedNodeIds');
      expect(serialized).not.toContain('activePath');

      // `overlayIds` is a legitimate slice, so the markers here are the
      // record-shaped field names only.
      const json = serializeStore(rig.instance);
      for (const marker of ['expandedId', 'addedNodeIds', 'activePath', 'pathNodeIds']) {
        expect(json, `store JSON must not carry ${marker}`).not.toContain(marker);
      }
    } finally {
      rig.instance.destroy();
    }
  });

  it('findPath is state-neutral: the projected store is byte-identical before and after, and history depth never moves', async () => {
    const rig = await makeRig('uncontrolled');
    try {
      rig.instance.selectNodes(['a']);
      await rig.instance.expandNode('c');
      await settle();
      const before = project(rig.instance);
      const depthBefore = rig.instance.store.getState().history.undoDepth;

      const path = await rig.instance.findPath('a', 'd', { direction: 'either' });
      expect(path).not.toBeNull();
      expect(project(rig.instance)).toEqual(before);
      expect(rig.instance.store.getState().history.undoDepth).toBe(depthBefore);

      rig.instance.clearPath();
      expect(rig.instance.getActivePath()).toBeNull();
      expect(project(rig.instance)).toEqual(before);
      expect(rig.instance.store.getState().history.undoDepth).toBe(depthBefore);
    } finally {
      rig.instance.destroy();
    }
  });

  it('an undo/redo walk clears the active path and never records it as a step', async () => {
    const rig = await makeRig('uncontrolled');
    try {
      rig.instance.hideNodes(['e']);
      const depth = rig.instance.store.getState().history.undoDepth;
      expect(await rig.instance.findPath('a', 'd', { direction: 'either' })).not.toBeNull();
      expect(rig.instance.store.getState().history.undoDepth).toBe(depth);

      expect(rig.instance.undo()).toBe(true);
      expect(rig.instance.getActivePath()).toBeNull();
      expect(rig.instance.redo()).toBe(true);
      expect(rig.instance.getActivePath()).toBeNull();
    } finally {
      rig.instance.destroy();
    }
  });
});
