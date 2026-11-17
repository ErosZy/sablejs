# Language & host compatibility

[← README](../README.md) · [Docs Index](README.md) · [Examples](../examples/README.md) · [Security](security.md) · [Architecture](architecture.md)

## Quick contract

| Surface | Support in sablejs v2 |
| --- | --- |
| **Guest syntax** | **ES5.1 scripts** (no `import`/`export`); returns final expression completion value |
| **Modern JS / TS** | Supported by downleveling syntax to ES5.1 with Babel or SWC before `compile()` (no automatic polyfills) |
| **Dynamic code** | Literal static `eval("...")` and `Function("...")` compile ahead of time; runtime-generated source is rejected |
| **Newer host built-ins** | Typed arrays, `Map`, `Set`, `Promise`, `Symbol`, `BigInt`, `Reflect`, `Proxy`, `Atomics`, `WeakRef`, and `Intl` follow host availability |
| **Artifact output** | CommonJS module (`.cjs`); bundle with esbuild, Vite, or Rollup for browsers/ESM |
| **Verified hosts** | Node 24, Deno 2, Bun, Chromium, Firefox, WebKit |
| **Conformance suite** | Pinned Test262 tests carrying ES5 clause metadata (`es5id`) |

## Downleveling modern JS & TypeScript

The ES5.1 compiler core keeps the security boundary small and auditable. Modern syntax should be lowered before compilation using Babel (or SWC) targeting ES5 — **Babel lowers syntax; sablejs controls execution**:

```js
const babel = require("@babel/core");
const presetEnv = require("@babel/preset-env");
const { compile } = require("sablejs");

const es5 = babel.transformSync(modernSource, {
  babelrc: false,
  configFile: false,
  sourceType: "script",
  presets: [[presetEnv, { modules: false, targets: { ie: "11" }, useBuiltIns: false }]],
}).code;

const artifact = compile(es5);
```

See [Worker Isolation](worker-isolation.md#bundling-modern-js-for-browser-workers) for a full esbuild + Babel + browser bundle script.

> [!NOTE]
> Modern host built-ins (`Map`, `Set`, `Promise`, `Intl`, typed arrays) are available when the host provides them, under read-only intrinsic protection. They do **not** add non-ES5 syntax support to the parser.

---

## Test262 conformance policy

Our pinned Test262 runner (`test/conformance/test262.js`) turns the ES5.1 contract into an executable release gate. Every eligible test is compiled, executed in a `trusted`-mode instance, and compared against native V8 on any failure.

```sh
npm run upstream:fetch -- test262   # check out pinned Test262 revision
npm run test262                     # run gate (exits non-zero on failure)
npm run test262:archive             # save full report to archives/test262/
```

### Corpus selection

- Only files under `test/language/**` and `test/built-ins/**` with an `es5id` frontmatter key are included (Test262's marker for ES5 specification clauses).
- Post-ES5 features without `es5id`, Annex B material, and harness files are out of scope by definition.
- Strict/sloppy variants run according to each test's flags (`onlyStrict`, `noStrict`, `raw`, or both).

### Dynamic-code policy exclusions

Because `sablejs` intentionally removes runtime code evaluation, tests requiring runtime dynamic code are excluded:

- All tests under `built-ins/eval/*`, and `built-ins/Object/getOwnPropertyNames/15.2.3.4-4-1.js` (which expects a global `eval` property).
- Tests whose Acorn token stream actually touches `eval` as a `name` token, or `Function` followed by `(` / `.call` / `.apply` / `.bind(`. Comments, strings, regexes, and early-error tokenization tests remain eligible.

### Pinning upstream expectations back to ES5.1

Test262 evolves to match newer ECMAScript editions even when `es5id` remains. Where upstream changed away from ES5.1, the runner restores the ES5.1 expectation (tracked in `es5VariantMetadata` / `hasES5SourceAdjustment` and reported under `es5Adjusted`):

- `language/statements/function/13.2-15-1.js` — pins function `.length` descriptor to `configurable: false` (ES5.1 13.2 step 15) rather than ES2015+ `configurable: true`.
- `language/expressions/object/prop-dup-*` — restores ES5.1 `SyntaxError` early errors for duplicate object properties in strict mode and accessor collisions in sloppy mode.
- `language/expressions/object/11.1.5-2gs.js`, `language/statements/break/S12.8_A3.js`, and `S12.8_A4_*` — restores required ES5.1 early `SyntaxError` checks.

Positive tests written with post-ES5 helper syntax are transpiled to ES5 via `@babel/preset-env` (`targets: { ie: "11" }`, no polyfills); negative `parse`/`early` error tests are never transpiled.

### Host-failure attribution & archiving

- Any failure is re-run on native V8 inside the same harness. Native failures are diagnostic only unless explicitly matched in `test/conformance/host-failures.json` (currently empty — stale entries also fail the run).
- `npm run test262:archive` writes full failure details plus environment metadata (`node`, platform, arch, CPUs, timestamp) to `archives/test262/<revision>-<timestamp>.json` and `latest.json`, which the release workflow attaches to GitHub releases.
