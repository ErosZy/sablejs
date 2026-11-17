# Roadmap

[← README](../README.md) · [Docs Index](README.md) · [Security](security.md) · [Performance](performance.md) · [CFG/SSA Hardening](cfg-ssa-hardening.md)

Status legend: **✅ Done** · **◐ Partial** · **⬜ Not started** · **⛔ Release blocker**
Priority order: **security correctness > semantic correctness > real-world evidence > DX > performance > benchmark scores**.

*Last updated: 2026-11-17 (historical snapshot markers preserve original 2026-09 dates).*

---

## Top priorities

1. ⛔ **CFG/SSA correctness hardening** — Convergent DSE, completion-aware CFG, MIR/HIR contract verification, and GVN reuse proofs have landed; held-out programs, large-scale fuzz campaigns, and canary gates remain open before re-promoting `O2`/`Os` to default ([hardening plan](cfg-ssa-hardening.md)).
2. ◐ **Facet & differential fuzzing** — Semantics, boundary-contract, and Acorn syntax fuzzers run in CI; expanded parser/serializer coverage and nightly 100k–1M campaigns remain.
3. ⬜ **Benchmark methodology & reporting** — Complete symmetric held-out reruns, peak memory reporting, and automated archive report generation.
4. ⬜ **Fuel-budget prototype** — Prototype and measure the compile-time loop/call budget design ([fuel-budget.md](fuel-budget.md)).

---

## Completed 2026-08 foundations

1. ✅ Threat model & explicit feature policies ([Security](security.md)) + permanent adversarial audit fixes.
2. ✅ Giant-literal scalability fixes (`SCCP`, frontend dedup, O2 const chunking, constant array folding) restoring Kraken 14/14.
3. ✅ Multi-engine differential fuzzer (`test/differential/fuzz.js` with failure minimization) and boundary facet fuzzer (`test/differential/fuzz-boundary.js`).
4. ✅ Boundary profiling counters (`createInstance({ profileBoundary: true })` / `--profile-boundary`) & tax tracking.
5. ✅ Real-world workloads (`benchmark/workloads/`) with cross-backend correctness oracle.
6. ✅ Official `sablejs/worker` helper (`createSandboxClient` / `handleSandboxMessages`) & [Worker Isolation](worker-isolation.md).
7. ✅ Concise README positioning, ES5.1 core strategy, v1→v2 migration guide, compatibility contract, and execution-model comparison.
8. ✅ Opt-in Source Map v3 across all optimization levels including virtual `#eval-N` / `#dynamic-N` sources ([Source Maps](source-maps.md)).
9. ✅ Full TypeScript declarations (`types/`) with `check:types` CI gate, 10 runnable `examples/` (`check:examples`), and hardened OIDC npm release pipeline.

---

## Status by workstream

### P0 — Optimizer correctness
- ✅ Convergent reverse-worklist DSE with atomic commit, diagnostic visit budgets, and 1–1,024-block tests.
- ◐ Completion-aware semantic CFG (`normal`/`exceptional`/`abrupt` edges) protecting GVN and catch-free `try/finally`; `switch`-inside-`try` `JCASE`/GVN/stack-height interactions fixed in `v2.0.0-beta.7`; real `catch`/`with`/`eval` scopes retain safe bailouts.
- ✅ `O1` set as default across compiler, examples, types, benchmarks, and docs; `O2`/`Os` remain experimental until all gates in [CFG/SSA Hardening](cfg-ssa-hardening.md) close.

### P0 — Security & resource control
- ✅ Private `WeakMap` wrapper resolution (no guest-observable symbols), single-pass trap-free `writeTarget`, iterative `cloneValue` (100k depth), `Map`/`Set`/typed-array/`Buffer` → `Uint8Array` isolation, and zero-skipped adversarial suite in `test/unit/security.test.js`.
- ✅ Worker timeout helper (`sablejs/worker`), payload budget patterns, and async capability `Promise.race` guidance ([Worker Isolation](worker-isolation.md)).
- ◐ Optional compile-time `FUELCHECK` loop/call instrumentation designed ([fuel-budget.md](fuel-budget.md)); prototype pending.

### P1 — Semantics, fuzzing & benchmarks
- ◐ Pinned ES5.1 Test262 (`es5id` corpus) archives reports on release (`npm run test262:archive`), and differential/corpus/metamorphic/verifier-mutation checks run in CI; multi-level Test262 parity and nightly 1M campaigns remain.
- ◐ Symmetric cold/warm `benchmark:release` protocol and leakage checks landed; populated 20+ held-out corpus and peak-memory reporting remain.
- ✅ Backend optimization batch (2026-08-23/24): items 1–18 shipped cleanly under [Optimization History](optimization.md) (item 16 rolled back; item 19 closed tuning).

### P2 — Size, architecture & docs
- ✅ Deterministic `benchmark/size.js --check` CI budgets across all level × security combinations; ⬜ safe factory sharing remains open post-hardening.
- ✅ One-way layered architecture (`frontend -> ir -> backend -> compiler -> runtime`), `LOC`/Source Map v3 support, IR dumps (`dumpDir`/`dumpIR`), TypeScript declarations, and streamlined user documentation.

---

## Recent fixes

- **2026-11-17 (v2.0.0-beta.8) — Built-in ES2015+ → ES5.1 transform (`options.transform` / `transformToES5`) & sandbox boundary mediation fixes:**
  - Added a zero-dependency Acorn ESTree → ES5.1 lowering pass ([`src/frontend/transform.js`](../src/frontend/transform.js)) enabled by default via `transform: "auto"` (zero-overhead ES5.1 fast path when valid ES5.1, custom `(src, ctx) => ...` hook with `chainSourceMap` support, and `dumpDir/transformed.es5.js`).
  - Seeded built-in iterator prototypes (`Array`, `String`, `Set`, `Map`, typed arrays, `matchAll`) in `standardIntrinsicRoots()` so `for..of` / iterator `.next()` work cleanly at `O2`/`Os` in `sandbox` mode while protecting `%IteratorPrototype%` against guest mutation, and forwarded `new.target` through `sableIntrinsicBoundary` / `constructHost` so `class Sub extends Error` preserves guest `CustomError.prototype` in `sandbox` mode.
- **2026-11-17 (v2.0.0-beta.7) — `switch` inside `try` MIR stack-height & `O2` GVN fixes (Issue #46):**
  - Updated `isTakenBranchEdge` in `src/ir/mir.js` so taken optimized `JCASE` and `NEXTITER` branch edges do not double-count fallthrough targets and trigger false MIR stack-height mismatches inside `try` blocks.
  - Updated `src/codegen/index.js` to guard `Switch` `dispatchPop` elision, reset `context.runtimeStack`, fall back cleanly when local GVN producers have `localKind === null`, and skip `denseSwitch` constant-case folding when `globalValueProducerOffsets` requires the live instruction.
  - Added regression, IR verifier, corpus replay, and fuzzer (`GENERATOR_VERSION = 3`) coverage.
- **2026-09-01/03 — CFG/SSA containment & verification hardening:**
  - Replaced 256-iteration partial DSE with convergent reverse worklist + atomic rollback; added completion-aware semantic CFG + independent reuse/LICM/DSE/provenance verifiers; refreshed provenance after mutating passes; switched default optimization to `O1`.
- **2026-08-22 — Boundary audit & scalability fixes:**
  - Tagged boundary errors via private `WeakSet` (preserving `RangeError` under stack exhaustion), fixed Proxy-wrapped branded container rejection errors, fixed sloppy `arguments.callee`/`caller` inside `"use strict"` esbuild bundles (`dist/runtime.js`), replaced `HOST_TARGET` symbol with private `WeakMap`, made `cloneValue` iterative, fixed `$v1_30` cross-region inline guard visibility, fixed giant-literal superlinearity (Kraken 14/14), and added shared intrinsic graph + pure-intrinsic call fast path.
