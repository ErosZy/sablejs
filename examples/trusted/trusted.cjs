// Trusted mode: the compiled program shares host objects by reference.
//
//   node examples/trusted/trusted.cjs
//
// `security: "trusted"` is an explicit opt-out of the sandbox. The guest can
// touch anything it is given: host objects mutate in place, prototypes and
// getters work, host errors surface raw with stacks, and capability tokens
// unwrap back to their raw functions. Use it only when the compiled program
// is fully trusted — the threat model is in docs/security.md.

const { compile, capability } = require("sablejs");

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

function compileTrusted(source, globals, input) {
  const program = load(compile(source, { security: "trusted", optimization: "O2" }).code);
  const instance = program.createInstance({ globals: Object.assign({ input }, globals) });
  const value = instance.run();
  instance.dispose();
  return value;
}

// --- 1. globalThis values, directly. --------------------------------------
// Pass the host globalThis itself through globals: trusted mode hands it over
// by reference, so the guest reads host globals (`process`) and writes land
// on the real host global object — visible outside the run. Sandbox mode
// refuses the same literal (the host global is an ambient object).
{
  const source = `
    GLOBAL.marker = 123;                         // host-side write, by reference
    [
      GLOBAL === hostGlobalThis,                 // identity is preserved
      typeof GLOBAL.process,                     // host global, no wrapper needed
      GLOBAL.process ? GLOBAL.process.version : null,
    ];
  `;
  const value = compileTrusted(source, { GLOBAL: globalThis, hostGlobalThis: globalThis }, null);
  console.log("1. trusted globalThis:", JSON.stringify(value));
  console.log("1. host sees marker  :", globalThis.marker);
  delete globalThis.marker;

  try {
    load(compile("GLOBAL.marker = 1;", { security: "sandbox" }).code).createInstance({
      globals: { GLOBAL: globalThis },
    });
  } catch (error) {
    console.log("1. sandbox contrast  :", error.message);
  }
}

// --- 2. Host objects mutate in place; identity is preserved. --------------
{
  const host = { count: 1 };
  const value = compileTrusted("input.count += 1; input;", {}, host);
  console.log("2. reference identity:", value === host, "| host.count now", host.count);
}

// --- 3. Prototypes, getters, and instanceof work. -------------------------
{
  class Ctor {
    constructor(n) {
      this.n = n;
    }
    get() {
      return this.n * 10;
    }
  }
  const obj = {
    get getter() {
      return 7;
    },
  };
  const value = compileTrusted(
    "var o = new input.Ctor(3); [o.get() + input.obj.getter, o instanceof input.Ctor];",
    {},
    { Ctor, obj }
  );
  console.log("3. prototype chain  :", JSON.stringify(value), "(method + getter + instanceof)");
}

// --- 4. Host errors surface raw, stack included. --------------------------
{
  const value = compileTrusted(
    "(function () { try { return boom(); } catch (e) { return [e.name, e.message, typeof e.stack]; } })();",
    {
      boom: () => {
        throw new Error("raw boom");
      },
    },
    null
  );
  console.log("4. raw host error   :", JSON.stringify(value), "(stack survives the boundary)");
}

// --- 5. Capability tokens unwrap back to their raw functions. -------------
// The same globals literal serves both modes: sandbox wraps, trusted unwraps.
{
  const rawFn = (n) => n * 10;
  const tok = capability(rawFn, { name: "tok" });
  const value = compileTrusted(
    "(function () { return [tok === raw, tok(2)]; })();",
    { tok, raw: rawFn },
    null
  );
  console.log("5. token unwraps    :", JSON.stringify(value), "(tok === the raw host function)");
}

// --- 6. Guest-internal state still cannot reach the host. -----------------
// Trusted changes crossing, not language: a bare assignment targets the
// guest's own global object, which the host never sees.
{
  const source = "guestOnly = 42; [typeof guestOnly];";
  const value = compileTrusted(source, {}, null);
  console.log(
    "6. guest global only :",
    JSON.stringify(value),
    "| host sees 'guestOnly':",
    typeof globalThis.guestOnly
  );
}
