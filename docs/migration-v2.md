# Migrating from sablejs v1 to v2

[← README](../README.md) · [Docs Index](README.md) · [Examples](../examples/README.md) · [Security](security.md) · [Worker Isolation](worker-isolation.md)

**sablejs v2** is a ground-up architectural shift, not a drop-in upgrade. Instead of encoding programs into custom opcodes for an embedded interpreter with boxed VM values (v1), v2 compiles guest JavaScript (with built-in ES2015+ → ES5.1 lowering) ahead of time into a plain CommonJS module that runs directly on the host JS engine behind automatic copied-data and capability boundaries.

> [!NOTE]
> The npm `latest` dist-tag stays on v1 until v2 exits beta. Install v2 explicitly with `npm install sablejs@beta`. Artifacts compiled in v1 cannot run on v2 and must be recompiled.

## What changed at a glance

| Area | v1 | v2 |
| --- | --- | --- |
| **Compilation** | Global `sablejs` CLI (`sablejs -i guest.js -o out`) | Programmatic `compile()` API in build step or cache |
| **Output artifact** | Base64/JSON opcode payload | Standard CommonJS (`.cjs`) module importing `sablejs/runtime` |
| **Initialization** | `require("sablejs/runtime")()` VM constructor | `program.createInstance({ globals })` |
| **Data & objects** | Manual boxed values (`create*` / `as*` helpers) | Standard JS values deep-copied automatically in `sandbox` mode |
| **Host functions** | `vm.createFunction(...)` bindings | Raw functions in `globals` (auto-wrapped) or explicit `capability()` |
| **Lifecycle** | Reusable VM: `vm.run(payload)` / `vm.destroy()` | Single-run instance: `instance.run()` then `instance.dispose()` |
| **Engine** | Embedded opcode interpreter | AOT-generated host JS + lightweight boundary runtime |
| **Source hiding** | Encoded custom bytecode | Deterministic identifier aliasing (not secret storage) |

## Step 1 — Replace the CLI build with `compile()`

Keep compilation inside a trusted build script or server-side cache:

```js
// build.cjs
const fs = require("node:fs");
const { compile } = require("sablejs");

const source = fs.readFileSync("guest.js", "utf8");
const result = compile(source, {
  optimization: "O1", // default; O2/Os are experimental during hardening
  security: "sandbox",
  sourceMap: {
    mode: "external",
    sourceFile: "guest.js",
    generatedFile: "guest.cjs",
    sourceMapURL: "guest.cjs.map",
  },
});

fs.writeFileSync("guest.cjs", result.code);
fs.writeFileSync("guest.cjs.map", result.map);
```

Single-file ES2015–ES2025 guest scripts are lowered automatically inside `compile()` (`transform: "auto"`). Use esbuild/Babel/SWC (ahead of `compile()` or via a custom `options.transform` hook) if your inputs use `import`/`export` modules, TypeScript/JSX, or `async`/generators — see [Worker Isolation](worker-isolation.md#bundling-modern-js-for-browser-workers) for a complete browser bundling pipeline.

## Step 2 — Replace `vm.run()` with single-run instances

V2 instances run **once** and are meant to be disposed cleanly in `finally`:

```js
const program = require("./guest.cjs");

const instance = program.createInstance({
  globals: { input: { price: 100 } },
});

try {
  console.log(instance.run()); // returns the guest script's final expression value
} finally {
  instance.dispose();
}
```

Cache the compiled module (`require("./guest.cjs")` or `loadCompiledArtifact(code)`), never the `RuntimeInstance`.

## Step 3 — Replace boxed values & `vm.createFunction()`

V2 uses standard JS values instead of boxed handles. Plain objects, arrays, `Date`, `RegExp`, `Map`, `Set`, typed arrays/`Uint8Array`, cycles, and shared references are copied across the boundary automatically:

```js
const { capability } = require("sablejs");

// Option A: raw functions in `globals` are auto-wrapped as capabilities
const instance = program.createInstance({
  globals: {
    input: { id: "record-1" },
    load: async function (id) {
      return database.get(id); // return plain, copyable data
    },
    // Option B: use capability() when you need a custom wrapper name or `this` receiver
    save: capability(api.save, { name: "save", thisValue: api }),
  },
});
```

Capability arguments and return values are copied, thrown host error stacks are stripped, and wrappers are revoked when `instance.dispose()` runs. Class instances, DOM nodes, and Node APIs (`fs`, `process`) are rejected in `sandbox` mode — expose narrow capability functions instead.

## Step 4 — Add Worker timeouts for untrusted code

The language boundary restricts what code can *access*, not CPU time or memory. Run untrusted compute-only programs inside `sablejs/worker` so your host can enforce wall-clock limits and terminate runaway workers. See [Worker Isolation](worker-isolation.md).

## Key behavioral differences to review

- **Default security is strict:** `security: "sandbox"` is on by default (`security: "trusted"` passes raw references and unwraps `capability()` tokens for trusted programs).
- **Script format:** Guest programs are scripts with no `import`/`export` (ES5.1–ES2025 syntax supported out of the box). `instance.run()` returns the completion value of the final expression.
- **No runtime string eval:** Global runtime `eval` and `new Function(dynamicVar)` are disabled. Literal static inputs (`eval("1 + 2")`, `new Function("x", "return x")`) can be AOT-compiled.
- **Worker channels carry data only:** Functions returned by `instance.run()` can be called in-process, but cannot cross `postMessage`. In Workers, pass arguments via `input` per message.
- **Client bundles:** Generated code aliases local identifiers deterministically, which is not encryption. Never embed secrets or private source maps in client-shipped artifacts.

## Migration checklist

- [ ] Install `sablejs@beta` alongside or ahead of retiring v1.
- [ ] Replace the `sablejs` CLI step with `compile()` at build time or in a server-side cache.
- [ ] Recompile all v1 programs into `.cjs` artifacts.
- [ ] Replace manual boxed values and `vm.createFunction()` with plain `globals` objects and `capability()`.
- [ ] Migrate reusable VM calls to `createInstance()` → `run()` → `dispose()` per execution.
- [ ] Wrap untrusted execution in `sablejs/worker` with `timeoutMs` and payload size checks.
- [ ] Verify error handling, source maps, and behavior at both `O0` and your target optimization level.
