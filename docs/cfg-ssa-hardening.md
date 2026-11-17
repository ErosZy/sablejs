# CFG and SSA Hardening Plan

[← README](../README.md) · [Docs Index](README.md) · [Architecture](architecture.md) · [Roadmap](roadmap.md) · [Optimization History](optimization.md) · [Performance](performance.md)

> [!NOTE]
> **Looking to integrate sablejs into your app?** Start with the [README](../README.md) or [Docs Index](README.md). This document is an internal compiler engineering plan tracking verification gates before promoting `O2`/`Os` back to the default profile (`O1` is currently the default).

**Status (2026-09-03): active, release-blocking for O2/Os.** The repository now defaults
to `O1`. DSE's fixed-point bug is repaired. Completion-labelled semantic CFGs
and independent dominance/no-clobber verification now protect GVN; catch-free
`try/finally` uses that graph, while real catch/with/eval scopes still bail out.
LICM, DSE, and guest provenance retain their protected-scope gates. Structured
regions, LICM plans, and elided stores now have independent verification; MIR
analyses are generation-checked and rebuilt after mutating SSA passes, and a
failed pass rolls back its licensed mutation fields. Explicit `O2` and `Os`
remain non-production until the remaining campaign, held-out evidence, and
canary gates close. O1 is containment, not a proof that O1 is fully correct.

This document is an implementation plan. An unchecked item is proposed work,
not a claim that the repository already has the behavior.

## Implementation checkpoint — 2026-09-03

Implemented in the current change:

- implicit O1 across the compiler, public examples, types, conformance and
  benchmark defaults; O2/Os remain explicit experimental profiles;
- reverse-worklist DSE with atomic commit, an optional fail-closed visit budget,
  structured bailout statistics, and a 1–1,024-block dedicated test command;
- conservative protected-region gates for GVN, LICM, and guest provenance,
  plus independent GVN and DSE kill switches;
- the two P0 regressions across optimization/security matrices, generated
  nested completion cases, generated CFG reference-liveness tests, and
  optimizer annotation mutation tests;
- one canonical operation definition source shared by frontend and IR, with
  numeric code, operands, stack effect, effect/control class, and `mayThrow`;
- separate normal-lowering and semantic CFG builders; labelled normal,
  exceptional, and abrupt completion edges; semantic CFG inspection output;
- GVN availability on the semantic CFG whenever completion can re-enter the
  scope (and the smaller normal CFG when all throws exit), with
  real-catch/with/eval bailout, live-producer enforcement, and an
  independent semantic dominance/no-clobber verifier;
- cross-level differential runs, pipeline replay metadata, fail-on-incomplete
  SunSpider/Kraken handling, and QuickJS prepare/run lifecycle separation.
- executable pass preservation/invalidation contracts, generation-checked MIR
  publication, verified MIR rebuilds after SCCP/DSE/DCE, and transactional
  rollback of the optimizer's licensed HIR annotations;
- region-specific `controlRegions` contracts, an independent semantic
  dead-store check, an independent LICM loop/invariance check, and stronger MIR
  edge/Phi/definition/effect/use-list identity verification.
- retained literal/SCCP branch facts verified against current MIR constants,
  post-CFG proof-ID rebinding, and an independent guest-origin analysis for
  slot/Phi/constructor marks;
- AST-aware reduction, permanent corpus replay, six metamorphic shape families,
  and a boundary oracle covering exceptions, input mutations, descriptors, key
  order, collection size, and capability-call traces;
- a hashed tuning/held-out/adversarial corpus manifest, dynamic-input workload
  mode, per-workload optimization coverage/bailouts, benchmark-leakage scanning,
  cold/warm release protocols, correctness artifacts, and fail-closed O2
  held-out readiness checks.

Still release-blocking:

- feature-quota/nightly/release campaigns, at least 20 independently sourced
  held-out programs, complete suite raw artifact archiving, statistical
  thresholds, and the O2 canary gate.

Evidence commands for this checkpoint are `npm test`,
`npm run test:optimizer:deep-cfg`, `npm run test:optimizer:completion`,
`npm run test:optimizer:verify-mutations`, `npm run test:optimizer:corpus`,
`npm run test:optimizer:metamorphic`, `npm run test:differential`, and
`npm run test:differential:boundary`. Benchmark evidence checks are
`npm run check:benchmark-leakage`, `npm run benchmark:check`, and
`npm run benchmark:correctness`. The merge commit and CI artifact IDs must
be added by the release PR; local implementation alone does not close a release
gate.

Local evidence observed on 2026-09-03 after the verifier/lifecycle hardening:

- `npm test` pinned to CPU 0: 323/323 passed;
- `npm run check:types`: passed;
- `npm run test:optimizer:semantic-cfg`: 5/5 passed;
- `npm run test:optimizer:verify-mutations`: 10/10 passed;
- `npm run test:optimizer:corpus`: 5/5 saved shapes passed;
- `npm run test:optimizer:metamorphic`: 6/6 shape families passed;
- `npm run test:optimizer:deep-cfg`: 12/12 passed, including the 1–1,024
  boundary family;
- `npm run test:differential`: 2,000 cases, zero mismatches across all levels
  with rotating security modes;
- `npm run test:differential:boundary`: 300 cases, zero mismatches, zero exotic
  failures, and zero syntax failures, with observable-state and call-trace
  comparison;
- `npm run benchmark:correctness -- --workload=mini-parser`: 16/16
  level/security/input-mode cases passed and its raw artifact passed
  `benchmark:check`;
- `benchmark/release.js` O2 trusted warm artifact smoke: 3/3 samples, exact
  5/5 suite count, zero errors, manifest and artifact validation passed;
- `npm run test:e2e:build && npm run test:e2e:node`: 76/76 runtime probes.
- four targeted Test262 literal-initialization files pinned to CPU 0: 8/8
  strict/sloppy variants passed after adding inherited non-writable prototype
  coverage; the complete pinned suite remains a required CI gate.

The first post-verifier differential run rejected 47 O2 candidates rather than
emitting wrong output. It exposed two proof-lifecycle defects: later branch
folding can make an old reuse unreachable, and aggregate literal folding could
consume a still-required producer. Both are now fixed and pinned by focused
regressions; replaying all 47 saved seeds and the full 2,000-case command has
zero mismatches.

The first run after enforcing fresh MIR rebuilds rejected another 71 O2/Os DCE
candidates. Their post-DCE graphs had inconsistent stack heights that the old
pipeline hid by reusing pre-DCE MIR. DCE is optional, so its transaction now
restores the verified HIR, MIR generation, and statistics and records the stable
`candidate-mir-invalid` reason. Two minimized shapes are pinned in
`optimizer-regressions.test.js`; the final 300-case boundary rerun has zero
mismatches. This is a safe product fallback, not a claim that the underlying DCE
shape limitation has been optimized away.

The first run after retaining SCCP proof inputs exposed 37 O1/O2/Os candidate
compilations where an earlier branch fold changed a later proof input from a
Phi ID to its sole producer ID. The selected targets were semantically correct,
but the proof identity was stale and the verifier rejected them. SCCP now
re-lowers the annotated graph, rebinds proof IDs against current MIR, and
withdraws any candidate that no longer has an all-predecessor constant proof;
the later copy-branch phase repeats the refresh. All 111 saved failed
level/security arms and the full 2,000-case differential command now pass. The
minimal adjacent logical/conditional case is permanent corpus
`sccp-proof-rebind.js`.

The first four-shard directed CI run found seed 3960, where guest-object marks
were valid when produced but a later copy/CFG rewrite changed the final graph.
The independent verifier correctly rejected the stale security proof. Guest
provenance now runs after every mutating pass against freshly rebuilt final MIR;
the seed is permanent corpus `guest-proof-after-copy.js` and passes at all four
levels in trusted and sandbox modes.

## Decision this plan implements

The audit found no benchmark-name dispatch, fixed benchmark bytecode, or
hard-coded scope/offset table. The optimizer operates on symbolic operations,
blocks, values, and standard data-flow facts, and small Richards perturbations
retained both the optimization and approximately the same result. The right
classification is therefore **not a fixed benchmark payload or benchmark
cheat**.

That does not make the current optimizer product-grade. Two deterministic,
shape-sensitive miscompilations show that the implementation and its validation
are not yet general enough:

| P0 finding                                    | Reproduction boundary                                                                                              | Affected profiles               | Root cause                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| DSE uses an unconverged liveness result       | 128 chained dynamic conditionals are correct; 129 can return `undefined` instead of the live value                 | `O2`, `Os`; sandbox and trusted | `runDeadStoreElimination` stops after 256 iterations and still performs deletion                                              |
| GVN ignores completion flow through `finally` | `function f(){var x=1,y=x;try{x=2;throw 0;}finally{return x;}} f();` can return the stale value `1` instead of `2` | `O2`; sandbox and trusted       | `RETURN`/`THROW` have no CFG successor through active finalizers, so a reuse annotation is not dominated on the semantic path |

The DSE root cause is now fixed by the reverse worklist. The GVN root cause is
fixed for the supported private-local domain: availability is solved on the
semantic completion graph whenever an in-scope completion target exists, and
every emitted reuse is independently checked for
live-source dominance and no intervening clobber. Catch-free `try/finally` is
re-enabled; real catch and with/eval environments deliberately keep the safe
bailout because their dynamic binding semantics are not yet in that proof.

Relevant implementation points are
[`src/backend/mir-optimizations.js`](../src/backend/mir-optimizations.js),
[`src/ir/cfg.js`](../src/ir/cfg.js), and
[`src/codegen/index.js`](../src/codegen/index.js).

The published `2,202` V8 score is a measurement of the complete O2 pipeline on
the current harness, not evidence that CFG/SSA alone generalizes. O1 already
runs MIR/SSA SCCP, copy propagation, and DCE, yet the historical V8 scores are
`25.5` at O0, `26.3` at O1, and `2,202` at O2. Most of that discontinuity is in
O2-only lowering, frame, boundary, literal, and exact-call-shape
specializations. The current workload corpus was also used while tuning those
specializations and is not a held-out validation set.

The product decision is consequently:

- retain CFG/SSA and the useful O2 mechanisms;
- treat the present implementation as shape-fragile until the gates in this
  document pass;
- prefer correctness-preserving bailout to an optimization based on incomplete
  analysis;
- make no cross-program performance claim until it survives a frozen held-out
  corpus and a lifecycle-symmetric harness.

### Goals and non-goals

The goal is that optimizer output never depends semantically on block traversal
order, an arbitrary convergence cap, or an unrelated source/operation insertion;
frontend shape changes must either lower correctly or fail at a verifier. Every
cross-block transformation needs a reproducible kill switch and a checked proof
obligation, and any failed analysis must leave the original program intact.

This work does not ban shape specialization. A fast path with complete semantic
guards, a general fallback, and held-out evidence is a valid product
optimization. It also does not promise identical code or speed for equivalent
source spellings, or turn the current numeric frontend stream into a public ABI.
P0 correctness repairs do not need to recover a benchmark score before landing.

## Safety policy during the work

1. Change the implicit optimization default from `O2` to `O1` in the first
   containment release. Keep explicit `O2`/`Os` available for development and
   compatibility testing, with a documented warning.
2. Freeze new O2/Os performance transformations until both P0 regressions are
   green and their surrounding generated families are in CI.
3. Use native ES5.1 behavior as the external oracle. Use O0 as an unoptimized
   cross-level baseline, not as an independent semantic specification.
4. A timeout, iteration budget, missing fact, unknown operation, or verifier
   uncertainty must preserve the original program or fail compilation. It must
   never authorize a rewrite.
5. No benchmark gain can waive a semantic, security, suite-completeness, or
   verifier failure.

The intended dependency order is:

```text
P0 evidence + containment
          |
          +--> completion-aware CFG/GVN ----+
          |                                  |
          +--> convergent DSE ---------------+--> IR contracts/verifiers
                                                      |
                                                      v
                                       generated validation + held-out benchmarks
                                                      |
                                                      v
                                             staged O2 re-enable
```

## Milestone 0 — Preserve evidence and contain the failures

**Goal:** remove silent wrong-code exposure before attempting larger IR work.

### Changes

- [x] Add the two minimized programs as unit regressions before changing the
      optimizer. Assert the returned value, not merely successful compilation.
- [x] Run each regression at `O0`, `O1`, `O2`, and `Os`, under both `sandbox`
      and `trusted`. A level that does not contain the offending pass still acts as
      a cross-level control.
- [ ] Generate the DSE family at 1, 2, 127, 128, 129, 255, 256, 257, 512, and
      1,024 branches. Archive the minimized failing source plus `hir.txt`,
      `mir.txt`, generated code, optimization statistics, level, and security mode.
- [x] Add an internal GVN kill switch, parallel to the existing DSE diagnostic
      switch, so an A/B can attribute a failure to one pass without editing source.
- [x] Make DSE fail closed immediately: if a diagnostic iteration budget is
      exhausted, discard the slot analysis, retain every store for that slot, and
      increment a `bailedOutSlots` statistic. Deletion must only start after an
      explicit convergence check.
- [x] Make GVN skip any scope with an active dynamic/exception region until the
      semantic CFG work is complete. `lightweight` is not an exception-safety
      proof.
- [x] Inventory every consumer of MIR CFG facts. In particular, conservatively
      gate the security-sensitive guest-provenance pass in protected regions until
      its cross-block slot/phi reasoning is independently shown sound on missing
      exceptional edges. Record whether SCCP, LICM, DSE, GVN, reachability, and
      provenance ignore, kill facts on, or fully model each edge class.
- [x] Change the implicit compiler default to O1. Update API examples, type
      comments, migration notes, cache examples, benchmark defaults, and the
      changelog in the same PR so behavior is not silently different from the
      documentation.

### Exit gate

- Both minimized cases and the whole boundary family agree with native and O0
  in the full level × security matrix.
- DSE budget exhaustion is observable in statistics and never changes program
  output.
- An omitted `optimization` option resolves to O1 in API, build, Worker, and
  artifact-cache tests.
- The generated artifacts for the failing cases are retained as CI evidence.

This milestone is containment, not closure. It does not justify calling O2 or
Os production-ready.

### MIR/CFG consumer inventory at the containment checkpoint

| Consumer | Current edge model / containment | Remaining requirement |
| --- | --- | --- |
| CFG reachability | Explicit union of semantic reachability and normal-lowering scaffolding reachability; finalizers are retained by completion edges, while MIR exception-stack scaffolding remains until MIR is normalized | Remove the normal-scaffolding half only after MIR no longer consumes synthetic exception values |
| SCCP | Normal MIR edges; it only commits justified branch annotations, with finalizers retained by reachability | Validate branch facts on the semantic graph and make the edge policy explicit |
| Copy propagation / local CSE | Intra-block only; dynamic scopes are excluded where direct locals are unavailable | Add exhaustive annotation verification; no cross-block exceptional fact should be introduced |
| GVN | Semantic CFG for private lightweight locals when completion can re-enter the scope; normal CFG when all throws exit; catch-free `TryFinally` enabled; real catch and with/eval scopes skipped and counted; every reuse gets an independent dominance/no-clobber check | Model dynamic catch bindings before widening the supported domain |
| LICM | Natural loops on the normal graph; protected/dynamic scopes are skipped and counted | Semantic loop/dominance verification across throwing operations |
| DSE | Normal graph only in private static-local scopes; protected/dynamic scopes skip; convergent worklist results commit atomically | Independent liveness verifier on the semantic graph before broadening eligibility |
| SSA DCE | Removes only pure producers consumed by `POP`; it does not use reachability to erase effectful operations | Mutation proofs and an exhaustive effect-class contract |
| Guest provenance | Protected/dynamic scopes are skipped and counted; all unproved values retain the guarded sandbox path | Independent semantic phi/provenance proof before re-enable |

This table records each consumer's chosen contract. A safe “skip” remains a
valid product fallback; it does not imply that consumer has been migrated to
semantic facts.

## Milestone 1A — Make DSE convergence a correctness invariant

**Goal:** replace the fixed-iteration heuristic with a terminating monotone
data-flow implementation whose result is committed atomically.

### Changes

- [x] Replace the per-slot full-graph loop in `runDeadStoreElimination` with a
      reverse worklist, or a bitset liveness solver for all eligible slots. Seed
      work from exits and re-enqueue predecessors only when `liveIn` changes.
- [x] Put the worklist mechanics in a small shared `src/backend/dataflow.js`
      once DSE's behavior is pinned. Any later GVN/provenance use must supply its
      own lattice, meet, transfer, and bailout semantics; “shared solver” must not
      mean “shared unproved assumptions.”
- [x] Separate analysis from mutation. Compute a complete immutable liveness
      result first; only then mark stores `elided`. A bailout or exception before
      commit leaves HIR byte-for-byte unmodified by DSE.
- [x] Remove the correctness meaning of the `256` cap. A resource budget may
      remain as a diagnostic guard, but crossing it must take the safe bailout path.
- [x] Record `iterations`/worklist visits, eligible slots, eliminated stores,
      and bailouts in pass statistics. Add a test that forces a bailout and asserts
      zero eliminations for that analysis unit.
- [x] Recompute or invalidate MIR after a pass that changes control flow or
      value annotations. Do not reuse an analysis object merely because instruction
      offsets stayed stable.

### Required tests

- Long acyclic chains on both sides of the old threshold.
- Diamonds, joins, backedges, irreducible-looking structured graphs, nested
  loops, switches, and multiple exits.
- A read reachable on only one distant successor; alternating writes and reads;
  multiple eligible slots with different live ranges.
- Random CFG families with a simple reference liveness solver in the test, plus
  source-level comparison against native behavior.
- Compile-time scaling tracked separately from correctness. A slow case may
  bail out; it may not miscompile.

### Exit gate

- No transformation can observe a partial fixed point.
- The generated 1–1,024 branch family and randomized CFG corpus have zero
  cross-level/native mismatches.
- A debug assertion independently recomputes liveness for every elided store on
  the regression corpus.

## Milestone 1B — Model exceptional and abrupt completion in the CFG

**Goal:** make dominance and availability describe JavaScript execution, not
only normal fallthrough and jumps.

### Changes

- [x] Define edge semantics before coding. At minimum distinguish `normal`,
      `exceptional`, and `abrupt` completion. A `return`, `throw`, `break`, or
      `continue` inside an active `finally` region reaches the finalizer before its
      ultimate destination; a finalizer may replace the pending completion.
- [x] Extend `buildCFG` to derive those edges from verified `controlRegions` and
      `syntheticRanges`. Do not approximate this by adding an edge from every block
      to every handler: edge construction must match the structured lowering and
      codegen continuation rules.
- [x] Make every CFG consumer declare which edge classes it uses. Reachability,
      dominators, GVN, DSE, SCCP, loop discovery, LICM, and unreachable-code removal
      need an explicit decision; a consumer must not accidentally receive a
      normal-only graph.
- [x] Keep GVN disabled in protected regions until its meet and kill rules have
      been validated on the completion-aware graph. Then require the reused load to
      dominate the use on all semantic paths and require no intervening write on
      any such path.
- [x] Treat potentially throwing operations inside a protected region as
      exceptional-flow producers when a handler/finalizer can observe state.
- [x] Add a CFG printer mode that labels edge kind and pending completion. This
      makes a future failure inspectable instead of relying on generated-code
      archaeology.

### Required tests

Cover nesting depths 1–8 and all meaningful combinations of:

- normal fallthrough, explicit `throw`, and a throwing call/property/coercion;
- `return`, `break`, and `continue` entering a finalizer;
- finalizer fallthrough versus finalizer `return`/`throw` overriding the pending
  completion;
- `try/catch`, `try/finally`, nested `try/catch/finally`, loops, labels, and
  switches;
- a local write before each completion and a read in the handler, finalizer,
  continuation, and outer scope.

Every case runs through all levels and both security modes. Tests should assert
the completion value or exception name and observable mutations.

### Exit gate

- The original GVN reproducer and generated completion matrix match native.
- For every `reuse` annotation, an independent verifier proves source
  dominance and absence of a clobber on the completion-aware CFG.
- CFG reachability never removes a finalizer that can run, including one reached
  only by an abrupt or exceptional completion.

Milestones 1A and 1B can be implemented in parallel after Milestone 0, but both
must land before the later optimizer validation gate.

Implementation evidence for Milestone 1B is
`npm run test:optimizer:semantic-cfg`,
`npm run test:optimizer:verify-mutations`,
`npm run test:optimizer:completion`, and the full level × security regression
matrix in `test/unit/optimizer-regressions.test.js`. Generated-loop code also
pins that any reuse producer which is emitted remains live through peepholes.
This closes the GVN completion-flow defect; it does not close the later O2
release gates.

## Milestone 2 — Turn IR conventions into checked contracts

**Goal:** make an opcode addition or shape change either work everywhere or fail
loudly during compilation/tests.

### Opcode and lowering contract

- [x] Introduce one neutral canonical operation-definition source (proposed:
      `src/operation-spec.js`) from which
      the frontend numeric opcode map and IR `OpSpec` are derived. It must include
      name, stable numeric code if still required, operands, stack effect, effect
      class, `mayThrow`, and control-flow class.
- [x] Until that migration lands, add a cross-table unit test that compares all
      90 current entries by numeric code and name. The existing self-consistency
      test for `OpSpec` alone is insufficient.
- [x] Replace handwritten MIR operation sets where the canonical effect/stack
      metadata can express the rule. For genuinely MIR-specific handling, require
      an exhaustive per-op classification test with an explicit unsupported case.
- [x] Replace adjacency assumptions such as `NEXTITER` followed by
      `JTRUE`/`JFALSE` with an explicit lowering relation, or verify the adjacency
      and operands before MIR construction and fail with a scoped diagnostic.
- [x] Strengthen `controlRegions` verification: legal nesting, region-specific
      required fields, matching boundaries, and valid abrupt-finally ranges.
- [x] Add an explicit frontend-to-HIR normalization boundary if more than one
      implicit emission pair remains. For example, normalize `NEXTITER` plus its
      conditional jump into one semantic two-exit form before MIR construction;
      MIR must not infer control flow by peeking at an unrelated next instruction.

  The adjacency audit found only the `NEXTITER`/conditional relation; it is now
  region-verified before MIR construction, and every operation carries an
  exhaustive canonical `mir` classification. No second implicit emission pair
  exists, so adding a pass-through normalization layer would not create a new
  contract boundary.
- [x] Document the numeric stream as an intra-compile internal format. If any
      cache or tool persists it across phases/versions, attach a schema version/hash
      and reject a mismatch instead of decoding it with the current table.

### Optimized-HIR verification

- [x] Extend verification beyond offsets and operand counts. After every pass,
      independently check the necessary proof obligations of annotations consumed
      by codegen:

  - [x] `reuse`: live source, correct slot/value, semantic dominance, no clobber;
  - [x] `licm`: the synthesized loop-header load dominates each use, the source
    plan is coherent, and the slot is invariant on every natural-loop block;
  - [x] `optimizedBranchTarget`: the annotation retains either the adjacent
    literal fact or SCCP SSA value IDs/values; verification independently
    recomputes current MIR constants and proves the selected real successor;
  - [x] `elided` store: dead at that point under the current semantic CFG;
  - [x] `guestObjectOutput`: an independent analysis traces literal/closure
    allocations through slots and Phi AND-meets, and checks return-safe guest
    constructors before accepting marked `NEW` outputs. A failed optional
    provenance candidate rolls back to the guarded sandbox path.

- [x] Give each analysis a generation number. The pass manager invalidates CFG,
      MIR, dominators, loops, and value facts according to a pass contract; a stale
      generation cannot be consumed.
- [x] Make pass mutation transactional. A pass either produces an edit set (or
      a fresh candidate IR), verifies it, and commits it, or discards it completely.
      A failed optional pass may rebuild from original verified HIR at O1; it must
      never continue from a partially mutated candidate. A core HIR/CFG/MIR
      structural-verifier failure aborts compilation rather than generating code.
- [x] Strengthen CFG/MIR verification alongside the annotation checks. CFG
      verification independently reconstructs the expected semantic edges;
      `verifyMIR` checks one phi input per predecessor, the identities behind use
      lists (not only counts), operation effect/arity, HIR-to-MIR offset mapping,
      and edge-specific stack signatures.

  MIR checks reciprocal unique edges, exactly one Phi input per predecessor,
  Phi/output definition identity, canonical operation arity/effect, exact
  HIR-operation mapping, exact use-list identities, and per-edge stack
  signatures. Core CFG verification reconstructs the expected normal/semantic
  edges from source HIR and rejects a graph that is merely internally
  self-consistent.
- [x] Make codegen reject an invalid or missing optimization source instead of
      silently changing how a proof annotation is interpreted. Verification runs
      before code generation in production builds as well as tests.
- [x] Add verifier mutation tests: corrupt one source offset, edge, region,
      opcode mapping, stack effect, and provenance mark and assert a deterministic
      compiler error.
- [x] Record `optimizerPipelineVersion`, the actual pass list, analysis
      generations, bailout scopes, and stable reason codes in compile metadata so a
      failure can be replayed without guessing which candidate pipeline ran.

### Exit gate

- Adding, removing, or reordering an operation fails one focused exhaustive
  test until every decoder/lowering consumer is updated.
- Every pass declares the analyses it preserves and invalidates.
- The optimized annotation mutation suite fails closed, while all valid
  O0/O1/O2/Os outputs still compile.

## Milestone 3 — Validate across programs and nearby shapes

**Goal:** catch the class of failure, not just the two strings that exposed it.

### Differential and metamorphic testing

- [x] Change both differential fuzzers from a hard-coded O2 run to a rotating
      level × security matrix. For each generated source, compare native behavior
      and compare the four sablejs levels with one another.
- [x] Compare more than the completion value: exception class, selected global
      mutations, own-property descriptors, key order where specified, and
      capability call traces.
- [ ] Add dedicated generators for deep CFGs and protected-region completions.
      Save seed, generator version, options, minimized source, IR dumps, and
      generated code for every mismatch.
- [x] Replace the semicolon-oriented minimizer for these failures with an
      AST-aware reducer that preserves structured control flow. Commit minimized
      historical cases under `test/differential/corpus/`; `.cache` remains only the
      inbox for newly found cases.
- [x] Add semantics-preserving metamorphic rewrites around optimized sites:
      dot versus bracket access, harmless temporary/alias introduction, no-op
      branches, independent declaration reorder, equivalent loop spelling, and
      literal versus runtime-provided input.
- [ ] Treat shape coverage and correctness separately. It is acceptable for a
      conservative optimization not to fire after a rewrite; it is never acceptable
      for the output to change. Performance claims may cover only shapes whose
      measured coverage is reported.

### CI tiers

| Tier    | Required work                                                                                                                                   | Failure policy                                                      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Per PR  | unit matrix, minimized P0 cases, generated boundary families, at least 5,000 directed cases over four shards, verifier mutations                | blocking; zero mismatches and zero timeouts                         |
| Nightly | 100,000 general + 100,000 CFG/SSA-directed cases, at least 20,000 metamorphic pairs, deeper CFG/finally families, saved corpus replay           | blocking for O2 release branch; preserve and minimize every failure |
| Release | pinned Test262 at O0/O1/O2/Os in trusted mode, full security battery at every level, boundary differential in both modes, all saved regressions | zero unexpected differences; no skip-count drift                    |

The directed PR run uses feature quotas rather than hoping random generation
reaches the relevant shapes: at least 500 `TryFinally`, 500 abrupt-finally, 500
loop/phi cases, 100 scopes above 257 blocks, and 100 actual hits each for SCCP,
GVN, and DSE. Bad-IR/annotation injection cases must be rejected 100% of the
time.

The existing commands remain part of the gate:

```sh
npm test
npm run test:differential
npm run test:differential:boundary
npm run upstream:fetch -- test262
npm run test262
```

The dedicated local/CI commands are
`test:optimizer:deep-cfg`, `test:optimizer:completion`,
`test:optimizer:semantic-cfg`, `test:optimizer:corpus`,
`test:optimizer:metamorphic`, and `test:optimizer:verify-mutations`. The PR
workflow also runs 5,000 general cases over four independent shards. Feature
quota accounting and the nightly/release tiers remain open.

### Exit gate

- All three CI tiers meet the matrix above.
- Every optimizer mismatch becomes a minimized permanent regression before its
  fix is merged.
- A one-token or one-basic-block perturbation of an optimized program either
  remains correct or causes the optimization to bail out; it never creates
  stale bytecode/offset-dependent behavior.

## Milestone 4 — Rebuild the performance evidence

**Goal:** separate a general compiler improvement from corpus memorization,
fixed-input partial evaluation, and unequal lifecycle accounting.

### Corpus discipline

- [ ] Split benchmarks into a visible tuning corpus, a frozen held-out release
      corpus, and adversarial shape families. Record the manifest hash before an
      optimization is designed; do not tune on held-out per-test results.
- [ ] Expand the held-out set with independently sourced ES5.1 programs and
      application-like programs that use different object, call, control-flow, and
      data shapes from the current eight workloads. Start with at least 20 programs
      with recorded, compatible licenses.
- [x] Make runtime-provided, varying input the primary workload mode. Keep
      source-embedded deterministic JSON as a separately named static-input mode;
      do not combine its partial-evaluation gains with general runtime throughput.
- [x] Report fast-path coverage and bailout counts by workload. A whitelist hit
      on `push`, `join`, `slice`, or another exact member-call shape must not be
      described as a CFG/SSA gain.
- [x] Add a repository check that production compiler/runtime files cannot
      import benchmark fixtures, and scan optimization predicates for benchmark
      names, fixture hashes, and fixed offsets. This is a guard against future
      leakage, not a claim that the current audit found such dispatch.

### Harness symmetry and failure handling

- [x] Publish separate cold and warm protocols. Cold includes parse/compile,
      instantiate/load, and one run for every backend. Warm prepares each backend
      once and times only equivalent repeated calls.
- [x] Stop re-evaluating the full source inside every QuickJS timed iteration
      when the sablejs/native arms compile or load outside the timer. Until this is
      fixed and the tables are rerun, label existing QuickJS ratios as
      lifecycle-asymmetric historical results.
- [x] Make any parse, compile, runtime, result-verification, or timeout failure
      fail the benchmark command with a non-zero exit. `SKIP` cannot silently reduce
      a SunSpider/Kraken total; assert the exact expected suite count.
- [x] Time Kraken data preparation consistently with the documented protocol.
      Data concatenated into the evaluated program is not “untimed” unless every
      backend performs the equivalent work outside its measured region.
- [ ] Archive raw JSON containing commit, dirty state, Node/QuickJS versions,
      CPU, OS, affinity, compiler options, corpus manifest, samples, warmups,
      results, errors, and suite counts.

### Attribution and statistical gate

- [ ] Measure O0→O1 as the conservative CFG/SSA bundle, then run pass-level
      kill-switch A/Bs for SCCP, copy propagation, DCE, GVN, LICM, and DSE. Measure
      O2 codegen/runtime specializations in separate rows.
- [ ] Use 10–20 measured samples after a declared warmup, pinned to one core.
      Report median and MAD. If noise can explain a delta, report it as flat.
- [ ] Predeclare the release thresholds. Initial defaults are: no held-out
      geomean regression greater than 5%, no individual held-out regression greater
      than 10% without a reviewed explanation, exact result agreement, and exact
      suite count. Rebaseline only in a dedicated evidence PR.
- [ ] Restoring O2 as the default additionally requires a useful held-out
      dynamic-input benefit: initially at least 1.10× O2/O1 execution geomean and
      no regression on at least 70% of held-out programs. Change these thresholds
      only before looking at a candidate's held-out per-test results.
- [x] Add a benchmark correctness smoke that checks the suite's internal success
      flag and result before accepting a score. A score or artifact-size ceiling
      alone is not a release gate.

The implemented commands are `benchmark:correctness`, `benchmark:heldout`, and
`benchmark:check`. `benchmark:correctness` emits replayable JSON and is archived
by the release workflow. `benchmark:heldout` deliberately exits non-zero while
the manifest has fewer than 20 licensed held-out programs; an empty corpus can
never pass. `benchmark:release -- --protocol=warm|cold --output=...` records
raw rounds, environment, exact compiler metadata, manifest hash, errors, and
suite count. Extending the same raw contract to every external suite and
enforcing the declared statistical thresholds remain open.

### Exit gate

- Results are reproducible from an archived manifest and raw artifact.
- Tuning and held-out results are reported separately, with static-input and
  dynamic-input results separated.
- Every backend uses the same declared lifecycle per table and runs the exact
  expected program count.
- Any claim attributed to CFG/SSA is supported by pass-level A/Bs and at least
  one frozen held-out corpus, not only the V8/Octane shapes used during design.

## Milestone 5 — Stage O2 back into the product

**Goal:** restore a fast default only after correctness and evidence are both
repeatable.

### Rollout

1. Ship Milestone 0 with O1 as the implicit default. Mark explicit O2/Os as
   experimental in release notes and invalidate precompiled-artifact caches by
   compiler version and complete option set.
2. Land Milestones 1A/1B behind the existing explicit levels. Keep conservative
   GVN/DSE bailouts and per-pass diagnostic switches.
3. Land Milestones 2–4 and keep O2 opt-in through a canary period: at least one
   million directed differential cases across at least 16 independent seeds,
   14 consecutive green nightlies, and no open P0/P1 correctness issue. The
   release artifact must contain the exact correctness and benchmark evidence.
4. Run at least two release candidates after the canary gate. Restore O2 as the
   default only when every exit criterion below is checked. Os is approved
   separately because it has a different pass/codegen mix.
5. Retain a one-line default rollback and individual GVN/DSE kill switches for
   at least one release after re-enabling O2. A rollback preserves semantics and
   may sacrifice only performance/size.

### O2 production-readiness exit criteria

- [x] Both P0 root causes are fixed, not merely matched by special-case source
      detection.
- [ ] Known cases, generated families, saved corpus, Test262, security tests,
      and differential tiers pass in their declared matrices.
- [x] Completion-aware CFG facts and optimized annotations pass the independent
      verifier after every relevant pass.
- [x] Opcode/OpSpec drift is impossible by construction or blocked by an
      exhaustive synchronization gate.
- [ ] Benchmark commands fail on errors/skips, use symmetric lifecycles, and
      archive exact suite counts and raw results.
- [ ] Held-out dynamic-input evidence shows a repeatable product benefit; public
      copy separates CFG/SSA results from O2 codegen/runtime specializations.
- [x] The rollback path, cache invalidation, and default-level documentation are
      tested.

No single Test262 run, benchmark score, fuzz campaign, or code review can check
this box on its own.

## Proposed implementation slices

| PR  | Scope                                                                                                      | Primary files                                                                                                                                                                                                   | Depends on               |
| --- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 1   | P0 regressions, safe DSE bailout, conservative GVN gate/kill switch, default O1, release note              | `test/unit/optimizer-regressions.test.js`, `src/backend/mir-optimizations.js`, `src/backend/optimizer.js`, API/docs/examples                                                                                    | none                     |
| 2   | Worklist DSE and proof-oriented tests/statistics                                                           | `src/backend/dataflow.js`, `src/backend/mir-optimizations.js`, optimizer tests                                                                                                                                  | PR 1                     |
| 3   | Completion-aware CFG and GVN re-enable                                                                     | `src/ir/cfg.js`, `src/ir/mir.js`, `src/backend/mir-optimizations.js`, CFG/optimizer tests                                                                                                                       | PR 1; parallel with PR 2 |
| 4   | Canonical op definitions, normalization, analysis invalidation, semantic verifier                          | `src/operation-spec.js`, `src/frontend/opcode.js`, `src/ir/op-spec.js`, `src/ir/normalize.js`, `src/ir/verify.js`, `src/backend/pass-manager.js`, `src/backend/verify-optimizations.js`, `src/codegen/index.js` | PRs 2–3                  |
| 5   | Cross-level fuzzing, CFG/finally generators, AST minimizer, replay corpus, metamorphic and mutation suites | `test/differential/`, `test/unit/ir-verifier.test.js`, `test/unit/opcode-contract.test.js`, `package.json`, CI workflow                                                                                         | PRs 2–4                  |
| 6   | Held-out corpus, symmetric harnesses, fail-on-skip, raw artifact/report generation                         | `benchmark/`, `tools/`, CI workflow, performance docs                                                                                                                                                           | PR 5                     |
| 7   | O2 release candidate and staged default restoration                                                        | compiler defaults, cache/version metadata, changelog and user docs                                                                                                                                              | all gates green          |

Prefer these reviewable slices over a single optimizer rewrite. Each PR must
arrive with its own failing-before/passing-after evidence and must leave the
safe bailout available.

## Documentation changes tied to implementation

- [`roadmap.md`](roadmap.md) is the live status entry point. Update markers only
  when an exit gate has evidence.
- [`optimization.md`](optimization.md) remains a historical record. Add dated
  corrections rather than rewriting old measurements as if they had never
  happened.
- [`performance.md`](performance.md) must label old O2 tables historical until
  the symmetric held-out rerun replaces them.
- [`architecture.md`](architecture.md) should describe checked IR contracts and
  edge classes only after they land. Avoid hard-coding an operation count in
  prose.
- When the default changes, update README examples, migration and Worker docs,
  type declarations, examples, benchmark defaults, and changelog in the same
  change. When O2 is restored, repeat that synchronization and link the release
  evidence.

The evidence for every completed checkbox should name the commit, command,
corpus manifest, raw artifact, and observed result. “Pass implemented” or
“benchmark improved” is not sufficient closure evidence.
