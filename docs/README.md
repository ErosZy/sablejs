# sablejs documentation

[← Back to README](../README.md) · [Quick Start](../README.md#quick-start) · [Examples](../examples/README.md) · [Changelog](../CHANGELOG.md)

Every execution flow in **sablejs** follows three steps:

1. **Compile** ES5.1 guest source (or Babel/SWC-downleveled JS/TS) into a standalone CommonJS module with `compile()`.
2. **Ship or cache** that compiled `.cjs` artifact alongside `sablejs/runtime`.
3. **Run and dispose** a fresh `createInstance({ globals })` per execution — optionally inside a `sablejs/worker` for timeouts.

## Start here

| Document | Read when you want to... |
| --- | --- |
| [Quick Start](../README.md#quick-start) | Run your first sandboxed program in 60 seconds |
| [Runnable Examples](../examples/README.md) | Copy working Node, Browser, Worker, Deno, Bun, precompile, or cache setups |
| [Choosing an Execution Model](comparison.md) | Decide between `sablejs`, QuickJS-WASM, cross-origin iframes, and raw `eval` |
| [Migrating from v1 to v2](migration-v2.md) | Upgrade an existing v1 codebase to v2 AOT modules and plain-data boundaries |
| [Compatibility](compatibility.md) | Check supported ES5.1 syntax, modern host globals, Babel downleveling, and Test262 rules |

## Production guides

| Document | Read when you want to... |
| --- | --- |
| [Worker Isolation & Timeouts](worker-isolation.md) | Enforce timeouts, isolate infinite loops, bundle browser workers, and set size budgets |
| [Security & Threat Model](security.md) | Review trust boundaries, object taxonomy, `Proxy`/`Symbol`/intrinsic rules, and audit findings |
| [Source Maps & Debugging](source-maps.md) | Configure inline/external Source Map v3 output, `node --enable-source-maps`, and DevTools |
| [Security Policy](../SECURITY.md) | Check supported versions or privately report a security issue |

## Architecture & engineering records

| Document | Read when you want to... |
| --- | --- |
| [Architecture](architecture.md) | Understand compiler layers (`frontend -> ir -> backend -> compiler -> runtime`), IR verification, and release checks |
| [Performance](performance.md) | Inspect historical V8/Octane/SunSpider/Kraken/workload benchmarks, bundle sizes, and reproduction scripts |
| [Roadmap](roadmap.md) | Track priorities, recent fixes, and remaining pre-stable milestones |
| [CFG & SSA Hardening Plan](cfg-ssa-hardening.md) | Review the compiler verification gates required before restoring `O2`/`Os` as the default |
| [Backend Optimization History](optimization.md) | Inspect the 2026-08 optimization batch design notes, kill switches, and historical measurements |
| [Fuel Budgets (Research Design)](fuel-budget.md) | Read the unimplemented compile-time loop-budget design proposal |
