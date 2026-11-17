# Choosing an execution model

[← README](../README.md) · [Docs Index](README.md) · [Examples](../examples/README.md) · [Security](security.md) · [Worker Isolation](worker-isolation.md) · [Performance](performance.md)

**sablejs** is designed for running user-authored rules, formulas, plugins, and AI-generated scripts on the host JavaScript engine with copied data, explicit capabilities, and standard source maps. It is not a universal replacement for browser origin isolation or an embedded JavaScript VM.

## At a glance

| Model | Execution | Host boundary | Debugging | Best fit |
| --- | --- | --- | --- | --- |
| **sablejs** | AOT-compiled host JavaScript | Copied data + explicit capabilities; pair with a Worker for timeouts | Generated JS, HIR/MIR dumps, Source Map v3 | Pricing/workflow rules, formulas, data transforms, plugins, constrained AI scripts |
| **QuickJS-WASM** | Bytecode interpreter compiled to WebAssembly | Explicit VM/host bridge | VM-specific tooling (not host DevTools) | Apps needing arbitrary runtime `eval` or full isolation from host-engine semantics |
| **Cross-origin iframe** | Browser JS in a separate origin | Async `postMessage` + browser origin sandbox | Standard browser DevTools inside frame | Browser-only plugins requiring their own DOM, UI, and origin boundary |
| **Raw `eval` / `new Function`** | Host JS in current realm | None (unless you build your own) | Standard host DevTools | Fully trusted code only |

> [!NOTE]
> Security depends on your deployment — the API surface you expose, browser/runtime behavior, resource controls, and where compilation runs — not just the name of the sandbox mechanism.

## Choose sablejs when

- You can compile guest code at build time or cache compilation on a trusted server.
- You want synchronous or near-native host execution without shipping a WASM VM.
- You need standard Source Map v3 support and inspectable compiler output.
- Your host API maps cleanly to copied JSON-like data and narrow capability functions.
- Built-in ES2015+ → ES5.1 lowering (plus esbuild/Babel/SWC for modules, TS/JSX, or `async`) fits your pipeline.

## Choose another tool when

- **Arbitrary runtime `eval`** of uncompiled user code on the client is a hard requirement → use **QuickJS-WASM** (or compile on your trusted backend and dispatch via `sablejs/worker`).
- **Guest plugins need their own DOM / third-party UI** in browsers → use a **cross-origin iframe**.
- **Code is 100% author-trusted** at the same privilege level as your app → **raw `eval` / `new Function`** (or `sablejs` with `security: "trusted"`) has the lowest complexity. Note that putting raw `eval` in a Worker adds termination, **not** API isolation inside that Worker.

## Production deployment checklist

> [!IMPORTANT]
> For untrusted guest programs, combine all four layers:
> 1. Compile with default `security: "sandbox"`.
> 2. Pass copied plain data and narrow `capability()` functions only.
> 3. Run inside a dedicated Worker (`sablejs/worker`) with a wall-clock timeout.
> 4. Enforce source-length, input/output payload size, and host memory limits.

Read [Security & Threat Model](security.md) and [Worker Isolation](worker-isolation.md) before treating this boundary as part of a production security design.

## Performance note

Historical Linux x64 runs (2026-08-24) recorded `O2` sandbox/QuickJS-WASM ratios of `1.86x` on V8 Benchmark Suite 7 (`2,202` vs `1,181`), `1.16x` on the SunSpider subset, and `1.70x` on the Kraken subset. Treat those numbers strictly as historical corpus references: `O1` is the current default while [CFG/SSA hardening](cfg-ssa-hardening.md) closes, and the earlier QuickJS measurements included source evaluation inside the timed loop while `sablejs` was precompiled. See [Performance](performance.md) for raw figures and methodology.

*Inspired by Figma's [WebAssembly plugin sandbox](https://www.figma.com/blog/how-we-built-the-figma-plugin-system/) and its [QuickJS runtime](https://www.figma.com/plugin-docs/updates/2020/07/07/version-1-update-16/).*
