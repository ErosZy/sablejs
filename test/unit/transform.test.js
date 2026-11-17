"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { describe, it } = require("node:test");
const { parse: parseAcorn } = require("acorn");
const {
  GenMapping,
  addMapping,
  setSourceContent,
  toEncodedMap,
} = require("@jridgewell/gen-mapping");
const { TraceMap, originalPositionFor } = require("@jridgewell/trace-mapping");
const { compile: compileProgram, normalizeTransformOptions, transformToES5 } = require("../../src");

const runtimeModule = path.resolve(__dirname, "../../src/runtime");
const LEVELS = ["O0", "O1", "O2", "Os"];
const SECURITIES = ["sandbox", "trusted"];

function toComparable(value, seen = new WeakMap()) {
  if (value === undefined) return { kind: "undefined" };
  if (value === null) return null;
  if (typeof value === "bigint") return { kind: "bigint", value: `${value}n` };
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { kind: "NaN" };
    if (Object.is(value, -0)) return { kind: "-0" };
    return value;
  }
  if (typeof value !== "object" && typeof value !== "function") return value;
  if (seen.has(value)) return { kind: "ref", id: seen.get(value) };
  seen.set(value, seen.size);

  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i += 1) {
      out.push(i in value ? toComparable(value[i], seen) : { kind: "hole" });
    }
    return out;
  }
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object Set]") {
    return { kind: "Set", entries: Array.from(value, (v) => toComparable(v, seen)) };
  }
  if (tag === "[object Map]") {
    return {
      kind: "Map",
      entries: Array.from(value, ([k, v]) => [toComparable(k, seen), toComparable(v, seen)]),
    };
  }
  if (tag === "[object RegExp]") {
    return { kind: "RegExp", source: value.source, flags: value.flags };
  }
  if (tag === "[object Date]") {
    return { kind: "Date", time: value.getTime() };
  }
  if (typeof value === "function") {
    return { kind: "function", length: value.length };
  }
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = toComparable(value[key], seen);
  }
  return out;
}

function loadProgram(source, options = {}) {
  const result = compileProgram(source, { runtimeModule, ...options });
  const generatedModule = { exports: {} };
  new Function("require", "module", "exports", result.code)(
    require,
    generatedModule,
    generatedModule.exports
  );
  return { result, program: generatedModule.exports };
}

function runProgram(source, globals = {}, options = {}) {
  const { result, program } = loadProgram(source, options);
  const instance = program.createInstance({ globals });
  try {
    return { result, value: instance.run() };
  } finally {
    instance.dispose();
  }
}

function assertParity(source, { createGlobals = () => ({}), compileOptions = {} } = {}) {
  const expected = vm.runInNewContext(source, createGlobals());
  const expectedComparable = toComparable(expected);
  for (const security of SECURITIES) {
    for (const optimization of LEVELS) {
      const { value } = runProgram(source, createGlobals(), {
        ...compileOptions,
        optimization,
        security,
      });
      assert.deepStrictEqual(
        toComparable(value),
        expectedComparable,
        `Parity mismatch for ${optimization}/${security}`
      );
    }
  }
}

describe("sablejs ES2015+ -> ES5.1 transform", function () {
  it("supports let/const block scoping, shadowing, loop uninitialized reset, and const TypeError", function () {
    assertParity(`
      const out = [];
      let x = "outer";
      {
        let x = "inner";
        const y = 42;
        out.push(x + ":" + y);
      }
      out.push(x);
      for (let i = 0; i < 3; i += 1) {
        let cell;
        out.push(cell === undefined ? "undef" : String(cell));
        cell = i * 10;
        out.push(cell);
      }
      let constErr = "";
      try {
        const c = 1;
        c = 2;
      } catch (e) {
        constErr = e.name;
      }
      out.push(constErr);
      out;
    `);
  });

  it("captures per-iteration bindings cleanly in loop closures with break/continue/return/labels", function () {
    assertParity(`
      const fns = [];
      for (let i = 0; i < 4; i += 1) {
        if (i === 1) continue;
        if (i === 3) break;
        fns.push(function () { return i; });
      }
      const mutated = [];
      for (let j = 0; j < 5; j += 1) {
        mutated.push(() => j);
        j += 1;
      }
      const obj = { a: 10, b: 20, c: 30 };
      const inFns = [];
      for (const k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          inFns.push(() => k + "=" + obj[k]);
        }
      }
      const ofFns = [];
      for (const v of [7, 8, 9]) {
        ofFns.push(() => v * 2);
      }
      let w = 0;
      const whileFns = [];
      while (w < 3) {
        let cur = w * 10;
        whileFns.push(() => cur);
        w += 1;
      }
      const nestedOut = [];
      outer: for (let r = 0; r < 3; r += 1) {
        for (let c = 0; c < 3; c += 1) {
          nestedOut.push(() => r + ":" + c);
          if (r === 1 && c === 1) continue outer;
          if (r === 2 && c === 0) break outer;
        }
      }
      function earlyReturnInLoop() {
        const saved = [];
        for (let i = 0; i < 4; i += 1) {
          saved.push(() => i);
          if (i === 2) return [saved.map((fn) => fn()), i];
        }
        return [];
      }
      ({
        forVals: fns.map((fn) => fn()),
        mutatedVals: mutated.map((fn) => fn()),
        inVals: inFns.map((fn) => fn()),
        ofVals: ofFns.map((fn) => fn()),
        whileVals: whileFns.map((fn) => fn()),
        nestedVals: nestedOut.map((fn) => fn()),
        early: earlyReturnInLoop(),
      });
    `);
  });

  it("lowers block-scoped function declarations when transform: true and rejects them in strict auto/false", function () {
    assertParity(
      `
      "use strict";
      let before = typeof innerFn;
      {
        function innerFn() { return 7; }
        var inBlock = innerFn();
      }
      let a = 0;
      if (true) {
        function pick() { return 1; }
        a = pick();
      } else {
        function pick() { return 2; }
      }
      [before, inBlock, a, typeof innerFn];
      `,
      { compileOptions: { transform: true } }
    );

    const strictAutoES5 = '"use strict"; { function blocked() { return 1; } }';
    assert.throws(() => compileProgram(strictAutoES5, { runtimeModule }), SyntaxError);
    assert.throws(
      () => compileProgram(strictAutoES5, { runtimeModule, transform: false }),
      SyntaxError
    );
  });

  it("handles arrow functions, lexical this/arguments, default, rest, destructured params, and fn.length", function () {
    assertParity(`
      const obj = {
        factor: 3,
        make() {
          const baseArgs = arguments;
          const inner = (x = 2, y = x + 1, ...rest) => ({
            scaled: (x + y) * this.factor,
            firstArg: baseArgs[0],
            restCount: rest.length,
            pair: () => ({ ok: x }),
          });
          return inner;
        },
      };
      const fn = obj.make(100);
      function paramsFn(a, b = 10, c, ...rest) {
        return [a, b, c, rest];
      }
      const destructParam = ({ x, y = 5 }, [head, ...tail]) => x + y + head + tail.length;
      const fnWithDestruct = ({ a }, b = 1) => a + b;
      ({
        undefDefault: fn(undefined, undefined, 9, 10),
        explicitArgs: fn(4, undefined),
        objReturn: fn(1).pair(),
        paramsRes: paramsFn(1, undefined, 3, 4, 5),
        destructRes: destructParam({ x: 2 }, [10, 20, 30]),
        lengths: [obj.make().length, paramsFn.length, destructParam.length, fnWithDestruct.length],
      });
    `);
  });

  it("supports deep object/array destructuring, rest, computed keys, iterables, member targets, and catch bindings", function () {
    assertParity(`
      const k = "dyn";
      const src = {
        a: 1,
        nested: { deep: [10, 20, 30, 40] },
        dyn: "hit",
        extra: 99,
      };
      const { a, [k]: dynVal, missing = 55, nested: { deep: [d0, , ...dRest] }, ...restObj } = src;
      const [s0, ...sRest] = new Set(["x", "y", "z"]);
      const [c0, c1, c2 = "!"] = "ab";
      const box = { left: "L", right: "R" };
      [box.left, box.right] = [box.right, box.left];

      let nullErr = "";
      try {
        const { nope } = null;
      } catch (e) {
        nullErr = e.name;
      }

      let optCatch = "";
      try {
        throw new Error("boom");
      } catch {
        optCatch = "caught";
      }

      let patCatch = "";
      try {
        throw new Error("hello");
      } catch ({ message }) {
        patCatch = message;
      }

      ({
        a,
        dynVal,
        missing,
        d0,
        dRest,
        restObjKeys: Object.keys(restObj).sort(),
        s0,
        sRest,
        chars: [c0, c1, c2],
        swapped: [box.left, box.right],
        nullErr,
        optCatch,
        patCatch,
      });
    `);
  });

  it("supports spread in arrays, calls with preserved receiver, new calls, and objects", function () {
    assertParity(`
      const a = [2, 3];
      const b = [5, 6];
      const arr = [1, ...a, 4, ...b];

      const receiver = {
        prefix: "hi:",
        joinArgs(...xs) {
          return this.prefix + xs.join(",");
        },
      };
      const extra = ["b", "c"];
      const callRes = receiver.joinArgs("a", ...extra);

      class Pair {
        constructor(x, y, z) {
          this.sum = x + y + z;
        }
      }
      const nums = [10, 20, 30];
      const pairInstance = new Pair(...nums);
      const dateInstance = new Date(...[2026, 0, 15, 0, 0, 0, 0]);

      const spreadObj = { x: 1, ...{ y: 2 }, ...null, ...undefined, x: 9, ...{ z: 3 } };

      ({
        arr,
        callRes,
        pairSum: pairInstance.sum,
        year: dateInstance.getFullYear(),
        spreadObj,
      });
    `);
  });

  it("supports template literals, tagged templates, raw escapes, and cached frozen template identity", function () {
    assertParity(`
      const name = "sable";
      const version = 2;
      const interp = \`hello \${name}-\${version + 1}
line2\`;

      const seenTemplates = [];
      function tag(strings, ...values) {
        seenTemplates.push(strings);
        return {
          cooked: strings.slice(),
          raw: strings.raw.slice(),
          frozen: Object.isFrozen(strings) && Object.isFrozen(strings.raw),
          values,
        };
      }
      function invokeTag(v) {
        return tag\`row:\\n\${v}\\t!\`;
      }
      const first = invokeTag("A");
      const second = invokeTag("B");
      ({
        interp,
        first,
        secondValues: second.values,
        sameTemplateObject: seenTemplates[0] === seenTemplates[1],
        rawArrayMatches: seenTemplates[0].raw === seenTemplates[1].raw,
      });
    `);
  });

  it("supports object extensions, shorthand/computed properties, accessors, and object super.m()", function () {
    assertParity(`
      const key = "score";
      const val = 77;
      const base = {
        greet(who) {
          return "hi " + who + ":" + this.tag;
        },
      };
      const child = {
        tag: "v2",
        val,
        ["k_" + key]: 88,
        get double() {
          return this.val * 2;
        },
        greet(who) {
          return super.greet(who) + "!";
        },
      };
      Object.setPrototypeOf(child, base);
      ({
        val: child.val,
        computed: child.k_score,
        double: child.double,
        superCall: child.greet("world"),
      });
    `);
  });

  it("supports for..of across Array, String (surrogate pairs), Set, Map, and custom iterables calling return()", function () {
    assertParity(`
      const arrOut = [];
      for (const n of [1, 2, 3]) arrOut.push(n * 10);

      const chars = [];
      for (const ch of "a😀b") chars.push(ch);

      const setOut = [];
      for (const v of new Set(["p", "q", "r"])) {
        if (v === "r") break;
        setOut.push(v);
      }

      const mapOut = [];
      for (const [k, v] of new Map([["x", 1], ["y", 2]])) {
        mapOut.push(k + "=" + v);
      }

      let breakClosed = 0;
      const customBreak = {
        [Symbol.iterator]() {
          let i = 0;
          return {
            next() {
              i += 1;
              return i <= 5 ? { value: i, done: false } : { done: true };
            },
            return() {
              breakClosed += 1;
              return { done: true };
            },
          };
        },
      };
      let breakSum = 0;
      for (const x of customBreak) {
        breakSum += x;
        if (x === 2) break;
      }

      let throwClosed = 0;
      const customThrow = {
        [Symbol.iterator]() {
          return {
            next() {
              return { value: 99, done: false };
            },
            return() {
              throwClosed += 1;
              return { done: true };
            },
          };
        },
      };
      let caughtMsg = "";
      try {
        for (const y of customThrow) {
          if (y === 99) throw new Error("stop-iter");
        }
      } catch (e) {
        caughtMsg = e.message;
      }

      ({ arrOut, chars, setOut, mapOut, breakClosed, breakSum, throwClosed, caughtMsg });
    `);
  });

  it("supports classes, inheritance, super, accessors, fields, static blocks, #private, brand checks, new enforcement, and built-in Error", function () {
    assertParity(`
      const log = [];
      class Base {
        static kind = "base";
        static {
          log.push("base-static:" + this.kind);
        }
        baseField = 10;
        #secret;
        constructor(v) {
          this.#secret = v * 2;
        }
        #doubleSecret() {
          return this.#secret * 2;
        }
        get secretInfo() {
          return this.#doubleSecret();
        }
        static hasSecret(obj) {
          return #secret in obj;
        }
        describe() {
          return "Base(" + this.baseField + ")";
        }
        static staticTag() {
          return "B";
        }
      }

      const SubExpr = class Sub extends Base {
        static #staticCount = 1;
        static {
          this.#staticCount += 4;
        }
        #extra = 5;
        constructor(v) {
          super(v);
        }
        get #computed() {
          return this.#extra + 1;
        }
        set #computed(n) {
          this.#extra = n;
        }
        describe() {
          this.#computed = 7;
          return super.describe() + "->Sub(" + this.secretInfo + "," + this.#computed + ")";
        }
        static countPlus() {
          return this.#staticCount + ":" + super.staticTag();
        }
      };

      const inst = new SubExpr(3);
      let callWithoutNewErr = "";
      try {
        SubExpr(3);
      } catch (e) {
        callWithoutNewErr = e.name;
      }

      class CustomError extends Error {
        constructor(msg, code) {
          super(msg);
          this.code = code;
        }
      }
      const err = new CustomError("bad input", 422);

      ({
        log,
        desc: inst.describe(),
        staticCount: SubExpr.countPlus(),
        brandHit: Base.hasSecret(inst),
        brandMiss: Base.hasSecret({}),
        instanceChecks: [inst instanceof Base, inst instanceof SubExpr],
        callWithoutNewErr,
        errInfo: [err instanceof Error, err instanceof CustomError, err.message, err.code],
      });
    `);
  });

  it("supports exponentiation, optional chaining, nullish coalescing, logical assignment, numeric separators, 0b/0o, and BigInt", function () {
    assertParity(`
      let expEvalCount = 0;
      const box = { v: 2 };
      const expHolder = {
        get target() {
          expEvalCount += 1;
          return box;
        },
      };
      expHolder.target.v **= 3;

      let sideEffects = 0;
      const bump = () => {
        sideEffects += 1;
        return 1;
      };
      const missingObj = null;
      const skippedOpt = missingObj?.fn(bump());
      const hostObj = {
        tag: "R",
        method(x) {
          return this.tag + ":" + x;
        },
      };
      const receiverPreserved = hostObj.method?.(5);
      const bracketKey = "tag";
      const optBracket = hostObj?.[bracketKey];
      const delMissing = delete missingObj?.prop;
      const toDelete = { a: 1, b: 2 };
      const delPresent = delete toDelete?.a;

      const nullish = [
        null ?? "fallback",
        undefined ?? "fallback",
        0 ?? "fallback",
        "" ?? "fallback",
        false ?? "fallback",
      ];

      let setterHits = 0;
      const accObj = {
        _a: 0,
        _b: 10,
        _c: null,
        get a() { return this._a; },
        set a(v) { setterHits += 1; this._a = v; },
        get b() { return this._b; },
        set b(v) { setterHits += 1; this._b = v; },
        get c() { return this._c; },
        set c(v) { setterHits += 1; this._c = v; },
      };
      accObj.a &&= bump();
      accObj.b ||= bump();
      accObj.b ??= bump();
      accObj.c ??= 77;

      const numLit = 1_000_000 + 0b1010 + 0o755;
      const big = 10n + 20n;

      ({
        rightAssoc: 2 ** 3 ** 2,
        innerPow: box.v,
        expEvalCount,
        sideEffects,
        skippedOpt,
        receiverPreserved,
        optBracket,
        delMissing,
        delPresent,
        afterDeleteKeys: Object.keys(toDelete),
        nullish,
        setterHits,
        accState: [accObj._a, accObj._b, accObj._c],
        numLit,
        big,
      });
    `);
  });

  it("lowers static eval() and Function() inputs written in ES2015+ inside guest code", function () {
    assertParity(`
      const evalRes = eval("const x = 40; const add = (y = 2) => x + y; add();");
      const dynFn = new Function("a = 10", "const restFn = (...b) => a + b[0] + b[1]; return restFn(5, 7);");
      [evalRes, dynFn(undefined)];
    `);
  });

  it("preserves ES5.1 fast path, validates options.transform, exposes transformToES5, and rejects modules/async/generators clearly", function () {
    const es5Code = "var x = 10; function f(a) { return a + x; } f(5);";
    const autoES5 = compileProgram(es5Code, { runtimeModule });
    const disabledES5 = compileProgram(es5Code, { runtimeModule, transform: false });
    assert.strictEqual(autoES5.metadata.inputLanguage, "es5.1");
    assert.strictEqual(autoES5.metadata.transformed, false);
    assert.strictEqual(autoES5.code, disabledES5.code);

    const esnextCode = "const f = (x = 1) => x + 2; f();";
    const autoNext = compileProgram(esnextCode, { runtimeModule });
    assert.strictEqual(autoNext.metadata.inputLanguage, "esnext");
    assert.strictEqual(autoNext.metadata.transformed, true);

    assert.throws(
      () => compileProgram("const x = 1;", { runtimeModule, transform: false }),
      SyntaxError
    );
    assert.throws(
      () => compileProgram("const x = 1;", { runtimeModule, transform: "none" }),
      SyntaxError
    );

    assert.throws(() => normalizeTransformOptions(123), /Invalid transform option/);
    assert.throws(
      () => compileProgram("var x = 1;", { runtimeModule, transform: 123 }),
      /Invalid transform option/
    );

    assert.throws(
      () => compileProgram("import foo from 'bar';", { runtimeModule }),
      (err) => err instanceof SyntaxError && /ES module import\/export/.test(err.message)
    );
    assert.throws(
      () => compileProgram("export const a = 1;", { runtimeModule }),
      (err) => err instanceof SyntaxError && /ES module import\/export/.test(err.message)
    );
    assert.throws(
      () => compileProgram("async function f() { return 1; }", { runtimeModule }),
      (err) => err instanceof SyntaxError && /Async functions are not supported/.test(err.message)
    );
    assert.throws(
      () => compileProgram("function* g() { yield 1; }", { runtimeModule }),
      (err) =>
        err instanceof SyntaxError && /Generator functions are not supported/.test(err.message)
    );

    const lowered = transformToES5(`
      const sum = (a, b = 10, ...rest) => a + b + rest.length;
      class Box { constructor(v) { this.v = v; } }
      sum(1, undefined, new Box(2).v);
    `);
    assert.strictEqual(lowered.transformed, true);
    assert.strictEqual(lowered.inputLanguage, "esnext");
    assert.doesNotThrow(() => parseAcorn(lowered.code, { ecmaVersion: 5 }));
  });

  it("preserves original ES2015+ coordinates in Source Map v3, chains custom hook maps, and writes dumpDir/transformed.es5.js", function () {
    const modernSource = [
      "class Greeter {",
      "  constructor(prefix) {",
      "    this.prefix = prefix;",
      "  }",
      "  fail(name) {",
      "    const msg = `${this.prefix}: ${name}`;",
      '    throw new Error(msg || "boom");',
      "  }",
      "}",
      'const g = new Greeter("err");',
      "const { fail } = { fail: (n) => g.fail(n) };",
      'fail("guest");',
    ].join("\n");

    const mappedResult = compileProgram(modernSource, {
      runtimeModule,
      optimization: "O1",
      sourceMap: {
        mode: "external",
        sourceFile: "modern.js",
        generatedFile: "modern.cjs",
        sourcesContent: true,
      },
    });
    const decoded = new TraceMap(mappedResult.map);
    assert.strictEqual(decoded.sources.includes("modern.js"), true);
    assert.strictEqual(decoded.sourcesContent[decoded.sources.indexOf("modern.js")], modernSource);

    const throwLineFound = mappedResult.code.split("\n").some((line, index) => {
      if (!line.trim()) return false;
      const pos = originalPositionFor(decoded, { line: index + 1, column: line.search(/\S/) });
      return pos.source === "modern.js" && pos.line === 7;
    });
    assert.strictEqual(throwLineFound, true);

    // Custom transform hook returning { code, map } chains back to pre-hook line 3
    const originalHookInput = [
      "// header line 1",
      "// header line 2",
      'const boom = () => { throw new Error("hook-boom"); };',
      "boom();",
    ].join("\n");
    const hookRes = compileProgram(originalHookInput, {
      runtimeModule,
      optimization: "O1",
      transform(input, ctx) {
        assert.strictEqual(ctx.sourceFile, "input.ts");
        const emitted = 'const boom = () => { throw new Error("hook-boom"); };\nboom();';
        const gm = new GenMapping({ file: "hook.js" });
        addMapping(gm, {
          generated: { line: 1, column: 0 },
          source: "input.ts",
          original: { line: 3, column: 0 },
        });
        addMapping(gm, {
          generated: { line: 1, column: 21 },
          source: "input.ts",
          original: { line: 3, column: 21 },
        });
        addMapping(gm, {
          generated: { line: 2, column: 0 },
          source: "input.ts",
          original: { line: 4, column: 0 },
        });
        setSourceContent(gm, "input.ts", input);
        return { code: emitted, map: JSON.stringify(toEncodedMap(gm)) };
      },
      sourceMap: {
        mode: "external",
        sourceFile: "input.ts",
        generatedFile: "out.cjs",
        sourcesContent: true,
      },
    });
    const chainedDecoded = new TraceMap(hookRes.map);
    const chainedFound = hookRes.code.split("\n").some((line, index) => {
      if (!line.trim()) return false;
      const pos = originalPositionFor(chainedDecoded, {
        line: index + 1,
        column: line.search(/\S/),
      });
      return pos.source === "input.ts" && pos.line === 3;
    });
    assert.strictEqual(chainedFound, true);
    assert.strictEqual(
      chainedDecoded.sourcesContent[chainedDecoded.sources.indexOf("input.ts")],
      originalHookInput
    );

    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sablejs-transform-dump-"));
    try {
      const nextDir = path.join(dumpDir, "esnext");
      compileProgram("const x = 1; x;", { runtimeModule, dumpDir: nextDir });
      assert.strictEqual(fs.existsSync(path.join(nextDir, "transformed.es5.js")), true);

      const es5Dir = path.join(dumpDir, "es5");
      compileProgram("var x = 1; x;", { runtimeModule, dumpDir: es5Dir });
      assert.strictEqual(fs.existsSync(path.join(es5Dir, "transformed.es5.js")), false);
    } finally {
      fs.rmSync(dumpDir, { recursive: true, force: true });
    }
  });
});
