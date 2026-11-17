"use strict";

// Official Worker isolation helpers. A Worker supplies a separately
// terminable execution agent; these helpers add serialized requests,
// wall-clock timeouts, response validation, and forceful termination.
// Portable hard memory quotas are host-specific. See docs/worker-isolation.md.
//
// Protocol between the two sides:
//   host -> worker: { id: number, input: <plain data>, program?: <artifact code> }
//   worker -> host: { id: number, ok: boolean, value?: <plain data>, error?: string }
// Without `program` the message runs the bound program (run); with `program`
// it loads and runs the given compiled artifact (evaluate). Every execution
// creates a fresh instance and disposes it, so one worker serves many
// serialized requests until a timeout, Worker error, or explicit termination.

const WORKER_MODULE = "sablejs/worker";

// Default artifact loader (Node). The generated code is AOT-compiled trusted
// output — it contains no evaluator — and the only module it imports is the
// sablejs runtime. Browser builds bundle the runtime into the worker script
// instead; pass options.loadProgram to supply the bundled runtime.
function loadCompiledArtifact(code) {
  const runtimeRequire = (specifier) => {
    if (specifier === "sablejs/runtime" || specifier === "sablejs") {
      return require("sablejs/runtime");
    }
    throw new Error(`sandbox worker cannot resolve module ${specifier}`);
  };
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("require", "module", "exports", code)(runtimeRequire, module, module.exports);
  return module.exports;
}

function validateResponse(message) {
  if (!message || typeof message !== "object") return "worker sent a non-object response";
  if (typeof message.id !== "number") return "worker response is missing its id";
  if (typeof message.ok !== "boolean") return "worker response is missing ok";
  if (message.ok && !Object.prototype.hasOwnProperty.call(message, "value")) {
    return "worker success response is missing value";
  }
  if (!message.ok && typeof message.error !== "string") {
    return "worker failure response is missing error";
  }
  return null;
}

function normalizeTimeout(value, label = "timeoutMs") {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new TypeError(`sandbox client ${label} must be a positive number`);
  }
  return timeout;
}

// Host-side client. `worker` is any object with addEventListener,
// postMessage, and terminate (a browser Worker or a compatible wrapper).
// The timeout terminates the worker, so a timed-out worker cannot be
// reused; recreate it for further runs.
function createSandboxClient(worker, options = {}) {
  const timeoutMs = normalizeTimeout(options.timeoutMs == null ? 1000 : options.timeoutMs);
  let nextId = 0;
  const pending = new Map();
  let terminated = false;

  function rejectAll(reason) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    pending.clear();
  }

  worker.addEventListener("message", (event) => {
    const message = event.data;
    const entry = pending.get(message && message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    const problem = validateResponse(message);
    if (problem) {
      entry.reject(new Error(problem));
    } else if (message.ok) {
      entry.resolve(message.value);
    } else {
      entry.reject(new Error(message.error));
    }
  });

  worker.addEventListener("error", (event) => {
    terminated = true;
    rejectAll(
      new Error(
        `sandbox worker failed: ${event && event.message ? event.message : "unknown error"}`
      )
    );
    worker.terminate();
  });

  function dispatch(payload, perCallOptions) {
    if (terminated) return Promise.reject(new Error("sandbox worker has been terminated"));
    let timeout;
    try {
      timeout = normalizeTimeout(
        perCallOptions.timeoutMs == null ? timeoutMs : perCallOptions.timeoutMs,
        "per-call timeoutMs"
      );
    } catch (error) {
      return Promise.reject(error);
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        terminated = true;
        worker.terminate();
        reject(
          new Error(`sandbox execution timed out after ${timeout} ms; the worker was terminated`)
        );
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage(
          Object.assign(
            { id, input: payload.input },
            payload.program !== undefined ? { program: payload.program } : {}
          )
        );
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  return {
    // Runs the bound program with copied `input` data. The input must be
    // structured-cloneable plain data (the same shape importGlobals accepts).
    run(input, perCallOptions = {}) {
      return dispatch({ input }, perCallOptions);
    },
    // Evaluates one compiled artifact with copied `input`. `program` is the
    // artifact code from compile() — never user source; the worker loads it
    // at worker privilege. The worker survives repeated run/evaluate calls.
    evaluate(program, input, perCallOptions = {}) {
      if (typeof program !== "string") {
        return Promise.reject(
          new TypeError("sandbox evaluate expects the compiled artifact code (a string)")
        );
      }
      return dispatch({ input, program }, perCallOptions);
    },
    terminate() {
      terminated = true;
      rejectAll(new Error("sandbox worker was terminated"));
      worker.terminate();
    },
  };
}

// Worker-side handler. Wire it into a worker script built with the compiled
// program (see the README build flow):
//
//   const program = require("./.sable/program.cjs");
//   require("sablejs/worker").handleSandboxMessages(program);
//
// It serializes messages, awaits real Promise results, answers once per
// execution, and disposes the instance afterwards.
// Messages carrying `program` load that artifact first (evaluate); the last
// loaded artifact is cached so repeated evaluation skips the module load.
function handleSandboxMessages(program, options = {}) {
  const post = options.postMessage || ((message) => self.postMessage(message));
  const scope = options.scope || self;
  const loadProgram = options.loadProgram || loadCompiledArtifact;
  let cachedCode = null;
  let cachedProgram = null;
  let queue = Promise.resolve();

  async function executeMessage(message) {
    let instance;
    try {
      let target = program;
      if (message.program !== undefined && message.program !== null) {
        if (typeof message.program !== "string") {
          throw new TypeError("sandbox evaluate messages must carry a compiled artifact string");
        }
        if (message.program !== cachedCode) {
          cachedProgram = loadProgram(message.program);
          cachedCode = message.program;
        }
        target = cachedProgram;
      }
      instance = target.createInstance({ globals: { input: message.input } });
      const result = instance.run();
      // ES5 guest programs are synchronous by default, but a program ending
      // in an async capability call returns the host Promise manufactured by
      // the boundary. Await only real Promises, not arbitrary guest thenables.
      const value =
        typeof Promise !== "undefined" && result instanceof Promise ? await result : result;
      post({ id: message.id, ok: true, value });
    } catch (error) {
      // Errors crossing the message channel must be sanitized strings;
      // structured cloning would strip host error objects anyway.
      post({ id: message.id, ok: false, error: String((error && error.message) || error) });
    } finally {
      if (instance) instance.dispose();
    }
  }

  scope.onmessage = (event) => {
    const message = event.data;
    if (!message || typeof message.id !== "number") return;
    // Serialize both CPU-bound runs and async capabilities. This makes the
    // documented one-request-at-a-time lifecycle an enforced invariant and
    // prevents instances from overlapping inside one Worker.
    queue = queue.then(
      () => executeMessage(message),
      () => executeMessage(message)
    );
  };
}

module.exports = {
  WORKER_MODULE,
  createSandboxClient,
  handleSandboxMessages,
  loadCompiledArtifact,
  validateResponse,
};
