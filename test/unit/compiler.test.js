"use strict";

const assert = require("assert");
const path = require("path");
const { describe, it } = require("node:test");
const { compile: compileProgram, lowerToHIR, lowerToMIR } = require("../../src/compiler");
const OpSpec = require("../../src/ir/op-spec");
const { buildCFG, verifyCFG } = require("../../src/ir/cfg");
const { ABI_VERSION, createProgram } = require("../../src/runtime");
const { monotonicNow, utf8ByteLength } = require("../../src/platform");
const {
  LOWERING_COVERAGE,
  STATIC_CONTROL_OPS,
  generate,
  validateLoweringCoverage,
} = require("../../src/codegen");

const runtimeModule = path.resolve(__dirname, "../../src/runtime");

function compile(source, options = {}) {
  return compileProgram(source, { security: "trusted", ...options });
}

function load(source, options = {}) {
  const result = compile(source, { runtimeModule, ...options });
  const generatedModule = { exports: {} };
  // This evaluates already-generated test output. Generated modules and the
  // runtime itself do not contain dynamic compilation.
  new Function("require", "module", "exports", result.code)(
    require,
    generatedModule,
    generatedModule.exports
  );
  return { result, program: generatedModule.exports };
}

function run(source, globals, options = {}) {
  const loaded = load(source, options);
  const instance = loaded.program.createInstance({
    globals,
    profileBoundary: options.profileBoundary,
  });
  return { ...loaded, instance, value: instance.run() };
}

describe("sablejs platform adapters", function () {
  it("counts UTF-8 bytes with browser and dependency-free fallbacks", function () {
    const samples = ["ascii", "中文", "😀", "x\ud800y", "\udc00"];
    const expected = samples.map((value) => Buffer.byteLength(value));
    const savedBuffer = globalThis.Buffer;
    const savedTextEncoder = globalThis.TextEncoder;
    try {
      globalThis.Buffer = undefined;
      assert.deepStrictEqual(samples.map(utf8ByteLength), expected);
      globalThis.TextEncoder = undefined;
      assert.deepStrictEqual(samples.map(utf8ByteLength), expected);
    } finally {
      globalThis.Buffer = savedBuffer;
      globalThis.TextEncoder = savedTextEncoder;
    }
  });

  it("provides a finite monotonic timestamp without fixing a host API", function () {
    const first = monotonicNow();
    const second = monotonicNow();
    assert(Number.isFinite(first));
    assert(second >= first);
  });
});

describe("sablejs OpSpec and AOT backend", function () {
  it("describes every frontend opcode", function () {
    assert.equal(OpSpec.count, 90);
    OpSpec.byCode.forEach((spec, code) => {
      assert.equal(spec.code, code);
      assert(spec.name);
      assert(spec.stack !== undefined);
      assert(spec.effect);
    });
  });

  it("has an exhaustive opcode-to-direct-call or static-control lowering", function () {
    assert.deepStrictEqual(validateLoweringCoverage(), LOWERING_COVERAGE);
    assert.equal(LOWERING_COVERAGE.total, 90);
    assert.equal(LOWERING_COVERAGE.directHelpers, 82);
    assert.equal(LOWERING_COVERAGE.staticControl, 8);
    OpSpec.byCode.forEach((spec) => {
      assert(STATIC_CONTROL_OPS.has(spec.name) || spec.helper, `missing lowering for ${spec.name}`);
    });
  });

  it("rejects unstructured control flow instead of emitting an interpreter fallback", function () {
    const scope = {
      id: 0,
      name: "unsupported",
      script: true,
      strict: false,
      lightweight: false,
      usesArguments: false,
      parameterCount: 0,
      parameters: [],
      variables: [],
      dynamicFunctions: [],
      controlRegions: [],
      syntheticRanges: [],
      codeLength: 1,
      instructions: [{ op: "JUMP", offset: 0, end: 1, args: [1] }],
    };
    assert.throws(
      () => generate({ entry: 0, scopes: [scope] }),
      /interpreter\/trampoline fallback is forbidden/
    );
  });

  it("emits direct helper calls without an instruction dispatcher", function () {
    const { result, value } = run("1 + 2 * 3;", undefined, { optimization: "O0" });
    assert.equal(value, 7);
    assert(!/opcode/i.test(result.code));
    assert(!/\bpc\b/.test(result.code));
    assert(!/switch\s*\(/.test(result.code));
    assert(!/\$r\.(?:dispatch|executeOpcode|runOpcode)\b/.test(result.code));
    assert(result.code.includes("$r.pushLiteral"));
    assert(!result.code.includes("function $run"));
    assert.equal(result.stats.codegen.fallbackScopes, 0);
  });

  it("lowers O2 primitive expressions to JIT-friendly JavaScript locals", function () {
    const { result, value } = run("var x = 2; x = (x + 3) * 4; x;", undefined, {
      optimization: "O2",
    });
    assert.equal(value, 20);
    assert(!result.code.includes("const $s = $f.stack"));
    assert(result.code.includes("const $v"));
    assert(!result.code.includes("$r.add($f)"));
    assert(!result.code.includes("$r.multiply($f)"));
    assert(result.stats.codegen.stackToLocal.helpersAvoided > 0);
  });

  it("keeps stackToLocal:false on the explicit-stack fallback at O2/Os", function () {
    // Promotion plans build $l locals that only exist on the lowered path;
    // with stackToLocal disabled the emitter falls back to the explicit
    // stack, so plans must not be built (the drift guard would otherwise
    // fail a legal compile — regression: "$r.getVar" leak).
    for (const optimization of ["O2", "Os"]) {
      for (const security of ["sandbox", "trusted"]) {
        const source = "var x=1; function f(a){ return a+x; } f(4);";
        const { result, value } = run(source, undefined, {
          optimization,
          security,
          stackToLocal: false,
        });
        assert.equal(value, 5, `${optimization} ${security} semantics`);
        assert.equal(
          result.stats.codegen.stackToLocal.enabled,
          false,
          `${optimization} ${security} stats`
        );
        assert.equal(
          result.stats.codegen.localPromotion.promotedSlots,
          0,
          `${optimization} ${security} plans`
        );
        // The fallback resolves variables through the runtime helpers rather
        // than lowering them into JIT-friendly locals.
        assert(result.code.includes("$r.getVar($f"), `${optimization} ${security} fallback lookup`);
        assert(!result.code.includes("const $v"), `${optimization} ${security} no lowered locals`);
      }
    }
  });

  it("supports direct control-flow block calls", function () {
    const source = "var i = 0; while (i < 5) { i++; } if (i === 5) { i + 10; } else { 0; }";
    assert.equal(run(source).value, 15);
  });

  it("emits simple source loops as native loops without a backedge trampoline", function () {
    for (const source of [
      "var i = 0; while (i < 4) { i++; } i;",
      "var i = 0; do { i++; } while (i < 4); i;",
      "var i = 0; for (; i < 4; i++) {} i;",
      "var result = '', object = { a: 1, b: 2 }; for (var key in object) { result += key; } result;",
    ]) {
      const { result, value } = run(source, undefined, { optimization: "O0" });
      assert(value === 4 || value === "ab");
      assert(result.code.includes("while (true)"));
      assert(!result.code.includes("$backedge"));
      assert(!result.code.includes("function $jump"));
    }
  });

  it("emits simple source conditionals as native if/else without block functions", function () {
    for (const source of [
      "var value = 1; if (host) { value = 2; } value;",
      "var value; if (host) { value = 2; } else { value = 3; } value;",
    ]) {
      const truthy = run(source, { host: true }, { optimization: "O0" });
      const falsy = run(source, { host: false }, { optimization: "O0" });
      assert.equal(truthy.value, 2);
      assert.equal(falsy.value, source.includes("else") ? 3 : 1);
      assert(truthy.result.code.includes("if ($r.branch($f))"));
      assert(!truthy.result.code.includes("function $b"));
      assert(!truthy.result.code.includes("function $run"));
    }
  });

  it("emits nested and sequential reducible regions as structured host control flow", function () {
    const source =
      "var i = 0, sum = 0; while (i < 5) { if (i % 2) { sum += i; } i++; } " +
      "if (sum === 4) { for (var j = 0; j < 2; j++) { sum++; } } sum;";
    const { result, value } = run(source, undefined, { optimization: "O0" });
    assert.equal(value, 6);
    assert(result.code.match(/while \(true\)/g).length >= 2);
    assert(result.code.includes("if ($r.branch($f))"));
    assert(!result.code.includes("function $b"));
    assert(!result.code.includes("$backedge"));
  });

  it("lowers targeted break and continue with loop-specific continuation semantics", function () {
    const source =
      "var i = 0, sum = 0; outer: for (; i < 7; i++) { " +
      "if (i === 2) continue; if (i === 5) break outer; sum += i; } " +
      "var j = 0; do { j++; if (j < 3) continue; sum += j; } while (j < 4); sum + i * 100;";
    const { result, value } = run(source, undefined, { optimization: "O0" });
    assert.equal(value, 515);
    assert(result.code.includes("continue $loop"));
    assert(result.code.includes("break $loop"));
    assert(!result.code.includes("function $b"));
    assert(!result.code.includes("$backedge"));
  });

  it("keeps labelled-break completion values after O2 location stripping", function () {
    for (const loop of [
      "while (true) { i++; if (i === 3) break done; }",
      "do { i++; if (i === 3) break done; } while (true);",
    ]) {
      const source = `var i = 0; done: { ${loop} throw new Error('unreachable'); } i;`;
      const loaded = run(source, undefined, { optimization: "O2" });
      assert.equal(loaded.value, 3);
      assert.equal(loaded.result.stats.codegen.fallbackScopes, 0);
    }
  });

  it("creates callable native functions and closures", function () {
    const source =
      "function outer(x) { return function(y) { return x + y; }; } var add4 = outer(4); add4(5);";
    const { value, instance } = run(source);
    assert.equal(value, 9);
    assert.equal(typeof instance.global.outer, "function");
    assert.equal(instance.global.outer(10)(2), 12);
  });

  it("keeps compiled function coercion consistent with explicit toString", function () {
    const source =
      "({} + function(){return 1}) === " + "({}.toString() + function(){return 1}.toString());";
    const loaded = run(source, undefined, { optimization: "O2" });
    assert.equal(loaded.value, true);
  });

  it("uses the ES5.1 descriptor for compiled function length", function () {
    const { value } = run(
      `
      var fn = function(a, b) {};
      var descriptor = Object.getOwnPropertyDescriptor(fn, "length");
      [descriptor.value, descriptor.writable, descriptor.enumerable,
       descriptor.configurable, delete fn.length, fn.hasOwnProperty("length")];
    `,
      undefined,
      { optimization: "O2" }
    );
    assert.deepStrictEqual(value, [2, false, false, false, false, true]);
  });

  it("preserves compiled method this and constructor behavior", function () {
    const source =
      "function Box(x) { this.x = x; } Box.prototype.read = function() { return this.x; }; var box = new Box(7); box.read();";
    const { value, instance } = run(source);
    assert.equal(value, 7);
    assert(instance.global.box instanceof instance.global.Box);
  });

  it("passes host objects through without wrappers and preserves identity", function () {
    const host = { count: 1 };
    const { value } = run("host.count = host.count + 1; host;", { host });
    assert.strictEqual(value, host);
    assert.equal(host.count, 2);
  });

  it("uses native objects, arrays, holes, properties, and constructors", function () {
    const source = "var value = { list: [1,,3] }; value.list[1] = new Date(0); value;";
    const { value, instance } = run(source);
    assert.strictEqual(value, instance.global.value);
    assert(Array.isArray(value.list));
    assert(value.list[1] instanceof Date);
    assert.equal(value.list[1].getTime(), 0);
  });

  it("exposes host ArrayBuffer, DataView, and TypedArray objects without wrappers", function () {
    const source =
      "var buffer = new ArrayBuffer(8);" +
      "var bytes = new Uint8Array(buffer);" +
      "var view = new DataView(buffer);" +
      "bytes[0] = 17; view.setUint16(1, 0x1234);" +
      "({ buffer: buffer, bytes: bytes, view: view, value: bytes[0] + view.getUint16(1) });";
    const loaded = run(source, undefined, { optimization: "O2" });
    assert(loaded.value.buffer instanceof ArrayBuffer);
    assert(loaded.value.bytes instanceof Uint8Array);
    assert(loaded.value.view instanceof DataView);
    assert.strictEqual(loaded.value.bytes.buffer, loaded.value.buffer);
    assert.equal(loaded.value.value, 17 + 0x1234);

    const buffer = new ArrayBuffer(4);
    const injected = run(
      "var bytes = new Uint8Array(buffer); bytes[2] = 99; bytes.buffer;",
      { buffer },
      { optimization: "O2" }
    );
    assert.strictEqual(injected.value, buffer);
    assert.equal(new Uint8Array(buffer)[2], 99);
  });

  it("uses native sloppy and strict property assignment semantics at O2", function () {
    const sloppySource =
      "var object = {}; Object.defineProperty(object, 'x', " +
      "{ value: 1, writable: false }); object.x = 2; object.x;";
    const sloppy = run(sloppySource, undefined, { optimization: "O2" });
    assert.equal(sloppy.value, 1);
    assert(sloppy.result.code.includes("$writeSloppy("));

    const strict = load(`"use strict"; ${sloppySource}`, { optimization: "O2" });
    assert(strict.result.code.includes("$writeStrict("));
    assert.throws(() => strict.program.createInstance().run(), TypeError);

    const rejected = new Proxy(
      {},
      {
        set() {
          return false;
        },
      }
    );
    assert.equal(run("host.x = 1; 7;", { host: rejected }, { optimization: "O2" }).value, 7);
    assert.throws(
      () => run("'use strict'; host.x = 1;", { host: rejected }, { optimization: "O2" }),
      TypeError
    );
  });

  it("recognizes the complete ES5 directive prologue", function () {
    assert.equal(
      run(
        "function f() { 'another directive'; 'use strict'; return this === undefined; } f.call(undefined);"
      ).value,
      true
    );
    assert.equal(
      run(
        "function f() { 'another directive'\n'use strict'; return this === undefined; } f.call(undefined);"
      ).value,
      true
    );
    assert.equal(
      run(
        "function f() { 'another directive'; 0; 'use strict'; return this === undefined; } f.call(undefined);"
      ).value,
      false
    );
  });

  it("allows an ES5 strict object literal getter/setter pair", function () {
    const source =
      "'use strict'; var stored = 0, object = { " +
      "get value() { return stored; }, set value(next) { stored = next; } }; " +
      "object.value = 7; object.value;";
    assert.equal(run(source).value, 7);
  });

  it("keeps O0 as an oracle for enabled optimization levels", function () {
    const source = "var x = 2; x = x * 4 + 1; x;";
    const o0 = run(source, undefined, { optimization: "O0" });
    for (const optimization of ["O1", "O2", "Os"]) {
      assert.deepStrictEqual(run(source, undefined, { optimization }).value, o0.value);
    }
    assert.equal(o0.result.stats.passes.length, 0);
  });

  it("builds CFG predecessors, dominators, and natural loop backedges", function () {
    const hir = lowerToHIR("var i = 0; while (i < 2) { i++; } i;");
    const cfg = buildCFG(hir.scopes[0]);
    assert.equal(verifyCFG(cfg, hir.scopes[0]), true);
    assert(cfg.blocks.length > 2);
    assert(cfg.loops.length > 0);
    const loop = cfg.loops[0];
    assert(cfg.dominators.get(loop.backedge).has(loop.header));
    assert(cfg.byStart.get(loop.header).predecessors.includes(loop.backedge));
    assert.equal(cfg.immediateDominators.get(cfg.entry), null);
  });

  it("preserves frontend structured-control regions through HIR lowering", function () {
    const hir = lowerToHIR(
      "if (host) { while (test()) { body(); } } else { for (var i = 0; i < 2; i++) { body(); } } " +
        "do { body(); } while (test()); for (var key in object) { body(); }"
    );
    const kinds = hir.scopes[0].controlRegions.map((region) => region.kind);
    assert.deepStrictEqual(kinds.slice().sort(), ["DoWhile", "For", "ForIn", "If", "While"]);
    hir.scopes[0].controlRegions.forEach((region) => {
      assert(Number.isInteger(region.start));
      assert(Number.isInteger(region.end));
      assert(region.end >= region.start);
    });
  });

  it("emits switch selection, fallthrough, and break as native switch control", function () {
    const source =
      "var result = ''; switch (host) { " +
      "case probe(1): result += 'a'; case probe(2): result += 'b'; break; " +
      "default: result = 'd'; } result + ':' + calls;";
    for (const [host, expected] of [
      [1, "ab:1"],
      [2, "b:2"],
      [3, "d:2"],
    ]) {
      let calls = 0;
      const loaded = run(
        source,
        {
          host,
          get calls() {
            return calls;
          },
          probe(value) {
            calls += 1;
            return value;
          },
        },
        { optimization: "O0" }
      );
      assert.equal(loaded.value, expected);
      assert(loaded.result.code.includes("switch ($case"));
      assert(loaded.result.code.includes("$r.caseJump($f)"));
      assert(!loaded.result.code.includes("function $b"));
      assert(!loaded.result.code.includes("$backedge"));
    }
  });

  it("emits dense constant-case switches as a native switch over the discriminant", function () {
    // Every case test is a single compile-time constant: the host switch
    // compares the discriminant directly, no $r.caseJump, no selector
    // variable, no guard chain. ES5 switch is strict equality on the
    // once-evaluated discriminant, which is exactly native switch semantics;
    // the "1" host exercises the no-coercion behavior.
    const source =
      "var result = ''; switch (host) { " +
      "case 1: result += 'a'; break; case 2: result += 'b'; break; " +
      "case 3: result += 'c'; break; default: result = 'd'; } result;";
    for (const security of ["trusted", "sandbox"]) {
      for (const [host, expected] of [
        [1, "a"],
        [2, "b"],
        [3, "c"],
        [7, "d"],
        ["1", "d"],
      ]) {
        const loaded = run(source, { host }, { optimization: "O2", security });
        assert.equal(loaded.value, expected);
        assert(loaded.result.code.includes("switch ($d"));
        assert(!loaded.result.code.includes("$r.caseJump($f)"));
        assert.equal(loaded.result.stats.codegen.stackToLocal.denseSwitches, 1);
        assert.equal(loaded.result.stats.codegen.stackToLocal.denseSwitchCases, 3);
      }
    }
  });

  it("preserves switch fallthrough, break, and out-of-order default in dense switches", function () {
    // Default sits between the case bodies: a match must skip it, a non-match
    // must enter it and then fall through, exactly like the guarded chain.
    const source =
      "var result = ''; switch (host) { " +
      "default: result += 'd'; case 1: result += 'a'; case 2: result += 'b'; break; " +
      "case 3: result += 'c'; break; } result;";
    for (const [host, expected] of [
      [1, "ab"],
      [2, "b"],
      [3, "c"],
      [9, "dab"],
    ]) {
      assert.equal(run(source, { host }, { optimization: "O2" }).value, expected);
      assert.equal(run(source, { host }, { optimization: "O0" }).value, expected);
    }
  });

  it("falls back to the guarded chain for non-constant or colliding case tests", function () {
    const nonConstant =
      "var result = ''; switch (host) { " +
      "case probe(1): result = 'a'; break; default: result = 'd'; } result;";
    const o2 = run(
      nonConstant,
      {
        host: 1,
        probe(value) {
          return value;
        },
      },
      { optimization: "O2" }
    );
    assert.equal(o2.value, "a");
    assert(o2.result.code.includes("$r.caseJump($f)"));
    assert.equal(o2.result.stats.codegen.stackToLocal.denseSwitches, 0);

    // Duplicate labels (valid guest code, first match wins) collide under
    // SameValueZero and would be a host SyntaxError — must stay guarded.
    const duplicate =
      "var result = ''; switch (host) { " +
      "case 1: result = 'a'; break; case 1: result = 'b'; break; default: result = 'd'; } result;";
    const dup = run(duplicate, { host: 1 }, { optimization: "O2" });
    assert.equal(dup.value, "a");
    assert(dup.result.code.includes("$r.caseJump($f)"));
    assert.equal(dup.result.stats.codegen.stackToLocal.denseSwitches, 0);

    // -0 and 0 are the same label under SameValueZero — a host switch would
    // be a SyntaxError, so the guarded chain must be kept. Guest semantics
    // stay first-match-wins on === (0 === -0), identical across O2/O0.
    const zero =
      "var result = ''; switch (host) { " +
      "case -0: result = 'n'; break; case 0: result = 'p'; break; default: result = 'd'; } result;";
    for (const host of [0, -0]) {
      assert.equal(run(zero, { host }, { optimization: "O2" }).value, "n");
      assert.equal(run(zero, { host }, { optimization: "O0" }).value, "n");
    }
    const zeroO2 = run(zero, { host: 0 }, { optimization: "O2" });
    assert(zeroO2.result.code.includes("$r.caseJump($f)"));
  });

  it("handles NaN, strings, booleans, null, undefined, and floats as dense case constants", function () {
    // NaN is a global read, not a constant op, so this switch stays guarded;
    // a NaN label never matches under === in either path.
    const nan =
      "var result = ''; switch (host) { case NaN: result = 'n'; break; default: result = 'd'; } result;";
    const nanO2 = run(nan, { host: NaN }, { optimization: "O2" });
    assert.equal(nanO2.value, "d");
    assert(nanO2.result.code.includes("$r.caseJump($f)"));
    assert.equal(run(nan, { host: 1 }, { optimization: "O2" }).value, "d");
    assert.equal(run(nan, { host: 1 }, { optimization: "O0" }).value, "d");

    const mixed =
      "var result = ''; switch (host) { case 's': result = 's'; break; " +
      "case true: result = 't'; break; case null: result = 'u'; break; " +
      "case undefined: result = 'v'; break; case 1.5: result = 'w'; break; " +
      "case -2: result = 'x'; break; default: result = 'd'; } result;";
    for (const [host, expected] of [
      ["s", "s"],
      [true, "t"],
      [null, "u"],
      [undefined, "v"],
      [1.5, "w"],
      [-2, "x"],
      [0, "d"],
    ]) {
      assert.equal(run(mixed, { host }, { optimization: "O2" }).value, expected);
    }
  });

  it("keeps loop break/continue and nested regions working inside dense switches", function () {
    // continue targets the outer loop across the switch; the inner switch is
    // dense and sits inside the loop region.
    const loop =
      "var result = 0; for (var i = 0; i < 4; i += 1) { " +
      "switch (i) { case 0: continue; case 1: result += 10; break; case 2: result += 100; break; " +
      "default: result += 1000; } } result;";
    assert.equal(run(loop, {}, { optimization: "O2" }).value, 1110);
    assert.equal(run(loop, {}, { optimization: "O0" }).value, 1110);

    // A nested short-circuit region inside a dense case body emits correctly.
    const nested =
      "var result = ''; switch (host) { case 1: " +
      "result += (flag ? 'a' : 'b'); break; case 2: result = 'c'; break; default: result = 'd'; } result;";
    for (const [host, expected] of [
      [1, "b"],
      [2, "c"],
      [3, "d"],
    ]) {
      assert.equal(run(nested, { host, flag: false }, { optimization: "O2" }).value, expected);
    }
    assert.equal(run(nested, { host: 1, flag: true }, { optimization: "O2" }).value, "a");
    assert(
      run(nested, { host: 1, flag: false }, { optimization: "O2" }).result.code.includes(
        "switch ($d"
      )
    );
  });

  it("evaluates the discriminant once and breaks out of dense switches", function () {
    let calls = 0;
    const source =
      "var result = ''; switch (probe()) { case 1: result = 'a'; break; " +
      "case 2: result = 'b'; break; default: result = 'd'; } result + ':' + calls;";
    const loaded = run(
      source,
      {
        get calls() {
          return calls;
        },
        probe() {
          calls += 1;
          return 2;
        },
      },
      { optimization: "O2" }
    );
    assert.equal(loaded.value, "b:1");
    assert(loaded.result.code.includes("switch ($d"));
  });

  it("keeps the guarded chain at O0 where there is no stack alias", function () {
    const source =
      "var result = ''; switch (host) { case 1: result = 'a'; break; " +
      "case 2: result = 'b'; break; default: result = 'd'; } result;";
    const o0 = run(source, { host: 2 }, { optimization: "O0" });
    assert.equal(o0.value, "b");
    assert(o0.result.code.includes("$r.caseJump($f)"));
    assert(!o0.result.code.includes("switch ($d"));
    assert.equal(o0.result.stats.codegen.stackToLocal.denseSwitches, 0);
  });

  it("emits reducible try/catch regions directly without block continuations", function () {
    const marker = {};
    const source =
      "var result = 0; try { if (host) throw marker; result = 1; } " +
      "catch (error) { if (error === marker) result = 2; } result;";
    const thrown = run(source, { host: true, marker }, { optimization: "O0" });
    const normal = run(source, { host: false, marker }, { optimization: "O0" });
    assert.equal(thrown.value, 2);
    assert.equal(normal.value, 1);
    assert(thrown.result.code.includes("try {"));
    assert(thrown.result.code.includes("catch ($error"));
    assert(!thrown.result.code.includes("function $b"));
    assert(!thrown.result.code.includes("function $run"));
  });

  it("restores catch environments before outer finally after abrupt catch completion", function () {
    const source =
      "var error = 'outer', seen; try { " +
      "try { throw 1; } catch (error) { throw 2; } finally { seen = error; } " +
      "} catch (outerError) {} seen;";
    const loaded = run(source, undefined, { optimization: "O0" });
    assert.equal(loaded.value, "outer");
    assert(loaded.result.code.includes("$r.endCatch($f)"));
    assert.equal(loaded.result.stats.codegen.fallbackScopes, 0);
  });

  it("structures conditional and logical expression short-circuit control", function () {
    const source =
      "var calls = 0; function hit(value) { calls++; return value; } " +
      "var a = host ? hit('yes') : hit('no'); var b = host && hit('and'); " +
      "var c = host || hit('or'); a + ':' + b + ':' + c + ':' + calls;";
    const truthy = run(source, { host: true }, { optimization: "O0" });
    const falsy = run(source, { host: false }, { optimization: "O0" });
    assert.equal(truthy.value, "yes:and:true:2");
    assert.equal(falsy.value, "no:false:or:2");
    assert(!truthy.result.code.includes("function $b"));
    assert(!truthy.result.code.includes("function $run"));
    assert.equal(truthy.result.stats.codegen.fallbackScopes, 0);
    const nested = run(
      "var result = 0; if (a && b && c) { result = 1; } result;",
      { a: true, b: true, c: true },
      { optimization: "O0" }
    );
    assert.equal(nested.value, 1);
    assert.equal(nested.result.stats.codegen.fallbackScopes, 0);
    assert(!nested.result.code.includes("function $run"));
  });

  it("emits non-abrupt try/finally and try/catch/finally as host exception structure", function () {
    const first = run(
      "var result = ''; try { result += 't'; if (host) throw marker; } " +
        "finally { result += 'f'; } result;",
      { host: false, marker: {} },
      { optimization: "O0" }
    );
    const second = run(
      "var result = ''; try { throw marker; } catch (error) { if (error === marker) result += 'c'; } " +
        "finally { result += 'f'; } result;",
      { marker: {} },
      { optimization: "O0" }
    );
    assert.equal(first.value, "tf");
    assert.equal(second.value, "cf");
    for (const loaded of [first, second]) {
      assert(loaded.result.code.includes("finally {"));
      assert(!loaded.result.code.includes("function $b"));
      assert(!loaded.result.code.includes("function $run"));
    }
  });

  it("uses host finally exactly once across return, break, and continue", function () {
    const source =
      "var log = ''; function returned() { try { return 3; } finally { log += 'r'; } } " +
      "var i = 0; while (i < 4) { i++; try { if (i === 1) continue; if (i === 3) break; log += i; } " +
      "finally { log += 'f'; } } returned() + ':' + log;";
    const loaded = run(source, undefined, { optimization: "O0" });
    assert.equal(loaded.value, "3:f2ffr");
    assert(loaded.result.code.includes("finally {"));
    assert(!loaded.result.code.includes("function $b"));
    assert(!loaded.result.code.includes("function $run"));
    assert.equal(loaded.result.stats.codegen.fallbackScopes, 0);
  });

  it("keeps canonical finally bodies reachable across optimized continue edges", function () {
    const source =
      "var count = 0, finalized = 0; while (count < 2) { " +
      "try { throw 1; } catch (error) { count++; continue; } finally { finalized++; } " +
      "finalized = -100; } count + ':' + finalized;";
    const loaded = run(source, undefined, { optimization: "O1" });
    assert.equal(loaded.value, "2:2");
    assert.equal(loaded.result.stats.codegen.fallbackScopes, 0);
    assert.doesNotThrow(() => lowerToMIR(source));
  });

  it("lowers post-finally for-in cleanup through explicit completion records", function () {
    const source =
      "var object = { a: 1, b: 1 }, count = 0, finalizers = 0; " +
      "for (var key in object) { try { count++; continue; } finally { finalizers++; } } " +
      "count + ':' + finalizers;";
    const loaded = run(source, undefined, { optimization: "O1" });
    assert.equal(loaded.value, "2:2");
    assert(loaded.result.code.includes("$completionRegion"));
    assert(!loaded.result.code.includes("function $run"));
    assert.equal(loaded.result.stats.codegen.fallbackScopes, 0);
    assert.doesNotThrow(() => lowerToMIR(source));
  });

  it("structures labelled block exits and structured static eval scopes", function () {
    const source =
      "var value = 0; outer: { value = 1; if (host) break outer; value = 2; } " +
      "function run() { eval('var i = 0; while (i < 2) { i++; } value += i;'); } run(); value;";
    const loaded = run(source, { host: true }, { optimization: "O0" });
    assert.equal(loaded.value, 3);
    assert(loaded.result.code.includes("$label"));
    assert(loaded.result.code.includes("break $label"));
    assert(!loaded.result.code.includes("function $b"));
    assert(!loaded.result.code.includes("function $run"));
    assert.equal(loaded.result.stats.codegen.fallbackScopes, 0);
  });

  it("lowers operand-stack dataflow to SSA MIR with Phi and use-def chains", function () {
    const mir = lowerToMIR("var x = 1; if (host) { x = 2; } while (x < 4) { x++; } x;");
    assert.equal(mir.kind, "ProgramMIR");
    const entry = mir.scopes[0];
    assert(entry.blocks.length > 2);
    assert(entry.values.length > 0);
    assert(entry.values.some((value) => value.uses.length > 0));
    assert(entry.blocks.some((block) => block.phis.length > 0));
    assert(entry.loops.length > 0);
    assert(entry.blocks.every((block) => block.operations.every((operation) => operation.effect)));
  });

  it("models path-dependent iterator, switch, and exception stack states in MIR", function () {
    for (const source of [
      "for (var key in { a: 1, b: 2 }) { key; }",
      "switch (2) { case 1: 10; break; case 2: 20; break; default: 30; }",
      "try { throw marker; } catch (error) { error; }",
    ]) {
      const mir = lowerToMIR(source);
      assert.equal(mir.kind, "ProgramMIR");
      assert(mir.scopes[0].blocks.length > 1);
    }
  });

  it("removes unreachable basic blocks at optimized levels but preserves O0", function () {
    const source = "function f() { return 1; 123456789 + 987654321; } f();";
    const o0 = load(source, { optimization: "O0" });
    const o1 = load(source, { optimization: "O1" });
    assert.equal(o0.program.createInstance().run(), 1);
    assert.equal(o1.program.createInstance().run(), 1);
    assert(o0.result.code.includes("123456789"));
    assert(!o1.result.code.includes("123456789"));
    assert(o1.result.stats.unreachableBlocksRemoved > 0);
    assert(o1.result.stats.cfg.blocks > 0);
  });

  it("folds constant branches before CFG reachability cleanup", function () {
    const source = "if (1 === 2) { 246813579; } else { 7; }";
    const o0 = load(source, { optimization: "O0" });
    const o1 = load(source, { optimization: "O1" });
    assert.equal(o0.program.createInstance().run(), 7);
    assert.equal(o1.program.createInstance().run(), 7);
    assert(o0.result.code.includes("246813579"));
    assert(!o1.result.code.includes("246813579"));
    assert(o1.result.stats.constantsFolded > 0);
    assert(o1.result.stats.constantBranchesFolded > 0);
    assert(o1.result.stats.unreachableBlocksRemoved > 0);
  });

  it("uses SSA SCCP to fold constant switch edges across basic blocks", function () {
    const source = "switch (2) { case 1: 135792468; break; case 2: 7; break; default: 864297531; }";
    const o0 = load(source, { optimization: "O0" });
    const o1 = load(source, { optimization: "O1" });
    assert.equal(o0.program.createInstance().run(), 7);
    assert.equal(o1.program.createInstance().run(), 7);
    assert(o0.result.code.includes("135792468"));
    assert(!o1.result.code.includes("135792468"));
    assert(!o1.result.code.includes("864297531"));
    assert(o1.result.stats.sccp.constantsPropagated > 0);
    assert(o1.result.stats.sccp.branchesFolded > 0);
  });

  it("propagates constants through private lightweight locals", function () {
    const source = "function f() { var x = 7; var y = x; return y; } f();";
    const o0 = load(source, { optimization: "O0" });
    const o1 = load(source, { optimization: "O1" });
    assert.equal(o0.program.createInstance().run(), 7);
    assert.equal(o1.program.createInstance().run(), 7);
    const o0Loads = (o0.result.code.match(/\$r\.getLocal\(/g) || []).length;
    const o1Loads = (o1.result.code.match(/\$r\.getLocal\(/g) || []).length;
    assert(o1Loads < o0Loads);
    assert(o1.result.stats.copyPropagation.constantsPropagated >= 2);
  });

  it("uses a duplicate for adjacent common local loads at O2", function () {
    const source = "function f(x) { return x + x; } f(host);";
    const o0 = run(source, { host: 6 }, { optimization: "O0" });
    const o2 = run(source, { host: 6 }, { optimization: "O2" });
    assert.equal(o0.value, 12);
    assert.equal(o2.value, 12);
    assert(!o0.result.code.includes("$r.dup($f)"));
    assert(!o2.result.code.includes("$r.dup($f)"));
    assert(/const (\$v\d+_\d+) = \$l\[1\];[\s\S]*\1 \+ \1/.test(o2.result.code));
    assert.equal(o2.result.stats.localCSE.loadsEliminated, 1);
  });

  it("reuses dominating private-local loads across basic blocks", function () {
    const source =
      "function f(flag) { var stable = 7, first = stable; " +
      "if (flag) { first++; } return first + stable; } f(true) + f(false);";
    const o0 = run(source, undefined, { optimization: "O0" });
    const o2 = run(source, undefined, { optimization: "O2" });
    assert.equal(o0.value, 29);
    assert.equal(o2.value, o0.value);
    assert(o2.result.stats.globalValueNumbering.crossBlockLoadsEliminated > 0);
    assert(o2.result.code.includes("let $gv"));

    const killed = run(
      "function f(flag) { var stable = 7, first = stable; " +
        "if (flag) { stable = 9; } return first + stable; } f(true) + f(false);",
      undefined,
      { optimization: "O2" }
    );
    assert.equal(killed.value, 30);
    assert.equal(killed.result.stats.globalValueNumbering.crossBlockLoadsEliminated, 0);
  });

  it("keeps cross-block GVN producers alive across generated loop blocks", function () {
    const source = `
      function tail(node) {
        var current = node;
        while (current.link !== null) current = current.link;
        current.value = 9;
        return current.value;
      }
      tail({ link: { link: null, value: 0 }, value: 0 });
    `;
    const { value } = run(source, undefined, { optimization: "O2" });
    assert.equal(value, 9);
  });

  it("hoists only invariant private-local reads out of natural loops", function () {
    const source =
      "function sum(n) { var invariant = 3, i = 0, total = 0; " +
      "while (i < n) { total = total + invariant; i++; } return total; } sum(4);";
    // Both securities (promotion is security-independent since Phase 3):
    // every non-parameter slot is promoted to a `$p` variable, so the
    // invariant read is a register access and LICM skips the redundant
    // alias. (Under Phase 3 the `$h`/`$l` hoist render is unreachable for
    // private locals — every LICM-eligible scope is promotion-eligible; see
    // the strict-parameter test below.)
    const sandbox = run(source, undefined, { optimization: "O2", security: "sandbox" });
    assert.equal(sandbox.value, 12);
    assert.equal(sandbox.result.stats.loopInvariantCodeMotion.loadsHoisted, 0);
    assert(!sandbox.result.code.includes("const $h"));
    const trusted = run(source, undefined, { optimization: "O2" });
    assert.equal(trusted.value, sandbox.value);
    assert.equal(trusted.result.stats.loopInvariantCodeMotion.loadsHoisted, 0);
    assert(!trusted.result.code.includes("const $h"));

    const changing = run(
      "function sum(n) { var value = 0, i = 0, total = 0; " +
        "while (i < n) { value = value + 1; total = total + value; i++; } return total; } sum(4);",
      undefined,
      { optimization: "O2", security: "sandbox" }
    );
    assert.equal(changing.value, 10);
    assert.equal(changing.result.stats.loopInvariantCodeMotion.loadsHoisted, 0);
  });

  it("hoists strict-parameter reads in scopes with a frame layout", function () {
    const source =
      'function loop(a) { "use strict"; var total = 0, i = 0; ' +
      "while (i < a) { total = total + a; i = i + 1; } return total; } loop(4);";
    // Both securities: the scope is fully promotion-eligible (Item 6
    // phases 2/3), so the LICM mirror skips these loads — the promoted
    // parameter is a register, not a frame-array read.
    for (const security of ["trusted", "sandbox"]) {
      const o2 = run(source, undefined, { optimization: "O2", security });
      assert.equal(o2.value, 16);
      assert.equal(o2.result.stats.loopInvariantCodeMotion.loadsHoisted, 0);
      assert(!o2.result.code.includes("const $h"));
    }
    // A closure-containing scope is not promotion-eligible, and it never
    // hoists either: the frontend marks the scope non-lightweight at the
    // CLOSURE emission site (emitter.emitFunction), and LICM's lightweight
    // guard excludes it before the mirror runs. That is not a coincidence:
    // no lightweight scope can be promotion-ineligible, because every other
    // exclusion term is also impossible there — dynamicFunctions comes only
    // from the Function constructor, which likewise marks the scope
    // non-lightweight, and GETLOCAL2/SETLOCAL2 are never emitted into HIR.
    // So the mirror skip covers the entire LICM space and the `$h = $l[...]`
    // render is unreachable for private locals under Phase 3; the exclusion
    // terms stay in both plans as defense-in-depth for future frontend
    // changes.
    const closure = run(
      'function outer(a) { "use strict"; var total = 0, i = 0; ' +
        "function inner() { return 1; } while (i < a) { total = total + a; i = i + 1; } " +
        "return total + inner(); } outer(4);",
      undefined,
      { optimization: "O2" }
    );
    assert.equal(closure.value, 17);
    assert.equal(closure.result.stats.loopInvariantCodeMotion.loadsHoisted, 0);
    assert(!closure.result.code.includes("const $h"));
    // Only inner's own scope (its self-name slot) is promoted; outer keeps
    // every slot on the frame array.
    assert.equal(closure.result.stats.codegen.localPromotion.eligibleScopes, 1);
    assert.equal(closure.result.stats.codegen.localPromotion.promotedSlots, 1);
  });

  it("does not hoist loads in scopes without a frame layout", function () {
    // The function is nested under a with block, so it has a dynamic chain
    // and codegen gives it no `$l`. Its strict parameter is still propagable
    // under Item 4 semantics, so a naive hoist would emit `$l[...]` into a
    // scope that never declares it.
    const source =
      "var loop, x = 1; with ({ x: 2 }) { loop = function(a) { " +
      '"use strict"; var total = 0, i = 0; while (i < a) { total = total + a; ' +
      "i = i + 1; } return total; }; } loop(4);";
    const o2 = run(source, undefined, { optimization: "O2" });
    assert.equal(o2.value, 16);
    assert.equal(o2.result.stats.loopInvariantCodeMotion.loadsHoisted, 0);
    assert(!o2.result.code.includes("const $h"));
  });

  describe("local promotion (trusted frame-shape specialization)", function () {
    const sumSource =
      "function sum(n) { var invariant = 3, i = 0, total = 0; " +
      "while (i < n) { total = total + invariant; i++; } return total; } sum(4);";

    it("promotes non-parameter locals into $exec prologue variables", function () {
      const o0 = run(sumSource, undefined, { optimization: "O0" });
      const o2 = run(sumSource, undefined, { optimization: "O2" });
      assert.equal(o2.value, o0.value);
      const promotion = o2.result.stats.codegen.localPromotion;
      assert.equal(promotion.eligibleScopes, 1);
      assert.equal(promotion.promotedSlots, 4);
      assert(o2.result.stats.codegen.stackToLocal.promotedLoads > 0);
      assert(o2.result.stats.codegen.stackToLocal.promotedStores > 0);
      // The prologue declares one variable per promoted slot; the loop body
      // reads and writes them directly, with no frame-array access to them.
      assert(/let \$p1_2, \$p1_3, \$p1_4, \$p1_5;/.test(o2.result.code));
      assert(!/\$l\[[2-5]\]/.test(o2.result.code));
      // Parameters keep their frame slot, and the frame literal keeps the
      // dead `void 0` placeholders — constructors, arguments mapping, and
      // metadata are untouched.
      assert(/\$l\[1\]/.test(o2.result.code));
      assert(
        /locals: \[void 0, \$args\[0\], void 0, void 0, void 0, void 0\]/.test(o2.result.code)
      );
    });

    it("promotes the same shapes under the sandbox (Phase 3)", function () {
      const sandbox = run(sumSource, undefined, { optimization: "O2", security: "sandbox" });
      assert.equal(sandbox.value, 12);
      const promotion = sandbox.result.stats.codegen.localPromotion;
      assert.equal(promotion.eligibleScopes, 1);
      assert.equal(promotion.promotedSlots, 4);
      assert(sandbox.result.stats.codegen.stackToLocal.promotedLoads > 0);
      assert(sandbox.result.stats.codegen.stackToLocal.promotedStores > 0);
      assert(/let \$p1_2, \$p1_3, \$p1_4, \$p1_5;/.test(sandbox.result.code));
      assert(!/\$l\[[2-5]\]/.test(sandbox.result.code));
    });

    it("never promotes scopes that create closures", function () {
      const source =
        "function counter() { var count = 0; " +
        "return function() { return ++count; }; } counter()();";
      const o2 = run(source, undefined, { optimization: "O2" });
      assert.equal(o2.value, 1);
      assert.equal(o2.result.stats.codegen.localPromotion.eligibleScopes, 0);
      assert(!/\$p\d+_\d+/.test(o2.result.code));
    });

    it("never promotes scopes under with, eval, or catch environments", function () {
      const sources = [
        ['function e() { var x = 1; return eval("x"); } e();', 1],
        [
          "var loop, x = 1; with ({ x: 2 }) { loop = function(a) { var total = 0; " +
            "for (var i = 0; i < a; i++) total = total + x; return total; }; } loop(4);",
          8,
        ],
        ["function f() { var y = 0; try { throw 3; } catch (e) { y = e; } return y + 1; } f();", 4],
      ];
      sources.forEach(([source, expected]) => {
        const o2 = run(source, undefined, { optimization: "O2" });
        assert.equal(o2.value, expected);
        assert.equal(o2.result.stats.codegen.localPromotion.eligibleScopes, 0);
        assert(!/\$p\d+_\d+/.test(o2.result.code));
      });
    });

    it("promotes strict parameter slots alongside locals (Phase 2)", function () {
      const source =
        "function scale(a, b) { 'use strict'; var c = 2; " +
        "a = a * c; b = b + a; return a + b; } scale(3, 4);";
      const o0 = run(source, undefined, { optimization: "O0" });
      const o2 = run(source, undefined, { optimization: "O2" });
      assert.equal(o2.value, o0.value);
      assert.equal(o2.value, 16);
      const promotion = o2.result.stats.codegen.localPromotion;
      assert.equal(promotion.eligibleScopes, 1);
      // Parameters (slots 1 and 2), the local (slot 3), and the function's
      // own name binding (slot 4) all live in prologue variables.
      assert.equal(promotion.promotedSlots, 4);
      assert(o2.result.stats.codegen.stackToLocal.promotedLoads > 0);
      assert(o2.result.stats.codegen.stackToLocal.promotedStores > 0);
      // Promoted parameters are initialized from the call arguments in the
      // declaration; non-parameter slots start uninitialized.
      assert(
        /let \$p1_1 = \$f\.callArgs\[0\], \$p1_2 = \$f\.callArgs\[1\], \$p1_3, \$p1_4;/.test(
          o2.result.code
        )
      );
      assert(!/\$l\[[1-3]\] = /.test(o2.result.code));
      assert(!/getLocal\(\$f, [1-3]\)/.test(o2.result.code));
    });

    it("keeps strict arguments unmapped under promoted parameters", function () {
      // arguments[0] = 99 must not reach the promoted parameter...
      const forward = "function f(a) { 'use strict'; arguments[0] = 99; return a; } f(7);";
      const o2f = run(forward, undefined, { optimization: "O2" });
      assert.equal(o2f.value, 7);
      // ...and a promoted parameter write must not reach arguments[0].
      const backward = "function f(a) { 'use strict'; a = 42; return arguments[0]; } f(7);";
      const o2b = run(backward, undefined, { optimization: "O2" });
      assert.equal(o2b.value, 7);
      [o2f, o2b].forEach((result) => {
        const promotion = result.result.stats.codegen.localPromotion;
        assert.equal(promotion.eligibleScopes, 1);
        // The parameter (slot 1) and the function's own name (slot 2).
        assert.equal(promotion.promotedSlots, 2);
      });
    });

    it("never promotes sloppy parameter slots (mapped arguments)", function () {
      // Slot 2 (the `b` local) and slot 3 (the function's own name binding)
      // are promoted; the parameter slot 1 stays on the live array because
      // the sloppy mapped-arguments proxy reads it through frame.locals.
      const plain = run("function f(a) { var b = a; return b; } f(9);", undefined, {
        optimization: "O2",
      });
      assert.equal(plain.value, 9);
      assert.equal(plain.result.stats.codegen.localPromotion.promotedSlots, 2);
      assert(/let \$p1_2, \$p1_3;/.test(plain.result.code));
      assert(!/\$p1_1\b/.test(plain.result.code));
      // A function that touches arguments keeps slot 1 live too; only its
      // self-name binding (slot 2) is promoted.
      const mapped = run("function f(a) { return arguments[0]; } f(5);", undefined, {
        optimization: "O2",
      });
      assert.equal(mapped.value, 5);
      assert.equal(mapped.result.stats.codegen.localPromotion.promotedSlots, 1);
      assert(!/\$p1_1\b/.test(mapped.result.code));
    });
  });

  describe("dead-store elimination (must-use liveness)", function () {
    const eliminated = (source, options) =>
      run(source, undefined, { optimization: "O2", ...options }).result.stats.deadStoreElimination
        .storesEliminated;
    // Every named function declaration carries a self-binding prologue store
    // (CURRENT SETLOCAL[nameSlot] POP); it is dead when the body never reads
    // its own name, so the counts below include it unless noted.

    it("elides a store killed by a later store and keeps the live one", function () {
      const source = "function f(y) { var x = 1; x = y; return x; } f(5);";
      const o0 = run(source, undefined, { optimization: "O0" });
      const o2 = run(source, undefined, { optimization: "O2" });
      assert.equal(o2.value, o0.value);
      assert.equal(o2.value, 5);
      assert.equal(o2.result.stats.deadStoreElimination.storesEliminated, 2);
    });

    it("keeps a store that an optimized read sits between and a live read follows", function () {
      // `first = stable` reads `stable` in the entry block; copy-prop folds
      // that read to a literal, but the fall-through path's `first + stable`
      // read is real. The folded read is a no-op for liveness — it must not
      // kill the entry store of `stable`.
      const source =
        "function f(flag) { var stable = 7, first = stable; " +
        "if (flag) { stable = 9; } return first + stable; } f(true) + f(false);";
      const o0 = run(source, undefined, { optimization: "O0" });
      const o2 = run(source, undefined, { optimization: "O2" });
      assert.equal(o2.value, o0.value);
      assert.equal(o2.value, 30);
      assert.equal(o2.result.stats.deadStoreElimination.storesEliminated, 1);
    });

    it("keeps a store read after a no-op local delete", function () {
      // deleteLocal pushes false for lightweight frames without touching the
      // slot, so `return x` still observes the stored 1: the delete neither
      // kills nor reads, and the store stays live.
      const source = "function f() { var x = 1; delete x; return x; } f();";
      const o0 = run(source, undefined, { optimization: "O0" });
      const o2 = run(source, undefined, { optimization: "O2" });
      assert.equal(o2.value, o0.value);
      assert.equal(o2.value, 1);
      assert.equal(o2.result.stats.deadStoreElimination.storesEliminated, 1);
    });

    it("never eliminates sloppy parameter stores (mapped arguments alias them)", function () {
      const source = "function f(a) { a = 1; a = 2; return a; } f(0);";
      const o2 = run(source, undefined, { optimization: "O2" });
      assert.equal(o2.value, 2);
      // Only the self-binding prologue store is dead.
      assert.equal(o2.result.stats.deadStoreElimination.storesEliminated, 1);
    });

    it("eliminates strict parameter stores", function () {
      const source = 'function f(a) { "use strict"; a = 1; a = 2; return a; } f(0);';
      const o0 = run(source, undefined, { optimization: "O0" });
      const o2 = run(source, undefined, { optimization: "O2" });
      assert.equal(o2.value, o0.value);
      assert.equal(o2.value, 2);
      // a=1 is killed by a=2; the a=2 store is orphaned by copy-prop (the
      // return read folds to the literal 2); plus the prologue.
      assert.equal(o2.result.stats.deadStoreElimination.storesEliminated, 3);
    });

    it("keeps cross-block live stores and elides cross-block dead ones", function () {
      const live = run(
        "function f(flag) { var x = 7; if (flag) { x = 9; } return x; } f(true) + f(false);",
        undefined,
        { optimization: "O2" }
      );
      assert.equal(live.value, 16);
      assert.equal(live.result.stats.deadStoreElimination.storesEliminated, 1);
      const dead = run(
        "function f(flag) { var x = 7; if (flag) { x = 9; x = 11; } return x; } f(true) + f(false);",
        undefined,
        { optimization: "O2" }
      );
      assert.equal(dead.value, 18);
      assert.equal(dead.result.stats.deadStoreElimination.storesEliminated, 2);
    });

    it("elides stores orphaned by copy-prop and loop-local dead stores", function () {
      const orphaned = run("function f() { var x = 2; return x + x; } f();", undefined, {
        optimization: "O2",
      });
      assert.equal(orphaned.value, 4);
      assert.equal(orphaned.result.stats.deadStoreElimination.storesEliminated, 2);
      const loop = run(
        "function f(n) { var x = 0; while (n > 0) { x = 1; n--; } return n; } f(3);",
        undefined,
        { optimization: "O2" }
      );
      assert.equal(loop.value, 0);
      assert.equal(loop.result.stats.deadStoreElimination.storesEliminated, 3);
    });

    it("keeps loop-carried stores and self-name stores that are read", function () {
      const carried = run(
        "function f(n) { var x = 0; while (n > 0) { x = x + n; n--; } return x; } f(3);",
        undefined,
        { optimization: "O2" }
      );
      assert.equal(carried.value, 6);
      assert.equal(carried.result.stats.deadStoreElimination.storesEliminated, 1);
      const self = run("function f() { return f === f; } f();", undefined, { optimization: "O2" });
      assert.equal(self.value, true);
      assert.equal(self.result.stats.deadStoreElimination.storesEliminated, 0);
    });

    it("ignores immediates that numerically collide with slot indices", function () {
      // NUMBER[2] (from `var y = 2`) shares the slot index of `x`; without
      // op gating it would kill the entry store of `x` and the flag-false
      // path would read undefined.
      const source =
        "function f(flag) { var x = 7; var y = 2; " +
        "if (flag) { x = 9; } return x; } f(true) + f(false);";
      const o0 = run(source, undefined, { optimization: "O0" });
      const o2 = run(source, undefined, { optimization: "O2" });
      assert.equal(o2.value, o0.value);
      assert.equal(o2.value, 16);
      assert.equal(o2.result.stats.deadStoreElimination.storesEliminated, 2);
    });

    it("keeps reuse producers live through later peephole passes", function () {
      // GVN marks the loop read of x as `reuse` of the earlier `!x` load.
      // Later peepholes must retain that producer: codegen now rejects a
      // missing reuse source instead of silently changing the annotation to
      // a slot read. DSE must also retain the store feeding the producer.
      const source =
        'function f() { var x = "ab"; var y = !x; ' +
        "while (3) { x = x[1]; break; } return y; } f();";
      const o0 = run(source, undefined, { optimization: "O0" });
      const o2 = run(source, undefined, { optimization: "O2", includeHIR: true });
      assert.equal(o2.value, o0.value);
      assert.equal(o2.value, false);
      const functionScope = o2.result.hir.scopes[1];
      const reuse = functionScope.instructions.find(
        (instruction) => instruction.optimized && instruction.optimized.kind === "reuse"
      );
      const producer = functionScope.instructions.find(
        (instruction) => instruction.offset === reuse.optimized.sourceOffset
      );
      assert.equal(producer.elided, undefined);
      // Entry store of x stays live; only the
      // self-binding prologue and the loop's own dead x store are elided.
      assert.equal(o2.result.stats.deadStoreElimination.storesEliminated, 2);
    });

    it("skips env-observer scopes (with/eval/catch) entirely", function () {
      const source =
        "var loop; with ({ x: 2 }) { loop = function(a) { " +
        "var total = 0; for (var i = 0; i < a; i++) total = total + x; " +
        "return total; }; } loop(4);";
      const o2 = run(source, undefined, { optimization: "O2" });
      assert.equal(o2.value, 8);
      assert.equal(o2.result.stats.deadStoreElimination.storesEliminated, 0);
    });

    it("never eliminates stores in try/finally scopes (exception path)", function () {
      // test262 S12.14_A15 regression: the desugared empty catch emits a
      // CATCH op, so every try/catch/finally scope has a dynamic chain and is
      // skipped wholesale. `result += 2` sits in the try body; the throw's
      // exception path (empty catch -> finally { break } -> return result)
      // reads `result`, but the THROW block has no CFG successors, so the
      // store looks dead to the backward fixpoint — eliding it returns 0
      // instead of 2 on that path.
      const source =
        "function SwitchTest3(value) { var result = 0; " +
        'switch (value) { case 0: try { result += 2; throw "ex"; } ' +
        "finally { break; } default: result += 32; break; } return result; } " +
        "SwitchTest3(2); SwitchTest3(0);";
      const o0 = run(source, undefined, { optimization: "O0" });
      const o2 = run(source, undefined, { optimization: "O2" });
      assert.equal(o2.value, o0.value);
      // The exception path is the last statement: try body -> throw -> empty
      // catch -> finally { break } -> return result. The finally's break
      // reads result, so the try body's += 2 store must survive.
      assert.equal(o2.value, 2);
      assert.equal(o2.result.stats.deadStoreElimination.storesEliminated, 0);
    });

    it("honors the dead-store-elimination kill switch", function () {
      const source = "function f(y) { var x = 1; x = y; return x; } f(5);";
      const off = run(source, undefined, { optimization: "O2", deadStoreElimination: false });
      assert.equal(off.value, 5);
      assert.equal(off.result.stats.deadStoreElimination, undefined);
      const on = eliminated(source);
      assert.equal(on, 2);
    });
  });

  it("inlines budgeted small calls behind identity and primitive guards", function () {
    const source = "function add(a, b) { return (a + b) | 0; } add(2, 3);";
    const inlined = run(source, undefined, { optimization: "O2" });
    assert.equal(inlined.value, 5);
    assert.equal(inlined.result.stats.codegen.inlining.callSites, 1);
    assert(inlined.result.stats.codegen.inlining.instructionsInlined > 0);
    assert(inlined.result.code.includes("typeof $v"));

    const disabled = run(source, undefined, {
      optimization: "O2",
      inlineSmallFunctions: false,
    });
    assert.equal(disabled.value, 5);
    assert.equal(disabled.result.stats.codegen.inlining.callSites, 0);

    const loaded = load("function add(a, b) { return a + b; } mutate(); add(2, 3);", {
      optimization: "O2",
    });
    let instance;
    instance = loaded.program.createInstance({
      globals: {
        mutate() {
          instance.global.add = function () {
            return 41;
          };
        },
      },
    });
    assert.equal(instance.run(), 41);
    assert.equal(loaded.result.stats.codegen.inlining.callSites, 1);

    let coercions = 0;
    const coerced = run(
      "function add(a, b) { return a + b; } add(host, 1);",
      {
        host: {
          valueOf() {
            coercions += 1;
            return 4;
          },
        },
      },
      { optimization: "O2" }
    );
    assert.equal(coerced.value, 5);
    assert.equal(coercions, 1);
    assert.throws(
      () => compile(source, { runtimeModule, optimization: "O2", inlineBudget: -1 }),
      /Invalid inline budget/
    );
  });

  it("eliminates a dead pure comparison but preserves getter reads", function () {
    let reads = 0;
    const host = {};
    Object.defineProperties(host, {
      left: {
        get() {
          reads += 1;
          return 1;
        },
      },
      right: {
        get() {
          reads += 1;
          return 2;
        },
      },
    });
    const source = "host.left === host.right; 9;";
    const o1 = run(source, { host }, { optimization: "O1" });
    assert.equal(o1.value, 9);
    assert.equal(reads, 2);
    assert(!o1.result.code.includes("$r.strictEqual($f)"));
    assert.equal(o1.result.stats.deadCodeElimination.stackDropsInserted, 2);
  });

  it("does not fold or eliminate observable host property reads", function () {
    let reads = 0;
    const host = {};
    Object.defineProperty(host, "value", {
      get() {
        reads += 1;
        return 3;
      },
    });
    assert.equal(run("host.value + host.value;", { host }, { optimization: "O2" }).value, 6);
    assert.equal(reads, 2);
  });

  it("exposes deterministic HIR and optimizer statistics", function () {
    const traced = [];
    const first = compile("1 + 2 * 3;", { runtimeModule, includeHIR: true, optimization: "O2" });
    const second = compile("1 + 2 * 3;", { runtimeModule, includeHIR: true, optimization: "O2" });
    const withTrace = compile("1 + 2 * 3;", {
      runtimeModule,
      optimization: "O2",
      tracePasses(pass) {
        traced.push(pass.name);
      },
    });
    assert.deepStrictEqual(first.hir, second.hir);
    assert(first.stats.constantsFolded > 0);
    assert.equal(first.stats.mir.builds, 5);
    assert.equal(first.stats.analysis.generation, first.stats.passes.length);
    assert(
      first.stats.analysis.rebuilds.some((entry) => entry.reason === "post-sccp-control-flow")
    );
    assert(
      first.stats.analysis.rebuilds.some((entry) => entry.reason === "post-copy-guest-provenance")
    );
    assert(
      first.stats.passes.every(
        (pass) =>
          Number.isInteger(pass.generation) &&
          Array.isArray(pass.preserves) &&
          Array.isArray(pass.invalidates)
      )
    );
    assert(first.stats.nodesAfter < first.stats.nodesBefore);
    assert(first.stats.passes.every((pass) => Number.isFinite(pass.durationMs)));
    assert.deepStrictEqual(
      traced,
      withTrace.stats.passes.map((pass) => pass.name)
    );
    assert.equal(first.metadata.abiVersion, ABI_VERSION);
    assert.equal(first.metadata.inputLanguage, "es5.1");
    assert.equal(first.metadata.optimizerAnalysisGeneration, first.stats.analysis.generation);
    assert.equal(compile("1;", { runtimeModule, optimization: "O0" }).stats.mir.builds, 0);
  });

  it("aliases non-observable source identifiers without post-codegen obfuscation", function () {
    const source =
      "var exported = (function factoryIdentity(outerConfidential) { " +
      "var retainedConfidential = outerConfidential + 1; " +
      "return function nestedIdentity(innerConfidential) { " +
      "return { publicField: retainedConfidential + innerConfidential }; }; })(4); " +
      "exported(3).publicField;";
    for (const optimization of ["O0", "O2"]) {
      const first = load(source, { optimization });
      const second = load(source, { optimization });
      assert.equal(first.program.createInstance().run(), 8);
      assert.equal(first.result.code, second.result.code);
      for (const hidden of [
        "factoryIdentity",
        "outerConfidential",
        "retainedConfidential",
        "nestedIdentity",
        "innerConfidential",
      ]) {
        assert(!first.result.code.includes(hidden), `${hidden} leaked into generated code`);
      }
      assert(first.result.code.includes("exported"));
      assert(first.result.code.includes("publicField"));
      assert.equal(first.result.metadata.identifierProtection, "alias");
      assert(first.result.stats.codegen.identifierProtection.aliasedBindings >= 5);
    }

    const preserved = compile(source, {
      runtimeModule,
      optimization: "O2",
      identifierProtection: "preserve",
    });
    assert(preserved.code.includes("retainedConfidential"));
    assert.equal(preserved.stats.codegen.identifierProtection.aliasedBindings, 0);
    assert.throws(
      () => compile("1;", { runtimeModule, identifierProtection: "unknown" }),
      /Unknown identifier protection mode/
    );

    for (const optimization of ["O0", "O2"]) {
      const reused = run(
        "function first(firstSecret) { return firstSecret + 1; } " +
          "function second(secondSecret) { return secondSecret + 2; } first(1) + second(2);",
        undefined,
        { optimization }
      );
      assert.equal(reused.value, 6);
      assert(reused.result.stats.codegen.identifierProtection.reusedAliases > 0);
      assert(
        reused.result.stats.codegen.identifierProtection.uniqueAliases <
          reused.result.stats.codegen.identifierProtection.aliasedBindings
      );
    }
  });

  it("folds giant constant array literals into native literals", function () {
    const count = 3000;
    let entries = "";
    for (let index = 0; index < count; index += 1) entries += (index ? ", " : "") + (index % 251);
    const source = `var data = [${entries}]; data.length;`;
    const { result, value } = run(source, undefined, { optimization: "O2" });
    assert.equal(value, count);
    // The per-element helper round-trips are folded into one literal.
    assert(!result.code.includes("initProperty"));
    assert(result.code.length < 200000);
  });

  it("folds constant object literals into native literals", function () {
    const source =
      'var o = { a: 1, b: "x", c: true, d: null, e: undefined, f: -0, g: 1.5, ' +
      "dup: 1, dup: 2, num: 0, neg: -5, h: NaN, i: Infinity, nested: { k: 3 } }; " +
      "[o.a, o.b, o.c, o.d, o.e, 1 / o.f, o.g, o.dup, o.num, o.neg, isNaN(o.h), o.i, o.nested.k]";
    for (const optimization of ["O0", "O1", "O2", "Os"]) {
      assert.deepEqual(
        run(source, undefined, { optimization }).value,
        [1, "x", true, null, undefined, -Infinity, 1.5, 2, 0, -5, true, Infinity, 3],
        optimization
      );
    }
    // The constant-property helper round-trips are folded into one literal.
    // NaN/Infinity are global-property reads (not literals) and `nested` is a
    // dynamic value, so both keep the runtime path on the same fresh object.
    const { result } = run(source, undefined, { optimization: "O2" });
    assert(result.code.includes('"a": 1'));
    assert(result.code.includes('"dup": 2'));
    assert(result.code.includes('"f": -0'));
    assert(result.code.includes('"k": 3'));
    // 3 runtime INITPROPs for h/i/nested; the trailing 13-element result
    // array has non-literal elements and stays on the runtime path.
    assert.equal((result.code.match(/initProperty/g) || []).length, 16);
  });

  it("keeps the __proto__ key on the runtime path (ES5.1 plain property)", function () {
    // Native literal syntax would give `__proto__` Annex-B prototype-setting
    // meaning; folding must stop so the runtime preserves ES5.1 semantics.
    const source =
      "var p = { q: 1 }; var o = { __proto__: p, z: 2 }; " +
      "[o.q, o.z, o.__proto__ === p, Object.getPrototypeOf(o) !== p]";
    for (const optimization of ["O0", "O1", "O2", "Os"]) {
      assert.deepEqual(
        run(source, undefined, { optimization }).value,
        [undefined, 2, true, true],
        optimization
      );
    }
    const { result } = run(source, undefined, { optimization: "O2" });
    // The proto key is emitted through the runtime, never in a literal.
    assert(result.code.includes('"__proto__"'));
    assert(!result.code.includes('"__proto__":'));
  });

  it("folds giant constant object literals into compact code", function () {
    const count = 3000;
    let entries = "";
    for (let index = 0; index < count; index += 1)
      entries += (index ? ", " : "") + `k${index}: ${index % 251}`;
    const source = `var data = { ${entries} }; data.k2999;`;
    const { result, value } = run(source, undefined, { optimization: "O2" });
    assert.equal(value, 2999 % 251);
    assert(result.code.length < 200000);
  });

  it("keeps cross-block inline guards from referencing out-of-scope temporaries", function () {
    // The helper closure is emitted inside the if-block; the call site in
    // the loop must fall back to the runtime call instead of referencing
    // the closure temporary by name.
    const source =
      "function f() { var fn = null; if (true) { function helper() { return 1; } fn = helper; } " +
      "var acc = 0; for (var i = 0; i < 3; i++) { acc += fn(); } return acc; } f();";
    for (const optimization of ["O0", "O2", "Os"]) {
      assert.equal(run(source, undefined, { optimization }).value, 3, optimization);
    }
  });

  it("uses compact leaf frames and a size-aware Os closure strategy", function () {
    const source = "function add(left, right) { return left + right; } add(2, 3);";
    const o2 = run(source, undefined, { optimization: "O2" });
    const os = run(source, undefined, { optimization: "Os" });
    assert.equal(o2.value, 5);
    assert.equal(os.value, 5);
    assert(o2.result.stats.codegen.leafFrameScopes > 0);
    assert(o2.result.stats.codegen.inlineLeafFrameScopes > 0);
    assert(o2.result.stats.codegen.framePooledScopes > 0);
    assert(o2.result.code.includes("$f = { metadata: $metadata, locals:"));
    assert(o2.result.code.includes("$poolHead"));
    assert(!o2.result.code.includes("argumentsInitialized: false"));
    const genericLeaf = run(source, undefined, {
      optimization: "O2",
      inlineLeafFrames: false,
      inlineFastFrames: false,
    });
    assert.equal(genericLeaf.value, 5);
    assert.equal(genericLeaf.result.stats.codegen.inlineLeafFrameScopes, 0);
    assert.equal(genericLeaf.result.stats.codegen.inlineFastFrameScopes, 0);
    assert(genericLeaf.result.code.includes("$invokeCompiled($r, $execute"));
    // Non-leaf fast scopes inline their frame construction by default and
    // omit fields the scope never reads.
    const fastSource =
      "function pair(outerValue) { return function inner() { return outerValue; }; } pair(7)();";
    const fast = run(fastSource, undefined, { optimization: "O2" });
    assert.equal(fast.value, 7);
    assert(fast.result.stats.codegen.inlineFastFrameScopes > 0);
    assert(fast.result.code.includes("callerFrame: $r.currentFrame"));
    assert(!fast.result.code.includes("argumentsInitialized: false"));
    assert(!os.result.code.includes("function $make1"));
    assert.equal(o2.result.metadata.perScopeFactories, true);
    assert.equal(os.result.metadata.perScopeFactories, false);
    assert(os.result.code.length < o2.result.code.length);
    assert(os.result.stats.codegen.stackToLocal.sizeTemporaryReuses > 0);
    assert.equal(os.result.stats.codegen.sizeOptimization.costModel.objective, "raw-bytes");
    assert.equal(os.result.stats.codegen.sizeOptimization.costModel.candidates.length, 2);
    assert.equal(os.result.stats.codegen.sizeOptimization.costModel.selected, "shared-factory");
  });

  it("pools leaf frames and resets per-call state", function () {
    const source =
      "function calc(v) { var t = v + 1; var u = t * 2; return u; } " +
      "var acc = 0; for (var i = 1; i <= 6; i++) { acc += calc(i); } acc;";
    for (const security of ["trusted", "sandbox"]) {
      const loaded = run(source, undefined, { optimization: "O2", security });
      assert.equal(loaded.value, 54, security);
      assert(loaded.result.stats.codegen.leafFrameScopes > 0, security);
      assert.equal(
        loaded.result.stats.codegen.framePooledScopes,
        loaded.result.stats.codegen.leafFrameScopes,
        security
      );
      assert(loaded.result.code.includes("$poolHead"), security);
      // The pooled acquire resets exactly the slots the body reads — the
      // parameter slot, rewritten from $args — and never stores `void 0`
      // into the reused array (a `void 0` store would transition it off
      // the packed-elements fast path and box double-valued locals). The
      // reserved slot 0 and the promoted `var` slots are unreachable from
      // the body, so their stale values are never observed.
      assert(loaded.result.code.includes("$f.locals[1] = $args[0];"), security);
      assert(!loaded.result.code.includes("$f.locals[0] = void 0;"), security);
      assert(!loaded.result.code.includes("$f.locals[2] = void 0;"), security);
    }
  });

  it("keeps receivers isolated across pooled frame reuse", function () {
    const source =
      "function put(v) { this.x = v; return this.x; } " +
      "var o1 = { put: put }; var o2 = { put: put }; " +
      'var a = o1.put(1); var b = o2.put(2); a + "|" + b + "|" + o1.x + "|" + o2.x;';
    for (const security of ["trusted", "sandbox"]) {
      const loaded = run(source, undefined, { optimization: "O2", security });
      assert.equal(loaded.value, "1|2|1|2", security);
      assert(loaded.result.stats.codegen.framePooledScopes > 0, security);
    }
  });

  it("reenters the same pool through a host callback without aliasing", function () {
    // leaf -> hostGo -> leaf: the inner call must not reuse the outer frame,
    // which is still active on the host stack (release happens only in the
    // finally after $execute returns).
    const source =
      "var depth = 0; function leaf() { depth += 1; return hostGo(leaf); } leaf(); depth;";
    let reentries = 0;
    const { value } = run(
      source,
      {
        hostGo(fn) {
          reentries += 1;
          return reentries < 3 ? fn() : reentries;
        },
      },
      { optimization: "O2" }
    );
    assert.equal(reentries, 3);
    assert.equal(value, 3);
    const loaded = load(source, { optimization: "O2" });
    assert(loaded.result.stats.codegen.framePooledScopes > 0);
    assert.equal(
      loaded.result.stats.codegen.framePooledScopes,
      loaded.result.stats.codegen.leafFrameScopes
    );
    let hops = 0;
    assert.equal(
      loaded.program
        .createInstance({
          globals: {
            hostGo(fn) {
              hops += 1;
              return hops < 3 ? fn() : hops;
            },
          },
        })
        .run(),
      3
    );
    assert.equal(hops, 3);
  });

  it("reenters a pooled leaf scope recursively without cross-call aliasing", function () {
    // nz (ternary, non-leaf) and dec (straight-line, leaf) alternate, so each
    // recursion depth acquires its own pooled dec frame.
    const source =
      "function nz(n) { return n === 0 ? 0 : 1 + dec(n); } " +
      "function dec(n) { return nz(n - 1); } var out = 0; " +
      "for (var i = 0; i < 4; i++) { out += dec(10); } out;";
    const loaded = run(source, undefined, { optimization: "O2" });
    assert.equal(loaded.value, 36);
    assert(loaded.result.stats.codegen.framePooledScopes > 0);
  });

  it("retires frames that materialize an arguments object", function () {
    // reader() reads leaf.arguments while leaf is active; the runtime then
    // caches an arguments proxy on leaf's frame. That frame must never be
    // reused, or a later call's parameters would alias the stale object.
    const source =
      "function leaf(a) { return reader(); } " +
      "function reader() { return leaf.arguments; } " +
      'var r1 = leaf(10); var r2 = leaf(20); r1[0] + "|" + r2[0] + "|" + (r1 !== r2);';
    for (const security of ["trusted", "sandbox"]) {
      const loaded = run(source, undefined, { optimization: "O2", security });
      assert.equal(loaded.value, "10|20|true", security);
      assert(loaded.result.stats.codegen.framePooledScopes > 0, security);
    }
  });

  it("walks caller chains through pooled frames", function () {
    const source =
      "function inner() { return outer.caller; } " +
      "function outer() { return inner(); } " +
      "function main2() { return outer(); } var got = main2(); got === main2;";
    for (const security of ["trusted", "sandbox"]) {
      const loaded = run(source, undefined, { optimization: "O2", security });
      assert.equal(loaded.value, true, security);
      assert(loaded.result.stats.codegen.framePooledScopes > 0, security);
    }
  });

  it("releases pooled frames when an exception unwinds through them", function () {
    // Guest try/catch disqualifies every scope it can reach (runtime-visible
    // locals), so a pooled frame can only be unwound by an exception that
    // reaches the host. The finally still releases the frame, and a fresh
    // instance from the same module runs correctly afterwards.
    const source =
      "function thrower() { if (armed) { throw 9; } return 1; } " +
      "function leafl() { return thrower(); } leafl(); 42;";
    const loaded = load(source, { optimization: "O2" });
    assert(loaded.result.stats.codegen.framePooledScopes > 0);
    assert.throws(
      () => loaded.program.createInstance({ globals: { armed: 1 } }).run(),
      (error) => error === 9
    );
    assert.equal(loaded.program.createInstance({ globals: { armed: 0 } }).run(), 42);
  });

  it("disables pooling with framePooling: false", function () {
    const source = "function add2(a, b) { var c = a + b; return c; } add2(2, 3);";
    for (const security of ["trusted", "sandbox"]) {
      const loaded = run(source, undefined, { optimization: "O2", security, framePooling: false });
      assert.equal(loaded.value, 5, security);
      assert(loaded.result.stats.codegen.leafFrameScopes > 0, security);
      assert.equal(loaded.result.stats.codegen.framePooledScopes, 0, security);
      assert(!loaded.result.code.includes("$poolHead"), security);
      assert(loaded.result.code.includes("const $f = { metadata: $metadata, locals:"), security);
    }
  });

  it("preserves names across dynamic environment chains", function () {
    const source =
      "function dynamicOwner(dynamicLocal) { var object = { dynamicLocal: 7 }; " +
      "with (object) { return function dynamicChild() { return dynamicLocal; }; } } " +
      "dynamicOwner(3)();";
    const loaded = run(source, undefined, { optimization: "O2" });
    assert.equal(loaded.value, 7);
    assert(loaded.result.code.includes("dynamicLocal"));
    assert.equal(loaded.result.stats.codegen.identifierProtection.aliasedBindings, 0);
  });

  it("lowers exception syntax to native try/catch without a dispatcher", function () {
    const hir = lowerToHIR("try { throw 1; } catch (error) { error; }");
    assert.equal(hir.kind, "ProgramHIR");
    assert(hir.scopes[0].instructions.some((instruction) => instruction.op === "TRY"));
    const source =
      "var x = 0; try { throw 4; } catch (error) { x = error; } finally { x = x + 2; } x;";
    const { result, value } = run(source);
    assert.equal(value, 6);
    assert(result.code.includes("try {"));
    assert(result.code.includes("catch ($error"));
  });

  it("preserves catch bindings in closures and host exception identity", function () {
    const marker = {};
    const source =
      "var saved; try { host(); } catch (error) { saved = function() { return error; }; } saved();";
    const { value } = run(source, {
      marker,
      host() {
        throw marker;
      },
    });
    assert.strictEqual(value, marker);
  });

  it("captures native with environments and applies their shadowing", function () {
    const source =
      "var x = 1, object = { x: 2 }, saved; with (object) { x = 3; saved = function() { return x; }; } x + saved();";
    const { value, instance } = run(source);
    assert.equal(value, 4);
    assert.equal(instance.global.object.x, 3);
    assert.equal(
      run(
        "var object = { x: 7, read: function() { return this.x; } }, result; with (object) { result = read(); } result;"
      ).value,
      7
    );
  });

  it("uses direct variable values only outside dynamic environment chains", function () {
    const safe = run(
      "var globalValue = 4; function outer() { var captured = 3; " +
        "return function() { captured = captured + 1; globalValue = globalValue + 1; " +
        "return captured + globalValue; }; } outer()();",
      undefined,
      { optimization: "O2" }
    );
    assert.equal(safe.value, 9);
    assert(safe.result.code.includes("$f.environment.outer.frame.locals"));
    assert(!safe.result.code.includes("$readVar($r, $f"));

    const dynamic = run(
      "var x = 1, saved; with ({ x: 7 }) { saved = function() { return x; }; } saved();",
      undefined,
      { optimization: "O2" }
    );
    assert.equal(dynamic.value, 7);
    assert(dynamic.result.code.includes("$r.getVar($f"));
  });

  it("executes static eval in the caller environment and rejects dynamic source", function () {
    const source =
      "function update() { var x = 2; eval('var y = 5; x = x + y;'); return x + y; } update();";
    assert.equal(run(source).value, 12);
    assert.throws(
      () => run("var source = '1 + 2'; eval(source);"),
      /Dynamic eval source is not supported/
    );
  });

  it("creates static Function bodies in the global environment", function () {
    const source = "var add = new Function('a', 'b', 'return a + b;'); add(3, 4);";
    assert.equal(run(source).value, 7);
    assert.equal(
      run(
        "function outer() { var secret = 1; return Function('return typeof secret;'); } outer()();"
      ).value,
      "undefined"
    );
  });

  it("implements sloppy arguments aliasing and strict arguments isolation", function () {
    assert.equal(run("function f(a) { arguments[0] = 3; return a; } f(1);").value, 3);
    assert.equal(run("function f(a) { 'use strict'; arguments[0] = 3; return a; } f(1);").value, 1);
    assert.equal(run("function f(a) { eval('arguments[0] = 8;'); return a; } f(1);").value, 8);
    assert.equal(
      run(
        "function f(a) { var tag = Object.prototype.toString.call(arguments); Object.defineProperty(arguments, '0', { get: function() { return 9; }, configurable: true }); return tag + ':' + a + ':' + arguments[0]; } f(1);"
      ).value,
      "[object Arguments]:1:9"
    );
    assert.equal(run("function f(a) { return f.arguments[0]; } f(6);").value, 6);
  });

  it("tracks ES5 caller restrictions across strict and sloppy compiled calls", function () {
    assert.equal(
      run(
        "function outer() { return inner(); } function inner() { return inner.caller === outer; } outer();"
      ).value,
      true
    );
    assert.throws(
      () =>
        run(
          "function outer() { 'use strict'; return inner(); } function inner() { return inner.caller; } outer();"
        ),
      TypeError
    );
  });

  it("does not treat catch declarative bindings as with call bases", function () {
    const source =
      "function test() { var x = 'local'; function setX() { this.x = 'global'; } try { throw setX; } catch (fn) { fn(); } return x; } test();";
    assert.equal(run(source).value, "local");
  });

  it("keeps internal descriptors isolated from host prototype pollution", function () {
    const source =
      "function f() { var object = {}, result; try { Object.prototype.get = function() { return 7; }; Object.defineProperty(object, 'x', Math); result = object.x; } finally { delete Object.prototype.get; } return result; } f();";
    assert.equal(run(source).value, 7);
    assert.equal(
      run(
        "var saved = Array.prototype.lastIndexOf, result; try { Array.prototype.lastIndexOf = 'changed'; function f() { var local = 3; return local; } result = f(); } finally { Array.prototype.lastIndexOf = saved; } result;"
      ).value,
      3
    );
  });

  it("hardens active FastFrames at observed array-prototype mutation calls", function () {
    const savedPush = Object.getOwnPropertyDescriptor(Array.prototype, "push");
    try {
      const source =
        "Object.defineProperty(Array.prototype, 'push', { " +
        "value: function() { throw new Error('guest push'); }, writable: true, configurable: true }); " +
        "var object = { get value() { return 7; } }; object.value;";
      const loaded = run(source, undefined, { optimization: "O2" });
      assert.equal(loaded.value, 7);
      assert(loaded.result.code.includes("$s.push"));
      assert(loaded.result.stats.codegen.fastFrameScopes > 0);
    } finally {
      Object.defineProperty(Array.prototype, "push", savedPush);
    }
  });

  it("keeps O2 FastFrame locals isolated from Array prototype index accessors", function () {
    const source =
      "var result; try { " +
      "Object.defineProperty(Array.prototype, '2', { get: function() { return 99; }, configurable: true }); " +
      "function read(a, b) { var local = 3; return local; } result = read(1, 2); " +
      "} finally { delete Array.prototype[2]; } result;";
    const loaded = run(source, undefined, { optimization: "O2" });
    assert.equal(loaded.value, 3);
    assert(loaded.result.stats.codegen.fastFrameScopes > 0);
  });

  it("rejects block-level function declarations in ES5.1 strict code", function () {
    assert.throws(
      () => compile("'use strict'; { function nested() {} }", { runtimeModule }),
      SyntaxError
    );
  });

  it("checks the compiler/runtime ABI and enforces instance lifecycle", function () {
    assert.throws(() => createProgram(() => {}, {}, "wrong-abi"), /ABI mismatch/);
    const { program } = load("42;");
    assert.equal(program.abiVersion, ABI_VERSION);
    const instance = program.createInstance();
    assert.equal(instance.run(), 42);
    assert.throws(() => instance.run(), /only run once/);
    instance.dispose();
  });
});

describe("sablejs guest-object provenance (local-safe write distinction)", function () {
  function sandboxCompile(source, options = {}) {
    return compileProgram(source, { security: "sandbox", runtimeModule, ...options });
  }

  function scriptScope(hir) {
    return hir.scopes.find((scope) => scope.script);
  }

  it("marks literal-held locals at O2/Os and emits the writeTarget-free guest helper", function () {
    for (const optimization of ["O2", "Os"]) {
      const result = sandboxCompile("var o = {}; o.x = 1; o.x;", {
        optimization,
        includeHIR: true,
      });
      // Both GETLOCAL reads of `o` are proven guest-created: the write target
      // and the final read.
      assert.equal(result.stats.guestProvenance.markedLoads, 2, optimization);
      const marked = scriptScope(result.hir).instructions.filter(
        (instruction) => instruction.guestObjectOutput
      );
      assert.equal(marked.length, 2, optimization);
      assert.ok(
        marked.every((instruction) => instruction.op === "GETLOCAL"),
        optimization
      );
      assert.match(result.code, /setGuestPropertyValue/, optimization);
      assert.doesNotMatch(result.code, /setSandboxPropertyValue/, optimization);
      // This evaluates already-generated test output (see load above).
      const generatedModule = { exports: {} };
      new Function("require", "module", "exports", result.code)(
        require,
        generatedModule,
        generatedModule.exports
      );
      assert.equal(generatedModule.exports.createInstance().run(), 1);
    }
  });

  it("never marks globals, injected data, or kill-reassigned locals", function () {
    const result = sandboxCompile(
      "var o = {}; o = Math.PI; o.x = 1; var t = g; t.x = 1; cap.foo = 1; Math.y = 2;",
      { optimization: "O2", includeHIR: true }
    );
    assert.equal(result.stats.guestProvenance.markedLoads, 0);
    assert.ok(
      !result.hir.scopes.some((scope) =>
        scope.instructions.some((instruction) => instruction.guestObjectOutput)
      )
    );
    assert.match(result.code, /setSandboxPropertyValue/);
    assert.doesNotMatch(result.code, /setGuestPropertyValue/);
  });

  it("leaves parameter slots unmarked (no seed flows into them)", function () {
    const result = sandboxCompile("function f(o) { o.x = 1; return o.x; } f({ a: 1 });", {
      optimization: "O2",
      includeHIR: true,
    });
    const functionScope = result.hir.scopes.find((scope) => !scope.script);
    assert.equal(functionScope.parameterCount, 1);
    assert.ok(!functionScope.instructions.some((instruction) => instruction.guestObjectOutput));
    assert.match(result.code, /setSandboxPropertyValue/);
  });

  it("marks phi joins only when every input is guest-created", function () {
    const joined = sandboxCompile("var o = (g.flag ? {} : {}); o.x = 1; o.x;", {
      optimization: "O2",
      includeHIR: true,
    });
    assert.ok(joined.stats.guestProvenance.markedLoads >= 1);
    assert.match(joined.code, /setGuestPropertyValue/);
    assert.doesNotMatch(joined.code, /setSandboxPropertyValue/);

    // A host value (Math.PI) on one arm kills the join mark: the load after
    // the reassignment must stay unmarked and the write must stay guarded.
    const mixed = sandboxCompile("var o = (g.flag ? {} : Math.PI); o.x = 1; o.x;", {
      optimization: "O2",
      includeHIR: true,
    });
    assert.equal(mixed.stats.guestProvenance.markedLoads, 0);
    assert.match(mixed.code, /setSandboxPropertyValue/);
    assert.doesNotMatch(mixed.code, /setGuestPropertyValue/);
  });

  it("keeps the provenance marks off O0/O1 output (no direct mode)", function () {
    for (const optimization of ["O0", "O1"]) {
      const result = sandboxCompile("var o = {}; o.x = 1; o.x;", {
        optimization,
        includeHIR: true,
      });
      assert.equal(result.stats.guestProvenance, undefined, optimization);
      assert.ok(
        !result.hir.scopes.some((scope) =>
          scope.instructions.some((instruction) => instruction.guestObjectOutput)
        ),
        optimization
      );
      // The guarded runtime write path ($r.setPropertyStatic -> writeTarget)
      // is unchanged at O0/O1; no guest helper exists there.
      assert.match(result.code, /setPropertyStatic/, optimization);
      assert.doesNotMatch(result.code, /setGuestPropertyValue/, optimization);
    }
  });
});

describe("sablejs slot-provenance stamps (Item 9, per-store write classification)", function () {
  function sandboxCompile(source, options = {}) {
    return compileProgram(source, { security: "sandbox", runtimeModule, ...options });
  }

  // Derives the set of $q-tracked slot indexes per generated $exec body.
  function trackedSlotsByScope(code) {
    const byScope = new Map();
    for (const exec of code.matchAll(/function \$exec(\d+)\([\s\S]*?\n\}/g)) {
      const scopeId = Number(exec[1]);
      const slots = new Set();
      for (const flag of exec[0].matchAll(/\$q\d+_(\d+)/g)) slots.add(flag[1]);
      byScope.set(scopeId, slots);
    }
    return byScope;
  }

  it("classifies frame-local write receivers once per store via $q flags", function () {
    const result = sandboxCompile(
      "function f(u) { var i; for (i = 0; i < 4; i++) { u[i] = i * 0.5; } return u[3]; } f(new Array(4));",
      { optimization: "O2" }
    );
    const stats = result.stats.codegen.slotProvenance;
    assert(stats.trackedScopes >= 1);
    assert(stats.trackedSlots >= 1);
    // The parameter slot's flag is declared and initialized lazily at the
    // write site (no per-call prologue classification — measured overhead).
    assert.match(result.code, /let \$q\d+_\d+/);
    assert.doesNotMatch(
      result.code,
      /let \$q\d+_\d+[\s\S]*?\$r\.boundary\.isUnmediatedWriteTarget\(\$f\.(?:locals\[\d+\]|callArgs\[\d+\])\)/
    );
    // The write site is the guarded ternary (the sandbox helper survives as
    // the ternary's fallback arm, never as the direct call).
    assert.match(
      result.code,
      /\(\$q\d+_\d+ === undefined \? \$q\d+_\d+ = \$r\.boundary\.isUnmediatedWriteTarget/
    );
    assert.doesNotMatch(result.code, /^\s*\$setSandbox\(/m);
    // Behavior parity with the unoptimized path.
    const generatedModule = { exports: {} };
    new Function("require", "module", "exports", result.code)(
      require,
      generatedModule,
      generatedModule.exports
    );
    assert.equal(generatedModule.exports.createInstance().run(), 1.5);
  });

  it("guards sloppy parameter slots with the mapped-arguments stamp", function () {
    const sloppy = sandboxCompile("function f(a) { a[0] = 1; return a[0]; } f([0]);", {
      optimization: "O2",
    });
    assert.match(sloppy.code, /!\$f\.argumentsInitialized && \(\$q\d+_\d+ === undefined/);
    // Strict functions have PoisonPill caller/arguments accessors and an
    // unmapped arguments object: no proxy can write a parameter slot, so the
    // guard must be absent.
    const strict = sandboxCompile(
      "function f(a) { 'use strict'; a[0] = 1; return a[0]; } f([0]);",
      { optimization: "O2" }
    );
    assert.doesNotMatch(strict.code, /argumentsInitialized && \(\$q/);
    assert.match(strict.code, /\(\$q\d+_\d+ === undefined/);
  });

  it("keeps flags off Os, O0/O1, trusted, and kill-switched builds", function () {
    const source = "function f(a) { a[0] = 1; return a[0]; } f([0]);";
    for (const optimization of ["Os", "O0", "O1"]) {
      const result = sandboxCompile(source, { optimization });
      assert.doesNotMatch(result.code, /\$q\d+_\d+/, optimization);
      assert.equal(result.stats.codegen.slotProvenance.trackedSlots, 0, optimization);
    }
    const trusted = compileProgram(source, {
      security: "trusted",
      runtimeModule,
      optimization: "O2",
    });
    assert.doesNotMatch(trusted.code, /\$q\d+_\d+/);
    const killed = sandboxCompile(source, { optimization: "O2", slotProvenance: false });
    assert.equal(killed.stats.codegen.slotProvenance.trackedSlots, 0);
    assert.doesNotMatch(killed.code, /\$q\d+_\d+/);
  });

  it("routes writes after a mapped-arguments rebind through the full path", function () {
    // The proxy rebinds the parameter slot to a host value; once arguments
    // are materialized the $q stamp may be stale, so the write must behave
    // exactly like the kill-switched build (both take the full path).
    const source =
      "var out = []; function f(a) { " +
      "var g = function() { return g.caller.arguments; }; var args = g(); " +
      "args[0] = host; a.x = 1; return [typeof a, a.x]; } " +
      "out.push(f(new Object())); print(JSON.stringify(out));";
    const { capability } = require("../../src/runtime");
    const runBoth = (options) => {
      const result = sandboxCompile(source, options);
      const generatedModule = { exports: {} };
      new Function("require", "module", "exports", result.code)(
        require,
        generatedModule,
        generatedModule.exports
      );
      let printed;
      const instance = generatedModule.exports.createInstance({
        globals: {
          print: capability(
            (value) => {
              printed = value;
            },
            { name: "print" }
          ),
          host: capability(function host() {}, { name: "host" }),
        },
      });
      instance.run();
      return printed;
    };
    assert.equal(
      runBoth({ optimization: "O2" }),
      runBoth({ optimization: "O2", slotProvenance: false })
    );
  });

  it("never mixes $q-tracked slots with the runtime setLocal path", function () {
    // A stack-height mismatch (constant-folded ternary merge) sends one
    // SETLOCAL through $r.setLocal; any tracked slot written that way would
    // bypass its store classification, so the per-scope tracked sets and the
    // runtime writes must be disjoint — per scope.
    const source =
      "function f(a) { var t = g ? 1 : 2; a[0] = t; a[0] = 1; return a[0]; } f(new Array(1));";
    const result = sandboxCompile(source, { optimization: "O2" });
    const byScope = trackedSlotsByScope(result.code);
    assert(byScope.size >= 1);
    for (const [scopeId, slots] of byScope) {
      if (!slots.size) continue;
      const scopeExec = result.code.match(
        new RegExp(`function \\$exec${scopeId}\\([\\s\\S]*?\\n\\}`)
      )[0];
      for (const match of scopeExec.matchAll(/\$r\.setLocal\(\$f, (\d+)\)/g)) {
        assert(!slots.has(match[1]), `tracked slot ${match[1]} written through runtime setLocal`);
      }
    }
    const generatedModule = { exports: {} };
    new Function("require", "module", "exports", result.code)(
      require,
      generatedModule,
      generatedModule.exports
    );
    assert.equal(generatedModule.exports.createInstance({ globals: { g: true } }).run(), 1);
  });
});

describe("sablejs inline guest-stamp write path (Item 10)", function () {
  function sandboxCompile(source, options = {}) {
    return compileProgram(source, { security: "sandbox", runtimeModule, ...options });
  }

  it("inlines provably-pure guest writes to a native strict set", function () {
    // Strict scope + provably-primitive MUL value: the guest branch is a
    // native `$o[$k] = $v` with no securing probe and no helper call.
    const result = sandboxCompile(
      "function f(v) { 'use strict'; var u = new Array(v.length); " +
        "for (var i = 0; i < v.length; i++) { u[i] = v[i] * 1.5; } return u[v.length - 1]; } " +
        "f([1, 2]);",
      { optimization: "O2" }
    );
    assert.match(
      result.code,
      /\(\$q\d+_\d+ === undefined \?[^)]*isUnmediatedWriteTarget\([^)]*\)[^)]*\)\) \? \$[a-z0-9_]+\[\$[a-z0-9_]+\] = \$[a-z0-9_]+ : \$setSandbox/
    );
    // The guest branch must not re-enter a helper: no $setGuest call at the
    // site (the stamp ternary's guest arm is the native set).
    assert.doesNotMatch(result.code, /\? \$setGuest\(\$r, \$f,/);
    const generatedModule = { exports: {} };
    new Function("require", "module", "exports", result.code)(
      require,
      generatedModule,
      generatedModule.exports
    );
    assert.equal(generatedModule.exports.createInstance().run(), 3);
  });

  it("keeps impure write values (call results) on $setGuest", function () {
    // A call result cannot be re-evaluated at the write site (side effects):
    // its guest branch must stay the $setGuest helper call.
    const result = sandboxCompile(
      "function f(o) { o.x = g(); return o.x; } var n = 0; " +
        "function g() { n++; return n; } var o = {}; f(o);",
      { optimization: "O2" }
    );
    assert.match(result.code, /\? \$setGuest\(\$r, \$f, \$\w+, "x", \$[a-z0-9_]+\) : \$setSandbox/);
  });

  it("uses the slim sloppy writer for sloppy scopes with silent-failure semantics", function () {
    const result = sandboxCompile("function f(o) { o.x = 1; return o.x; } f({});", {
      optimization: "O2",
    });
    assert.match(result.code, /\? \$writeSloppy\(\$[a-z0-9_]+, "x", \$[a-z0-9_]+\) : \$setSandbox/);
    const generatedModule = { exports: {} };
    new Function("require", "module", "exports", result.code)(
      require,
      generatedModule,
      generatedModule.exports
    );
    assert.equal(generatedModule.exports.createInstance().run(), 1);
  });

  it("never inlines a write whose receiver is not provably guest", function () {
    // `Math` is a protected intrinsic read from the global: writeTarget
    // resolution is exactly what blocks the write, so the site must keep the
    // full $setSandbox path — no native set, no $writeSloppy, no $setGuest.
    const result = sandboxCompile("function f() { Math.polluted = 1; } f();", {
      optimization: "O2",
    });
    assert.doesNotMatch(result.code, /Math\.polluted = /);
    assert.doesNotMatch(result.code, /\? \$writeSloppy\(/);
    assert.doesNotMatch(result.code, /\? \$setGuest\(/);
    // The write stays a full-path line: $setSandbox with the receiver read
    // through $readGlobal — no ternary, no slim writer, no native set.
    assert.match(
      result.code,
      /\$setSandbox\(\$r, \$writeSloppy, \$[a-z0-9_]+, "polluted", \$[a-z0-9_]+\);/
    );
    assert.doesNotMatch(result.code, /\(\$q\d+_\d+ === undefined \?[^)]*isUnmediatedWriteTarget/);
  });

  it("keeps the inline forms off kill-switched and non-O2 builds", function () {
    const source = "function f(o) { 'use strict'; o.x = 1; return o.x; } f({});";
    const killed = sandboxCompile(source, { optimization: "O2", inlineGuestWrites: false });
    assert.match(killed.code, /\? \$setGuest\(\$r, \$f,/);
    assert.doesNotMatch(killed.code, /\? \$writeSloppy\(/);
    for (const optimization of ["O0", "O1", "Os"]) {
      const result = sandboxCompile(source, { optimization });
      // O0 legitimately uses $writeSloppy for plain global writes; the inline
      // form is specifically the ternary arm (`? $writeSloppy(`) of a
      // $q-classified guest write, which requires O2 provenance.
      assert.doesNotMatch(result.code, /\? \$writeSloppy\(/);
      assert.doesNotMatch(result.code, /\(\$q\d+_\d+ === undefined \?/);
    }
    const trusted = compileProgram(source, {
      security: "trusted",
      runtimeModule,
      optimization: "O2",
    });
    assert.doesNotMatch(trusted.code, /\? \$writeSloppy\(/);
    assert.doesNotMatch(trusted.code, /\$q\d+_\d+/);
  });
});

describe("sablejs inline literal init (Item 13)", function () {
  function sandboxCompile(source, options = {}) {
    return compileProgram(source, { security: "sandbox", runtimeModule, ...options });
  }

  it("inlines fresh-literal inits with the live flag guard and function-value probe", function () {
    // {a: f()} at O2 sandbox: guard reads the live runtime flag; the fast arm
    // is a native set with the typeof-function probe; the slow arm re-pushes
    // the full operand stack and calls initProperty.
    const result = sandboxCompile(
      "function f() { return function inner() { return 1; }; } var o = {a: f()}; o.a();",
      { optimization: "O2" }
    );
    assert.match(result.code, /if \(\$prototypesHaveSetters\(\)\) \{/);
    assert.match(
      result.code,
      /\$s\.push\(\$[a-z0-9_]+, \$[a-z0-9_]+, \$[a-z0-9_]+\);\s*\n\s*\$r\.initProperty\(\$f\);/
    );
    assert.match(
      result.code,
      /\$[a-z0-9_]+\[\$[a-z0-9_]+\] = \(typeof \$[a-z0-9_]+ === "function" \? \$r\.boundary\.secureValue\(\$[a-z0-9_]+\) : \$[a-z0-9_]+\);/
    );
    const generatedModule = { exports: {} };
    new Function("require", "module", "exports", result.code)(
      require,
      generatedModule,
      generatedModule.exports
    );
    assert.equal(generatedModule.exports.createInstance().run(), 1);
  });

  it("skips the probe for provably-primitive values and the probe entirely in trusted mode", function () {
    // {a: x + y} — ADD is a primitive-result op: no typeof probe.
    const sandbox = sandboxCompile("var x = 1, y = 2; var o = {a: x + y}; o.a;", {
      optimization: "O2",
    });
    assert.match(sandbox.code, /if \(\$prototypesHaveSetters\(\)\) \{/);
    assert.doesNotMatch(sandbox.code, /typeof .* === "function" \? \$r\.boundary\.secureValue/);
    // Trusted mode has no boundary: the fast arm is a bare native set.
    const trusted = compileProgram("var x = 1, y = 2; var o = {a: x + y}; o.a;", {
      security: "trusted",
      runtimeModule,
      optimization: "O2",
    });
    assert.match(trusted.code, /if \(\$prototypesHaveSetters\(\)\) \{/);
    assert.doesNotMatch(trusted.code, /\$r\.boundary\.secureValue/);
    const generatedModule = { exports: {} };
    new Function("require", "module", "exports", trusted.code)(
      require,
      generatedModule,
      generatedModule.exports
    );
    assert.equal(generatedModule.exports.createInstance().run(), 3);
  });

  it("keeps __proto__ keys and flushed-stack operands on the runtime path", function () {
    // __proto__ must define an own data property (ES5.1), never a chain swap,
    // so its init never inlines. A hole in an array literal flushes the model
    // stack, so the inits after the hole keep the runtime path too.
    const result = sandboxCompile(
      "var p = {x: 1}; var o = {'__proto__': p}; var a = [f(), , f()]; function f() { return 1; } o['__proto__'].x + a.length;",
      { optimization: "O2" }
    );
    // The literal __proto__ init has no guard: it is the plain helper line.
    assert.match(result.code, /\$r\.initProperty\(\$f\);\s*\n(?!\s*\}\s*\n\s*\$r\.initProperty)/);
    assert.doesNotMatch(result.code, /\$[a-z0-9_]+\["__proto__"\] = /);
    const generatedModule = { exports: {} };
    new Function("require", "module", "exports", result.code)(
      require,
      generatedModule,
      generatedModule.exports
    );
    assert.equal(generatedModule.exports.createInstance().run(), 4);
  });

  it("falls back correctly after the flag flips mid-program", function () {
    // Trusted guest installs a getter-only accessor, then initializes a
    // literal: the guard must observe the flip and route the init through
    // defineData (own data property) instead of a throwing plain assignment.
    const result = compileProgram(
      "Object.defineProperty(Object.prototype, 'k', { get: function () { return 9; }, configurable: true }); " +
        "var v = 7; var o = {k: v}; " +
        "[o.k, Object.getOwnPropertyDescriptor(o, 'k').writable];",
      { security: "trusted", runtimeModule, optimization: "O2" }
    );
    assert.match(result.code, /if \(\$prototypesHaveSetters\(\)\) \{/);
    const generatedModule = { exports: {} };
    new Function("require", "module", "exports", result.code)(
      require,
      generatedModule,
      generatedModule.exports
    );
    const instance = generatedModule.exports.createInstance({});
    try {
      assert.deepStrictEqual(instance.run(), [7, true]);
    } finally {
      instance.dispose();
      delete Object.prototype.k;
    }
  });

  it("keeps the inline forms off kill-switched and non-O2 builds", function () {
    const source = "function f() { return 1; } var o = {a: f()}; o.a;";
    const killed = sandboxCompile(source, { optimization: "O2", inlineGuestInit: false });
    assert.doesNotMatch(killed.code, /\$prototypesHaveSetters\(\)/);
    for (const optimization of ["O0", "O1", "Os"]) {
      const result = sandboxCompile(source, { optimization });
      assert.doesNotMatch(result.code, /\$prototypesHaveSetters\(\)/);
    }
    const trusted = compileProgram(source, {
      security: "trusted",
      runtimeModule,
      optimization: "Os",
    });
    assert.doesNotMatch(trusted.code, /\$prototypesHaveSetters\(\)/);
  });

  it("demotes and compiles when a flushed SETVAR writes through $r.setVar", function () {
    // Octane EarleyBoyer regression: a hole in an array literal routes the
    // EMPTY init through the runtime path and flushes the model stack, so
    // the following `g = [v, , v]` SETVAR falls back to the name-based
    // $r.setVar helper. Promotion/provenance scopes must demote every slot
    // that helper touches (here none — g is a global) and still compile,
    // instead of the pre-fix hard error.
    const result = compileProgram(
      "var g = 0; " + "function f(v) { var x = 1; g = [v, , v]; return g[2] + x; } " + "f(6);",
      { security: "trusted", runtimeModule, optimization: "O2" }
    );
    assert.match(result.code, /\$r\.setVar\(\$f, "[^"]+"\)/);
    const generatedModule = { exports: {} };
    new Function("require", "module", "exports", result.code)(
      require,
      generatedModule,
      generatedModule.exports
    );
    assert.equal(generatedModule.exports.createInstance().run(), 7);
  });
});

describe("sablejs inline host intrinsics (Item 14)", function () {
  function sandboxCompile(source, options = {}) {
    return compileProgram(source, { security: "sandbox", runtimeModule, ...options });
  }

  it("emits direct calls for intrinsic identifiers, with the sandbox ambient probe", function () {
    const source = 'isNaN(1); parseFloat("1.5px");';
    const sandbox = sandboxCompile(source, { optimization: "O2" });
    // Direct arm is a bare variable call (a variable callee passes
    // undefined this — the (0, ...) sequence expression would only be
    // needed for member-expression callees, and it is the classic V8
    // anti-inline idiom; keep the call feedback-friendly).
    assert.match(
      sandbox.code,
      /typeof \$[a-z0-9_]+ === "object" && \$[a-z0-9_]+ !== null && \$r\.boundary\.ambientValues\.has\(\$[a-z0-9_]+\) \? \$applySandbox1/
    );
    // The direct arm goes through the sanitizing $hostCallN helper so a
    // throwing ToPrimitive (String/Number on a throwing toString) surfaces
    // the same sanitized error the boundary throws.
    assert.match(sandbox.code, /: \$hostCall1\(\$[a-z0-9_]+, \$[a-z0-9_]+, /);
    // Trusted keeps the $apply chain: measured −6..−7% on Typescript when
    // inlined (V8 already fully optimizes the chain, and the shape change
    // perturbs the enclosing functions), so trusted must not inline.
    const trusted = compileProgram(source, {
      security: "trusted",
      runtimeModule,
      optimization: "O2",
    });
    assert.match(trusted.code, /\$apply\(\$r, \$f, /);
    assert.doesNotMatch(trusted.code, /\$[a-z0-9_]+\(\$[a-z0-9_]+\)/);
    assert.equal(sandbox.stats.codegen.inlining.hostIntrinsicCallSites, 2);
    assert.equal(trusted.stats.codegen.inlining.hostIntrinsicCallSites, 0);
  });

  it("computes the five intrinsics identically to the mediated path", function () {
    for (const security of ["sandbox", "trusted"]) {
      const result = run(
        '[isNaN(1), parseFloat("1.5px"), parseInt("42", 10), Number("3"), String(42), isNaN()]',
        {},
        { security, optimization: "O2" }
      );
      assert.deepStrictEqual(result.value, [false, 1.5, 42, 3, "42", true], security);
      // Trusted is gated off (measured −6..−7% on Typescript), so only
      // sandbox counts inline sites; trusted still computes identically
      // through $apply.
      assert.equal(
        result.result.stats.codegen.inlining.hostIntrinsicCallSites,
        security === "sandbox" ? 6 : 0,
        security
      );
    }
  });

  it("honors guest redefinitions through every global write vector", function () {
    const shadow = 'function shadow(x) { return "shadow:" + x; } isNaN = shadow; isNaN(1);';
    for (const security of ["sandbox", "trusted"]) {
      assert.equal(run(shadow, {}, { security, optimization: "O2" }).value, "shadow:1", security);
    }
    // The guest global object is reachable as top-level this (no globalThis
    // binding in the ES5.1 guest), so member writes to it are SETPROPs.
    const setprop = 'function shadow() { return "via-setprop"; } this.isNaN = shadow; isNaN(1);';
    for (const security of ["sandbox", "trusted"]) {
      assert.equal(
        run(setprop, {}, { security, optimization: "O2" }).value,
        "via-setprop",
        security
      );
    }
    const define =
      'function shadow() { return "via-define"; } Object.defineProperty(this, "isNaN", { value: shadow }); isNaN(1);';
    for (const security of ["sandbox", "trusted"]) {
      assert.equal(run(define, {}, { security, optimization: "O2" }).value, "via-define", security);
    }
    // A declared global holding a non-function shadows the intrinsic: the
    // call must throw exactly like the mediated path.
    for (const security of ["sandbox", "trusted"]) {
      assert.throws(
        () => run("var isNaN = 5; isNaN(1);", {}, { security, optimization: "O2" }).value,
        TypeError,
        security
      );
    }
  });

  it("excludes locals, parameters, and member calls from the inline", function () {
    const local =
      'function f(isNaN) { return isNaN(1); } f(function (x) { return "param:" + x; });';
    for (const security of ["sandbox", "trusted"]) {
      const result = run(local, {}, { security, optimization: "O2" });
      assert.equal(result.value, "param:1", security);
      assert.equal(result.result.stats.codegen.inlining.hostIntrinsicCallSites, 0, security);
    }
    const member = 'var o = { isNaN: function (x) { return "member:" + x; } }; o.isNaN(1);';
    for (const security of ["sandbox", "trusted"]) {
      const result = run(member, {}, { security, optimization: "O2" });
      assert.equal(result.value, "member:1", security);
      assert.equal(result.result.stats.codegen.inlining.hostIntrinsicCallSites, 0, security);
    }
    // A with-environment read resolves dynamically and must keep its result.
    const withScope = 'with ({ isNaN: function (x) { return "with:" + x; } }) { isNaN(1); }';
    for (const security of ["sandbox", "trusted"]) {
      assert.equal(run(withScope, {}, { security, optimization: "O2" }).value, "with:1", security);
    }
  });

  it("calls through guest argument objects and arities like the mediated path", function () {
    for (const security of ["sandbox", "trusted"]) {
      const objects = run(
        '[String({ toString: function () { return "T"; } }), Number({ valueOf: function () { return 7; } }), isNaN(Math), parseFloat("1.5", 2, 3, 4, 5, 6)]',
        {},
        { security, optimization: "O2" }
      );
      assert.deepStrictEqual(objects.value, ["T", 7, true, 1.5], security);
      // 6-arg calls keep the generic array fallback shape in sandbox mode.
      if (security === "sandbox") {
        assert.match(objects.result.code, /\$applySandbox\(/);
      }
    }
  });

  it("keeps the inline forms off kill-switched and non-O2 builds", function () {
    const source = "isNaN(1);";
    const killed = sandboxCompile(source, { optimization: "O2", inlineHostIntrinsics: false });
    assert.doesNotMatch(killed.code, /\$[a-z0-9_]+\(\$[a-z0-9_]+\)/);
    assert.match(killed.code, /\$applySandbox1\(\$r, /);
    // O0/O1 compile no call helpers at all (interpreter `$r.call`), Os keeps
    // the mediated helper but never the direct-call inline form.
    for (const optimization of ["O0", "O1"]) {
      const result = sandboxCompile(source, { optimization });
      assert.doesNotMatch(result.code, /\$[a-z0-9_]+\(\$[a-z0-9_]+\)/);
      assert.match(result.code, /\$r\.call\(\$f, 1\)/);
    }
    const os = sandboxCompile(source, { optimization: "Os" });
    assert.doesNotMatch(os.code, /\$[a-z0-9_]+\(\$[a-z0-9_]+\)/);
    assert.match(os.code, /\$applySandbox1\(\$r, /);
    const trusted = compileProgram(source, {
      security: "trusted",
      runtimeModule,
      optimization: "O0",
    });
    assert.doesNotMatch(trusted.code, /\$[a-z0-9_]+\(\$[a-z0-9_]+\)/);
    assert.match(trusted.code, /\$r\.call\(\$f, 1\)/);
  });
});

describe("sablejs inline member host intrinsics (Item 15)", function () {
  function sandboxCompile(source, options = {}) {
    return compileProgram(source, { security: "sandbox", runtimeModule, ...options });
  }

  it("emits identity-guarded direct calls for member intrinsics, sandbox only", function () {
    const source = 'function f(a) { a.push(1); return a.join(","); } f;';
    const sandbox = sandboxCompile(source, { optimization: "O2" });
    // Identity guard against the imported raw prototype function, ambient
    // probes per argument, and a direct Function.prototype.call arm that
    // reuses the checked callee as the callable.
    assert.match(sandbox.code, /\$[a-z0-9_]+ !== \$hostJoin/);
    assert.match(sandbox.code, /\$[a-z0-9_]+ !== \$hostPush/);
    // Direct arm through the sanitizing helper with the checked callee and
    // the recorded receiver.
    assert.match(sandbox.code, /: \$hostCall1\(\$[a-z0-9_]+, \$[a-z0-9_]+, /);
    assert.match(sandbox.code, /boundary\.ambientValues\.has\(/);
    assert.equal(sandbox.stats.codegen.inlining.memberIntrinsicCallSites, 2);
    // Trusted keeps the $apply chain (the same measured decision as item 14).
    const trusted = compileProgram(source, {
      security: "trusted",
      runtimeModule,
      optimization: "O2",
    });
    assert.doesNotMatch(trusted.code, /\$hostJoin/);
    assert.equal(trusted.stats.codegen.inlining.memberIntrinsicCallSites, 0);
  });

  it("guards the mutating members with the protected-receiver probe", function () {
    const source = "function f(a, v) { a.push(v); a.sort(); return a; } f;";
    const sandbox = sandboxCompile(source, { optimization: "O2" });
    assert.equal(sandbox.stats.codegen.inlining.memberIntrinsicCallSites, 2);
    assert.match(sandbox.code, /boundary\.protectedValues\.has\(/);
    // Read-only members never emit the protected probe (the boundary
    // classifies them pure and lets them run on protected receivers).
    const readOnly = sandboxCompile("function f(s) { return s.slice(1); } f;", {
      optimization: "O2",
    });
    assert.doesNotMatch(readOnly.code, /protectedValues\.has\(/);
    assert.equal(readOnly.stats.codegen.inlining.memberIntrinsicCallSites, 1);
  });

  it("matches both prototypes for slice and indexOf", function () {
    const source =
      'function f(a, s) { return [a.slice(1), a.indexOf(2), s.slice(1), s.indexOf("b")]; } f([2, 3, 4], "abc");';
    const sandbox = sandboxCompile(source, { optimization: "O2" });
    assert.equal(sandbox.stats.codegen.inlining.memberIntrinsicCallSites, 4);
    assert.match(sandbox.code, /\$hostSliceArray/);
    assert.match(sandbox.code, /\$hostSliceString/);
    assert.match(sandbox.code, /\$hostIndexOfArray/);
    assert.match(sandbox.code, /\$hostIndexOfString/);
    const result = run(source, {}, { security: "sandbox", optimization: "O2" });
    assert.deepStrictEqual(result.value, [[3, 4], 0, "bc", 1]);
  });

  it("computes all eight members identically to the mediated path", function () {
    const source =
      '(function (a) { a.push(4); a.sort(); return [a.join(","), a.slice(1), a.indexOf(4)]; })([3, 1, 2])' +
      ' + "|" + (function (s) { return [s.charAt(1), s.indexOf("b", 2), s.slice(1, 3), s.replace(/b/, "X")]; })("abca")' +
      ' + "|" + (function (s) { return s.replace(/a/, function (m) { return m + m; }); })("aba")' +
      ' + "|" + (function (r, s) { return [r.test(s), r.test("nope")]; })(/a/g, "abca")';
    for (const optimization of ["O2", "O0"]) {
      for (const security of ["sandbox", "trusted"]) {
        const value = run(source, {}, { security, optimization });
        const baseline = run(source, {}, { security, optimization, inlineMemberIntrinsics: false });
        assert.deepStrictEqual(value.value, baseline.value, `${security} ${optimization}`);
        // The O2 sandbox arm bypasses the boundary for every member call:
        // zero hostCall mediations with profiling on, where the mediated
        // baseline counts the full chain (4 calls × 2 invocations + 3
        // stateless = 11).
        if (optimization === "O2" && security === "sandbox") {
          const profiled = run(source, {}, { security, optimization, profileBoundary: true });
          const profiledBaseline = run(
            source,
            {},
            {
              security,
              optimization,
              inlineMemberIntrinsics: false,
              profileBoundary: true,
            }
          );
          assert.equal(profiled.instance.boundaryStats().hostCalls, 0);
          assert.equal(profiledBaseline.instance.boundaryStats().hostCalls, 12);
          assert.ok(profiled.result.stats.codegen.inlining.memberIntrinsicCallSites > 0);
        }
      }
    }
  });

  it("routes guest overrides, own or on the prototype chain, to the fallback", function () {
    const own = 'var o = { join: function () { return "own"; } }; o.join();';
    const proto =
      'function C() {} C.prototype.join = function () { return "proto"; }; var o = new C(); o.join();';
    const onObject =
      "var o = Object.create({ indexOf: function () { return 99; } }); o.indexOf(1);";
    for (const security of ["sandbox", "trusted"]) {
      assert.equal(run(own, {}, { security, optimization: "O2" }).value, "own", security);
      assert.equal(run(proto, {}, { security, optimization: "O2" }).value, "proto", security);
      assert.equal(run(onObject, {}, { security, optimization: "O2" }).value, 99, security);
    }
  });

  it("keeps boundary semantics for protected receivers", function () {
    // push on a shared intrinsic receiver must throw the same boundary error
    // the mediated path throws (sandbox only — trusted has no boundary, and
    // running it there would mutate the host's Array.prototype).
    const mutating = "var p = Object.getPrototypeOf([]); p.push(1);";
    assert.throws(
      () => run(mutating, {}, { security: "sandbox", optimization: "O2" }).value,
      /cannot modify a shared intrinsic/
    );
    assert.throws(
      () =>
        run(
          mutating,
          {},
          { security: "sandbox", optimization: "O2", inlineMemberIntrinsics: false }
        ).value,
      /cannot modify a shared intrinsic/
    );
    // Read-only members on protected receivers run exactly like the
    // mediated path — join over a protected receiver's own elements is
    // legal.
    const readOnly = 'Object.getPrototypeOf([]).join(",");';
    for (const security of ["sandbox", "trusted"]) {
      const value = run(readOnly, {}, { security, optimization: "O2" }).value;
      const baseline = run(
        readOnly,
        {},
        { security, optimization: "O2", inlineMemberIntrinsics: false }
      ).value;
      assert.deepStrictEqual(value, baseline, security);
    }
    // test on RegExp.prototype throws the identical sanitized error in
    // both arms (it is classified pure, so no boundary error either way):
    // same name and message, and — critically — not a raw host TypeError
    // with its stack (the sanitization the direct arm must preserve).
    const testOnPrototype = 'Object.getPrototypeOf(/a/).test("a");';
    function caught(errorOptions, mode) {
      try {
        run(testOnPrototype, {}, { security: mode, optimization: "O2", ...errorOptions }).value;
        return null;
      } catch (error) {
        return {
          name: error.name,
          message: error.message,
          sanitized: !(error instanceof TypeError) && typeof error.stack !== "string",
        };
      }
    }
    for (const security of ["sandbox", "trusted"]) {
      assert.deepStrictEqual(
        caught({}, security),
        caught({ inlineMemberIntrinsics: false }, security),
        security
      );
      // The sanitization promise is the sandbox's; trusted has no boundary
      // and surfaces the raw host error in both arms.
      if (security === "sandbox") assert.ok(caught({}, security).sanitized, security);
    }
  });

  it("evaluates accessor members exactly once", function () {
    const source =
      'var count = 0; var o = {}; Object.defineProperty(o, "join", { get: function () { count += 1; return Array.prototype.join; } }); ' +
      'o.join(","); count;';
    const value = run(source, {}, { security: "sandbox", optimization: "O2" });
    assert.equal(value.value, 1);
  });

  it("calls through guest argument objects like the mediated path", function () {
    const source =
      'var o = [1, 2]; var f = o.join; [f.call(o), (function () { var a = [1, 2]; return a.join.call(a, "-"); })()]';
    for (const security of ["sandbox", "trusted"]) {
      assert.deepStrictEqual(
        run(source, {}, { security, optimization: "O2" }).value,
        ["1,2", "1-2"],
        security
      );
    }
    // Sort with a guest comparator runs it unmediated in both paths.
    const sort = "[3, 1, 2].sort(function (a, b) { return a - b; })";
    for (const security of ["sandbox", "trusted"]) {
      assert.deepStrictEqual(
        run(sort, {}, { security, optimization: "O2" }).value,
        [1, 2, 3],
        security
      );
    }
  });

  it("keeps the inline forms off kill-switched, non-O2, and non-sandbox builds", function () {
    const source = "function f(a) { a.push(1); } f;";
    const killed = sandboxCompile(source, { optimization: "O2", inlineMemberIntrinsics: false });
    assert.doesNotMatch(killed.code, /\$hostPush/);
    assert.match(killed.code, /\$applySandbox1\(\$r, /);
    assert.equal(killed.stats.codegen.inlining.memberIntrinsicCallSites, 0);
    for (const optimization of ["O0", "O1", "Os"]) {
      const result = sandboxCompile(source, { optimization });
      assert.equal(result.stats.codegen.inlining.memberIntrinsicCallSites, 0, optimization);
    }
    const trusted = compileProgram(source, {
      security: "trusted",
      runtimeModule,
      optimization: "O2",
    });
    assert.doesNotMatch(trusted.code, /\$hostPush/);
  });

  it("recovers flushed member-call operands across a control region (item 15b)", function () {
    // A control-flow region between the operand pushes and the CALL — the
    // ternary inside the object-literal argument — flushes callable,
    // receiver, object, and key onto $s. The O2 emitter mirrors $s, recovers
    // the tail by name, and emits the same inline with a $s trim in place of
    // the dispatch. The recovery is O2-gated like the rest of item 15.
    const source =
      'var a = []; for (var i = 0; i < 500; i++) { a.push({ id: i, tag: i % 2 ? "x" : "y" }); } a.length;';
    const on = run(source, {}, { security: "sandbox", optimization: "O2" });
    const off = run(
      source,
      {},
      { security: "sandbox", optimization: "O2", inlineMemberIntrinsics: false }
    );
    assert.equal(on.value, 500);
    assert.deepStrictEqual(on.value, off.value);
    assert.ok(on.result.stats.codegen.inlining.memberIntrinsicCallSites >= 1);
    assert.equal(off.result.stats.codegen.inlining.memberIntrinsicCallSites, 0);
    // The recovered inline trims $s by the call's operands (count + 2).
    const compiled = sandboxCompile(source, { optimization: "O2" });
    assert.match(compiled.code, /\$hostCall1\(/);
    assert.match(compiled.code, /\$s\.length -= 3;/);
    // The trim keeps the frame's references in lockstep, so boundary
    // profiling stays exact on the recovered path.
    const profiled = run(
      source,
      {},
      { security: "sandbox", optimization: "O2", profileBoundary: true }
    );
    assert.equal(profiled.instance.boundaryStats().hostCalls, 0);
  });

  it("keeps branch-flushed argument values on the mediated dispatch (item 15b)", function () {
    // When the call argument itself is the exclusive branch value, the
    // mirror holds only a placeholder for it — the recovery must miss and
    // the dispatch must produce the alternating values, never a stale
    // branch constant.
    const source =
      'var a = []; for (var i = 0; i < 6; i++) { a.push(i % 2 ? "x" : "y"); } a.join(":");';
    for (const security of ["sandbox", "trusted"]) {
      const value = run(source, {}, { security, optimization: "O2" }).value;
      const baseline = run(
        source,
        {},
        { security, optimization: "O2", inlineMemberIntrinsics: false }
      ).value;
      assert.deepStrictEqual(value, baseline, security);
    }
    assert.equal(run(source, {}, { security: "sandbox", optimization: "O2" }).value, "y:x:y:x:y:x");
  });
});

describe("sablejs generated-code inspection mode (dumpDir)", function () {
  const fs = require("fs");
  const os = require("os");

  function tempDumpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "sablejs-dump-test-"));
  }

  it("writes hir.txt, semantic cfg.txt, mir.txt, and code.js for O2", function () {
    const dir = tempDumpDir();
    try {
      const result = compile(
        "var o = {}; o.x = 1; var t = (o.g ? 1 : 2) + 3; function f(a) { return a + 1; } f(41);",
        { optimization: "O2", security: "sandbox", dumpDir: dir }
      );
      // The dump is a side channel; the result object is unchanged unless the
      // graph-returning options are requested.
      assert.equal(result.hir, undefined);
      assert.equal(result.cfg, undefined);
      assert.equal(result.mir, undefined);
      const files = fs.readdirSync(dir).sort();
      assert.deepStrictEqual(files, ["cfg.txt", "code.js", "hir.txt", "mir.txt"]);

      const hir = fs.readFileSync(path.join(dir, "hir.txt"), "utf8");
      assert.match(hir, /^ProgramHIR version=1 entry=#0 scopes=2\n/);
      assert.match(hir, /scope "" #0 codeLength=\d+/);
      assert.match(hir, /NEWOBJECT/);
      assert.match(hir, /SETPROP_S "x"/);
      // Nested scopes print as references, not JSON graphs.
      assert.match(hir, /CLOSURE scope:"f" #1/);
      assert.doesNotMatch(hir, /\{"kind":"FunctionHIR"/);
      // The provenance mark is visible in the dump.
      assert.match(hir, /GETLOCAL 1\s+; guest/);

      const cfg = fs.readFileSync(path.join(dir, "cfg.txt"), "utf8");
      assert.match(cfg, /^CFG edgeModel=semantic scopes=2\n/);
      assert.match(cfg, /class=normal/);

      const mir = fs.readFileSync(path.join(dir, "mir.txt"), "utf8");
      assert.match(mir, /^MIR scopes=2\n/);
      assert.match(mir, /block \d+\.\.\d+/);
      // The ternary join produces a phi (block with pred=[...] succ=[...]).
      assert.match(mir, /pred=\[.*\] succ=\[/);
      assert.match(mir, /phi #\S+ slot=\d+ <- \[/);

      const code = fs.readFileSync(path.join(dir, "code.js"), "utf8");
      assert.match(code, /"use strict";/);
      assert.match(code, /\$createProgram\(/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("works at every optimization level including O0", function () {
    for (const optimization of ["O0", "O1", "O2", "Os"]) {
      const dir = tempDumpDir();
      try {
        compile("var a = 1 + 2; a;", { optimization, dumpDir: dir });
        const hir = fs.readFileSync(path.join(dir, "hir.txt"), "utf8");
        assert.match(hir, /^ProgramHIR/, optimization);
        assert.match(
          fs.readFileSync(path.join(dir, "mir.txt"), "utf8"),
          /^MIR scopes=1\n/,
          optimization
        );
        assert.match(
          fs.readFileSync(path.join(dir, "code.js"), "utf8"),
          /"use strict";/,
          optimization
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("mirrors the graph dumps when dumpIR/includeHIR are also set", function () {
    const dir = tempDumpDir();
    try {
      const result = compile("var o = { a: 1 }; o.a;", {
        optimization: "O2",
        security: "sandbox",
        dumpDir: dir,
        dumpIR: "all",
      });
      assert.ok(result.hir);
      assert.ok(result.cfg);
      assert.ok(result.mir);
      const mir = fs.readFileSync(path.join(dir, "mir.txt"), "utf8");
      assert.match(mir, /mir scope #0 /);
      assert.match(mir, /NEWOBJECT/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes through a custom fs adapter instead of Node built-ins", function () {
    // The adapter is the browser path: an in-memory implementation (e.g.
    // memfs) lets dumpDir work without Node's fs/path in the bundle.
    const calls = [];
    const adapter = {
      mkdirSync: (directory) => calls.push(["mkdir", directory]),
      writeFileSync: (file, text) => calls.push(["write", file, text]),
      join: (...parts) => parts.join("/"),
    };
    const result = compile("var a = 1 + 2; a;", {
      optimization: "O2",
      security: "sandbox",
      dumpDir: "/virtual/dump",
      fs: adapter,
    });
    // The dump is a side channel; the result object is unchanged.
    assert.equal(result.hir, undefined);
    assert.equal(calls.length, 5);
    assert.deepStrictEqual(calls[0], ["mkdir", "/virtual/dump"]);
    assert.deepStrictEqual(
      calls.slice(1).map((call) => call[1]),
      [
        "/virtual/dump/hir.txt",
        "/virtual/dump/cfg.txt",
        "/virtual/dump/mir.txt",
        "/virtual/dump/code.js",
      ]
    );
    assert.match(calls[2][2], /^CFG edgeModel=semantic scopes=1\n/);
    assert.match(calls[3][2], /^MIR scopes=1\n/);
  });
});
