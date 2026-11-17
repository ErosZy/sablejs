"use strict";

const assert = require("assert");
const path = require("path");
const { describe, it } = require("node:test");
const sablejs = require("../../src");

const runtimeModule = path.resolve(__dirname, "../../src/runtime");

function load(source, options = {}) {
  const result = sablejs.compile(source, { runtimeModule, ...options });
  const generatedModule = { exports: {} };
  new Function("require", "module", "exports", result.code)(
    require,
    generatedModule,
    generatedModule.exports
  );
  return { result, program: generatedModule.exports };
}

function run(source, globals, options = {}) {
  const loaded = load(source, options);
  const instance = loaded.program.createInstance({ globals });
  return { ...loaded, instance, value: instance.run() };
}

function assertSandboxBlocked(source, pattern = /sablejs sandbox boundary/) {
  for (const optimization of ["O0", "O1", "O2", "Os"]) {
    assert.throws(
      () => run(source, undefined, { optimization }),
      pattern,
      `${optimization} allowed an escape path`
    );
  }
}

describe("sablejs sandbox security boundary", function () {
  it("uses sandbox mode by default and keeps trusted mode explicit", function () {
    const sandbox = load("1;");
    assert.equal(sandbox.result.metadata.security, "sandbox");
    assert.equal(sandbox.program.security, "sandbox");
    assert.throws(
      () => sandbox.program.createInstance({ security: "trusted" }),
      /compiled as sandbox/
    );
    assert.equal(load("1;", { security: "trusted" }).result.metadata.security, "trusted");
    assert.throws(() => load("1;", { security: "unknown" }), /security mode/);
  });

  it("keeps ambient globals outside the guest global object", function () {
    assert.deepStrictEqual(
      run(
        "[typeof globalThis, typeof global, typeof process, " +
          "Object.getPrototypeOf(this) === null, typeof this.constructor];"
      ).value,
      ["undefined", "undefined", "undefined", true, "undefined"]
    );
  });

  it("keeps mediated property and call operations on the optimized local stack", function () {
    const loaded = load(
      "var item = { value: 1, read: function () { return this.value; } }; " +
        "var ctor = item.constructor; item.value = item.read() + 1; item.value;",
      { optimization: "O2" }
    );
    assert.match(loaded.result.code, /getSandboxPropertyValue/);
    assert.match(loaded.result.code, /applySandboxValue/);
    // The written object is provably guest-created (literal stored in a
    // local), so the write takes the writeTarget-free guest path; reads and
    // calls of the same object stay mediated.
    assert.match(loaded.result.code, /setGuestPropertyValue/);
    assert.match(loaded.result.code, /\["read"\]/);
    assert.doesNotMatch(loaded.result.code, /\$r\.(?:getProperty|call|setProperty)/);
    assert.equal(loaded.program.createInstance().run(), 2);
  });

  it("blocks Function-constructor escapes through ordinary prototypes", function () {
    assertSandboxBlocked(
      "var HostFunction = ({}).constructor.constructor; " + "HostFunction('return this')();"
    );
  });

  it("blocks Function-constructor escapes through property descriptors", function () {
    assertSandboxBlocked(
      "var proto = Object.getPrototypeOf(function () {}); " +
        "var HostFunction = Object.getOwnPropertyDescriptor(proto, 'constructor').value; " +
        "HostFunction('return this')();"
    );
  });

  it("blocks Function-constructor escapes through bind and call", function () {
    assertSandboxBlocked(
      "var BoundFunction = Function.bind(null); BoundFunction('return this')();"
    );
    assertSandboxBlocked("Function.prototype.call.call(Function, null, 'return this')();");
  });

  it("blocks additional constructor and reflection escape chains", function () {
    assertSandboxBlocked(
      "Object.getOwnPropertyDescriptor(Object.prototype, 'constructor').value" +
        ".constructor('return this')();"
    );
    assertSandboxBlocked("Object.getPrototypeOf(Object).constructor('return this')();");
    assertSandboxBlocked("(function guest() {}).constructor('return this')();");
    assertSandboxBlocked("Reflect.apply(Function, null, ['return this'])();");
    assertSandboxBlocked("Reflect.construct(Function, ['return this'])();");
  });

  it("mediates raw intrinsic values delivered through native callbacks", function () {
    const prefix =
      "var descriptor = Object.getOwnPropertyDescriptor(Function.prototype, 'constructor'); " +
      "var values = Object.values(descriptor); " +
      "values.forEach(function (candidate) { if (typeof candidate === 'function') { ";
    assertSandboxBlocked(
      prefix + "Reflect.apply(candidate, null, ['return process.version'])(); } });"
    );
    assertSandboxBlocked(prefix + "candidate.call(null, 'return process.version')(); } });");
  });

  it("keeps the boundary active through with-environment lookups", function () {
    assertSandboxBlocked("with (Object.prototype) { constructor.constructor('return this')(); }");
  });

  it("copies plain globals recursively and preserves graph identity inside the guest", function () {
    const shared = { value: 1 };
    const host = { left: shared, right: shared };
    const loaded = run(
      "input.left.value = 9; [input.left === input.right, input.right.value, input];",
      { input: host }
    );
    assert.deepStrictEqual(loaded.value.slice(0, 2), [true, 9]);
    assert.notStrictEqual(loaded.value[2], host);
    assert.notStrictEqual(loaded.value[2].left, shared);
    assert.equal(host.left.value, 1);
  });

  it("rejects custom prototypes, accessors, and symbols in globals", function () {
    const inherited = Object.create({ inherited: globalThis });
    assert.throws(
      () => load("input;").program.createInstance({ globals: { input: inherited } }),
      /plain data/
    );

    let reads = 0;
    const accessor = {};
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get() {
        reads += 1;
        return globalThis;
      },
    });
    assert.throws(
      () => load("input;").program.createInstance({ globals: { input: accessor } }),
      /accessor/
    );
    assert.equal(reads, 0);

    const symbolic = { [Symbol("secret")]: 1 };
    assert.throws(
      () => load("input;").program.createInstance({ globals: { input: symbolic } }),
      /symbol/
    );
  });

  it("exposes host functions only through explicit cloned capabilities", function () {
    assert.equal(typeof sablejs.capability, "function");
    let received;
    const hostResult = { total: 0 };
    const add = sablejs.capability(function (input) {
      received = input;
      input.value = 20;
      hostResult.total = input.value + 2;
      return hostResult;
    });
    const loaded = run(
      "var local = { value: 3 }; var result = add(local); " +
        "result.total = 99; [local.value, result.total];",
      { add }
    );
    assert.deepStrictEqual(loaded.value, [3, 99]);
    assert.deepStrictEqual(received, { value: 20 });
    assert.equal(hostResult.total, 22);
  });

  it("rejects ambient objects and functions returned by capabilities", function () {
    assert.equal(typeof sablejs.capability, "function");
    const returnGlobal = sablejs.capability(() => globalThis);
    const returnNestedGlobal = sablejs.capability(() => ({ nested: globalThis }));
    const returnFunction = sablejs.capability(() => function leaked() {});
    assert.throws(() => run("returnGlobal();", { returnGlobal }), /ambient host object/);
    assert.throws(
      () => run("returnNestedGlobal();", { returnNestedGlobal }),
      /ambient host object/
    );
    assert.throws(() => run("returnFunction();", { returnFunction }), /function/);
  });

  it("sanitizes capability exceptions and revokes wrappers on dispose", function () {
    assert.equal(typeof sablejs.capability, "function");
    const fail = sablejs.capability(() => {
      const error = new Error("expected failure");
      error.secret = globalThis;
      throw error;
    });
    assert.deepStrictEqual(
      run("try { fail(); } catch (error) { [error.name, error.message, typeof error.secret]; }", {
        fail,
      }).value,
      ["Error", "expected failure", "undefined"]
    );
    assert.equal(
      run("try { fail(); } catch (error) { typeof error.stack; }", { fail }).value,
      "undefined"
    );

    const exported = run("cap;", { cap: sablejs.capability(() => 1) });
    exported.instance.dispose();
    assert.throws(() => exported.value(), /revoked/);
  });

  it("keeps intrinsic objects read-only, including indirect mutator calls", function () {
    Object.defineProperty(Object.prototype, "__sablejsDeleteProbe", {
      value: 1,
      configurable: true,
    });
    try {
      assertSandboxBlocked("Object.prototype.__sablejsPolluted = 1;");
      assertSandboxBlocked(
        "Object.defineProperty.call(null, Object.prototype, '__sablejsPolluted', " +
          "{ value: 1, configurable: true });"
      );
      assertSandboxBlocked(
        "Reflect.defineProperty(Object.prototype, '__sablejsPolluted', " +
          "{ value: 1, configurable: true });"
      );
      assertSandboxBlocked("Object.setPrototypeOf(Object.prototype, { polluted: true });");
      assertSandboxBlocked("Array.prototype.push.call(Object.prototype, 1);");
      assertSandboxBlocked("Reflect.set({}, '__sablejsPolluted', 1, Object.prototype);");
      assertSandboxBlocked(
        "var setter = Object.prototype.__lookupSetter__('__proto__'); " +
          "setter.call(Array.prototype, Object.prototype);"
      );
      assertSandboxBlocked(
        "var proxy = new Proxy(Array.prototype, {}); proxy.__sablejsPolluted = 1;"
      );
      assertSandboxBlocked(
        "var proxy = Proxy.revocable(Array.prototype, {}).proxy; " + "proxy.__sablejsPolluted = 1;"
      );
      if (typeof Error.captureStackTrace === "function") {
        assertSandboxBlocked("Error.captureStackTrace(Object.prototype);");
      }
      assertSandboxBlocked("with (Object.prototype) { delete __sablejsDeleteProbe; }");
      assert.equal(Object.prototype.__sablejsDeleteProbe, 1);
    } finally {
      delete Object.prototype.__sablejsPolluted;
      delete Object.prototype[0];
      delete Array.prototype.__sablejsPolluted;
      delete Object.prototype.__sablejsDeleteProbe;
      delete Object.prototype.stack;
    }
  });

  it("preserves ordinary intrinsic behavior behind the mediated boundary", function () {
    const result = run(
      "var date = new Date(0); var values = [1, 2].map(function (n) { return n * 2; }); " +
        "[Object.keys({ answer: 42 })[0], [] instanceof Array, " +
        "Object.getPrototypeOf([]) === Array.prototype, date.getTime(), values.join(',')];"
    ).value;
    assert.deepStrictEqual(result, ["answer", true, true, 0, "2,4"]);
  });

  it("clones asynchronous capability results and sanitizes rejections", async function () {
    const resolveData = sablejs.capability(async () => ({ nested: { value: 3 } }));
    const rejectData = sablejs.capability(async () => {
      const error = new Error("async failure");
      error.secret = globalThis;
      throw error;
    });
    const resolved = await run("resolveData();", { resolveData }).value;
    assert.deepStrictEqual(resolved, { nested: { value: 3 } });
    await assert.rejects(run("rejectData();", { rejectData }).value, /async failure/);
  });

  it("preserves the legacy pass-through contract only in trusted mode", function () {
    const host = { count: 1 };
    const loaded = run(
      "host.count += 1; host;",
      { host },
      { security: "trusted", optimization: "O2" }
    );
    assert.strictEqual(loaded.value, host);
    assert.equal(host.count, 2);
  });
});

// --- Adversarial battery from the 2026-08-22 audit (see docs/security.md, Verification) ---

// Guards let some probes throw their own fallback error when the host lacks a
// newer built-in; every expected block message matches this pattern.
const AUDIT_BLOCKED_PATTERN =
  /sablejs sandbox boundary|not a function|Cannot read|not a typed array|no Map|no Set|no WeakMap|no TA|no cst|Dynamic Function source/;

// Returns the outcome instead of throwing, for probes that distinguish a
// value from a block and for the known-issue pins below.
function attempt(source, globals, options = {}) {
  try {
    return { outcome: "value", value: run(source, globals, options).value };
  } catch (error) {
    return { outcome: "throw", message: String(error && error.message) };
  }
}

// The frontend prints a chalk warning for rejected dynamic Function/eval
// arguments; silence it while compiling those probes.
function withoutFrontendWarnings(callback) {
  const original = console.log;
  console.log = () => {};
  try {
    return callback();
  } finally {
    console.log = original;
  }
}

describe("sablejs sandbox adversarial battery (audit 2026-08-22)", function () {
  it("blocks Function-constructor escapes through ordinary prototypes", function () {
    assertSandboxBlocked("({}).constructor.constructor('return this')();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("[].constructor.constructor('return process')();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("''.constructor.constructor('return this')();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("(1).constructor.constructor('return this')();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("true.constructor.constructor('return this')();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked(
      "Object.getPrototypeOf({}).constructor.constructor('return this')();",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "Object.getPrototypeOf(Object).constructor('return this')();",
      AUDIT_BLOCKED_PATTERN
    );
  });

  it("blocks Function-constructor escapes through descriptors and reflection", function () {
    assertSandboxBlocked(
      "Object.getOwnPropertyDescriptor(Function.prototype, 'constructor').value('return this')();",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "Object.getOwnPropertyDescriptor(Object.prototype, 'constructor').value.constructor('return this')();",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked("Function.prototype.constructor('return this')();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked(
      "Function.prototype.call.call(Function, null, 'return this')();",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked("Function.call(null, 'return this')();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Function.apply(null, ['return this'])();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Function.bind(null)('return this')();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked(
      "Reflect.apply(Function, null, ['return this'])();",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked("Reflect.construct(Function, ['return this'])();", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked(
      "with (Object.prototype) { constructor.constructor('return this')(); }",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "eval('this.constructor.constructor(\\'return this\\')()');",
      AUDIT_BLOCKED_PATTERN
    );
  });

  it("rejects dynamic Function arguments and indirect eval", function () {
    withoutFrontendWarnings(() => {
      assertSandboxBlocked("var x = 'return this'; Function(x)();", AUDIT_BLOCKED_PATTERN);
    });
    assert.throws(() => load("var e = eval; e('return this');"));
  });

  it("compiles literal Function and eval inputs into sandboxed guest code", function () {
    for (const optimization of ["O0", "O1", "O2", "Os"]) {
      const direct = run("Function('return this')();", undefined, { optimization }).value;
      assert.equal(Object.getPrototypeOf(direct), null);
      assert.equal(direct.process, undefined);

      const constructed = run("new Function('return typeof process')();", undefined, {
        optimization,
      }).value;
      assert.equal(constructed, "undefined");

      const concatenated = run("Function('return ' + 'this')() === this;", undefined, {
        optimization,
      }).value;
      assert.equal(concatenated, true);
    }
    // eval literals observe the guest global too; O2 is pinned by the
    // known-issue test below until the mediation mismatch is fixed.
    const evaluated = run("eval('Object.getPrototypeOf(this) === null');", undefined, {
      optimization: "O1",
    }).value;
    assert.equal(evaluated, true);
  });

  it("blocks prototype pollution through every mutator family", function () {
    assertSandboxBlocked("Object.prototype.x = 1;", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Array.prototype.push(1);", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Array.prototype[0] = 1;", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Array.prototype.length = 0;", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("delete Object.prototype.toString;", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("delete Function.prototype.call;", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked(
      "Object.defineProperty(Object.prototype, 'polluted', {value: 1, configurable: true});",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "Object.defineProperty.call(null, Object.prototype, 'polluted', {value: 1, configurable: true});",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "Object.defineProperty.apply(null, [Object.prototype, 'polluted', {value: 1, configurable: true}]);",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "var b = Object.defineProperty.bind(null, Object.prototype, 'polluted', {value: 1, configurable: true}); b();",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "Object.defineProperties(Object.prototype, {x: {value: 1}});",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked("Object.assign(Object.prototype, {x: 1});", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Object.freeze(Object.prototype);", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Object.seal(Object.prototype);", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Object.preventExtensions(Object.prototype);", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Object.setPrototypeOf(Object.prototype, {});", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Reflect.set(Object.prototype, 'polluted', 1);", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked(
      "Reflect.set({}, 'polluted', 1, Object.prototype);",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "Reflect.defineProperty(Object.prototype, 'polluted', {value: 1, configurable: true});",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "Reflect.deleteProperty(Object.prototype, 'toString');",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "Object.prototype.__defineGetter__('polluted', function(){ return 1; });",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "Object.prototype.__defineSetter__('polluted', function(v){});",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "var s = Object.prototype.__lookupSetter__('__proto__'); s.call(Array.prototype, Object.prototype);",
      AUDIT_BLOCKED_PATTERN
    );
  });

  it("blocks array, date, map, set, and regexp mutators redirected at protected receivers", function () {
    assertSandboxBlocked("Array.prototype.push.call(Object.prototype, 1);", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked(
      "Array.prototype.splice.call(Object.prototype, 0, 0, 1);",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked("Array.prototype.sort.call(Object.prototype);", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked(
      "Array.prototype.unshift.call(Object.prototype, 1);",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "Date.prototype.setTime.call(Object.prototype, 0);",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "RegExp.prototype.compile.call(Object.prototype, 'x');",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "if (typeof Map === 'function') { Map.prototype.set.call(Object.prototype, 1, 1); } else { throw new TypeError('no Map'); }",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "if (typeof Map === 'function') { Map.prototype.clear.call(Object.prototype); } else { throw new TypeError('no Map'); }",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "if (typeof Set === 'function') { Set.prototype.add.call(Object.prototype, 1); } else { throw new TypeError('no Set'); }",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "if (typeof WeakMap === 'function') { WeakMap.prototype.set.call(Object.prototype, {}, 1); } else { throw new TypeError('no WeakMap'); }",
      AUDIT_BLOCKED_PATTERN
    );
    assertSandboxBlocked(
      "if (typeof Uint8Array === 'function') { Uint8Array.prototype.set.call(Object.prototype, []); } else { throw new TypeError('no TA'); }",
      AUDIT_BLOCKED_PATTERN
    );
    if (typeof Error.captureStackTrace === "function") {
      assertSandboxBlocked("Error.captureStackTrace(Object.prototype);", AUDIT_BLOCKED_PATTERN);
    }
  });

  it("blocks proxy wrapping of protected intrinsics and with-environment writes", function () {
    assertSandboxBlocked("new Proxy(Array.prototype, {});", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("Proxy.revocable(Array.prototype, {});", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("with (Object) { prototype = {}; }", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("with (Math) { PI = 3; }", AUDIT_BLOCKED_PATTERN);
    assertSandboxBlocked("with (Object.prototype) { delete toString; }", AUDIT_BLOCKED_PATTERN);
  });

  it("keeps guest own-object mutation isolated from shared intrinsics", function () {
    const swapped = run(
      "var o = {}; o.__proto__ = Object.prototype; o.polluted = 1; Object.prototype.polluted;"
    ).value;
    assert.equal(swapped, undefined);
    const shadowed = run("var Object = 1; Object;").value;
    assert.equal(shadowed, 1);
    const withWrite = attempt("with ({}) { constructor = 1; }");
    assert.equal(withWrite.outcome, "value");
  });

  it("keeps sloppy writes to boxed primitives as no-ops and null writes throwing", function () {
    for (const optimization of ["O0", "O2"]) {
      // ES5.1 PutValue on a boxed primitive silently fails the write.
      const result = run("(1).z = 3; 's'.w = 4; true.b = 5; 42;", undefined, { optimization });
      assert.equal(result.value, 42);
      // ES5.1 PutValue on null/undefined bases throws even in sloppy code.
      const nullWrite = attempt("var r = null; r.x = 1; 42;", undefined, { optimization });
      assert.equal(nullWrite.outcome, "throw");
    }
  });

  it("blocks runtime accessors obtained through property descriptors", function () {
    for (const optimization of ["O0", "O2"]) {
      const direct = attempt(
        "function f(){}; var g = Object.getOwnPropertyDescriptor(f, 'caller').get; g(f);",
        undefined,
        { optimization }
      );
      // O0 wraps the accessor at the mediated read and re-mediates the call
      // (harmless null); O2 keeps the raw accessor and rejects it outright.
      // Both outcomes prove the accessor never executes against host frames.
      assert.ok(
        direct.outcome === "throw" || (direct.outcome === "value" && direct.value === null),
        JSON.stringify(direct)
      );

      const viaCall = run(
        "function f(){}; var g = Object.getOwnPropertyDescriptor(f, 'caller').get; g.call(f);",
        undefined,
        { optimization }
      ).value;
      assert.equal(viaCall, null);

      const prototypeCaller = attempt(
        "var g = Object.getOwnPropertyDescriptor(Function.prototype, 'caller').get; g.call(Object.prototype);",
        undefined,
        { optimization }
      );
      assert.ok(
        prototypeCaller.outcome === "throw" || prototypeCaller.value === null,
        JSON.stringify(prototypeCaller)
      );
    }
  });

  it("wraps host functions delivered through nested native callbacks", function () {
    // Promise invokes the executor natively from inside a guest call; the
    // resolve delivered to the executor must be stored wrapped so the guest
    // can only reach it through the boundary re-mediation.
    const result = run(
      "var saved; function outer() { new Promise(function (resolve) { saved = resolve; }); return saved; } " +
        "var raw = outer(); raw.call(null, 7); 'resolved';"
    ).value;
    assert.equal(result, "resolved");
  });

  it("rejects custom shapes in capability results", function () {
    class HostSecret {
      constructor() {
        this.value = 1;
      }
    }
    const returnsInstance = sablejs.capability(() => new HostSecret());
    assert.equal(attempt("cap();", { cap: returnsInstance }).outcome, "throw");

    const accessor = {};
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get() {
        return globalThis;
      },
    });
    const returnsAccessor = sablejs.capability(() => accessor);
    assert.equal(attempt("cap();", { cap: returnsAccessor }).outcome, "throw");

    const pass = sablejs.capability((input) => input);
    assert.equal(
      attempt("cap({ then: function (cb) { cb('evil'); } });", { cap: pass }).outcome,
      "throw"
    );

    if (typeof SharedArrayBuffer === "function") {
      assert.equal(attempt("cap(new SharedArrayBuffer(4));", { cap: pass }).outcome, "throw");
    }
  });

  it("rejects runtime-owned callables smuggled between instances", function () {
    // A guest closure from a sandbox instance.
    const sandboxLoaded = load("function secret(){ return 42; } secret;");
    const guestFunction = sandboxLoaded.program.createInstance({}).run();
    assert.equal(typeof guestFunction, "function");
    assert.throws(
      () => sandboxLoaded.program.createInstance({ globals: { smuggled: guestFunction } }),
      /owned by the sablejs runtime/
    );

    // A wrapHostFunction wrapper reached through a shared intrinsic.
    const wrapperLoaded = load("Array.prototype.map;");
    const wrapper = wrapperLoaded.program.createInstance({}).run();
    assert.equal(typeof wrapper, "function");
    assert.throws(
      () => wrapperLoaded.program.createInstance({ globals: { smuggled: wrapper } }),
      /owned by the sablejs runtime/
    );

    // A guest closure from a trusted instance injected into a sandbox instance.
    const trustedLoaded = load("function secret(){ return 42; } secret;", { security: "trusted" });
    const trustedGuestFunction = trustedLoaded.program.createInstance({}).run();
    assert.equal(typeof trustedGuestFunction, "function");
    assert.throws(
      () => sandboxLoaded.program.createInstance({ globals: { smuggled: trustedGuestFunction } }),
      /owned by the sablejs runtime/
    );

    // A capability wrapper produced by instance A.
    const capLoaded = load("cap;");
    const capWrapper = capLoaded.program
      .createInstance({
        globals: { cap: sablejs.capability(() => 1, { name: "cap" }) },
      })
      .run();
    assert.equal(typeof capWrapper, "function");
    assert.throws(
      () => capLoaded.program.createInstance({ globals: { smuggled: capWrapper } }),
      /owned by the sablejs runtime/
    );
  });

  it("auto-wraps raw host functions in globals as capabilities", function () {
    let received;
    const hostResult = { total: 0 };
    const add = function (input) {
      received = input;
      input.value = 20;
      hostResult.total = input.value + 2;
      return hostResult;
    };
    const loaded = run(
      "var local = { value: 3 }; var result = add(local); " +
        "result.total = 99; [local.value, result.total];",
      { add }
    );
    // Copy semantics both directions: guest mutations never reach host
    // objects through the auto-wrapped capability.
    assert.deepStrictEqual(loaded.value, [3, 99]);
    assert.deepStrictEqual(received, { value: 20 });
    assert.equal(hostResult.total, 22);
  });

  it("sanitizes auto-wrapped errors and revokes wrappers on dispose", function () {
    const fail = function () {
      const error = new RangeError("expected failure");
      error.secret = globalThis;
      throw error;
    };
    assert.deepStrictEqual(
      run("try { fail(); } catch (error) { [error.name, error.message, typeof error.secret]; }", {
        fail,
      }).value,
      ["RangeError", "expected failure", "undefined"]
    );

    const exported = run("cap;", {
      cap: function () {
        return 1;
      },
    });
    assert.throws(() => new exported.value(), /not a constructor/);
    exported.instance.dispose();
    assert.throws(() => exported.value(), /revoked/);
  });

  it("auto-wraps nested functions in objects, arrays, Maps, and Sets with dedup identity", function () {
    const fn = (x) => x * 10;
    const value = run(
      "input.a.fn(2); input.arr[0](3); input.m.get('k')(4); input.s.has(input.a.fn);" +
        "[typeof input.a.fn, typeof input.arr[0], typeof input.m.get('k'), input.a.fn === input.other];",
      { input: { a: { fn }, other: fn, arr: [fn], m: new Map([["k", fn]]), s: new Set([fn]) } }
    ).value;
    assert.deepStrictEqual(value, ["function", "function", "function", true]);
  });

  it("derives auto-capability names from function names and property paths", function () {
    const named = function saveRecord() {};
    const first = run("input.save;", { input: { save: named } });
    first.instance.dispose();
    assert.throws(() => first.value(), /capability saveRecord has been revoked/);

    const anonymous = run("input.save;", { input: { save: function () {} } });
    anonymous.instance.dispose();
    assert.throws(() => anonymous.value(), /capability save has been revoked/);

    const mapValue = run("input.m;", { input: { m: new Map([["k", function () {}]]) } });
    mapValue.instance.dispose();
    assert.throws(() => mapValue.value.get("k")(), /capability capability has been revoked/);
  });

  it("auto-wraps mixed trees alongside explicit capability tokens", function () {
    const token = sablejs.capability((input) => input + 1, { name: "withBase" });
    const plain = { a: 1 };
    const value = run("[raw(1), token(2), plain === plain];", {
      raw: (x) => x + 1,
      token,
      plain,
    }).value;
    assert.deepStrictEqual(value, [2, 3, true]);
  });

  it("clones cyclic globals with preserved identity", function () {
    const cyclic = { name: "a" };
    cyclic.self = cyclic;
    assert.equal(run("input.self === input;", { input: cyclic }).value, true);
  });

  it("keeps host globals absent and top-level this on the guest global", function () {
    const globals = run(
      "typeof process + ',' + typeof require + ',' + typeof global + ',' + typeof module;"
    ).value;
    assert.equal(globals, "undefined,undefined,undefined,undefined");
    assert.equal(Object.getPrototypeOf(run("this;").value), null);
  });

  it("preserves arguments, caller, and instanceof semantics for guest functions", function () {
    assert.equal(
      run("function inner() { return arguments.callee === inner; } inner();").value,
      true
    );
    assert.equal(
      run(
        "function outer() { function inner() { return inner.caller === outer; } return inner(); } outer();"
      ).value,
      true
    );
    assert.equal(
      attempt("'use strict'; (function(){ return arguments.callee; })();").outcome,
      "throw"
    );
    assert.equal(run("({}) instanceof Function;").value, false);
  });

  it("invokes guest proxy traps through host intrinsics without host leakage", function () {
    assert.equal(run("var p = new Proxy({ a: 1 }, {}); Object.keys(p).join(',');").value, "a");
    assert.equal(
      run("var p = new Proxy({}, { has: function(){ return true; } }); 'x' in p;").value,
      true
    );
    assert.equal(
      run(
        "var p = new Proxy({}, { get: function(t, k){ return k === 'x' ? Object.prototype : 1; } }); p.x === Object.prototype;"
      ).value,
      true
    );
    assert.equal(
      attempt(
        "var p = new Proxy({}, { get: function(t, k){ return k === 'toJSON' ? function(){ return { leaked: Object.prototype }; } : undefined; } }); JSON.stringify(p);"
      ).outcome,
      "value"
    );
  });

  it("keeps the guest global read-only against Error extensions", function () {
    if (typeof Error.prepareStackTrace !== "undefined") {
      assertSandboxBlocked("Error.prepareStackTrace = function(){};", AUDIT_BLOCKED_PATTERN);
    }
    assertSandboxBlocked("Function.prototype.x = 1;", AUDIT_BLOCKED_PATTERN);
  });
});

describe("sablejs sandbox known issues (audit 2026-08-22)", function () {
  // These tests pin the fixed behavior of audit findings 1-3
  // (see docs/security.md, Historical audit record).

  it("O2/Os: property reads on function globals must work inside dynamic scopes (finding 1)", function () {
    const cases = [
      "function f() { try { throw 1; } catch (e) { return Object.keys({a:1})[0]; } } f();",
      "function f() { with ({}) { return Array.isArray([]); } } f();",
      "eval('Object.getPrototypeOf(this) === null');",
    ];
    for (const optimization of ["O0", "O1", "O2", "Os"]) {
      for (const source of cases) {
        const result = attempt(source, undefined, { optimization });
        assert.equal(result.outcome, "value", `${optimization} ${source} -> ${result.message}`);
      }
    }
    assert.equal(
      run("eval('Object.getPrototypeOf(this) === null');", undefined, { optimization: "O2" }).value,
      true
    );
  });

  it("O2: wrapper surface must not be observable through direct reads (finding 1)", function () {
    for (const optimization of ["O0", "O1", "O2", "Os"]) {
      const result = run("({}).constructor.length;", undefined, { optimization }).value;
      assert.equal(result, 1, `${optimization} exposed the wrapper surface`);
    }
  });

  it("keeps instanceof prototype resolution consistent across optimization levels", function () {
    for (const optimization of ["O0", "O1", "O2", "Os"]) {
      const compiledFn = run("(function(){}) instanceof Function;", undefined, {
        optimization,
      }).value;
      assert.equal(compiledFn, true, `${optimization} instanceof Function on a compiled fn`);
      const plain = run("({}) instanceof Function;", undefined, { optimization }).value;
      assert.equal(plain, false, `${optimization} instanceof Function on a plain object`);
      const array = run("[] instanceof Array;", undefined, { optimization }).value;
      assert.equal(array, true, `${optimization} instanceof Array`);
    }
  });

  it("boundary errors must not leak host frames through stack (finding 2)", function () {
    const result = run(
      "var s = ''; try { Object.prototype.x = 1; } catch (e) { s = String(e.stack); } s;"
    ).value;
    assert.doesNotMatch(result, /security\.js|runtime\/index\.js/);
  });

  it("Error.captureStackTrace must not expose host frames on guest objects (finding 2)", function () {
    if (typeof Error.captureStackTrace !== "function") return;
    const direct = attempt("Error.captureStackTrace(Object.prototype);");
    assert.equal(direct.outcome, "throw");
    const redirected = attempt("var o = {}; Error.captureStackTrace.call(o);");
    assert.equal(redirected.outcome, "throw");
    assert.match(redirected.message, /sablejs sandbox boundary/);
  });

  it("wrapper source must not be readable through Function.prototype.toString (finding 2)", function () {
    for (const optimization of ["O0", "O1", "O2", "Os"]) {
      for (const source of [
        "var w = ({}).constructor; w.toString();",
        "var w = ({}).constructor; Function.prototype.toString.call(w);",
      ]) {
        // Conservative levels reject the read while optimized levels may
        // return a redacted representation. Both are secure outcomes.
        const result = attempt(source, undefined, { optimization });
        assert.ok(
          result.outcome === "throw" ||
            (result.outcome === "value" &&
              !/sableIntrinsicBoundary|sableDynamicFunctionBoundary/.test(result.value)),
          `${optimization}: ${JSON.stringify(result)}`
        );
      }
    }
  });

  it("capability-cloned Buffer views must not carry the Buffer prototype (finding 3)", function () {
    if (typeof Buffer === "undefined") return;
    const expose = sablejs.capability(() => Buffer.from([1, 2, 3]));
    const result = run("cap();", { cap: expose }).value;
    assert.equal(Object.getPrototypeOf(result), Uint8Array.prototype);
    assert.deepStrictEqual(Array.from(result), [1, 2, 3]);
  });

  it("worker client validates responses and enforces timeouts", async function () {
    const { createSandboxClient } = sablejs.worker;
    // A fake worker that answers the first message and drops the second.
    const posted = [];
    const fakeWorker = {
      listeners: {},
      addEventListener(name, handler) {
        this.listeners[name] = handler;
      },
      postMessage(message) {
        posted.push(message);
      },
      terminate() {},
      respond(handler, message) {
        handler({ data: message });
      },
    };
    const client = createSandboxClient(fakeWorker, { timeoutMs: 5000 });
    const success = client.run({ price: 100 });
    assert.equal(posted.length, 1);
    fakeWorker.respond(fakeWorker.listeners.message, {
      id: posted[0].id,
      ok: true,
      value: { total: 120 },
    });
    assert.deepStrictEqual(await success, { total: 120 });

    const malformed = client.run({});
    fakeWorker.respond(fakeWorker.listeners.message, { id: posted[1].id, ok: true });
    await assert.rejects(malformed, /missing value/);

    const dropped = client.run({});
    client.terminate();
    await assert.rejects(dropped, /terminated/);

    const fastClient = createSandboxClient(fakeWorker, { timeoutMs: 5 });
    await assert.rejects(fastClient.run({}), /timed out/);
  });

  it("worker client rejects invalid per-call timeouts without poisoning the worker", async function () {
    const { createSandboxClient } = sablejs.worker;
    let terminated = 0;
    const posted = [];
    const fakeWorker = {
      listeners: {},
      addEventListener(name, handler) {
        this.listeners[name] = handler;
      },
      postMessage(message) {
        posted.push(message);
      },
      terminate() {
        terminated += 1;
      },
    };
    const client = createSandboxClient(fakeWorker, { timeoutMs: 5000 });
    await assert.rejects(client.run({}, { timeoutMs: NaN }), /positive number/);
    await assert.rejects(client.run({}, { timeoutMs: -1 }), /positive number/);
    assert.equal(posted.length, 0);
    assert.equal(terminated, 0);

    const valid = client.run({ ok: true });
    fakeWorker.listeners.message({ data: { id: posted[0].id, ok: true, value: true } });
    assert.equal(await valid, true);
    client.terminate();
  });

  it("worker client cleans up when postMessage rejects an uncloneable input", async function () {
    const { createSandboxClient } = sablejs.worker;
    let terminated = 0;
    const fakeWorker = {
      addEventListener() {},
      postMessage() {
        const error = new Error("could not be cloned");
        error.name = "DataCloneError";
        throw error;
      },
      terminate() {
        terminated += 1;
      },
    };
    const client = createSandboxClient(fakeWorker, { timeoutMs: 10 });
    await assert.rejects(client.run({ fn() {} }), { name: "DataCloneError" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(terminated, 0);
    client.terminate();
    assert.equal(terminated, 1);
  });

  it("worker client rejects pending work and terminates after a Worker error", async function () {
    const { createSandboxClient } = sablejs.worker;
    let terminated = 0;
    const posted = [];
    const fakeWorker = {
      listeners: {},
      addEventListener(name, handler) {
        this.listeners[name] = handler;
      },
      postMessage(message) {
        posted.push(message);
      },
      terminate() {
        terminated += 1;
      },
    };
    const client = createSandboxClient(fakeWorker, { timeoutMs: 5000 });
    const pending = client.run({});
    fakeWorker.listeners.error({ message: "worker crashed" });
    await assert.rejects(pending, /worker crashed/);
    await assert.rejects(client.run({}), /has been terminated/);
    assert.equal(posted.length, 1);
    assert.equal(terminated, 1);
  });

  it("worker client evaluate ships compiled artifacts and validates the program argument", async function () {
    const { createSandboxClient } = sablejs.worker;
    const posted = [];
    const fakeWorker = {
      listeners: {},
      addEventListener(name, handler) {
        this.listeners[name] = handler;
      },
      postMessage(message) {
        posted.push(message);
      },
      terminate() {},
      respond(handler, message) {
        handler({ data: message });
      },
    };
    const client = createSandboxClient(fakeWorker, { timeoutMs: 5000 });
    const artifact = "compiled artifact";
    const success = client.evaluate(artifact, { price: 100 });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].program, artifact);
    fakeWorker.respond(fakeWorker.listeners.message, {
      id: posted[0].id,
      ok: true,
      value: { total: 120 },
    });
    assert.deepStrictEqual(await success, { total: 120 });
    await assert.rejects(client.evaluate(42, {}), /compiled artifact/);
    // A plain run must not carry a program field.
    const plain = client.run({});
    assert.equal(posted[1].program, undefined);
    client.terminate();
    await assert.rejects(plain, /terminated/);
  });

  it("worker handler loads and runs compiled artifacts on evaluate messages", async function () {
    const { handleSandboxMessages } = sablejs.worker;
    const compiled = sablejs.compile("var total = input.price * 2; total;", { runtimeModule });
    assert.equal(compiled.optimization, "O1");
    const artifact = compiled.code;
    let loads = 0;
    const posted = [];
    const scope = {};
    handleSandboxMessages(
      {
        createInstance() {
          throw new Error("bound program must not run for evaluate messages");
        },
      },
      {
        scope,
        postMessage: (message) => posted.push(message),
        loadProgram: (code) => {
          loads += 1;
          const module = { exports: {} };
          new Function("require", "module", "exports", code)(require, module, module.exports);
          return module.exports;
        },
      }
    );
    scope.onmessage({ data: { id: 1, input: { price: 21 }, program: artifact } });
    scope.onmessage({ data: { id: 2, input: { price: 22 }, program: artifact } });
    scope.onmessage({ data: { id: 3, input: {}, program: 7 } });
    scope.onmessage({ data: { id: 4, input: { price: 1 } } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(posted[0], { id: 1, ok: true, value: 42 });
    assert.deepStrictEqual(posted[1], { id: 2, ok: true, value: 44 });
    assert.equal(loads, 1); // the last artifact is cached across messages
    assert.equal(posted[2].ok, false);
    assert.match(posted[2].error, /compiled artifact/);
    assert.equal(posted[3].ok, false);
    assert.match(posted[3].error, /bound program/);
  });

  it("worker handler awaits async results, disposes afterwards, and serializes runs", async function () {
    const { handleSandboxMessages } = sablejs.worker;
    const posted = [];
    const events = [];
    const scope = {};
    let releaseFirst;
    const firstResult = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    handleSandboxMessages(
      {
        createInstance({ globals }) {
          const id = globals.input.id;
          events.push(`create:${id}`);
          return {
            run() {
              events.push(`run:${id}`);
              return id === 1 ? firstResult : id * 10;
            },
            dispose() {
              events.push(`dispose:${id}`);
            },
          };
        },
      },
      { scope, postMessage: (message) => posted.push(message) }
    );

    scope.onmessage({ data: { id: 1, input: { id: 1 } } });
    scope.onmessage({ data: { id: 2, input: { id: 2 } } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(events, ["create:1", "run:1"]);
    assert.deepStrictEqual(posted, []);

    releaseFirst(10);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(posted, [
      { id: 1, ok: true, value: 10 },
      { id: 2, ok: true, value: 20 },
    ]);
    assert.deepStrictEqual(events, [
      "create:1",
      "run:1",
      "dispose:1",
      "create:2",
      "run:2",
      "dispose:2",
    ]);
  });

  it("default artifact loader resolves the sablejs runtime (Node)", function () {
    const { loadCompiledArtifact } = sablejs.worker;
    const program = loadCompiledArtifact(
      sablejs.compile("var total = input.price * 3; total;").code
    );
    const instance = program.createInstance({ globals: { input: { price: 10 } } });
    try {
      assert.equal(instance.run(), 30);
    } finally {
      instance.dispose();
    }
  });

  it("host-called guest functions must not mutate host arguments or receiver", function () {
    const loaded = load(
      "function f(a) { a.x = 99; a.nested.y = 88; this.tag = true; return a.x; } f;"
    );
    const instance = loaded.program.createInstance({ globals: {} });
    const fn = instance.run();
    const hostArg = { x: 1, nested: { y: 2 } };
    const hostThis = { tag: false };
    assert.equal(fn.call(hostThis, hostArg), 99);
    assert.deepStrictEqual(hostArg, { x: 1, nested: { y: 2 } });
    assert.deepStrictEqual(hostThis, { tag: false });
    instance.dispose();
  });

  it("guest-internal calls keep reference semantics across frames", function () {
    const loaded = load(
      "function g(o) { o.v = 2; return o.v; }" +
        "function h() { var o = { v: 1 }; return [g(o), o.v]; } h;"
    );
    const instance = loaded.program.createInstance({ globals: {} });
    assert.deepStrictEqual(instance.run()(), [2, 2]);
    instance.dispose();
  });
});

describe("sablejs sandbox boundary-internals and clone sweep (P0 audit 2026-08-22)", function () {
  // P0-S1: the boundary used to tag wrappers with a symbol (`HOST_TARGET`)
  // that guest proxies could observe in traps and that enumeration paths
  // could reveal. The mapping now lives in a WeakMap (trap-free and
  // unforgeable); these regressions pin the old reveal closed.

  it("reveals no boundary symbols through enumeration on wrappers or intrinsics", function () {
    // The only symbol a guest may observe on a mediated intrinsic is the
    // intrinsic's own spec tag (Math[Symbol.toStringTag]); a boundary tag
    // would be a foreign symbol on every entry in this list.
    const result = run(
      "var tag = (typeof Symbol === 'function' && Symbol.toStringTag) || null;" +
        "var list = [Array.prototype.push, Object.prototype.toString, ({}).constructor, Math, JSON];" +
        "list.map(function (w) {" +
        "  var own = Object.getOwnPropertySymbols(w);" +
        "  var all = Reflect.ownKeys(w);" +
        "  var foreign = 0;" +
        "  for (var i = 0; i < all.length; i += 1) {" +
        "    if (typeof all[i] === 'symbol' && all[i] !== tag) foreign += 1;" +
        "  }" +
        "  var foreignOwn = 0;" +
        "  for (var j = 0; j < own.length; j += 1) {" +
        "    if (own[j] !== tag) foreignOwn += 1;" +
        "  }" +
        "  var foreignDesc = (typeof Object.getOwnPropertyDescriptors === 'function')" +
        "    ? Reflect.ownKeys(Object.getOwnPropertyDescriptors(w))" +
        "        .filter(function (k) { return typeof k === 'symbol' && k !== tag; }).length" +
        "    : 0;" +
        "  return [foreignOwn, foreign, foreignDesc];" +
        "});"
    ).value;
    assert.deepStrictEqual(result, [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
  });

  it("never fires guest proxy get traps with boundary internals during writes", function () {
    const result = run(
      "var log = [];" +
        "var p = new Proxy({ x: 1 }, {" +
        "  get: function (t, k) { log.push(k); return t[k]; }," +
        "  set: function (t, k, v) { t[k] = v; return true; }" +
        "});" +
        "p.x = 2;" +
        "var duringWrite = log.length;" +
        "Object.getOwnPropertySymbols(p);" +
        "var duringSymbols = log.length;" +
        "p.x;" +
        "[duringWrite, duringSymbols, log[log.length - 1], p.x];"
    ).value;
    assert.deepStrictEqual(result, [0, 0, "x", 2]);
  });

  it("keeps write-target resolution trap-free so guest traps cannot steer writes", function () {
    // A get trap returning a mediated wrapper must not let the write resolve
    // to the wrapper's host target (old behaviour: boundary error, or a write
    // into a shared intrinsic). The write lands per the guest's own trap
    // semantics on its own target.
    const result = run(
      "var boundaryPush = Array.prototype.push;" +
        "var target = {};" +
        "var p = new Proxy(target, {" +
        "  get: function (t, k) { return boundaryPush; }," +
        "  set: function (t, k, v) { t[k] = v; return true; }" +
        "});" +
        "p.steer = 42;" +
        "target.steer;"
    ).value;
    assert.equal(result, 42);
  });

  it("mediates writes made inside guest proxy traps the same as any guest write", function () {
    const outcome = attempt(
      "var p = new Proxy({}, {" +
        "  set: function (t, k, v) { Math.polluted = 1; return true; }" +
        "});" +
        "p.x = 1;"
    );
    assert.equal(outcome.outcome, "throw");
    assert.match(outcome.message, /cannot modify a shared intrinsic/);
  });

  // P0-S3: clone edge shapes — sparse, huge, deep, exotic.

  it("clones sparse arrays with holes preserved and huge lengths without iterating holes", function () {
    const sparse = new Array(5);
    sparse[1] = "a";
    sparse[3] = "b";
    assert.deepStrictEqual(
      run("var a = input; a[0] = 'x';" + "[a.length, (0 in a), (1 in a), a[1], a[3], a[4]];", {
        input: sparse,
      }).value,
      [5, true, true, "a", "b", undefined]
    );

    const huge = [];
    huge.length = 100000;
    huge[99999] = 7;
    assert.deepStrictEqual(
      run("var a = input; a[50000] = 1;" + "[a.length, a[99999], (50000 in a), (0 in a)];", {
        input: huge,
      }).value,
      [100000, 7, true, false]
    );
  });

  it("clones huge plain object graphs", function () {
    const big = {};
    for (let i = 0; i < 50000; i += 1) big["k" + i] = i;
    assert.deepStrictEqual(
      run("[Object.keys(input).length, input.k49999, input.k0, input.missing];", { input: big })
        .value,
      [50000, 49999, 0, undefined]
    );
  });

  it("clones deeply nested graphs iteratively without stack overflow", function () {
    let deep = { leaf: true };
    for (let i = 0; i < 100000; i += 1) deep = { child: deep };
    deep.self = deep;
    assert.equal(run("typeof input;", { input: deep }).value, "object");
    const walk = run(
      "var d = input; var n = 0;" +
        "while (typeof d === 'object') { d = d.child; n += 1; }" +
        "[n, d];",
      { input: deep }
    ).value;
    assert.deepStrictEqual(walk, [100001, undefined]);
  });

  it("handles null-prototype objects, class instances, and specials nested in plain data", function () {
    const nullProto = Object.create(null);
    nullProto.value = 1;
    assert.equal(
      run("Object.getPrototypeOf(input) === Object.prototype;", { input: nullProto }).value,
      true
    );

    class HostClass {}
    const instance = new HostClass();
    instance.value = 1;
    assert.equal(attempt("input;", { input: instance }).outcome, "throw");

    const date = new Date(1700000000000);
    assert.deepStrictEqual(
      run("[input.a === input.b, input.a.getTime()];", { input: { a: date, b: date } }).value,
      [false, 1700000000000]
    );
  });

  // P0-S4: Map / Set / typed array / Buffer clone boundaries.

  it("clones Map keys and values with identity preserved across the graph", function () {
    const shared = { name: "shared" };
    const inner = new Map([["x", 2]]);
    const map = new Map([
      [shared, 1],
      ["inner", inner],
    ]);
    assert.deepStrictEqual(
      run(
        "var m = input.map;" +
          "[m.get(input.shared), m.get('inner').get('x'), m.size, m.has(input.shared)];",
        { input: { map, shared } }
      ).value,
      [1, 2, 2, true]
    );

    const cyclic = new Map();
    cyclic.set("self", cyclic);
    assert.equal(run("input.m.get('self') === input.m;", { input: { m: cyclic } }).value, true);
  });

  it("clones Sets with member identity preserved", function () {
    const a = { name: "a" };
    const b = { name: "b" };
    assert.deepStrictEqual(
      run("[input.s.has(input.a), input.s.has(input.b), input.s.size];", {
        input: { s: new Set([a, b]), a, b },
      }).value,
      [true, true, 2]
    );
  });

  it("clones typed arrays with standard prototypes and DataView bytes", function () {
    const floats = new Float64Array([1.5, 2.5]);
    class MyBytes extends Uint8Array {}
    const sub = new MyBytes([1, 2, 3]);
    const view = new DataView(new ArrayBuffer(3));
    view.setUint8(0, 0);
    view.setUint8(1, 255);
    view.setUint8(2, 128);
    assert.deepStrictEqual(
      run(
        "[" +
          "  input.floats.length, input.floats[0], input.floats[1]," +
          "  Object.getPrototypeOf(input.floats) === Float64Array.prototype," +
          "  Object.getPrototypeOf(input.sub) === Uint8Array.prototype," +
          "  input.sub.length, input.sub[2]," +
          "  input.view.getUint8(1), input.view.byteLength" +
          "];",
        { input: { floats, sub, view } }
      ).value,
      [2, 1.5, 2.5, true, true, 3, 3, 255, 3]
    );
  });

  it("clones guest Maps, Sets, and typed arrays back to the host", function () {
    const result = run(
      "var k = { id: 1 };" +
        "var m = new Map(); m.set(k, 'v');" +
        "var s = new Set([k]);" +
        "var f = new Float32Array([0.5]);" +
        "[m, s, f, k];"
    ).value;
    assert.equal(result[0] instanceof Map, true);
    assert.equal(result[0].get(result[3]), "v");
    assert.equal(result[1] instanceof Set, true);
    assert.equal(result[1].has(result[3]), true);
    assert.equal(result[2] instanceof Float32Array, true);
    assert.deepStrictEqual(Array.from(result[2]), [0.5]);
  });
});

describe("sablejs sandbox fuzzer regressions (boundary facet campaign 2026-08-22)", function () {
  // Fuzz-boundary campaign findings: mediated calls whose target overflows
  // the stack used to corrupt the reported error (the sanitization path
  // itself ran on an exhausted stack and threw "Invalid regular
  // expression" SyntaxError instead of the engine's RangeError), and proxy
  // arguments over branded containers leaked raw receiver TypeErrors from
  // the clone internals instead of the documented boundary rejection.

  it("preserves the engine's own error when a mediated call exhausts the stack", function () {
    const source =
      "function f0(a, b) {" +
      "  Object.defineProperty({}, 'x', { value: f0(1, 2) });" +
      "  return 3;" +
      "}" +
      "f0(0, 0);";
    for (const optimization of ["O0", "O1", "O2", "Os"]) {
      const trusted = load(source, { optimization, security: "trusted" });
      let trustedError;
      try {
        trusted.program.createInstance({}).run();
      } catch (error) {
        trustedError = error;
      }
      assert.ok(trustedError, `${optimization} trusted recursion did not fail`);
      assert.equal(trustedError.name, "RangeError");

      const sandbox = load(source, { optimization, security: "sandbox" });
      let sandboxError;
      try {
        sandbox.program.createInstance({}).run();
      } catch (error) {
        sandboxError = error;
      }
      assert.ok(sandboxError, `${optimization} sandbox recursion did not fail`);
      assert.equal(
        sandboxError.name,
        "RangeError",
        `${optimization} sandbox corrupted the stack-overflow error`
      );
      assert.equal(
        sandboxError.message,
        trustedError.message,
        `${optimization} sandbox changed the stack-overflow error`
      );
    }
  });

  it("rejects Proxy-wrapped branded containers with the documented boundary error", function () {
    const cases = [
      ["new Set([1, 'a'])", "Set"],
      ["new Map([['k', 1]])", "Map"],
      ["new Date(1234567890)", "Date"],
      ["new ArrayBuffer(8)", "ArrayBuffer"],
    ];
    for (const [expression, tag] of cases) {
      const result = run(
        "var fn = g;" +
          "try { fn(new Proxy(" +
          expression +
          ", { get: function (t, k) { return t[k]; } })); }" +
          "catch (e) { e.message; }",
        { g: sablejs.capability(function () {}, { name: "g" }) }
      );
      assert.equal(
        result.value,
        "sablejs sandbox boundary: g.args[0] is a Proxy-wrapped " +
          tag +
          "; only plain data or explicit capabilities cross",
        `${expression} did not produce the proxy boundary rejection`
      );
    }
  });

  it("reports the proxy rejection as a TypeError with a stable boundary message", function () {
    const result = run(
      "var caught = null;" +
        "try { fn(new Proxy(new Set([1]), { get: function (t, k) { return t[k]; } })); }" +
        "catch (e) { caught = [e.name, e.message]; }" +
        "caught;",
      { fn: sablejs.capability(function () {}, { name: "fn" }) }
    );
    assert.deepStrictEqual(result.value, [
      "TypeError",
      "sablejs sandbox boundary: fn.args[0] is a Proxy-wrapped Set; only plain data or explicit capabilities cross",
    ]);
  });

  it("still clones proxies over plain data as the data they present", function () {
    const result = run(
      "var got = null;" +
        "var v = fn(new Proxy({ a: 1, b: [2] }, { get: function (t, k) { return t[k]; } }));" +
        "[v.a, v.b[0], typeof v];",
      {
        fn: sablejs.capability(
          function (x) {
            return x;
          },
          { name: "fn" }
        ),
      }
    );
    assert.deepStrictEqual(result.value, [1, 2, "object"]);
  });
});

describe("sablejs guest-object write fast path (local-safe IR distinction)", function () {
  it("keeps protected-intrinsic writes blocked at every optimization level", function () {
    assertSandboxBlocked("Math.PI = 3;");
    // The `__proto__` read is sensitive, so its result carries a mediated
    // origin and the write to the shared Object.prototype stays guarded.
    assertSandboxBlocked("({}).__proto__.x = 1;");
    assertSandboxBlocked("var p = Object.getPrototypeOf({}); p.x = 1;");
  });

  it("keeps capability-token, injected-data, and captured-locals writes on the guarded path", function () {
    const loaded = load(
      "cap.foo = 1; g.x = 1; var t = g; t.y = 2;" +
        "function outer() { var o = {}; return function () { o.x = 1; return o.x; }; }" +
        "outer()();",
      { optimization: "O2" }
    );
    assert.match(loaded.result.code, /setSandboxPropertyValue/);
    assert.doesNotMatch(loaded.result.code, /setGuestPropertyValue/);
    assert.equal(
      loaded.program
        .createInstance({
          globals: { cap: sablejs.capability(() => 1), g: { a: 1 } },
        })
        .run(),
      1
    );
  });

  it("still secures stored host functions on the guest write path", function () {
    // Reading `[].map` off a guest array yields the raw host function; the
    // slim guest write path must still wrap it before storing, so the stored
    // value is a wrapper, not the raw function.
    assert.equal(
      run("var o = {}; o.f = [].map; o.f === [].map;", undefined, { optimization: "O2" }).value,
      false
    );
    for (const optimization of ["O0", "O1", "O2", "Os"]) {
      assert.deepStrictEqual(
        run("var o = {}; o.f = [].map; o.f.call([1], String);", undefined, { optimization }).value,
        ["1"]
      );
    }
  });

  it("writes through closures as guest targets at every optimization level", function () {
    for (const optimization of ["O0", "O1", "O2", "Os"]) {
      assert.equal(
        run("function f() {} f.x = 1; f.x === 1;", undefined, { optimization }).value,
        true
      );
    }
  });

  it("fast-paths this-writes via the frame stamp and keeps mediated receivers guarded", function () {
    // Receiver writes (`this.n = ...`) are classified once per call; the
    // generated code must read the frame stamp instead of resolving
    // writeTarget per write.
    const loaded = load(
      "function Counter() { this.n = 0; }" +
        "Counter.prototype.inc = function (v) { this.n = this.n + v; return this.n; };" +
        "var c = new Counter(); c.inc(1); c.inc(2); c.n;",
      { optimization: "O2" }
    );
    const instance = loaded.program.createInstance({ profileBoundary: true });
    assert.equal(instance.run(), 3);
    assert.match(loaded.result.code, /\$f\.thisIsGuest/);
    assert.match(loaded.result.code, /"usesThisWrites":true/);
    // Exactly one writeTarget remains: the `Counter.prototype.inc` store,
    // whose base is an unmarked GETVAR result. Both `this.n` writes and the
    // two `c.inc` calls skip per-write resolution entirely.
    assert.equal(instance.boundaryStats().writeTargets, 1);

    // The stamp is an exact complement of writeTarget: a protected intrinsic
    // receiver must still hit the guarded path and throw, at every level.
    for (const optimization of ["O0", "O1", "O2", "Os"]) {
      assert.throws(
        () =>
          run("var o = Math; function F() { this.x = 1; } F.call(o);", undefined, { optimization }),
        /sablejs sandbox boundary/,
        `${optimization} allowed a write to a protected receiver`
      );
    }
    // And a plain guest receiver stays writable through the stamp path.
    for (const optimization of ["O0", "O1", "O2", "Os"]) {
      assert.equal(
        run("var o = { n: 1 }; function F() { this.n = this.n + 1; } F.call(o); o.n;", undefined, {
          optimization,
        }).value,
        2
      );
    }
  });

  it("fast-paths new-of-guest-closure results and keeps unsafe constructors guarded", function () {
    // A return-safe guest constructor: `new` always yields the fresh object,
    // so writes to the result skip writeTarget resolution.
    const safeLoaded = load(
      "function Point(x, y) { this.x = x; this.y = y; }" +
        "var p = new Point(1, 2); p.x = 3; p.x + p.y;",
      { optimization: "O2" }
    );
    const safe = safeLoaded.program.createInstance({ profileBoundary: true });
    assert.equal(safe.run(), 5);
    assert.equal(safeLoaded.result.stats.guestProvenance.markedNews, 1);
    assert.match(safeLoaded.result.code, /setGuestPropertyValue/);
    assert.equal(safe.boundaryStats().writeTargets, 0);

    // A constructor that can return an object is NOT return-safe: the mark
    // must be withheld and writes stay on the guarded path.
    const unsafeLoaded = load(
      "function G() { return { ok: 1 }; }" + "var g = new G(); g.x = 1; g.x;",
      { optimization: "O2" }
    );
    const unsafe = unsafeLoaded.program.createInstance({ profileBoundary: true });
    assert.equal(unsafe.run(), 1);
    assert.equal(unsafeLoaded.result.stats.guestProvenance.markedNews, 0);
    assert.match(unsafeLoaded.result.code, /setSandboxPropertyValue/);
    assert.ok(unsafe.boundaryStats().writeTargets > 0);

    // new of an intrinsic name is never marked: the host can inject a
    // hostile constructor under the same global name at instance creation,
    // so a static mark would be unsound. Writes to the result stay guarded.
    const intrinsicLoaded = load("var a = new Array(3); a[0] = 7; a[1] = 8; a[0] + a[1];", {
      optimization: "O2",
    });
    const intrinsic = intrinsicLoaded.program.createInstance({ profileBoundary: true });
    assert.equal(intrinsic.run(), 15);
    assert.equal(intrinsicLoaded.result.stats.guestProvenance.markedNews, 0);
    assert.ok(intrinsic.boundaryStats().writeTargets >= 2);
  });

  it("pins isUnmediatedWriteTarget to writeTarget's no-op condition", function () {
    // The frame stamp is only sound if it is the exact complement of
    // writeTarget's resolution: whenever writeTarget(v) throws or returns a
    // target other than v, isUnmediatedWriteTarget(v) must be false, and
    // vice versa. Sweep representative values through both.
    const loaded = run("({ a: 1 });", { print: sablejs.capability(() => 1) });
    const instance = loaded.instance;
    const boundary = instance.boundary;
    const wrapper = instance.global.print;
    const values = [
      instance.global,
      instance.global.Object,
      globalThis.Math,
      globalThis.JSON,
      globalThis.Date,
      globalThis.Function,
      boundary.functionConstructor,
      boundary.redactedToString,
      wrapper,
      () => 1,
      {},
      [],
      Object(1),
      Object.create(null),
      undefined,
      null,
      1,
      "s",
      true,
      NaN,
    ];
    for (const value of values) {
      let noOp;
      try {
        // Object.is: `===` is false for NaN, which would mis-flag a genuine
        // no-op as a target change.
        noOp = Object.is(boundary.writeTarget(value), value);
      } catch {
        noOp = false;
      }
      const label = value === null ? "null" : typeof value;
      assert.equal(
        boundary.isUnmediatedWriteTarget(value),
        noOp,
        `isUnmediatedWriteTarget diverged from writeTarget for a ${label} value`
      );
    }
  });

  it("fast-paths phi-joined guest objects and keeps mixed joins guarded", function () {
    const joined = run(
      "var o = (g.flag ? {} : {}); o.x = 1; o.x;",
      { g: { flag: 1 } },
      { optimization: "O2" }
    );
    assert.equal(joined.value, 1);
    assert.match(joined.result.code, /setGuestPropertyValue/);
    assert.doesNotMatch(joined.result.code, /setSandboxPropertyValue/);

    const mixed = run(
      "var o = (g.flag ? {} : Math.PI); o.x = 1; o.x;",
      { g: { flag: 1 } },
      { optimization: "O2" }
    );
    assert.equal(mixed.value, 1);
    assert.match(mixed.result.code, /setSandboxPropertyValue/);
  });

  it("emits arity-specialized dispatch for guest calls and the generic form above five args", function () {
    const loaded = load(
      "var f0 = function () { return 0; }; var f1 = function (a) { return a; }; " +
        "var f5 = function (a, b, c, d, e) { return a + b + c + d + e; }; " +
        "var f6 = function (a, b, c, d, e, f) { return f; }; " +
        "f0(); f1(1); f5(1, 2, 3, 4, 5); f6(1, 2, 3, 4, 5, 6);",
      { optimization: "O2" }
    );
    assert.match(loaded.result.code, /applySandboxValue0: \$applySandbox0/);
    assert.match(loaded.result.code, /applySandboxValue1: \$applySandbox1/);
    assert.match(loaded.result.code, /applySandboxValue5: \$applySandbox5/);
    // Six-argument calls keep the generic array form.
    assert.match(loaded.result.code, /applySandboxValue: \$applySandbox/);
    assert.match(loaded.result.code, /\$applySandbox\(\$r, [^)]*, \[[^\]]{4,}\]\)/);
  });

  it("dispatches arities 0-5 and >5 with correct results and this bindings", function () {
    const source =
      "var box = { base: 10, call: function () { return this.base; } }; " +
      "var zero = function () { return 0; }; " +
      "var one = function (a) { return a; }; " +
      "var two = function (a, b) { return a * b; }; " +
      "var three = function (a, b, c) { return a + b + c; }; " +
      "var four = function (a, b, c, d) { return a - b - c - d; }; " +
      "var five = function (a, b, c, d, e) { return a + b + c + d + e; }; " +
      "var six = function (a, b, c, d, e, f) { return a + b + c + d + e + f; }; " +
      "result = zero() + one(1) + two(2, 3) + three(1, 2, 3) + " +
      "four(10, 1, 2, 3) + five(1, 2, 3, 4, 5) + six(1, 2, 3, 4, 5, 6) + " +
      "box.call();";
    for (const optimization of ["O0", "O1", "O2", "Os"]) {
      const ran = run(source, undefined, { optimization });
      assert.equal(
        ran.value,
        0 + 1 + 6 + 6 + 4 + 15 + 21 + 10,
        `arity dispatch at ${optimization}`
      );
    }
  });

  it("ignores guest-overridden .call/.apply on the fast dispatch path", function () {
    // The arity-specialized fast path forwards via the captured
    // Function.prototype.call, so guest code overwriting callable.call must
    // not hijack the invocation (and the overwritten property is honored by
    // direct member calls, matching the host).
    const source =
      "var hijack = function (a) { return a + 1; }; " +
      "hijack.call = function () { return 999; }; " +
      "result = hijack(1) + (hijack.call === Function.prototype.call ? 1 : 0);";
    const ran = run(source, undefined, { optimization: "O2" });
    assert.equal(ran.value, 2, "call site dispatches to the closure, not to hijack.call");
  });

  it("keeps dispatch entry accounting across the arity variants", function () {
    const loaded = load("var f = function (a) { return a; }; " + "var h = f; result = h(3);", {
      optimization: "O2",
    });
    const instance = loaded.program.createInstance({ profileBoundary: true });
    assert.equal(instance.run(), 3);
    const stats = instance.boundary.stats;
    assert.equal(stats.calls, 1, "one dispatch entry");
    assert.equal(stats.guestCalls, 1, "one guest dispatch");
    assert.equal(stats.hostCalls, 0, "no host mediation");

    const hostLoaded = load("result = Math.max(3, 7);", { optimization: "O2" });
    const hostInstance = hostLoaded.program.createInstance({ profileBoundary: true });
    assert.equal(hostInstance.run(), 7);
    const hostStats = hostInstance.boundary.stats;
    assert.equal(hostStats.guestCalls, 0);
    assert.equal(hostStats.hostCalls, 1);
  });

  it("throws the host-style TypeError for non-function callables through every arity", function () {
    for (const source of ["42();", "var t = 1; t(2);", "var s = 'x'; s();", "var u; u();"]) {
      assert.throws(
        () => run(source, undefined, { optimization: "O2" }),
        (error) => error instanceof TypeError && /is not a function/.test(String(error.message)),
        source
      );
    }
  });
});

describe("sablejs literal-init fast path (prototype write guard, audit 2026-08-23)", function () {
  it("creates own data properties for plain literals in both modes", function () {
    for (const security of ["sandbox", "trusted"]) {
      const value = run(
        "var o = { a: 1, b: 'x', c: null }; [o.a, o.b, o.c === null, Object.getOwnPropertyDescriptor(o, 'a').writable];",
        undefined,
        { optimization: "O2", security }
      ).value;
      assert.deepStrictEqual(value, [1, "x", true, true], security);
    }
  });

  it("initializes array literal holes and length without observing the prototype", function () {
    const value = run("var a = [1, , 3]; [a.length, a[0], a[1], a[2], 1 in a];", undefined, {
      optimization: "O2",
      security: "trusted",
    }).value;
    assert.deepStrictEqual(value, [3, 1, undefined, 3, false]);
  });

  it("creates object-literal properties over inherited non-writable data properties", function () {
    for (const optimization of ["O1", "O2"]) {
      for (const strict of [false, true]) {
        const value = run(
          (strict ? "'use strict'; " : "") +
            "Object.defineProperty(Object.prototype, 'blocked', " +
            "{ value: 9, writable: false, configurable: true }); " +
            "var result; try { " +
            "  var o = { blocked: 3 }; " +
            "  result = [o.blocked, Object.prototype.hasOwnProperty.call(o, 'blocked'), " +
            "   Object.getOwnPropertyDescriptor(o, 'blocked').writable]; " +
            "} finally { delete Object.prototype.blocked; } result;",
          undefined,
          { optimization, security: "trusted" }
        ).value;
        assert.deepStrictEqual(value, [3, true, true], `${optimization}, strict=${strict}`);
      }
    }
  });

  it("creates array-literal elements over inherited non-writable indices", function () {
    for (const optimization of ["O1", "O2"]) {
      for (const strict of [false, true]) {
        const value = run(
          (strict ? "'use strict'; " : "") +
            "Object.defineProperty(Array.prototype, '0', " +
            "{ value: 9, writable: false, configurable: true }); " +
            "var result; try { " +
            "  var a = [3]; " +
            "  result = [a[0], Object.prototype.hasOwnProperty.call(a, '0'), " +
            "   Object.getOwnPropertyDescriptor(a, '0').writable]; " +
            "} finally { delete Array.prototype[0]; } result;",
          undefined,
          { optimization, security: "trusted" }
        ).value;
        assert.deepStrictEqual(value, [3, true, true], `${optimization}, strict=${strict}`);
      }
    }
  });

  it("bypasses inherited setters for literals but not for assignments (trusted mode)", function () {
    // After a setter lands on Object.prototype, literal init must still
    // create own data properties (ES5.1 CreateDataProperty). Plain
    // assignment observes the inherited setter only when no own property
    // shadows it — and once the literal has created one, re-assignment
    // writes that own property without touching the setter.
    const value = run(
      "var hits = 0; " +
        "Object.prototype.__defineSetter__('boom', function () { hits += 1; }); " +
        "var o = { boom: 41 }; " + // literal init: own data prop, setter not fired
        "o.boom = 42; " + // own prop shadows the setter: still not fired
        "var o2 = {}; " +
        "o2.boom = 5; " + // no own prop: assignment fires the setter
        "var result = [o.boom, hits, Object.getOwnPropertyDescriptor(o, 'boom').writable, o2.boom]; " +
        "delete Object.prototype.boom; " +
        "result;",
      undefined,
      { optimization: "O2", security: "trusted" }
    ).value;
    assert.deepStrictEqual(value, [42, 1, true, undefined]);
  });

  it("treats an accessor descriptor with set: undefined as unsafe for assignment", function () {
    const value = run(
      "var hits = 0; " +
        "Object.defineProperty(Object.prototype, 'k', { set: function () { hits += 1; }, configurable: true }); " +
        "var o = { k: 7 }; " +
        "[o.k, hits];",
      undefined,
      { optimization: "O2", security: "trusted" }
    ).value;
    assert.deepStrictEqual(value, [7, 0]);
  });

  it("keeps __proto__ literal keys as data properties (ES5.1, not prototype assignment)", function () {
    const value = run(
      "var p = { marker: 1 }; var o = { __proto__: p }; " +
        "[o.__proto__ === p, Object.getOwnPropertyDescriptor(o, '__proto__').writable, o.marker];",
      undefined,
      { optimization: "O2", security: "trusted" }
    ).value;
    assert.deepStrictEqual(value, [true, true, undefined]);
  });

  it("keeps literal semantics stable after defineProperties setter installs", function () {
    const value = run(
      "var hits = 0; " +
        "Object.defineProperties(Object.prototype, { g: { set: function () { hits += 1; } } }); " +
        "var o = { g: 5 }; " +
        "[o.g, hits];",
      undefined,
      { optimization: "O2", security: "trusted" }
    ).value;
    assert.deepStrictEqual(value, [5, 0]);
  });

  it("keeps sandbox literals immune to prototype setter attempts (blocked mutation)", function () {
    assert.throws(
      () =>
        run("Object.prototype.__defineSetter__('boom', function () {}); 1;", undefined, {
          optimization: "O2",
          security: "sandbox",
        }),
      /sablejs sandbox boundary/,
      "sandbox must block prototype setter installation"
    );
  });

  it("bypasses getter-only accessors installed via defineProperty (no 'set' key)", function () {
    // A getter-only accessor is still an accessor: assignment through it
    // has no setter to call (TypeError in the strict runtime module), so
    // literal init must not assign — the guard flags any accessor, not
    // just setters. Plain sloppy assignment on a missing own key stays a
    // silent no-op (the getter still answers reads).
    const value = run(
      "Object.defineProperty(Object.prototype, 'k', { get: function () { return 9; }, configurable: true }); " +
        "var v = 7; " +
        "var o = {k: v}; " +
        "var o2 = {}; " +
        "o2.k = 5; " +
        "[o.k, o2.k, Object.getOwnPropertyDescriptor(o, 'k').writable];",
      undefined,
      { optimization: "O2", security: "trusted" }
    ).value;
    assert.deepStrictEqual(value, [7, 9, true]);
  });

  it("bypasses getter-only accessors installed via __defineGetter__", function () {
    const value = run(
      "Object.prototype.__defineGetter__('q', function () { return 10; }); " +
        "var v = 7; " +
        "var o = {q: v}; " +
        "var result = [o.q]; " +
        "delete Object.prototype.q; " + // __defineGetter__ installs enumerable; don't leave it
        "result;",
      undefined,
      { optimization: "O2", security: "trusted" }
    ).value;
    assert.deepStrictEqual(value, [7]);
  });

  it("bypasses getter-only accessors installed via defineProperties", function () {
    const value = run(
      "Object.defineProperties(Object.prototype, { r: { get: function () { return 11; } } }); " +
        "var v = 7; " +
        "var o = {r: v}; " +
        "[o.r];",
      undefined,
      { optimization: "O2", security: "trusted" }
    ).value;
    assert.deepStrictEqual(value, [7]);
  });

  it("keeps literal inits intact after a failed sloppy __proto__ chain swap", function () {
    // Modern hosts make Object.prototype an immutable-prototype exotic: a
    // __proto__ write on it throws (sloppy included), so the chain never
    // changes — the write-path guard flag is defensive for hosts without
    // that behavior. This pins host parity: the write throws and a
    // subsequent literal still creates own data properties.
    const value = run(
      "var hits = 0; " +
        "var caught = false; " +
        "try { Object.prototype.__proto__ = { set k(f) { hits += 1; } }; } catch (e) { caught = true; } " +
        "var v = 7; " +
        "var o = {k: v}; " +
        "[caught, o.k, hits, Object.getOwnPropertyDescriptor(o, 'k').writable];",
      undefined,
      { optimization: "O2", security: "trusted" }
    ).value;
    assert.deepStrictEqual(value, [true, 7, 0, true]);
  });

  it("keeps literal inits intact after a failed strict __proto__ chain swap", function () {
    const value = run(
      '"use strict"; ' +
        "var caught = false; " +
        "try { Object.prototype.__proto__ = { a: 1 }; } catch (e) { caught = true; } " +
        "var v = 7; " +
        "var o = {k: v}; " +
        "[caught, o.k, Object.getOwnPropertyDescriptor(o, 'k').writable];",
      undefined,
      { optimization: "O2", security: "trusted" }
    ).value;
    assert.deepStrictEqual(value, [true, 7, true]);
  });

  it("keeps literal inits intact after a failed Reflect.set __proto__ swap", function () {
    const value = run(
      "var caught = false; " +
        "try { Reflect.set(Object.prototype, '__proto__', { a: 1 }); } catch (e) { caught = true; } " +
        "var v = 7; " +
        "var o = {k: v}; " +
        "[caught, o.k, Object.getOwnPropertyDescriptor(o, 'k').writable];",
      undefined,
      { optimization: "O2", security: "trusted" }
    ).value;
    assert.deepStrictEqual(value, [true, 7, true]);
  });
});

describe("sablejs capability tokens in trusted mode", function () {
  it("unwraps capability tokens to their recorded callables", function () {
    const rawFn = (x) => x * 10;
    const tok = sablejs.capability(rawFn, { name: "tok" });
    const value = run(
      "[tok(2), input.a.tok(3), input.arr[0](4), input.m.get('k')(5), input.s.has(tok)];",
      { tok, input: { a: { tok }, arr: [tok], m: new Map([["k", tok]]), s: new Set([tok]) } },
      { security: "trusted" }
    ).value;
    assert.deepStrictEqual(value, [20, 30, 40, 50, true]);
  });

  it("preserves the trusted pass-through contract when no tokens are present", function () {
    const input = { a: 1, nested: { b: 2 } };
    const loaded = run("input;", { input }, { security: "trusted" });
    assert.strictEqual(loaded.value, input);
    assert.strictEqual(loaded.value.nested, input.nested);
  });

  it("never mutates the host globals object", function () {
    const tok = sablejs.capability(() => 1, { name: "tok" });
    const host = { obj: { fn: tok, data: { x: 1 } } };
    assert.equal(run("input.obj.fn();", { input: host }, { security: "trusted" }).value, 1);
    // The token stays frozen in the host tree, and the guest shares the
    // token-free sibling by reference instead of rebuilding it.
    assert.strictEqual(host.obj.fn, tok);
    assert.strictEqual(
      run("input.obj.data;", { input: host }, { security: "trusted" }).value,
      host.obj.data
    );
  });

  it("replaces the same token with the same callable at every occurrence", function () {
    const rawFn = () => 7;
    const tok = sablejs.capability(rawFn, { name: "tok" });
    assert.equal(run("a === b.c;", { a: tok, b: { c: tok } }, { security: "trusted" }).value, true);

    const obj = { base: 3 };
    const bound = sablejs.capability(
      function () {
        return this.base;
      },
      { name: "m", thisValue: obj }
    );
    const value = run(
      "[m() === m2(), m()];",
      { m: bound, m2: bound },
      { security: "trusted" }
    ).value;
    assert.deepStrictEqual(value, [true, 3]);
  });

  it("unwraps tokens inside cyclic trusted globals", function () {
    const g = { fn: sablejs.capability(() => 7, { name: "fn" }) };
    g.self = g;
    assert.equal(
      run("input.self === input && input.fn();", { input: g }, { security: "trusted" }).value,
      7
    );
  });

  it("honors thisValue in trusted mode", function () {
    const counter = { base: 5 };
    const bound = sablejs.capability(
      function (n) {
        return this.base + n;
      },
      { name: "add", thisValue: counter }
    );
    assert.equal(run("add(3);", { add: bound }, { security: "trusted" }).value, 8);
  });
});
