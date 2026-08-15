# Engineering invariants & design rules

**Audience:** anyone writing or reviewing orbit code. This is the registry of
*cross-cutting properties* every change must preserve. Review new code against
all of it; when a change earns a new invariant, add it here with its pinning
test named.

## Terminology — what earns the word "invariant"

- An **invariant** is a falsifiable predicate over observable system state. A
  violation is a bug by definition — no judgment call involved — and every
  invariant must be *pinned*: enforced by a test (ideally a property test)
  that fails when the predicate breaks, not just documented.
- A **design rule** prescribes a *mechanism or API shape*. It guides authors
  and reviewers; a deviation is a design discussion (written up in the PR),
  not automatically a bug. Most design rules exist in service of an invariant.
- A **process policy** governs how we produce evidence and gate releases. It
  lives in CI, scripts, and docs — not in runtime state.

## 1. Invariants

| ID | Invariant | Pinned by |
|---|---|---|
| E1 | **Atomic host update.** One `applyHostUpdate` transaction produces **at most one** store publish (zero when nothing changed) and at most one engine commit. Later asynchronous resource refinements (e.g. image-atlas decode flushes) are separate commits outside the transaction, governed by E8 — never a second commit "from" the update. | Instance suites assert publish/commit counts; `perf-gate.test.ts` pins one buffers-only commit per brush step. |
| E2 | **Core module-scope purity.** `packages/core` imports no React, no engine, no `@cosmos.gl/graph`; zustand only via `zustand/vanilla`; **no module-scope** DOM or network access. Runtime browser APIs are reached only through injectable seams with guarded lookups (`imageAtlas.ts`: `fetchImpl ?? globalThis.fetch`), so Node imports and tests never touch them. | `scripts/check-boundaries.mjs` + ESLint restricted-imports/globals rules + the `fixtures/lint-violations` meta-tests. |
| E3 | **Mount exactly once per session.** Context-loss recovery recreates the engine's machinery and replays the scene; it never re-runs mount side effects. | `recovery.test.ts` (single-mount case). |
| E4 | **Ingest acceptance is replay-safe.** Replaying an already-accepted `(sequence, batchId)` is a no-op; a rejected append consumes zero budget and the session survives. | `ingestion.test.ts` / `ingestion-races.test.ts` (backpressure-conformance cases). |
| E5 | **Reconciler bijection.** The id↔index mapping is a bijection over the accepted roster at every publication; unchanged declared positions defer to live drift. | `reconciler.test.ts` randomized property soak. |
| E6 | **Adapter commit atomicity.** Within one engine commit, the cosmos adapter applies all channels before a single `render()` — no mixed frames ever reach the screen. | GPU probe record (atomic-commit) + `CosmosEngine` staging tests. |
| E7 | **History coalescing is a sliding window with anchor refresh.** Writes to the same coalesce key merge while consecutive writes stay within the window (500 ms for brushes); each merge re-anchors the window, so an uninterrupted drag is one entry regardless of total duration. Two corollaries are by design (see D6): a mid-gesture pause longer than the window splits the entry, and distinct gestures inside the window merge — there is no gesture identity. | `history.test.ts` ("each merge refreshes the window anchor"), `undo-redo.test.ts`. |
| E8 | **Roster-atomic resource mappings.** Every engine commit that carries a structural roster carries, in that same commit, index-addressed resource mappings of the correct length for that roster — resolved slots where known, placeholders otherwise. Later resources-only commits may promote placeholders but never change a mapping's length for the live roster and never reference a freed slot. | FakeEngine commit-shape assertions (structure + channel lengths sampled on every commit). |
| E9 | **Revision-stamped derived work.** No derived value computed against revision coordinate R (metric columns, search results, frozen domains, crossfilter columns) is admitted into or published over state whose *declared dependency coordinates* differ from R — unless explicitly rebased and the rebase is itself revision-checked. Stamps are captured at issue time by the producer; substituting the current revision for a missing stamp is a violation (it makes the gate self-satisfying). | Metric admission tests (`metrics.test.ts`, `styling-instance.test.ts` stale-column cases), search-flight interleaving tests, crossfilter rebuild tests. |
| E10 | **Mask composition preserves base styling.** Masking modulates alpha only: the base color of a masked or unmasked element equals what it would render with no mask configured, and clearing all masks restores the exact pre-mask render state — including under a theme change while masked. | Mask/theme matrix tests over committed color buffers (mask suites + `brush-fastpath-incremental.test.ts` end-state equivalence). |
| E11 | **Search results are query-coherent.** A published search slice always carries the query it answers; consumers treat results whose query differs from the current input as absent — never displayed as current, never activatable, never able to overwrite a newer publication. | Instance-level clear/edit-vs-resolve interleaving tests + `<GraphSearch>` stale-Enter component tests. |
| E12 | **No silent loss of admitted values.** For every non-empty source cell an adapter's documented mapping admits, the prepared output contains the value (possibly coerced), an explicit typed null, or a diagnostic naming what was dropped and why. Equivalent inputs through different lanes (rows / CSV / JSON / Arrow / Parquet) produce parity-equivalent snapshots and summaries. | `parity.test.ts` cross-lane equivalence + the data-package validation suites. |

## 2. Design rules

Deviations need a written justification in the PR, not a test failure.

| ID | Rule | Serves | Notes |
|---|---|---|---|
| D1 | **Publication metadata, not roster heuristics.** A model update must *say* whether it is a proven pure append or a replacement; consumers never infer it from equal ids, lengths, or prefixes. Equal ids do not imply equal rows. | E9 | |
| D2 | **Explicit clear transitions for runtime-mutable config.** Every runtime-mutable config lane accepts a `null`/empty reset distinct from omission; omission always means "no change", never "reset". React prop removal forwards the reset form. | — | Follow the `subgraph: … \| null` / `filter: … \| null` precedent for every new runtime lane. |
| D3 | **Validate before teardown.** Replacing a live subsystem (crossfilter engine, service, atlas) builds and validates the candidate first, swaps atomically, and disposes the predecessor last; a failed build leaves the predecessor fully functional. | E1 | |
| D4 | **Reject at the boundary.** Host-supplied options (playback, specs, scales) are validated with typed operation errors before any state mutation or timer scheduling. | E1 | |
| D5 | **Owned native resources have a named owner and a close path.** Any handle with an OS/GPU cost (`ImageBitmap`, contexts, workers) documents who closes it and when; churn tests assert close-exactly-once and a bounded live count. | — | |
| D6 | **Gesture identity over wall-clock heuristics.** Where interaction boundaries exist (pointerdown/up), plumb them; time-window coalescing is the fallback, not the model. Don't tune the window constant to paper over the model. | E7 | |
| D7 | **Construction-only options are read once and defended.** `engine`, `services`, `searchIndex`, `execution`, `history`, `limits` are read at construction; changing one requires a keyed remount or a replacement instance. A later change attempt is ignored with a one-shot warning diagnostic — never silently stashed as if it took effect. | E9 | Host implication: mode switches that change a construction option must key-remount `<Graph>`. |
| D8 | **The injector takes the namespaced key.** Any synthetic field an adapter writes into caller-owned data uses a key the source's own naming rules make unreachable — collision impossible *by construction*, not merely unlikely. | E12 | The Omnigraph kind discriminator is `attrs['orbit:type']`: a colon is illegal in `.pg` identifiers, so no schema property can ever claim it. Precedent: GraphQL `__typename`, JSON-LD `@type`. |
| D9 | **One rule per concept — and rename what collides with it.** When two mechanisms turn out to be the same operation with different parameters, generalize to the one that produces both; if the generalization leaves two API verbs reading as the same word, rename one. | E1 | Group collapse and node fold are one containment rewrite over a singly-parented representative forest; nesting then works with no special case. |
| D10 | **State a consumer must react to has to be published.** Instance-owned state that changes what a host should render must reach the store (or an event); a getter returning the new value is not enough — getters are pull, and a consumer that never learns to re-pull renders stale forever. | E1 | Earned by live verification, not tests: a fold badge read a getter through a ref and never updated, while 1,000+ unit tests stayed green. When adding instance state, ask: *what tells a subscriber this went stale?* |
| D11 | **What a host must configure is a PROP, not a CSS trick.** If hosts predictably need to change something about a packaged component, expose a typed prop with a documented default. Style overrides that merge rather than replace can land in the DOM and silently do nothing. | — | Earned by real integration: repositioning the toolbar required knowing its internal default inset. Ask of any new component: what will hosts want to change, and is there a prop for it? |

## 3. Process policies

| ID | Policy | Notes |
|---|---|---|
| P1 | **Performance claims require evaluated measurement.** Every recorded perf run carries the target, the measured value, the qualifying-profile decision, and an explicit pass/fail verdict. An over-budget qualifying run may be recorded only with a written callout. Silent numbers are banned. | The evaluator (`scripts/perf-gate.mjs`) stamps verdicts; its unit suite runs in every check. |
| P2 | **Correct tier or say so.** Measurement fixtures use the defined tier cardinalities (L = 100K nodes / 250K edges) or the artifact names the deviation prominently. Refusing to run beats silently under-tiering. | `perf-lite` refuses unreachable tiers and labels reduced fixtures with an explicit deviation field. |
| P3 | **Findings get verified before they get scheduled.** External review findings are confirmed against code, tests, and documented intent before entering a fix plan. Applies to our own docs as much as external reviews — verification passes have caught overstated findings *and* errors in this document's own ancestors. | Keeps priorities honest and stops us from "fixing" pinned, intentional behavior. |
| P4 | **Real-GPU measurement only.** Wall-clock performance numbers count only from a headful browser on real GPU hardware, n≥3 runs, variance-qualified. Software rasterizers (SwiftShader and kin) are never accepted; CI runs deterministic operation-count gates instead. | `perf-lite` disqualifies non-qualifying profiles and high-variance run sets in the artifact itself. |
| P5 | **Live verification before shipping a slice.** Unit suites prove code correct against its own model; only driving the real demo shows whether the state is *observable* and the feature usable. Every feature slice gets a live drive before its PR. | D10's origin story is the standing evidence: the suites were green while the UI rendered stale. |
