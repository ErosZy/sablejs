# Source maps & debugging

[← README](../README.md) · [Docs Index](README.md) · [Examples](../examples/README.md) · [Architecture](architecture.md) · [Security](security.md)

`compile()` can generate deterministic **Source Map v3** output for the CommonJS artifact, mapping `$exec*` stack frames and debugger breakpoints back to the original ES5.1 guest source at every optimization level (`O0`, `O1`, `O2`, `Os`).

When `sourceMap` is omitted or `false`, generated code, optimization decisions, and compiler stats are byte-for-byte identical to builds without source-map support.

---

## Quick usage

```js
const { compile } = require("sablejs");

const result = compile(source, {
  sourceMap: {
    mode: "external",               // "external" | "inline"
    sourceFile: "rules/input.js",   // logical guest filename (never inferred from cwd)
    generatedFile: "rules.cjs",     // `file` field in the v3 map
    sourceMapURL: "rules.cjs.map",  // optional comment appended only in external mode
    sourcesContent: false,          // set true to embed guest source in the map
  },
});

// result.code  — generated CommonJS (with data URL comment if mode === "inline")
// result.map   — serialized Source Map v3 JSON string (undefined when disabled)
// result.metadata.sourceMap — normalized settings (never duplicates source/map text)
```

### Shorthand values

| `sourceMap` value | Behavior |
| --- | --- |
| `false` / omitted | Disabled (`result.map === undefined`, zero build impact) |
| `true` or `"external"` | External map with logical defaults (`sourceFile: "<sablejs-input>"`, `generatedFile: "generated.cjs"`, `sourcesContent: false`, no URL comment) |
| `"inline"` | Same logical defaults, with a base64 `//# sourceMappingURL=data:...` comment appended to `result.code` |
| `{ mode, sourceFile, generatedFile, sourceMapURL, sourcesContent }` | Full configuration (validated before codegen) |

> [!TIP]
> When `dumpDir` is also set, the compiler writes `code.js.map` alongside `code.js` (using the relative URL `code.js.map` so absolute host paths never leak), while `result.code` and `result.map` still use your configured logical filenames.

---

## Using maps in Node.js & browsers

Engines and bundlers consume the map — `sablejs` does not install global `Error.prepareStackTrace` hooks:

- **Node.js:** Write `rules.cjs` and `rules.cjs.map` side by side with `sourceMapURL: "rules.cjs.map"` and launch Node with `--enable-source-maps`. Runtime `$exec*` frames inside errors resolve to your guest file and line (covered in [`test/unit/source-map-e2e.test.js`](../test/unit/source-map-e2e.test.js)).
- **Browsers / esbuild:** Compile with `sourceMap: "inline"` and `sourcesContent: true` (for non-secret code), then bundle with esbuild (`sourcemap: "inline"`). esbuild chains the artifact's inline map through to the final browser bundle (covered in [`examples/browser/`](../examples/browser/build.cjs)).

---

## What is mapped (and what is not)

- **Statement-level mapping across all levels:** Each statement maps at statement granularity across `O0`, `O1`, `O2`, and `Os`. Folded constants, native literals, loop-hoisted reads, and control-flow scaffolding inherit their containing statement. (Enabling source maps keeps small-function expression inlining disabled so call stacks remain clear.)
- **Nested functions:** Lexical function declarations and expressions map directly to their own lines inside `sourceFile`.
- **Static `eval("...")` and `Function("...")`:** Compiled ahead of time to virtual sources named **`<sourceFile>#eval-N`** and **`<sourceFile>#dynamic-N`**. Compiler-injected prefixes (`'use strict';` and `function _dynamic_N(...)`) are stripped from `sourcesContent` and compensated in line/column translations so segments land at the guest's exact coordinates.
- **Runtime-dynamic `eval(expr)`:** Dynamic strings not statically concatenable have no static source and remain unmapped (though their call site in the enclosing code still maps cleanly).
- **Reset regions:** Runtime imports, metadata boilerplate, and scope prologues remain explicitly unmapped.

---

## Privacy & sandbox error rules

- **Source protection:** Maps default to `sourcesContent: false`, leave `names` empty (preserving identifier aliasing), and never emit absolute filesystem paths. Keep external `.map` files private on servers when guest logic is sensitive.
- **Boundary & host errors keep stacks stripped:** In `sandbox` mode, boundary violations (e.g., prototype tampering) and sanitized capability errors intentionally delete host stacks (`src/runtime/security.js`). Source maps never weaken that isolation and do not attach a forgeable `guestLocation` property to stripped error objects.

---

## How it works (compiler internals)

For contributors maintaining `src/compiler/index.js`, `src/codegen/index.js`, and `src/codegen/source-map.js`:

1. **`retainSourceLocations`:** The compiler derives `retainSourceLocations = Boolean(sourceMap || preserveSourceLocations)`. Even at `O2`/`Os`, the optimizer preserves frontend `LOC(line, column)` operations instead of stripping them, without emitting unnecessary runtime `$f.line/$f.column` assignments unless `preserveSourceLocations` is explicitly requested.
2. **Private markers in codegen:** During string emission, `LOC` ops emit collision-resistant private markers carrying `{ sourceIdentity, line, column }`, and `$exec*` boundaries emit reset markers so mappings never bleed across scopes. Every marker-free `Os` candidate is measured **before** mapping so size-based factory selection remains deterministic and unchanged.
3. **Finalization with `@jridgewell/gen-mapping`:** `src/codegen/source-map.js` scans the assembled output once, strips all markers (asserting none remain), converts 1-based Acorn lines to Source Map v3 offsets, emits segments at the first non-whitespace column of each non-empty line, and aligns `sources` / `sourcesContent` by GenMapping's own source-index order (so nested `#eval-N` / `#dynamic-N` scopes always match).
4. **Synthetic scope inheritance:** `inheritSynthetic` propagates the enclosing synthetic source descriptor (`{ text, lines, columns }`) down to lexical functions declared inside static `eval` / `Function` bodies (`translateSynthetic`).
