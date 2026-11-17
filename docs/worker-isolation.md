# Worker isolation & timeouts

[← README](../README.md) · [Docs Index](README.md) · [Examples](../examples/README.md) · [Security](security.md)

> [!IMPORTANT]
> **`sandbox` restricts what code can reach; a Worker restricts how long it can run.** Never run untrusted code without a wall-clock timeout and payload limits. Never reuse a terminated Worker.

`sablejs/worker` pairs two helpers:
- **`handleSandboxMessages(program, options)`** (worker side): creates and disposes a fresh instance for every request and serializes execution.
- **`createSandboxClient(worker, options)`** (host side): adds `timeoutMs` cancellation, validates response messages, and terminates stalled Workers.

---

## Quick setup (3 steps)

### 1. Create the worker script

```js
// sandbox.worker.js
const program = require("./.sable/program.cjs");
require("sablejs/worker").handleSandboxMessages(program);
```

### 2. Call it from the host

```js
// host.js (browser Worker — see Node adapter note below)
const { createSandboxClient } = require("sablejs/worker");

const worker = new Worker("/sandbox.worker.js");
const sandbox = createSandboxClient(worker, { timeoutMs: 1000 });

try {
  const result = await sandbox.run({ price: 100 }); // { total: 120 }
  console.log(result);
} finally {
  sandbox.terminate();
}
```

### 3. Know the lifecycle rules

- **Workers are reusable across normal runs:** Each `sandbox.run(input)` executes inside a fresh, single-run `RuntimeInstance` and disposes it before responding, so guest state never leaks between calls.
- **Timeouts terminate permanently:** If a request exceeds `timeoutMs` (overrideable per call via `sandbox.run(input, { timeoutMs: 250 })`), the client rejects and kills the Worker. Spawn a new Worker for future runs.
- **Plain data only over `postMessage`:** Both `input` and the return value must be structured-cloneable (no functions). Errors return as sanitized message strings.
- **One request runs at a time per Worker:** Messages queue and execute strictly serially (including Promise-returning capability calls). Use multiple Workers if you need true parallelism.

---

## Calling functions through a Worker

Because functions cannot cross `postMessage`, end your guest script with a call that reads `input`, rather than returning a function reference:

```js
// Single function: user-code.js
function price(input) {
  var tax = input.region === "eu" ? 0.2 : 0;
  return { total: input.base * (1 + tax) };
}
price(input);
```

```js
await sandbox.run({ base: 100, region: "us" }); // { total: 100 }
await sandbox.run({ base: 100, region: "eu" }); // { total: 120 }
```

To expose multiple named operations from one Worker, dispatch on an `op` field:

```js
// Dispatch pattern: user-code.js
var handlers = {
  price: function (args) { return { total: args.base * 1.2 }; },
  discount: function (args) { return { base: args.base, off: Math.min(args.off, args.base) }; },
};
handlers[input.op](input.args);
```

```js
await sandbox.run({ op: "price", args: { base: 100 } });            // { total: 120 }
await sandbox.run({ op: "discount", args: { base: 100, off: 30 } }); // { base: 100, off: 30 }
```

---

## Bundling modern JS for browser Workers

Single-file ES2015–ES2025 scripts lower directly inside `compile()`. When your guest pipeline also uses `import`/`export` modules, TypeScript, JSX, or `async`/generators, install `esbuild` (plus `@babel/core` / `@babel/preset-env` for `async` or generator transforms) alongside `sablejs@beta` to normalize inputs ahead of `compile()` and bundle the Worker for browsers:

```sh
npm install sablejs@beta
npm install --save-dev @babel/core @babel/preset-env esbuild
```

```js
// build-sandbox.js
const fs = require("node:fs");
const path = require("node:path");
const babel = require("@babel/core");
const presetEnv = require("@babel/preset-env");
const esbuild = require("esbuild");
const { compile } = require("sablejs");

async function build() {
  const source = fs.readFileSync("user-code.js", "utf8");
  const normalized = await esbuild.transform(source, { loader: "js", target: "es2015" });

  const es5 = babel.transformSync(normalized.code, {
    babelrc: false,
    configFile: false,
    sourceType: "script",
    presets: [[presetEnv, { modules: false, targets: { ie: "11" }, useBuiltIns: false }]],
  }).code;

  const generated = compile(es5, { runtimeModule: "sablejs/runtime" });

  fs.mkdirSync(".sable", { recursive: true });
  fs.writeFileSync(".sable/program.cjs", generated.code);

  await esbuild.build({
    entryPoints: [path.resolve("sandbox.worker.js")],
    bundle: true,
    platform: "browser",
    format: "iife",
    outfile: "public/sandbox.worker.js",
  });
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

---

## Evaluating compiled artifacts dynamically (`sandbox.evaluate`)

If you compile many short or AI-generated scripts on a trusted server, you can reuse one running Worker via `sandbox.evaluate(artifactCode, input)`:

```js
const { compile } = require("sablejs");

const artifactCode = compile("({ total: input.price * 1.2 });").code;
const result = await sandbox.evaluate(artifactCode, { price: 100 });
```

> [!WARNING]
> **Only pass AOT-compiled `compile().code` artifacts to `evaluate()`, never raw user source.** The default loader (`loadCompiledArtifact`) executes the artifact wrapper with `new Function` at Worker privilege, requiring a CSP that allows it. Under strict CSP, precompile at build time (`run()`), or supply a custom `options.loadProgram` (also required in browser bundles so dynamic loads resolve the bundled runtime).

---

## Capabilities inside a Worker & timeouts

Because functions cannot cross `postMessage`, stock `handleSandboxMessages` injects only `input`. If your guest code needs host capabilities *plus* Worker timeout protection, define the capabilities inside a custom Worker script while keeping `createSandboxClient` on the host:

```js
// budget.worker.js
const { capability } = require("sablejs");
const program = require("./.sable/program.cjs");

const save = capability(async function (record) {
  const res = await fetch("/api/records", {
    method: "POST",
    body: JSON.stringify(record),
  });
  return { saved: res.ok };
}, { name: "save" });

let queue = Promise.resolve();
self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg.id !== "number") return;
  queue = queue.then(async () => {
    let instance;
    try {
      instance = program.createInstance({ globals: { save, input: msg.input } });
      const raw = instance.run();
      const value = raw instanceof Promise ? await raw : raw;
      self.postMessage({ id: msg.id, ok: true, value });
    } catch (error) {
      self.postMessage({ id: msg.id, ok: false, error: String((error && error.message) || error) });
    } finally {
      if (instance) instance.dispose();
    }
  });
};
```

### Per-call timeouts for async capabilities

If an async host capability hangs forever, `await raw` hangs unless wrapped with a race timer shorter than the Worker's `timeoutMs` (use an `AbortSignal` when you also want to cancel underlying work):

```js
const { capability } = require("sablejs");

function timeoutCapability(hostFn, { name, timeoutMs, onTimeout } = {}) {
  return capability(async function (...args) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`capability ${name} timed out after ${timeoutMs} ms`);
        err.name = "TimeoutError";
        if (onTimeout) onTimeout(err, args);
        reject(err);
      }, timeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve(hostFn(...args)), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }, { name });
}
```

> [!NOTE]
> Synchronous blocking capabilities (busy loops or sync I/O) freeze the event loop so timers cannot fire. Only the Worker's `timeoutMs` termination can preempt synchronous hangs.

---

## Node.js `worker_threads` adapter

`sablejs/worker` targets the Web `Worker` interface (`addEventListener` receiving `{ data }`, `self` in the worker). In Node.js:
- On the worker side, pass `{ scope: parentPort, postMessage: (msg) => parentPort.postMessage(msg) }` to `handleSandboxMessages`.
- On the host side, wrap `worker_threads.Worker` with an `addEventListener` adapter that forwards `worker.on("message", (data) => listener({ data }))`.

See the complete runnable example in [`examples/worker/`](../examples/worker/host.cjs).

## Memory & payload size budgets

Browser Workers do not expose a portable hard memory cap. Always pair `timeoutMs` with host-side checks on guest source length, input payload size, and output size (plus OS/process memory limits on servers):

```js
function runWithBudgets(source, input, budgets) {
  if (source.length > budgets.sourceBytes) throw new Error("source too large");
  if (JSON.stringify(input).length > budgets.inputBytes) throw new Error("input too large");
  return sandbox.run(input).then((value) => {
    if (JSON.stringify(value).length > budgets.outputBytes) throw new Error("output too large");
    return value;
  });
}
```

Never place secrets inside client-side bundles or worker scripts.
