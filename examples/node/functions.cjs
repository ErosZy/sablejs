// In-process guest function calls: how to call functions out of a compiled
// program, the ways data crosses the call, and the state rules.
//
//   node examples/node/functions.cjs
//
// The compiler is AOT — the artifact below is fixed at build time. What this
// example varies is the *calls*, not the program.

const { compile, capability } = require("sablejs");
const path = require("node:path");

// Load a compiled artifact from its code string (the compiler is not needed
// at runtime — see ../precompile for the full build-time split).
function load(code) {
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(
    (specifier) => {
      if (specifier === "sablejs/runtime" || specifier === "sablejs") {
        return require("sablejs/runtime");
      }
      throw new Error(`unexpected module ${specifier}`);
    },
    module,
    module.exports
  );
  return module.exports;
}

const mkdir = (dir) => require("node:fs").mkdirSync(dir, { recursive: true });
mkdir(path.join(__dirname, "..", ".cache", "node"));

// --- 1. End the program with a function; run() returns the callable. -----
// State keeps reference semantics between the guest's own frames: the
// closure's `log` array lives in the guest realm and persists across
// host-initiated calls. Only host-initiated calls copy — arguments and
// results cross the boundary, guest-internal state does not.
{
  const source = `
    var log = [];
    function tally(n) {
      log.push(n);
      return log.reduce(function (a, b) { return a + b; }, 0);
    }
    tally; // final expression -> run() returns the guest function
  `;
  const program = load(compile(source, { optimization: "O2" }).code);
  const instance = program.createInstance({ globals: {} });
  const tally = instance.run(); // synchronous
  console.log("1. guest closure  :", tally(1), tally(2), tally(3), "(state kept between calls)");
  instance.dispose();
}

// --- 2. The guest calls host capabilities while it runs. ------------------
// Any host function in `globals` auto-wraps as a capability (sandbox mode).
// The same works for functions passed as call *arguments* — they are copied
// like globals, so a host function in an argument position is callable too.
{
  const source = `
    function checkout(input) {
      return {
        line: round(input.line),
        tax: round(input.line * input.rate),
        qty: input.qty,
      };
    }
    checkout;
  `;
  const program = load(compile(source, { optimization: "O2" }).code);
  const instance = program.createInstance({
    globals: {
      round: (n) => Math.round(n * 100) / 100, // auto-wrapped capability
    },
  });
  const checkout = instance.run();
  console.log("2. via globals    :", checkout({ line: 19.996, rate: 0.2, qty: 2 }));

  // The capability can also arrive as an argument, exactly like globals.
  const apply = load(
    compile("function apply(f, n) { return f(n) * 2; } apply;", { optimization: "O2" }).code
  )
    .createInstance({})
    .run();
  console.log(
    "2. via argument   :",
    apply((n) => n + 1, 5),
    "(host fn passed as an argument)"
  );
  instance.dispose();
}

// --- 3. Explicit capability tokens — custom name and receiver. ------------
// Use capability() when you need to control the wrapper: { thisValue } binds
// a receiver, and the `name` is what surfaces in the errors the guest sees.
{
  const source = `
    function total(input) {
      try {
        return { sum: add(input.a, input.b), ok: true };
      } catch (error) {
        return { name: error.name, message: error.message, ok: false };
      }
    }
    total;
  `;
  const calculator = { base: 1000 };
  const add = capability(
    function (a, b) {
      if (typeof a !== "number" || typeof b !== "number") {
        throw new TypeError("only numbers"); // sanitized at the boundary
      }
      return this.base + a + b;
    },
    {
      name: "add",
      thisValue: calculator,
    }
  );
  const program = load(compile(source, { optimization: "O2" }).code);
  const instance = program.createInstance({ globals: { add } });
  const total = instance.run();
  console.log("3. capability()   :", total({ a: 1, b: 2 }), "(receiver bound via thisValue)");
  console.log(
    "3. capability()   :",
    total({ a: "1", b: 2 }),
    "(guest sees sanitized name+message)"
  );
  instance.dispose();
}

// --- 4. One call per run via the `input` global. --------------------------
// The alternative documented in the README: the program ends with the call,
// and arguments come in through the `input` global.
{
  const source = `
    function price(input) { return { total: input.price * 1.2 }; }
    price(input); // called once, inside the run
  `;
  const program = load(compile(source, { optimization: "O2" }).code);
  const instance = program.createInstance({ globals: { input: { price: 100 } } });
  console.log("4. input global   :", instance.run()); // synchronous value
  instance.dispose();
}
