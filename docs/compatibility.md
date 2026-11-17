# Language & host compatibility

[← README](../README.md) · [Docs Index](README.md) · [Examples](../examples/README.md) · [Security](security.md) · [Architecture](architecture.md)

## Quick contract

| Surface | Support in sablejs v2 |
| --- | --- |
| **Guest syntax** | **ES5.1–ES2025 scripts** (no `import`/`export`); returns final expression completion value |
| **Built-in lowering** | Automatic ES2015+ → ES5.1 AST pass (`transform: "auto"` default; zero overhead fast path when input is already ES5.1) |
| **TS / JSX / async / modules** | Bundle or transpile via external bundler (esbuild/Babel/SWC) or a custom `options.transform` hook (automatically chains Source Map v3) |
| **Dynamic code** | Literal static `eval("...")` and `Function("...")` compile ahead of time (including ES2015+ bodies); runtime-generated source is rejected |
| **Newer host built-ins** | Typed arrays, `Map`, `Set`, `Promise`, `Symbol`, `BigInt`, `Reflect`, `Proxy`, `Atomics`, `WeakRef`, and `Intl` follow host availability |
| **Artifact output** | CommonJS module (`.cjs`); bundle with esbuild, Vite, or Rollup for browsers/ESM |
| **Verified hosts** | Node 24, Deno 2, Bun, Chromium, Firefox, WebKit |
| **Conformance suite** | Pinned Test262 tests carrying ES5 clause metadata (`es5id`) |

## Built-in ES2015+ → ES5.1 transform (`options.transform`)

`compile()` keeps the AOT IR and runtime security boundary strictly ES5.1, while automatically lowering modern ECMAScript syntax upfront using a zero-dependency AST transform (`src/frontend/transform.js`):

| `transform` value | Behavior |
| --- | --- |
| `"auto"` **(default)** | Parses as ES5.1 first (`transformed: false`, zero-overhead fast path); if ES2015+ syntax is used, lowers to ES5.1 (`transformed: true`, `inputLanguage: "esnext"`). |
| `true` / `"es5"` / `"es5.1"` | Unconditionally runs the ES2015+ → ES5.1 AST lowering pass (also enables block-scoped `function` lowering in strict scripts). |
| `false` / `"none"` | Strictly enforces ES5.1 syntax (`SyntaxError` on ES2015+ syntax). |
| `(source, ctx) => string \| { code, map? }` | Custom preprocessor hook (for TypeScript, JSX, `async`, etc.); `sablejs` runs `"auto"` ES5.1 lowering afterward and chains any returned source map (`chainSourceMap`). |

### Supported vs external / hook syntax

- **Lowered out of the box:** `let`/`const` block scoping + per-iteration loop closures, arrow functions (lexical `this`/`arguments`), default/rest/destructured parameters (`fn.length` preserved), deep object/array destructuring & rest, spread in arrays/calls/`new`/objects, template & tagged template literals, shorthand/computed object properties & methods + `super.m()`, `for..of` (with `.return()` cleanup), `class`/`extends`/`super`/fields/`static {}`/`#private`/`#priv in obj`, `**`/`**=`, optional chaining `?.`, nullish coalescing `??`, logical assignment (`&&=`/`||=`/`??=`), optional/destructured `catch`, numeric separators (`1_000`), `0b`/`0o`, and `BigInt` literals.
- **Requires a bundler or custom `options.transform` hook:** ES module `import`/`export` bundling, TypeScript/JSX syntax, `async`/`await`, `function*`/`yield`, and host polyfills for missing globals.

```js
const babel = require("@babel/core");
const presetEnv = require("@babel/preset-env");
const { compile, transformToES5 } = require("sablejs");

// Custom transform hook for TypeScript / async / generators + chained Source Map v3
const artifact = compile(tsOrAsyncSource, {
  sourceMap: true,
  transform(code, { sourceFile }) {
    const out = babel.transformSync(code, {
      filename: sourceFile,
      babelrc: false,
      configFile: false,
      sourceType: "script",
      sourceMaps: true,
      presets: [[presetEnv, { modules: false, targets: { ie: "11" }, useBuiltIns: false }]],
    });
    return { code: out.code, map: out.map };
  },
});

// Standalone printer when only ES5.1 JS output is needed:
const { code } = transformToES5("const add = (a, b = 1) => a + b; add(4);");
```

See [Worker Isolation](worker-isolation.md#bundling-modern-js-for-browser-workers) for a full esbuild browser Worker bundling script.

> [!NOTE]
> Modern host built-ins (`Map`, `Set`, `Promise`, `Intl`, typed arrays) follow host availability under read-only intrinsic protection without automatic polyfills.

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
