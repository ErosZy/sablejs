# Changelog

This file records user-visible changes. GitHub releases remain the source for
the exact commit list and downloadable artifacts.

## Unreleased

## 2.0.0-beta.7 — 2026-11-17

- Fixed `MIR stack height mismatch` when compiling `switch` statements whose
  `case` branches are folded by SCCP (such as `switch` inside `try`/`catch`,
  `try`/`finally`, or branch joins without `break`) (#46).
- Fixed `switch` code generation to skip emitting `$r.pop` when dead-code
  elimination elides an unused pure discriminant and its dispatch pop,
  preserving prior script completion values.
- Fixed `O2` code generation to keep GVN reuse temporaries materialized when a
  folded-literal `case` test would otherwise be elided by dense-switch
  lowering, or when `GETLOCAL` dispatches through the runtime helper in
  catch-free `try`/`finally` and dynamic-ancestor scopes.

## 2.0.0-beta.6 — 2026-09-03

- Changed the implicit optimization default from O2 to O1 while O2/Os remain
  experimental behind the CFG/SSA hardening release gate.
- Replaced DSE's fixed 256-iteration partial commit with a convergent reverse
  worklist and fail-closed diagnostic budget. Added completion-labelled semantic
  CFGs and independently verified GVN reuse; catch-free `try/finally` is
  supported while real catch/with/eval and unproved protected-scope passes keep
  conservative bailouts.
- Added full optimization-level/security regressions for the deep-CFG and
  `try`/`finally` wrong-code cases, a GVN kill switch, pipeline replay metadata,
  and a canonical operation table shared by frontend and IR.
- Added executable pass preservation/invalidation contracts, generation-checked
  MIR rebuilds, transactional annotation rollback, structured-region checks,
  independent LICM/dead-store proofs, and identity-level MIR verification.
- Made invalid optional DCE candidates fail closed: the compiler restores the
  last verified HIR/MIR/statistics and exposes `candidate-mir-invalid` through
  optimizer bailout metadata instead of emitting or continuing with the
  inconsistent candidate.
- Added retained literal/SCCP branch facts with independent MIR constant
  checking, plus an independent guest-origin analysis covering slots, Phi
  meets, and return-safe constructors; invalid provenance candidates retain the
  fully guarded sandbox write path. Guest-origin proofs are produced only after
  the final copy/CFG rewrites against freshly rebuilt MIR.
- Moved MIR lowering categories into the canonical exhaustive operation
  contract and verified the sole `NEXTITER`/conditional emission relation
  before MIR construction.
- Added source-reconstructed CFG verification and MIR edge-stack/HIR-mapping
  checks; optimizer bailout metadata now includes stable reasons plus scope and
  diagnostic codes when available.
- Added SCCP proof-ID rebinding after CFG-changing folds, AST-aware mismatch
  reduction, permanent optimizer corpus replay, metamorphic shape checks, and a
  boundary oracle for descriptors, key order, input mutations, and capability
  traces.
- Added attributable SCCP/copy/DCE/GVN/LICM/DSE kill switches, a hashed corpus
  manifest, benchmark-leakage CI, default dynamic-input workloads, cold/warm
  release protocols, native-oracle benchmark correctness checks, and replayable
  raw benchmark artifacts. The held-out O2 gate fails closed until 20 licensed
  programs are present.
- Fixed object and array literal initialization when their prototypes contain
  inherited non-writable data properties; the runtime now takes the same
  define-own-property fallback already used for inherited accessors.
- Reworked the public documentation around the v2 product positioning,
  migration path, execution-model comparison, and benchmark sampling.
- Removed hard-coded beta versions from installation documentation.

## 2.0.0-beta.5 — 2026-08-25

- Added deterministic inline and external Source Map v3 output, including
  statement mappings and virtual sources for static `eval` and `Function`
  bodies.
- Added TypeScript declarations for the compiler, runtime, capabilities,
  generated programs, and Worker helpers.
- Added verified Node, browser, Worker, Deno, Bun, precompile, caching, and
  error-handling examples.
- Restored complete ESM named exports for the root package and subpaths.
- Fixed O2/Os stack fallback behavior, multi-line dynamic-function source-map
  geometry, source-map metadata gating, and browser bundle map chaining.

## 2.0 beta series

- Replaced the v1 opcode interpreter and boxed-value VM API with AOT-generated
  CommonJS artifacts that use standard JavaScript values.
- Added default sandbox mode with copied data, protected intrinsics, explicit
  capabilities, and an optional trusted pass-through mode.
- Added `sablejs/worker` for per-run message validation, wall-clock timeouts,
  and Worker termination.
- Added O0, O1, O2, and Os optimization levels, inspection output, pinned
  Test262 conformance, differential fuzzing, and reproducible benchmark gates.

See [Migrating from sablejs v1 to v2](docs/migration-v2.md) for the breaking
API and artifact changes.
