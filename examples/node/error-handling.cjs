"use strict";

// Error handling: what throws where, and what the guest and host each see.
//
//   node examples/node/error-handling.cjs
//
// Contract in one line: the compiler throws for bad options; the runtime
// throws guest errors at run(); sandbox capability errors are sanitized
// (message preserved, stack deleted); boundary violations are stackless.

const { compile, capability } = require("sablejs");

// Load a compiled artifact from its code string (the generated code only
// imports the sablejs runtime). In an app you would `require()` the artifact
// file instead; this helper keeps the example single-file.
function load(code) {
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(
    (specifier) => {
      if (specifier === "sablejs/runtime" || specifier === "sablejs")
        return require("sablejs/runtime");
      throw new Error(`unexpected module ${specifier}`);
    },
    module,
    module.exports
  );
  return module.exports;
}

function run(source, globals = {}, options = {}) {
  const program = load(compile(source, { security: "sandbox", ...options }).code);
  const instance = program.createInstance({ globals });
  try {
    return instance.run();
  } finally {
    instance.dispose();
  }
}

// 1. Compile-time validation errors — thrown synchronously by compile(),
//    before any code is generated, with descriptive messages.
try {
  compile("1;", { security: "paranoid" });
} catch (error) {
  console.log("1. bad option    :", error.message);
  // "Unknown sablejs security mode paranoid"
}

try {
  compile("1;", { sourceMap: { mode: "embed" } });
} catch (error) {
  console.log("1. bad sourceMap:", error.message);
  // 'Invalid sourceMap mode "embed": expected "external" or "inline"'
}

// 2. Guest errors surface at run() with the guest's own message. This is
//    normal JS error flow — catch it and handle it like any other error.
try {
  run('throw new Error("guest boom");');
} catch (error) {
  console.log("2. guest throw  :", error.name, "-", error.message);
}

// 3. Host functions in `globals` become capabilities. In sandbox mode a
//    throwing capability is sanitized: the guest-visible error keeps its
//    name and message but its stack is deleted (host frames must not cross
//    the boundary).
const failingCapability = capability(() => {
  throw new TypeError("host database is down");
});

const guestView = run(
  "function callIt() { try { host.save(); } catch (e) { return [e.name, e.message, e.stack === undefined ? 'stackless' : 'stacked']; } } callIt();",
  { host: { save: failingCapability } }
);
console.log("3. sandbox cap  :", guestView.join(" - "));
// "TypeError - host database is down - stackless": message preserved, host
// frames stripped by the sandbox boundary.

// 4. In trusted mode, globals pass through by reference and the raw host
//    error surfaces unchanged (stack included). Pick the mode by trust
//    level, not by error behavior.
try {
  run(
    "host.save();",
    {
      host: {
        save: () => {
          throw new TypeError("raw host error");
        },
      },
    },
    { security: "trusted" }
  );
} catch (error) {
  console.log(
    "4. trusted cap  :",
    error.name,
    "-",
    error.message,
    "- stack:",
    error.stack ? "present" : "deleted"
  );
}

// 5. Sandbox boundary violations (here: polluting a host prototype) get
//    their stacks deleted by policy, so host internals never leak into
//    guest-visible errors.
const boundaryView = run(
  "var s = ''; try { Object.prototype.x = 1; } catch (e) { s = String(e.stack); } s;"
);
console.log("5. boundary     :", boundaryView === "undefined" ? "stack deleted" : "STACK LEAKED");
// "stack deleted" — the guest cannot observe host frames.

// 6. Instance lifecycle errors: instances are single-run and must be
//    disposed. Calling run() twice, or after dispose(), throws.
const program = load(compile("1;", {}).code);
const instance = program.createInstance({});
instance.run();
try {
  instance.run();
} catch (error) {
  console.log("6. double run   :", error.message);
}
instance.dispose();
try {
  instance.run();
} catch (error) {
  console.log("6. after dispose:", error.message);
}
