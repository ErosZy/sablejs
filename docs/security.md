# Security & threat model

[← README](../README.md) · [Docs Index](README.md) · [Worker Isolation](worker-isolation.md) · [Security Policy](../SECURITY.md)

**sablejs** enforces **controlled execution**: untrusted, user-authored, or AI-generated JavaScript can compute on copied data and invoke explicit host capabilities, without reaching ambient host globals, mutating shared prototypes, or executing dynamic host code.

---

## Threat model

- **In scope (untrusted):** The guest ES5.1 program, every value it constructs at runtime (`{}`, arrays, closures, proxies, errors), and all `globals` data copied into the guest — including malicious reflection (`constructor` chains), prototype pollution, exotic prototypes, and deeply nested payloads.
- **Trusted:** The build-time compiler, `sablejs/runtime`, the host application loading the compiled `.cjs` artifact, and every capability function authored by the host.
- **Out of scope (host responsibility):** CPU time and memory exhaustion. Run untrusted programs in a dedicated [`sablejs/worker`](worker-isolation.md) for wall-clock termination, validate source/input/output payload sizes, and apply host/process memory controls. Never embed secrets in client-shipped bundles.

---

## Trust boundaries & components

| Component | Trust | Responsibility |
| --- | --- | --- |
| **Compiler** (`src/compiler`, `src/frontend`, `src/ir`, `src/backend`, `src/codegen`) | Trusted (build-time) | Parses ES5.1 and emits CommonJS. Compiles literal static `eval`/`Function`; rejects runtime dynamic code. |
| **Generated code** (`.cjs`) | Untrusted execution | Implements guest logic using runtime helpers. Contains no `eval`, `new Function`, or opcode loop. |
| **Runtime** (`src/runtime`) | Trusted | Executes frames, calls, `arguments`, and property ops, routing boundary values through mediation. |
| **Sandbox boundary** (`src/runtime/security.js`) | Trusted mediation point | Mediates reads, writes, calls, construction, iterative deep-cloning, and capability dispatch. |
| **`capability()`** | Trusted host wrapper | Deep-copies arguments/returns, strips host error stacks, and revokes the guest wrapper on `dispose()`. |
| **Worker** (`sablejs/worker`) | Host resource layer | Serializes requests and enforces wall-clock timeouts + hard Worker termination. |

**Core boundary invariant:** In `sandbox` mode, guest code may **read** shared built-ins, never **mutate** them, never construct runtime code, and never receive an unmediated host object or raw host function.

---

## Value & object taxonomy

| Category | Sandbox handling |
| --- | --- |
| **Protected intrinsics** | `Object`, `Array`, `Math`, prototypes, etc. Readable and mediated-callable; any mutation throws a boundary `TypeError`. |
| **Guest-owned objects** | Everything created by guest code (`{}`, `new Date()`, proxies). Fully mutable inside the instance; copied on capability crossings. |
| **Injected `globals` data** | Iteratively deep-copied at `createInstance()` (handling cycles and graphs 100k+ deep without stack overflow). Accessors, symbols, custom prototypes, class instances, and ambient objects (`globalThis`, `process`) are rejected. |
| **Capability tokens** | Frozen null-prototype tokens from `capability(fn, { name, thisValue })`. Raw functions in `globals` auto-wrap using the same machinery in `sandbox` mode and unwrap to raw functions in `trusted` mode. |
| **Mediated wrappers** | Guest-facing wrappers around capabilities and intrinsic methods. Targets live in a module-private `WeakMap` (unobservable, unforgeable); `toString` is redacted and `Function.prototype.toString` refuses wrapper receivers. |

---

## Key security policies

- **Dynamic code:** Runtime `eval(expr)` and `new Function(...)` fail closed. Static literal inputs are AOT-compiled cleanly into guest code bound to the guest global.
- **Prototype & intrinsic locking:** Mutations via direct assignment, `Object.defineProperty`, `Reflect.*`, `Array.prototype.push.call`, `__defineGetter__`, `__proto__`, `Error.captureStackTrace` (rejected outright), and proxy-wrapping protected targets are all blocked.
- **Host stack privacy:** Boundary errors carry no stack trace; host errors thrown inside capabilities are sanitized into plain copies with no host file paths.
- **`Proxy` & `Symbol`:** Guests may proxy their own objects (traps run as mediated guest code), not protected intrinsics. Wrappers store targets in a private `WeakMap` with **no hidden symbols**, so `Reflect.ownKeys` and proxy traps cannot observe or steer boundary state.
- **Trap-free `writeTarget` resolution:** Checking mutability and resolving wrappers happen synchronously in one trap-free pass before any write.
- **`Map`, `Set`, typed arrays, `Buffer`, `SharedArrayBuffer`, `Intl`:** Collections and typed arrays work inside the guest and clone across capability calls. Node `Buffer` clones into plain `Uint8Array` (stripping Node `Buffer.prototype`). `SharedArrayBuffer` is rejected across capability boundaries. `Atomics` and `Intl` follow host availability.
- **Extend intrinsics before first instance:** The protected intrinsic graph is snapshotted once on the first sandbox `createInstance()`. Any host prototype extensions made afterwards cannot be safely writable or callable.
- **Cross-instance & host-entry safety:** Compiled closures and wrappers are branded per runtime so smuggling them into another instance's `globals` throws. Guest functions returned by `run()` copy host arguments/receivers on entry, while nested callbacks (`toJSON`, regex replacers, proxy traps) keep guest reference semantics.
- **`security: "trusted"`:** Zero-copy reference pass-through mode that preserves raw host objects, prototypes, stacks, and unwrapped `capability()` tokens. Use **only** for fully trusted programs.

---

## Verification & 2026-08-22 internal audit

Continuous verification runs at all four optimization levels (`O0`, `O1`, `O2`, `Os`):

- `npm test` — 100+ adversarial security probes (zero skipped) covering function-constructor chains, prototype pollution, `WeakMap`/enumeration internals, proxy trap steering, and iterative clone edge cases.
- `npm run test:differential` / `npm run test:differential:boundary` — cross-engine comparison against native V8 and QuickJS.
- `npm run test262` — pinned ES5.1 conformance gate.

### Summary of the 2026-08-22 internal boundary audit

An internal boundary audit found no usable host-code escape or host-object-graph leak within the threat model. Four findings (plus iterative clone hardening) were resolved with permanent regression tests:

1. **Dynamic-scope mediation mismatch at O2/Os (fixed):** Property reads through `eval`/`with`/`try-catch` now stay mediated cleanly across chained reads at all optimization levels.
2. **Host stack disclosure (fixed):** Stripped boundary stacks, rejected `Error.captureStackTrace`, and blocked `Function.prototype.toString` on wrappers.
3. **Host re-dispatch surface (`callHost`):** Audited reachable functions; stripped Node `Buffer.prototype` to `Uint8Array` on clone.
4. **Guest-observable wrapper symbol tag (fixed):** Replaced the symbol tag with the module-private `wrapperTargets` `WeakMap` and added enumeration/trap-steering sweeps.

For vulnerability reporting guidelines, see [SECURITY.md](../SECURITY.md).
