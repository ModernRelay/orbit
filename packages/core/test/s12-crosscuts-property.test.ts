/**
 * property suite — randomized group-definition / collapse-expand /
 * filter / parallel-edge-toggle sequences never corrupt the id↔index bijection
 * and never leave a dangling meta-edge.
 *
 * Two lanes run the SAME seeded sequence and are compared step by step:
 *
 * - the SCENE lane calls the product composition directly
 * (`rewriteGroups` → `collapseParallelEdges` → `Reconciler.reconcile` →
 * `sceneGroupsOf`), which is exactly what `reconcileScene` composes
 * (instance.ts `composeStage3Rewrite` + `reconcileScene`). It is the only
 * lane with access to the full `RenderScene`, so it carries the scene
 * invariants (a)–(d);
 * - the INSTANCE lane drives the real instance over FakeEngine and asserts
 * its observable projections (scene roster, committed pointCount/links,
 * store.groups) agree with the scene lane, plus (e) the once-per-pass
 * diagnostic rule. A divergence means the instance does NOT compose what
 * this file claims it composes — the cross-check is what keeps the scene
 * lane from testing a private mirror.
 *
 * INDEX POLICY: names two policies ('rebuild' | 'stable'), but v0.10
 * implements only 'rebuild' — `indexPolicy` exists in no source file and
 * `Reconciler` has no policy parameter (see reconciler.ts header). The suite
 * therefore runs the single implemented policy; `it('…single implemented
 * index policy…')` pins that fact so the day 'stable' lands, the missing
 * parameterization is visible here.
 */

import { describe, expect, it } from 'vitest';

import { Reconciler } from '../src/reconciler';
import {
  buildRepForest,
  collapseParallelEdges,
  metaEdgePublicId,
  resolveManualGroups,
  rewriteGroups,
  sceneGroupsOf,
  scenePointRefAt,
  validateGroupSpecs,
} from '../src/groups';
import { createGraphInstance } from '../src/instance';
import type { GraphInstance } from '../src/instance';
import type { EngineCommit } from '../src/engine/index';
import { FakeEngine } from '../src/testing/index';
import { validateSnapshot } from '../src/validate';
import type {
  AcceptedGraph,
  GraphDiagnostic,
  GraphNode,
  GraphSnapshot,
  GroupSpec,
  RenderScene,
  ResolvedGroup,
} from '../src/types';

type NA = { bucket: number };
type EA = Record<string, never>;

const container = {} as unknown as HTMLElement;

/** Classic mulberry32 — the repo's seeded-PRNG convention (perf-gate.test.ts,
 * link-pick.test.ts): a failing sequence reproduces from its printed seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NODE_IDS: readonly string[] = Array.from({ length: 12 }, (_, i) => `n${i}`);
const GROUP_IDS: readonly string[] = ['G0', 'G1', 'G2'];

/** drop lanes the fixture deliberately triggers — invariant (e) asserts
 * each is reported exactly once and never re-emitted by a later pass. */
const DROP_CODES: readonly string[] = [
  'duplicate-node-id',
  'dangling-edge-endpoint',
  'self-loop-retained',
];

/**
 * 12 nodes / 18 edges. Contains same-directed-pair PARALLELS (n0→n1 twice,
 * n4→n5 three times) so the toggle is operative for the whole run
 * the inoperative-case latch is a separate, deterministic unit (pins-parallel).
 *
 * It also carries one row per DROP lane (a duplicate node id, an edge to
 * a nonexistent endpoint, a self-loop) so every pass has real drop
 * diagnostics to over- or under-report.
 */
function fixtureSnapshot(): GraphSnapshot<NA, EA> {
  const nodes: GraphNode<NA>[] = NODE_IDS.map((id, i) => ({ id, attrs: { bucket: i % 4 } }));
  nodes.push({ id: 'n3', attrs: { bucket: 3 } }); // duplicate id → first wins
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['n0', 'n1'],
    ['n0', 'n1'], // parallel
    ['n1', 'n2'],
    ['n2', 'n3'],
    ['n3', 'n0'],
    ['n4', 'n5'],
    ['n4', 'n5'], // parallel
    ['n4', 'n5'], // parallel
    ['n5', 'n6'],
    ['n6', 'n7'],
    ['n7', 'n4'],
    ['n8', 'n9'],
    ['n9', 'n10'],
    ['n10', 'n11'],
    ['n11', 'n8'],
    ['n2', 'n6'],
    ['n6', 'n10'],
    ['n10', 'n2'],
    ['n0', 'nowhere'], // dangling endpoint → dropped
    ['n7', 'n7'], // self-loop → retained with a diagnostic
  ];
  return {
    datasetKey: 'prop',
    sourceRevision: 1,
    nodes,
    edges: pairs.map(([source, target]) => ({ source, target })),
  };
}

// ---------------------------------------------------------------------------
// Sequence generator — one plan, replayed by both lanes.
// ---------------------------------------------------------------------------

type Step =
  | { kind: 'groups'; specs: readonly GroupSpec[] | null; valid: boolean }
  | { kind: 'collapse'; groupId: string; collapsed: boolean }
  | { kind: 'filter'; bucket: number | null; mode: 'hide' | 'dim' }
  | { kind: 'parallel'; on: boolean };

interface Plan {
  seed: number;
  steps: readonly Step[];
}

const INVALID_KINDS = ['duplicate', 'overlap', 'unknown', 'cycle', 'self'] as const;

function shuffled(rng: () => number, source: readonly string[]): string[] {
  const out = [...source];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** A VALID acyclic/singly-parented groups array: a shuffled prefix split into chunks. */
function validGroups(rng: () => number): GroupSpec[] {
  const pool = shuffled(rng, NODE_IDS).slice(0, 2 + Math.floor(rng() * (NODE_IDS.length - 2)));
  const groupCount = Math.min(1 + Math.floor(rng() * GROUP_IDS.length), pool.length);
  const specs: GroupSpec[] = [];
  let at = 0;
  for (let g = 0; g < groupCount; g++) {
    const remaining = pool.length - at;
    const left = groupCount - g;
    if (remaining < left) break;
    const take = g === groupCount - 1 ? remaining : 1 + Math.floor(rng() * (remaining - left + 1));
    specs.push({
      id: GROUP_IDS[g]!,
      memberIds: pool.slice(at, at + take),
      collapsed: rng() < 0.5,
    });
    at += take;
  }
  return specs;
}

/** Corrupts a valid array into exactly one acyclic/singly-parented violation. */
function corrupt(rng: () => number, specs: readonly GroupSpec[]): GroupSpec[] {
  const kind = INVALID_KINDS[Math.floor(rng() * INVALID_KINDS.length)]!;
  const out = specs.map((s) => ({ ...s, memberIds: [...s.memberIds] }));
  const first = out[0]!;
  switch (kind) {
    case 'duplicate':
      first.memberIds.push(first.memberIds[0]!);
      break;
    case 'overlap':
      if (out.length > 1) out[1]!.memberIds.push(first.memberIds[0]!);
      else first.memberIds.push(first.memberIds[0]!);
      break;
    case 'unknown':
      first.memberIds.push('ghost-node');
      break;
    case 'cycle':
      // Nesting itself is legal; a CYCLE through it is not. `first` gains a
      // parent that `first` already contains, closing the loop.
      out.push({ id: 'G-nest', memberIds: [first.id] });
      first.memberIds.push('G-nest');
      break;
    case 'self':
      first.memberIds.push(first.id);
      break;
  }
  return out;
}

function makePlan(seed: number, steps: number): Plan {
  const rng = mulberry32(seed);
  const out: Step[] = [];
  let defined: GroupSpec[] = [];
  for (let s = 0; s < steps; s++) {
    const roll = rng();
    if (roll < 0.4 || defined.length === 0) {
      if (rng() < 0.08) {
        out.push({ kind: 'groups', specs: null, valid: true });
        defined = [];
      } else {
        const specs = validGroups(rng);
        if (rng() < 0.15) {
          // Rejected pass: the previous configuration must stay live.
          out.push({ kind: 'groups', specs: corrupt(rng, specs), valid: false });
        } else {
          out.push({ kind: 'groups', specs, valid: true });
          defined = specs;
        }
      }
    } else if (roll < 0.65) {
      const target = defined[Math.floor(rng() * defined.length)]!;
      const collapsed = !(target.collapsed === true);
      out.push({ kind: 'collapse', groupId: target.id, collapsed });
      defined = defined.map((g) => (g.id === target.id ? { ...g, collapsed } : g));
    } else if (roll < 0.85) {
      out.push({
        kind: 'filter',
        bucket: rng() < 0.2 ? null : Math.floor(rng() * 4),
        mode: rng() < 0.5 ? 'hide' : 'dim',
      });
    } else {
      out.push({ kind: 'parallel', on: rng() < 0.5 });
    }
  }
  return { seed, steps: out };
}

// ---------------------------------------------------------------------------
// Scene lane — the product composition, with full RenderScene access.
// ---------------------------------------------------------------------------

/** Mirrors instance.ts `composeStage3Rewrite` + the tail of `reconcileScene`. */
function composeScene(
  model: AcceptedGraph<NA, EA>,
  groups: readonly ResolvedGroup[],
  parallel: boolean,
  reconciler: Reconciler,
): RenderScene {
  const base = rewriteGroups(model, buildRepForest(groups));
  const rewrite = parallel ? collapseParallelEdges(model, base) : base;
  const result = reconciler.reconcile(rewrite !== null ? rewrite.graph : model);
  return rewrite === null ? result.scene : { ...result.scene, groups: sceneGroupsOf(rewrite) };
}

const SCENE_KEY_PREFIX = '\u0000';

/** Every scene invariant this suite owns, evaluated after EVERY step. */
function assertSceneInvariants(scene: RenderScene, where: string): void {
  const groups = scene.groups;
  const physicalPoints = groups?.physicalPointCount ?? scene.count;
  const physicalLinks = groups?.physicalLinkCount ?? scene.linkCount;

  // (d) synthetics are a contiguous SUFFIX with an exact accounting.
  if (groups !== undefined) {
    expect(physicalPoints + groups.superNodes.length, `${where}: point suffix`).toBe(scene.count);
    expect(physicalLinks + groups.metaEdges.length, `${where}: link suffix`).toBe(scene.linkCount);
  } else {
    expect(physicalPoints, `${where}: no rewrite ⇒ all points physical`).toBe(scene.count);
    expect(physicalLinks, `${where}: no rewrite ⇒ all links physical`).toBe(scene.linkCount);
  }

  // (a) idByIndex / indexById are mutually inverse over the physical prefix,
  // and the map covers the whole scene exactly once (no aliasing).
  expect(scene.idByIndex.length, `${where}: idByIndex length`).toBe(scene.count);
  expect(scene.indexById.size, `${where}: indexById size`).toBe(scene.count);
  for (let i = 0; i < physicalPoints; i++) {
    const id = scene.idByIndex[i]!;
    expect(scene.indexById.get(id), `${where}: forward @${String(i)}`).toBe(i);
    expect(id.startsWith(SCENE_KEY_PREFIX), `${where}: physical id is public @${String(i)}`).toBe(
      false,
    );
  }
  for (const [id, index] of scene.indexById) {
    if (index >= physicalPoints) continue;
    expect(scene.idByIndex[index], `${where}: reverse @${String(index)}`).toBe(id);
  }
  // The synthetic suffix carries INTERNAL keys only — never a public id.
  for (let i = physicalPoints; i < scene.count; i++) {
    expect(scene.idByIndex[i]!.startsWith(SCENE_KEY_PREFIX), `${where}: suffix key`).toBe(true);
  }

  // (b) every link endpoint indexes a LIVE slot.
  expect(scene.links.length, `${where}: links length`).toBe(2 * scene.linkCount);
  expect(scene.edgeIdByIndex.length, `${where}: edgeIdByIndex length`).toBe(scene.linkCount);
  for (let k = 0; k < scene.links.length; k++) {
    const slot = scene.links[k]!;
    expect(slot, `${where}: endpoint ${String(k)} in range`).toBeLessThan(scene.count);
    expect(scene.idByIndex[slot], `${where}: endpoint ${String(k)} live`).toBeDefined();
  }

  // (c) no dangling meta-edge: the suffix link slot's endpoints resolve back
  // to the MetaEdge's declared public endpoints (group id or node id).
  if (groups !== undefined) {
    for (let j = 0; j < groups.metaEdges.length; j++) {
      const meta = groups.metaEdges[j]!;
      const slot = physicalLinks + j;
      const sourceRef = scenePointRefAt(scene, scene.links[2 * slot]!);
      const targetRef = scenePointRefAt(scene, scene.links[2 * slot + 1]!);
      expect(sourceRef, `${where}: meta ${meta.id} source ref`).not.toBeNull();
      expect(targetRef, `${where}: meta ${meta.id} target ref`).not.toBeNull();
      const sourceId = sourceRef!.kind === 'group' ? sourceRef!.group.id : sourceRef!.id;
      const targetId = targetRef!.kind === 'group' ? targetRef!.group.id : targetRef!.id;
      expect(sourceId, `${where}: meta ${meta.id} source`).toBe(meta.source);
      expect(targetId, `${where}: meta ${meta.id} target`).toBe(meta.target);
      expect(
        metaEdgePublicId(
          sourceRef!.kind === 'group' ? 'group' : 'node',
          sourceId,
          targetRef!.kind === 'group' ? 'group' : 'node',
          targetId,
        ),
        `${where}: meta ${meta.id} tuple id`,
      ).toBe(meta.id);
      expect(meta.count, `${where}: meta ${meta.id} badge`).toBeGreaterThan(0);
    }
    // Super-node slots resolve to their ResolvedGroup, in suffix order.
    for (let j = 0; j < groups.superNodes.length; j++) {
      const ref = scenePointRefAt(scene, physicalPoints + j);
      expect(ref, `${where}: super ref @${String(j)}`).not.toBeNull();
      expect(ref!.kind).toBe('group');
      expect(ref!.kind === 'group' ? ref!.group.id : null).toBe(groups.superNodes[j]!.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Instance lane.
// ---------------------------------------------------------------------------

interface Rig {
  instance: GraphInstance<NA, EA>;
  engine: FakeEngine;
}

async function rig(): Promise<Rig> {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance<NA, EA>({
    engine: () => {
      const e = new FakeEngine();
      engines.push(e);
      return e;
    },
    fitViewOnFirstData: false,
  });
  await instance.attach(container);
  instance.applyHostUpdate({ data: fixtureSnapshot(), nodeColor: 'red', linkColor: 'blue' });
  return { instance, engine: engines[0]! };
}

/** The scene geometry the engine currently holds in the testing state mirror. */
function lastStructure(engine: FakeEngine): NonNullable<EngineCommit['structure']> {
  const structure = engine.lastStructure;
  if (structure === undefined) throw new Error('no structure commit yet');
  return structure;
}

function duplicateDiagnostics(diags: readonly GraphDiagnostic[]): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const d of diags) {
    const key = `${d.code}\u0000${d.message}`;
    if (seen.has(key)) dupes.push(key);
    seen.add(key);
  }
  return dupes;
}

/** The drop lane, normalized for step-to-step comparison. */
function dropDiagnostics(
  diags: readonly GraphDiagnostic[],
): ReadonlyArray<{ code: string; count: number; message: string }> {
  return diags
    .filter((d) => DROP_CODES.includes(d.code))
    .map((d) => ({ code: d.code, count: d.count, message: d.message }));
}

// ---------------------------------------------------------------------------

const SEQUENCES = 1000;
const STEPS = 8;
const BASE_SEED = 0x5121_3000;

describe('property suite: group/collapse/filter/parallel sequences', () => {
  it(`keeps the id↔index bijection and meta-edge integrity across ${String(SEQUENCES)} randomized sequences`, async () => {
    const model = validateSnapshot<NA, EA>(fixtureSnapshot());
    // The drop verdict for this dataset revision, computed once by the
    // validator. Nothing in a group/filter/parallel sequence re-validates, so
    // this must be the store's drop lane at EVERY step of EVERY sequence.
    const expectedDrops = dropDiagnostics(model.diagnostics);
    expect(expectedDrops.map((d) => d.code).sort()).toEqual([...DROP_CODES].sort());
    let stepsRun = 0;
    let rewritesSeen = 0;
    let metaEdgesSeen = 0;
    let rejectedPasses = 0;

    for (let s = 0; s < SEQUENCES; s++) {
      const plan = makePlan(BASE_SEED + s, STEPS);
      const reconciler = new Reconciler();
      const { instance, engine } = await rig();
      let specs: readonly GroupSpec[] | null = null;
      let parallel = false;
      let lastPassRejected = false;

      try {
        for (let i = 0; i < plan.steps.length; i++) {
          const step = plan.steps[i]!;
          const where = `seed ${String(plan.seed)} step ${String(i)} (${step.kind})`;

          switch (step.kind) {
            case 'groups': {
              // D4 boundary: a violating array is rejected BEFORE any rewrite,
              // so the previously accepted configuration stays live.
              const rejected =
                step.specs !== null &&
                validateGroupSpecs(step.specs, model.nodeIndex).diagnostic !== null;
              expect(rejected, `${where}: generator/validator agreement`).toBe(!step.valid);
              if (!rejected) specs = step.specs;
              lastPassRejected = rejected;
              if (rejected) rejectedPasses++;
              instance.applyHostUpdate({ groups: step.specs });
              break;
            }
            case 'collapse': {
              const current: readonly GroupSpec[] = specs ?? [];
              specs = current.map((g) =>
                g.id === step.groupId ? { ...g, collapsed: step.collapsed } : g,
              );
              lastPassRejected = false;
              instance.applyHostUpdate({ groups: specs });
              break;
            }
            case 'filter': {
              instance.applyHostUpdate({
                filter:
                  step.bucket === null
                    ? null
                    : {
                        nodes: (n: GraphNode<NA>) => (n.attrs?.bucket ?? -1) !== step.bucket,
                        mode: step.mode,
                      },
              });
              break;
            }
            case 'parallel': {
              parallel = step.on;
              instance.applyHostUpdate({ parallelEdgeGrouping: step.on });
              break;
            }
          }

          const resolved =
            specs === null ? [] : resolveManualGroups(specs, model.nodeIndex);
          const scene = composeScene(model, resolved, parallel, reconciler);
          assertSceneInvariants(scene, where);
          stepsRun++;
          if (scene.groups !== undefined) {
            rewritesSeen++;
            metaEdgesSeen += scene.groups.metaEdges.length;
          }

          // --- instance lane agrees with the scene lane ---
          const physical = scene.groups?.physicalPointCount ?? scene.count;
          expect(instance.getSceneNodeIds(), `${where}: scene roster`).toEqual(
            scene.idByIndex.slice(0, physical),
          );
          const structure = lastStructure(engine);
          expect(structure.pointCount, `${where}: committed pointCount`).toBe(scene.count);
          expect(Array.from(structure.links), `${where}: committed links`).toEqual(
            Array.from(scene.links),
          );
          expect(
            instance.store.getState().groups.map((g) => `${g.id}:${String(g.collapsed)}`),
            `${where}: store.groups`,
          ).toEqual(resolved.map((g) => `${g.id}:${String(g.collapsed)}`));

          // (e) drops/diagnostics: exactly once per pass — the store never
          // accumulates a duplicate, and a rejected groups pass contributes
          // EXACTLY ONE config-error that a later accepted pass clears.
          const diags = instance.getDiagnostics();
          expect(duplicateDiagnostics(diags), `${where}: duplicate diagnostics`).toEqual([]);
          expect(dropDiagnostics(diags), `${where}: drop lane`).toEqual(expectedDrops);
          expect(
            diags.filter((d) => d.code === 'config-error').length,
            `${where}: config-error count`,
          ).toBe(lastPassRejected ? 1 : 0);
        }
      } finally {
        instance.destroy();
      }
    }

    // Coverage floor: the run genuinely exercised rewrites, meta-edges and
    // rejected passes — an all-pass-through run would satisfy the invariants
    // vacuously.
    expect(stepsRun).toBe(SEQUENCES * STEPS);
    expect(rewritesSeen).toBeGreaterThan(SEQUENCES);
    expect(metaEdgesSeen).toBeGreaterThan(SEQUENCES);
    expect(rejectedPasses).toBeGreaterThan(50);
  }, 120_000);

  it('runs the single implemented index policy: "stable" does not exist in v0.10', () => {
    // The acceptance bullet asks for both indexPolicy modes. `Reconciler`
    // takes no policy (reconciler.ts: "v0.1 implements the 'rebuild' index
    // policy only") and no source file mentions indexPolicy, so there is one
    // policy to run. This assertion fails the day a policy parameter lands,
    // forcing the suite above to be parameterized.
    expect(Reconciler.length).toBe(0);
    const probe = new Reconciler() as unknown as Record<string, unknown>;
    expect(Object.keys(probe)).not.toContain('policy');
    expect(Object.keys(probe)).not.toContain('freeList');
  });
});
