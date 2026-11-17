# Performance

[← README](../README.md) · [Docs Index](README.md) · [Choosing an Execution Model](comparison.md) · [CFG/SSA Hardening](cfg-ssa-hardening.md) · [Optimization History](optimization.md)

All measurements below were collected on **Linux x64** (`Node.js 24.14.0`, `V8 13.6`, Intel Core i5-12400F, `quickjs-emscripten 0.32.0`) pinned to a single CPU core (`taskset -c 11`). Each table notes whether higher or lower numbers are better and whether values are medians or single runs.

> [!IMPORTANT]
> **Correctness & methodology status (2026-09-02):** All `O2` figures below are **historical reference measurements**, not a production recommendation or proof that CFG/SSA alone drove the gains. While P0 DSE/GVN root causes are fixed, `O2` and `Os` remain experimental until the [CFG and SSA Hardening Plan](cfg-ssa-hardening.md) gates complete (`O1` is the current compiler default). Additionally, the recorded QuickJS runs timed source evaluation alongside execution where `sablejs` was precompiled, and older SunSpider/Kraken scripts could omit failed cases. The harness has since been fixed to prepare QuickJS outside timing and fail on skips, but these tables have not yet been rerun on a held-out corpus.

---

## At a glance (historical O2 reference)

| Benchmark | sablejs O2 sandbox | QuickJS-WASM 0.32.0 | Sampling |
| --- | ---: | ---: | --- |
| V8 Benchmark Suite 7 score *(higher is better)* | **2,202** | 1,181 | median of 3 |
| SunSpider 1.0, 23 tests *(ms; lower is better)* | **515.5** | 597.7 | median of 3 |
| Kraken 1.1, 14 tests *(ms; lower is better)* | **15,935.3** | 27,081.9 | single run |

On that historical harness, `sablejs` O2 sandbox recorded **1.86x** V8 Suite 7 score, **1.16x** faster SunSpider subset total, and **1.70x** faster Kraken subset total versus QuickJS-WASM. Treat these purely as historical reference points for that machine and harness.

---

## V8 Benchmark Suite 7

Three measured runs per backend pinned to core 11 (2026-08-24 refresh). The `v1 baseline` column reflects the removed v1 interpreter captured right before migration. Because sandbox mode blocks mutations to shared `Math` and `Object.prototype`, the suite uses local deterministic RNG and inheritance helpers (only `print` is injected as a capability).

| Suite | v1 baseline | sandbox O2 | trusted O2 | QuickJS-WASM |
| --- | ---: | ---: | ---: | ---: |
| Richards | 162 | 1,120 | 1,328 | 1,046 |
| Crypto | 198 | 4,595 | 9,014 | 977 |
| RayTrace | 371 | 597 | 565 | 1,241 |
| NavierStokes | 266 | 17,476 | 17,979 | 1,784 |
| DeltaBlue | 174 | 1,079 | 1,177 | 1,055 |
| **Geometric score** | **224** | **2,202** | **2,783** | **1,181** |

- **Raw 3-run scores:** `sandbox O2` = `2,203 / 2,019 / 2,202` (median `2,202`); `trusted O2` = `2,783 / 2,813 / 2,597` (median `2,783`); `QuickJS-WASM` = `1,177 / 1,188 / 1,181` (median `1,181`).
- **Sandbox retention:** On paired 2026-08-24 medians, sandbox retained **79.1%** of trusted throughput (up from 60.3% on 2026-08-22). Per-suite sandbox overhead: Richards `15.7%`, Crypto `49.0%`, NavierStokes `2.8%`, DeltaBlue `8.3%`, RayTrace `-5.7%`.
- **Kill-switch A/Bs (within-session):** Dead-store elimination (`--no-dse`, median of 4) measured `+6.1%` sandbox (`1,483` vs `1,398`) and `+2.0%` trusted (`2,120` vs `2,079`); slot-provenance write stamps (`--no-slot-provenance`, 6 rounds) measured `+9.9%` (`1,824` vs `1,660`); inline guest writes (`--no-inline-guest-writes`) moved write-heavy NavierStokes `+17.0%` (`+23.9%` re-verified) and Crypto `+8.8%` while leaving full-suite geomean flat (`+4.8% / -2.5% / +0.6%`). RayTrace cross-table variations stem from session drift (interleaved local-promotion A/B measured `421 vs 424` trusted, `361 vs 366` sandbox).

### Sandbox boundary profile (`--profile-boundary`)

`benchmark/run.js --profile-boundary` (via `createInstance({ profileBoundary: true })`) shows where sandbox boundary transitions land per suite (2026-08-24 after arity dispatch and slot-provenance stamps):

| Suite | boundary.calls | guest calls | host calls | constructs | guest constructs | writeTargets | mediated gets | wrapper creations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Richards | 22.7M | 22.7M | 148 | 17.4k | 11.8k | 1.05M | 206 | 0 |
| Crypto | 13.5M | 10.8M | 2.7M | 59k | 29.7k | 42k | 364 | 0 |
| RayTrace | 6.5M | 3.4M | 3.2M | 2.7M | 2.7M | 3.35M | 2.6M | 0 |
| NavierStokes | 17.4k | 16.9k | 460 | 523 | 337 | 237k | 206 | 0 |
| DeltaBlue | 37.7M | 36.3M | 1.43M | 747k | 474k | 5.02M | 197k | 65.7k |

- Full-suite `writeTargets` dropped **210.4M → 10.0M** after item 9 slot-provenance stamps (`NavierStokes 70.1M → 237k`, `Crypto 123.5M → 42k`, `Richards 5.0M → 1.05M`, `RayTrace 5.96M → 3.35M`, `DeltaBlue 5.86M → 5.02M`).
- Residual `writeTargets` come from property-read chains (unmarked by design) and mapped `arguments` fallback paths.

---

## Optimization batch highlights (2026-08-23 → 2026-08-24)

Full design notes, soundness arguments, and kill-switch experiments for Items 1–19 live in [Optimization History](optimization.md):

- **Write-guard reduction:** Guest provenance v1/v2 (`thisIsGuest` frame stamp + return-safe `new`), slot-provenance write stamps (item 9, full-suite A/B `+9.9%`), and inline guest writes (item 10, NavierStokes `+17%–23.9%`).
- **Call & `new` dispatch:** Arity-specialized guest calls (item 2: Richards `+6.3%`, DeltaBlue `+8.4%`), arity-specialized `NEW` dispatch (item 8: RayTrace 99.99% fast path), pure-intrinsic caching, and shared intrinsic graph (`createInstance` `387 µs → 33.6 µs`).
- **Literal folding & materialization:** Literal-init fast path (item 11), inlined guest init (item 13), and nested literal chain deep-fold (item 17: input materialization `54 µs → 17.5 µs`).
- **Sandbox-only intrinsic call inlining:** Direct identifier calls (`isNaN`/`parseFloat`/`parseInt`/`Number`/`String`, item 14) and member calls (`push`/`sort`/`join`/`charAt`/`indexOf`/`slice`/`replace`/`test`, items 15/15b: `json-transform` `2.58–2.70×`); kept disabled in `trusted` mode where measurement showed regressions.
- **Frames, locals & branches:** Local promotion phases 1–3 (item 6: `681` promoted slots, NavierStokes `+45%` trusted / `+47.6%` sandbox), convergent DSE (item 7a), dense native `switch` (item 7b), leaf-frame pooling (item 7c), frame-stack sync simplification (item 12), and branch-test deferral (item 18).
- **Negative result:** Item 16 (constant-key `INITPROP` / fast globals) measured flat and was rolled back; the tuning loop exited at Item 19.

---

## Compiled size by optimization level

Measured on the 137.1 KB V8 Suite 7 source (2026-08-24, decimal KB = bytes ÷ 1000). Minified browser IIFEs bundle `sablejs/runtime` via esbuild `0.28.2`. CI enforces these budgets within `+5%` via `npm run benchmark:size -- --check`:

| Level | Sandbox CJS | Sandbox min IIFE | Trusted CJS | Trusted min IIFE |
| --- | ---: | ---: | ---: | ---: |
| O0 | 869.1 KB | 621.3 KB | 869.1 KB | 621.3 KB |
| O1 | 859.8 KB | 614.4 KB | 859.8 KB | 614.4 KB |
| O2 | 1,380.5 KB | 657.1 KB | 1,141.0 KB | 521.3 KB |
| Os | 668.6 KB | 385.7 KB | 597.3 KB | 353.2 KB |

### Size/speed Pareto & per-level V8 scores

- **Factory selection (`raw CJS`):** Per-scope factories at `O2` cost `+57%` sandbox (`1,380.5` vs `877.2 KB`) and `+51%` trusted (`1,141.0` vs `755.8 KB`) compared to shared factories; `Os` chooses shared factories (`668.6 KB` sandbox / `597.3 KB` trusted).
- **Wire footprint (with gzip level 9):**
  - Benchmark source (`v8-suite.js`): `137.1 KB` raw → `55.8 KB` min → `17.6 KB` gzip
  - Sandbox O2 CJS (no runtime): `1,380.5 KB` raw → `624.6 KB` min → `75.5 KB` gzip
  - Sandbox O2 IIFE (+ runtime): `657.1 KB` min → **`87.5 KB` gzip** (`521.3 KB` / `74.4 KB` trusted)
  - Sandbox Os IIFE (+ runtime): `385.7 KB` min → **`60.7 KB` gzip** (`353.2 KB` / `57.6 KB` trusted)
- **Historical V8 Suite 7 sandbox scores across optimization levels:** `O0`: `25.5` (`621.3 KB` IIFE), `O1`: `26.3` (`614.4 KB`), `O2`: `2,202` median (`657.1 KB`), `Os`: `884` (`385.7 KB`). Note that `O1` already runs MIR SCCP, copy propagation, and DCE; the jump to `2,202` comes from combining those with `O2`-only lowering, specialized frame factories, local promotion, boundary fast paths, and literal folding.

---

## Octane 2.0, SunSpider 1.0 & Kraken 1.1 subsets

### Octane 2.0 (pinned `570ad1ccfe86e3eecba0636c8f932ac08edec517`, single run)

Includes suites not requiring runtime-generated code; shared-intrinsic helpers in RayTrace/DeltaBlue/`Math.random` are guest-localized for `sablejs` while QuickJS runs untouched source (`Splay` marked `*` is back-derived within <1% from geomean):

| Suite | sablejs O2 trusted | sablejs O2 sandbox | QuickJS-WASM |
| --- | ---: | ---: | ---: |
| Richards | 1,294 | 929 | 897 |
| DeltaBlue | 1,321 | 1,088 | 992 |
| Crypto | 3,919 | 3,440 | 897 |
| RayTrace | 442 | 410 | 713 |
| RegExp | 4,927 | 3,371 | 442 |
| Splay | 1,749 | 1,628 * | 2,832 * |
| NavierStokes | 11,700 | 5,730 | 1,572 |
| Box2D | 3,017 | 2,296 | 3,608 |
| **Geometric score** | **2,674** | **2,088** | **1,472** |

*Pre-items A/B vs commit `743fd16` (2026-08-24, 3-round interleaved medians):* **+37% geomean** across 8 suites (Splay `2.25×`, EarleyBoyer `2.14×`, RayTrace `1.67×`, NavierStokes `1.48×`, Crypto `1.12×`, RegExp `1.05×`, DeltaBlue `1.00×`, Richards `0.88×` from cumulative code-shape interaction rather than any single switchable item; Box2D `+31%` and Typescript `+20%` measured separately).

### SunSpider 1.0 (23 tests, median of 3, ms — lower is better)

Excludes 3 intrinsic-mutating tests (`date-format-tofte`, `date-format-xparb`, `string-tagcloud`) on all backends:

| Backend | Total (23 tests) |
| --- | ---: |
| sablejs O2 trusted | 396.1 ms |
| sablejs O2 sandbox | 515.5 ms |
| QuickJS-WASM | 597.7 ms |

### Kraken 1.1 (14 tests, single run, ms — lower is better)

Uses `--max-old-space-size=2048` due to ~1.8 MB folded imaging literals; `ai-astar`'s `Array.prototype` helpers are lowered locally:

| Backend | Total (14 tests) |
| --- | ---: |
| sablejs O2 trusted | 5,370.9 ms |
| sablejs O2 sandbox | 15,935.3 ms |
| QuickJS-WASM | 27,081.9 ms |

---

## Real-world workloads (historical static-input run, ops/sec)

Eight ES5.1 workloads in `benchmark/workloads/` (higher is better; `native V8` is shown as an un-sandboxed ceiling reference only). The table reflects the 2026-08-24 static-input run before `--input-mode=dynamic` became the default:

| Workload | sablejs sandbox | sablejs trusted | QuickJS-WASM | native V8 |
| --- | ---: | ---: | ---: | ---: |
| json-transform | 3,395 | 1,876 | 150 | 15,479 |
| pricing-rules | 2,130 | 1,790 | 152 | 4,324 |
| form-validator | 25,779 | 31,265 | 10,155 | 184,974 |
| spreadsheet-formulas | 17,722 | 18,498 | 3,076 | 77,707 |
| workflow-rules | 22,692 | 24,572 | 2,523 | 100,874 |
| template-logic | 12,508 | 14,254 | 8,333 | 252,746 |
| data-aggregation | 354 | 553 | 63 | 4,842 |
| mini-parser | 8,637 | 8,353 | 8,965 | 126,377 |

---

## Reproduction

```sh
npm ci
npm run benchmark:release -- --samples=3
npm run benchmark:release -- --protocol=cold --samples=3 --output=.cache/cold.json
npm run benchmark:release -- --protocol=warm --samples=10 --warmup=2 --output=.cache/warm.json
npm run benchmark:check -- --artifact=.cache/warm.json
npm run benchmark:correctness -- --output=.cache/benchmark-correctness.json
npm run benchmark -- --security=sandbox
npm run upstream:fetch -- octane sunspider kraken
npm run benchmark:octane -- --suite=Richards,DeltaBlue,Crypto,RayTrace,RegExp,Splay,NavierStokes,Box2D
npm run benchmark:sunspider -- --backend=sablejs-sandbox --samples=3
node --max-old-space-size=2048 benchmark/kraken.js --backend=sablejs-sandbox
npm run benchmark:workloads -- --backend=sablejs-sandbox
```

Supports `--protocol=cold|warm`, `--disable-pass=sccp,copy-propagation,dce,gvn,licm,dse` (recorded in compile metadata), `--input-mode=dynamic|static`, `--profile-boundary`, and `--workload=name`. Note: QuickJS-WASM is a WebAssembly interpreter reference, not native QuickJS.
