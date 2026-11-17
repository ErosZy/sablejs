<h1 align="center">
  <img src="./logo.jpg" alt="sablejs" width="720">
</h1>

<p align="center">
  <strong>Run user-authored and AI-generated JavaScript safely on the host JS engine — fast, isolated, and debuggable.</strong>
</p>

<p align="center">
  <a href="https://github.com/ErosZy/sablejs/actions/workflows/ci.yml"><img alt="Ubuntu CI" src="https://github.com/ErosZy/sablejs/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/sablejs"><img alt="npm beta" src="https://img.shields.io/npm/v/sablejs/beta?label=npm%20beta"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/ErosZy/sablejs"></a>
  <a href="https://github.com/ErosZy/sablejs/releases"><img alt="Release" src="https://img.shields.io/github/v/release/ErosZy/sablejs"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#common-recipes">Recipes</a> ·
  <a href="examples/README.md">Examples</a> ·
  <a href="docs/security.md">Security</a> ·
  <a href="docs/README.md">Documentation</a>
</p>

**sablejs** compiles untrusted JavaScript ahead of time into a plain CommonJS module guarded by a lightweight capability runtime — ideal for plugin systems, pricing and workflow rules, spreadsheet formulas, data transforms, and AI-generated scripts.

- **Fast AOT execution** — Runs directly on the host JS engine with no embedded interpreter or WASM VM startup tax.
- **Safe by default** — Deep-copies input data, blocks prototype/intrinsic tampering, and wraps host functions as revocable capabilities.
- **Debuggable with standard tools** — Emits Source Map v3 for Node.js and browser DevTools, plus inspectable IR dumps.

```text
Modern JS / TS ──(Babel / SWC)──▶ ES5.1 ──(sablejs compile)──▶ Plain CJS Artifact ──▶ Node · Browser · Worker · Deno · Bun
```

> Inspired by Figma's [WebAssembly plugin sandbox](https://www.figma.com/blog/how-we-built-the-figma-plugin-system/) and its [QuickJS runtime](https://www.figma.com/plugin-docs/updates/2020/07/07/version-1-update-16/).

## Quick start

Install the v2 beta (`latest` remains on v1 while v2 is in beta; coming from v1? See the [Migration Guide](docs/migration-v2.md)):

```sh
npm install sablejs@beta
```

### Try it in one file

Guest programs are ES5.1 scripts (no `import`/`export`) that return their final expression value:

```js
const { compile, worker } = require("sablejs");

// 1. Compile untrusted source ahead of time (defaults to sandbox mode + O1 optimization)
const { code } = compile("({ total: input.price * 1.2 });");

// 2. Load the compiled artifact and create a single-run instance
const program = worker.loadCompiledArtifact(code);
const instance = program.createInstance({
  globals: { input: { price: 100 } },
});

try {
  console.log(instance.run()); // { total: 120 }
} finally {
  instance.dispose(); // always dispose to release resources and revoke capabilities
}
```

### Precompile for production

In production, keep compilation at build time (or in a server-side cache). Your deployed app only needs the generated artifact and `sablejs/runtime`:

```js
// build.cjs — build time
const fs = require("node:fs");
const { compile } = require("sablejs");

const { code } = compile("({ total: input.price * 1.2 });");
fs.writeFileSync("program.cjs", code);
```

```js
// run.cjs — runtime (no compiler needed)
const program = require("./program.cjs");
const instance = program.createInstance({
  globals: { input: { price: 100 } },
});

try {
  console.log(instance.run()); // { total: 120 }
} finally {
  instance.dispose();
}
```

> [!TIP]
> **Three-piece mental model:** `compile()` produces a standalone `.cjs` artifact → your app caches or bundles that artifact → each execution creates a fresh single-run `instance`, calls `instance.run()`, and cleans up with `instance.dispose()`.

## Common recipes

### 1. Pass host functions (capabilities)

In default `sandbox` mode, `globals` data is recursively deep-copied so guest mutations never touch host objects. Any host function anywhere in `globals` becomes a **capability** automatically — arguments and return values are copied, host error stacks are stripped, and the wrapper is revoked on `dispose()`:

```js
const instance = program.createInstance({
  globals: {
    input: { price: 100 },
    save: async function (record) {
      const res = await fetch("/api/records", {
        method: "POST",
        body: JSON.stringify(record),
      });
      return { saved: res.ok };
    },
  },
});
```

Need a custom wrapper name or a bound `this` receiver? Wrap explicitly with `capability()`:

```js
const { capability } = require("sablejs");

const save = capability(api.save, {
  name: "save",
  thisValue: api,
});
```

Explicit `capability()` tokens also work unchanged in `security: "trusted"` (where they unwrap back to the raw host function).

### 2. Export and call guest functions

End your guest script with a function expression to return a callable function to the host:

```js
// Guest source: "function price(input) { return { total: input.price * 1.2 }; } price;"
const instance = program.createInstance({ globals: {} });

try {
  const price = instance.run(); // synchronous — returns a callable
  console.log(price({ price: 100 })); // { total: 120 }
} finally {
  instance.dispose();
}
```

Host-initiated calls automatically copy arguments and `this` in `sandbox` mode, while calls between guest functions keep standard JavaScript reference semantics.

### 3. Enforce timeouts with a Worker

The language boundary restricts what code can *reach*, not how long it runs. To stop infinite loops and bound execution time, run programs in a dedicated Worker using `sablejs/worker`:

```js
// sandbox.worker.js
const program = require("./program.cjs");
require("sablejs/worker").handleSandboxMessages(program);
```

```js
// host.js (browser Worker, or Node worker_threads with a small adapter)
const { createSandboxClient } = require("sablejs/worker");

const sandbox = createSandboxClient(new Worker("/sandbox.worker.js"), {
  timeoutMs: 1000,
});

await sandbox.run({ price: 100 }); // { total: 120 }
```

`createSandboxClient` terminates the Worker on timeout and exposes `sandbox.evaluate(artifactCode, input)` for dynamically compiled artifacts. Never pass raw uncompiled user source to `evaluate()`. See [Worker isolation](docs/worker-isolation.md) for Node adapters, Worker-side capabilities, and size limits.

### 4. Modern JavaScript & TypeScript

Downlevel ES2015+ or TypeScript to ES5.1 with Babel or SWC before calling `compile()` — **Babel lowers syntax; sablejs controls execution**.

All public entry points (`sablejs`, `sablejs/runtime`, `sablejs/worker`) ship TypeScript declarations in `types/`:

```ts
import { compile } from "sablejs";
import type { CompileOptions, CompileResult } from "sablejs";

const options: CompileOptions = {
  optimization: "O1",
  security: "sandbox",
  sourceMap: { mode: "external", sourceFile: "rules/input.js" },
};
const result: CompileResult = compile(source, options);
```

### 5. Source maps & IR debugging

Opt into Source Map v3 generation with `sourceMap` or inspect compiler stages with `dumpDir` / `dumpIR`:

```js
const result = compile(source, {
  sourceMap: {
    mode: "external", // or "inline" (embeds base64 data URL)
    sourceFile: "rules/input.js",
    generatedFile: "rules.cjs",
    sourceMapURL: "rules.cjs.map",
    sourcesContent: false,
  },
});
```

| Option | Purpose |
| --- | --- |
| `sourceMap: true \| "external" \| "inline" \| { ... }` | Statement-level Source Map v3 (static `eval`/`Function` bodies map to `#eval-N` / `#dynamic-N`). Zero overhead when omitted. See [Source maps](docs/source-maps.md). |
| `dumpDir: "/path"` | Writes `hir.txt`, `cfg.txt`, `mir.txt`, `code.js`, and `code.js.map` (when mapping is enabled). Pass custom `fs` for non-Node hosts. |
| `includeHIR` / `includeCFG` / `includeMIR` / `dumpIR` | Attaches IR/CFG graph objects directly onto `result`. |

## Sandbox at a glance

| Surface | Default `sandbox` behavior |
| --- | --- |
| ES5.1 built-ins | Protected `Object`, `Array`, `Math`, `Date`, `RegExp`, `JSON`, etc. Readable and callable; prototype mutation blocked. |
| Modern host built-ins | `Map`, `Set`, `Promise`, typed arrays, `Symbol`, `BigInt`, `Reflect`, `Proxy`, `Intl` exposed when the host has them (intrinsics remain read-only). |
| Injected `globals` | Primitives, plain objects, arrays, `Date`, `RegExp`, buffers/`Uint8Array`, `Map`, `Set` deep-copied; host functions wrapped as revocable capabilities. |
| Host & dynamic code | `window`, `document`, `process`, `fs`, ambient class instances, and runtime `eval`/`Function` blocked. Static literal `eval`/`Function` inputs are compiled ahead of time. |

Need raw object identity and zero-copy interop for **fully trusted** code? Pass `security: "trusted"`. Read the threat model and boundary policies in [Security](docs/security.md).

## Compatibility & status

| Surface | Contract |
| --- | --- |
| Guest language | ES5.1 scripts (no module imports); use Babel/SWC for modern JS/TS |
| Output | CommonJS module (bundle with esbuild/Vite/Rollup for browsers) |
| Optimization | **`O1` default** (`O0` baseline; `O2` and `Os` remain experimental until [CFG/SSA hardening](docs/cfg-ssa-hardening.md) gates complete) |
| Tested hosts | Node 24, Deno 2, Bun, Chromium, Firefox, WebKit |
| Conformance | Release-gated pinned ES5.1 Test262 suite (`es5id` corpus) |

**Performance note:** Historical reference runs on Linux x64 (2026-08-24) recorded an `O2` sandbox score of **2,202** on V8 Benchmark Suite 7 vs **1,181** in QuickJS-WASM 0.32.0 (87.5 KB gzipped browser bundle including runtime). Treat `O2` numbers as historical reference baselines rather than the current `O1` default; see [Performance](docs/performance.md) for methodology, artifact sizes, and reproduction commands.

## Documentation

Browse the full [Docs Index](docs/README.md) or jump directly to a guide:

| Guide | What you will learn |
| --- | --- |
| [Examples](examples/README.md) | 10 runnable demos across Node, Browser, Worker, Deno, Bun, precompile, caching, and error handling |
| [Migrating from v1 to v2](docs/migration-v2.md) | Upgrading from v1 opcodes/CLI to v2 AOT compilation and capabilities |
| [Choosing an execution model](docs/comparison.md) | Comparing `sablejs` vs QuickJS-WASM, cross-origin iframes, and `eval` |
| [Worker isolation](docs/worker-isolation.md) | Wall-clock timeouts, Worker-side capabilities, Babel+esbuild bundling, size budgets |
| [Security model](docs/security.md) | Threat model, trust boundaries, feature policies, and audit record |
| [Source maps](docs/source-maps.md) | Node `--enable-source-maps`, browser DevTools, virtual eval sources, compiler design |
| [Compatibility](docs/compatibility.md) | Supported JS features, downleveling, and Test262 conformance policy |
| [Architecture](docs/architecture.md) · [Performance](docs/performance.md) · [Roadmap](docs/roadmap.md) | Compiler layers, IR verification, benchmarks, release workflow, and roadmap |

## Development

```sh
git clone https://github.com/ErosZy/sablejs.git
cd sablejs
npm ci
npm test                      # unit + security adversarial suite
npm run check:types           # TypeScript CJS/ESM checks
npm run check:examples        # verifies all examples match documented output
npm run build && npm run check:compliance
```

`npm run build` produces `dist/runtime.js` and `dist/compiler.js`. See [Architecture](docs/architecture.md) for Test262, differential fuzzing, benchmark suites, and the release workflow. Report vulnerabilities via [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE) — third-party dependency notices live in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
