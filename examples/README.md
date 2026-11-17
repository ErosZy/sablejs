# sablejs examples

[← README](../README.md) · [Docs Index](../docs/README.md) · [Quick Start](../README.md#quick-start) · [Worker Isolation](../docs/worker-isolation.md) · [Security](../docs/security.md)

Every example below is runnable directly from a checkout of this repository and is verified in CI by `npm run check:examples` (Deno and Bun tests run whenever those runtimes are installed).

> [!TIP]
> **Three-piece mental model:** `compile()` compiles guest JS (ES5.1–ES2025) once (at build time or in a cache) → the generated `.cjs` **artifact** depends only on `sablejs/runtime` → each call runs `program.createInstance({ globals })` → `instance.run()` → `instance.dispose()`.

## Find the right example

| Goal | Start here | Run it |
| --- | --- | --- |
| Evaluate a snippet in Node.js | [`node/basic.cjs`](node/basic.cjs) | `node examples/node/basic.cjs` |
| Handle guest, capability, and boundary errors | [`node/error-handling.cjs`](node/error-handling.cjs) | `node examples/node/error-handling.cjs` |
| Expose host capabilities & call guest functions | [`node/functions.cjs`](node/functions.cjs) | `node examples/node/functions.cjs` |
| Precompile at build time (zero compiler in prod) | [`precompile/`](precompile/) | `node examples/precompile/build.cjs && node examples/precompile/run.cjs` |
| Cache compiled artifacts by source/options hash | [`caching/cache.cjs`](caching/cache.cjs) | `node examples/caching/cache.cjs` |
| Enforce wall-clock timeouts in a Worker | [`worker/`](worker/) | `node examples/worker/host.cjs` |
| Bundle for browsers with inline source maps | [`browser/`](browser/) | `node examples/browser/build.cjs` (open `examples/browser/index.html`) |
| Run trusted host-reference code (`security: "trusted"`) | [`trusted/trusted.cjs`](trusted/trusted.cjs) | `node examples/trusted/trusted.cjs` |
| Bundle for Deno | [`deno/`](deno/) | `node examples/deno/build.mjs && deno run examples/deno/main.ts` |
| Run in Bun | [`bun/`](bun/) | `bun examples/bun/main.ts` |

## What each directory covers

- **`node/basic.cjs`** — Minimal end-to-end flow: `compile()` → write `.cjs` + `.map` → `createInstance()` → `run()` → `dispose()`.
- **`node/error-handling.cjs`** — Option validation errors, guest `throw` values, sanitized sandbox capability errors vs raw trusted stacks, stackless boundary rejections, and single-run lifecycle errors.
- **`node/functions.cjs`** — Exporting stateful guest closures across calls, auto-wrapped host functions in `globals` and call arguments, explicit `capability(fn, { name, thisValue })`, and the single-call `input` global pattern.
- **`precompile/`** — Recommended production setup: build scripts produce `out/program.cjs`, `program.cjs.map`, and `metadata.json`; the runtime script never imports the compiler.
- **`caching/cache.cjs`** — Content-addressed cache keyed by `sha256(source + canonical options + compiler version + schema)` so identical inputs skip recompilation.
- **`worker/`** — Serialized worker execution and per-run `timeoutMs` cancellation using `sablejs/worker`, including the small Node `worker_threads` event adapter.
- **`browser/`** — Bundles a precompiled artifact for browsers with esbuild while preserving inline Source Map v3 mappings back to `guest.js`.
- **`trusted/trusted.cjs`** — Contrasts `security: "trusted"` (direct `globalThis` access, reference identity, prototype chains, unmasked stacks, unwrapped `capability()` tokens) against default `sandbox` behavior.
- **`deno/` & `bun/`** — Cross-runtime usage in Deno (`--platform=neutral` esbuild bundle) and Bun (`require`-compatible loading).

Application users can copy any pattern above after installing `sablejs@beta`. Inside this repo checkout, all examples resolve directly through the local `package.json` `exports` map with no extra install steps beyond `npm install` at the repository root.
