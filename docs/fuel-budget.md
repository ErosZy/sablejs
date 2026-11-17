# Fuel budgets: compile-time loop instrumentation (research design)

[← README](../README.md) · [Docs Index](README.md) · [Worker Isolation](worker-isolation.md) · [Architecture](architecture.md)

> [!NOTE]
> **Status: research design only — not implemented.** Today, use a dedicated [`sablejs/worker`](worker-isolation.md) with `timeoutMs` for wall-clock termination.

This optional, opt-in design bounds **productive work** (loop iterations and function calls) deterministically via compile-time instrumentation, raising a clean guest-visible error instead of waiting on host stack exhaustion or clock jitter. When disabled, generated code stays byte-identical.

---

## Goals & non-goals

- **Goal:** Deterministic per-instance work budgets that catch infinite loops, unbounded recursion, and `try/catch` retry spinners cleanly.
- **Non-goals:** Wall-clock bounds or memory caps (still require a Worker + `timeoutMs` and host payload/memory limits), or any overhead on default builds without `fuel` enabled.

## Why the compiler pipeline supports this cleanly

1. **Natural loops already exist:** `src/ir/cfg.js` computes `cfg.loops: [{ header, backedge }]`. Placing checks at loop headers runs once per iteration rather than per instruction.
2. **Side-effect classification prevents elimination:** `src/ir/op-spec.js` classifies ops (`pure`/`allocate`/`read`/`write`/`host`/`dynamic`/`call`). Marking `FUELCHECK` as `host` prevents SCCP, GVN, DCE, or LICM from hoisting or deleting it.
3. **Exhaustive lowering check:** `validateLoweringCoverage` in `src/codegen/index.js` ensures new ops explicitly map to runtime helpers.

---

## Proposed design

### Compile & runtime mechanics

```js
// Sketch — not yet implemented
const artifact = compile(source, { fuel: true, fuelBudget: 1e6 });
const instance = artifact.createInstance({ fuel: 5e5 }); // optional per-instance override
instance.run(); // throws RangeError("sablejs fuel budget exceeded") on exhaustion
```

- **Insertion points:** Insert one `FUELCHECK` at every natural-loop header (`cfg.loops`) and optionally at each call/construct site (`fuel: true` vs `fuel: "loops"`). Call-site checks turn unbounded recursion into a deterministic budget error before overflowing the host JS call stack.
- **Runtime counter:** Decrement a runtime-private counter (`--frame.fuel <= 0` up to exact integer range `2^53`), unreachable and unforgeable by guest code.

### Closing the `catch`-retry infinite loop hole

A normal catchable exception cannot stop `try { while (true) {} } catch (e) {}`, because each thrown budget error jumps to `catch` and re-enters the loop.

**Recommended fix:** In `TRY`/`ENDTRY` catch lowering (only when `fuel` is enabled), rethrow a runtime-private `FUEL_SENTINEL` before entering the guest catch body:

```js
catch (e) { if (e === FUEL_SENTINEL) throw e; /* guest catch body */ }
```

Once fuel hits zero, the sentinel unwinds through every nested `catch` and exits cleanly as a sanitized guest `RangeError` (`RangeError` adds no non-ES5 built-in).

---

## Open design questions

- Measuring default `fuelBudget` overhead (`fuel: true` vs `fuel: "loops"`) across differential tests and V8 benchmarks before finalizing options.
- Verifying `FUEL_SENTINEL` interactions inside `finally` cleanup paths and `dispose()`.
- Deciding whether `sandbox.evaluate()` Worker runs should default `fuel` on for short-lived dynamic scripts.
