# Architecture

[← README](../README.md) · [Docs Index](README.md) · [Examples](../examples/README.md) · [Security](security.md) · [Performance](performance.md) · [CFG/SSA Hardening](cfg-ssa-hardening.md)

**sablejs** compiles ES5.1 source ahead of time into plain CommonJS modules. Generated code runs directly on host JS values and objects — there is no bytecode interpreter or runtime source parser.

---

## Compiler pipeline & modules

```text
guest JS ─▶ frontend ─▶ IR (HIR / CFG / MIR) ─▶ backend passes ─▶ codegen ─▶ .cjs artifact + runtime
```

Dependencies stay strictly one-way (`frontend -> ir -> backend -> compiler -> runtime`), with `src/compiler` orchestrating the build and `src/runtime` remaining independent of compiler code:

| Directory | Responsibility |
| --- | --- |
| `src/frontend` | Acorn ES5.1 parser and frontend operation emission (static `eval`/`Function` lowered ahead of time) |
| `src/ir` | HIR/MIR representations, normal & completion-aware semantic CFGs, decoding, and structural verifiers |
| `src/backend` | Optimization passes (`O1` / `O2` / `Os`), transactional rollback, and independent proof verifiers |
| `src/codegen` | Direct JS emission (`$exec*` scopes, frame factories, literal folding, Source Map v3 markers) |
| `src/compiler` | Public `compile()`, `AOTCompiler`, option validation, and inspection/dump integration |
| `src/runtime` | Standalone `sablejs/runtime` execution engine, `arguments`/frame helpers, and `security.js` mediation |
| `src/worker.js` | `sablejs/worker` (`createSandboxClient`, `handleSandboxMessages`) for timeout/termination boundaries |

---

## Optimization levels

| Level | Status | Behavior |
| --- | --- | --- |
| `O0` | Baseline | Unoptimized differential baseline; no optimizer rewrites |
| **`O1`** | **Default** | Conservative CFG cleanup, constant folding, copy propagation, and dead-code elimination |
| `O2` | Experimental | Adds stack-to-local lowering, GVN, LICM, DSE, local promotion, guarded small-function inlining, and specialized per-scope fast frames |
| `Os` | Experimental | Uses raw-byte cost modeling to pick shared vs per-scope closure factories, reuses temporary slots, prunes helper imports, and suppresses growth-heavy inlines |

Unknown calls, property lookups, dynamic `with`/`eval` environments, captured closures, sloppy `arguments` aliasing, and observable coercions act as optimization barriers unless a pass verifies safety.

> [!NOTE]
> `O1` is the default while remaining corpus, held-out performance, and canary gates in the [CFG and SSA Hardening Plan](cfg-ssa-hardening.md) are completed for `O2`/`Os`. `O1` shrinks exposure rather than providing a formal correctness proof.

---

## IR & control-flow contracts

- **Single source of truth:** `src/operation-spec.js` defines every operation's code, operand layout, stack effect, effect/control class, `mayThrow` flag, and exhaustive MIR lowering rule. The internal numeric stream is never a public ABI (`schemaVersion` guards against mismatch). `NEXTITER`/`JTRUE|JFALSE` adjacency is verified prior to MIR construction.
- **Explicit CFG contracts:** Consumers pick between the **normal CFG** and the **semantic CFG** (which labels `normal`, `exceptional`, and `abrupt` completion paths through `finally` blocks). Inspectable via `includeCFG`, `dumpIR: "cfg"`, and `dumpDir/cfg.txt`.
- **Verified pass pipeline:** HIR is structurally verified after every pass. Each pass declares preserved/invalidated analyses, MIR tracks generation IDs and rebuilds cleanly after SCCP/DSE/DCE, failed passes roll back licensed HIR annotations cleanly, and optional DCE failures fall back via `candidate-mir-invalid`.
- **Independent proof checks:** Dedicated checkers validate `reuse` dominance/no-clobber, LICM loop invariance, semantic deadness of elided stores, edge stack signatures, CFG source reconstruction, and guest-object provenance marks. Invalid optional proofs fall back cleanly to safe runtime helpers.

---

## Public API & type declarations

`sablejs`, `sablejs/runtime`, and `sablejs/worker` expose `compile`, `AOTCompiler`, `capability`, `runtime`, `worker`, `lowerToHIR`, `lowerToMIR`, `normalizeSecurity`, and `normalizeSourceMapOptions`. Complete TypeScript definitions live in `types/` (`npm run check:types`), and opt-in Source Map v3 emission is documented in [Source Maps](source-maps.md).

In default `sandbox` mode, `globals` are deep-copied, host functions auto-wrap (with explicit `capability()` available for custom names/`thisValue`), boundary errors omit stacks, and runtime boundary checks stay monomorphic via private `WeakMap` tracking. `security: "trusted"` passes host references directly and unwraps `capability()` tokens for trusted programs.

---

## Verification & release pipeline

### Local & CI verification commands

```sh
npm ci
npm test                                   # unit + security adversarial suite
npm run check:format                       # Prettier code formatting check
npm run check:types                        # TypeScript declarations (CJS & ESM)
npm run check:examples                     # runs all documented examples
npm run upstream:fetch -- test262 && npm run test262   # pinned ES5.1 Test262 gate
npm run test:differential                  # 2,000-case differential smoke vs V8/QuickJS
npm run fuzz:differential                  # 100,000-case campaign (.cache/differential-failures/)
npm run benchmark:smoke                    # quick benchmark sanity check
npm run benchmark:size -- --check          # artifact size budgets
npm run build && npm run check:compliance  # build dist/ bundles & verify THIRD_PARTY_NOTICES
```

Test262 is pinned to a fixed revision in `tools/upstreams.js` and verified before running any conformance case. Differential harnesses compare `O0`/`O1`/`O2`/`Os` across `sandbox` and `trusted` modes.

### Releasing a new version

1. Update `package.json` (and sync `package-lock.json` + `CHANGELOG.md`), push to `master`, and wait for `Ubuntu CI` to pass.
2. Tag `v<version>` matching `package.json` and push the tag:

```sh
version=$(node -p '"v" + require("./package.json").version')
git tag "$version" && git push origin "$version"
```

`.github/workflows/release.yml` verifies the tag sits on `master`, executes the full test/Test262/differential/benchmark/browser matrix under read-only permissions, archives Test262 reports, and passes only the verified release artifact to the OIDC npm publish job (`beta` tag for prereleases, `latest` for stable releases).
