"use strict";

const assert = require("assert");
const path = require("path");
const { describe, it } = require("node:test");
const { compile: compileProgram } = require("../../src/compiler");
const { sourceMapURLComment, stripMarkers } = require("../../src/codegen/source-map");
const { TraceMap, originalPositionFor } = require("@jridgewell/trace-mapping");

const runtimeModule = path.resolve(__dirname, "../../src/runtime");
const OPTIMIZATION_LEVELS = ["O0", "O1", "O2", "Os"];

// A source exercising straight-line code, nested lexical functions, if/else,
// every loop form, switch, try/catch/finally, labelled exits, with, and a
// thrown runtime error. The statement lines are exactly the lines that carry
// a LOC operation in the HIR.
const STATEMENT_SOURCE = [
  "var x = 1;",
  "function f(a) {",
  "  return a + x;",
  "}",
  "var y = f(2);",
  "if (y > 1) {",
  "  x = y * 2;",
  "} else {",
  "  x = 0;",
  "}",
  "switch (x) {",
  "case 2: x = 1; break;",
  "default: x = 0;",
  "}",
  "for (var i = 0; i < 3; i += 1) x += i;",
  "while (x > 0) x -= 1;",
  "do { x += 1; } while (x < 10);",
  "try { x += 1; } catch (e) { x = 0; } finally { x = 1; }",
  "with (x) { x = 2; }",
  "outer: for (var j = 0; j < 2; j += 1) { if (j) break outer; }",
  'var boom = (function () { throw new Error("boom"); })();',
].join("\n");

// The statement lines of STATEMENT_SOURCE that carry a LOC op AND have
// generated code beneath that marker. Line 2 (the function declaration) maps
// through the scope entry marker, which pins the generated factory header to
// the declaration's own LOC — a devtools breakpoint on the declaration lands
// on the factory line instead of the first body statement. Line 8 (the else
// header) carries a LOC whose generated code starts under a different active
// location, so — exactly like the runtime $f.line tracking — no generated
// line inherits it. This is the statement-level v1 contract; a line is
// mapped when a statement's code appears after its LOC.
const STATEMENT_LINES = [1, 2, 3, 5, 6, 7, 9, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21];

function compile(source, options = {}) {
  return compileProgram(source, options);
}

function load(result) {
  const generatedModule = { exports: {} };
  new Function("require", "module", "exports", result.code)(
    require,
    generatedModule,
    generatedModule.exports
  );
  return generatedModule.exports;
}

function run(source, options = {}) {
  const program = load(compile(source, { runtimeModule, ...options }));
  return program.createInstance({}).run();
}

// Decodes the map and returns one entry per non-empty generated line:
// { generated, source, line, column } where line/column are null when the
// line is unmapped. Column queries the first non-whitespace character, which
// is where the statement-level segments land.
function mappedLines(code, map) {
  const decoded = new TraceMap(map);
  const lines = code.split("\n");
  const result = [];
  lines.forEach((line, index) => {
    const column = line.search(/\S/);
    if (column < 0) return;
    const position = originalPositionFor(decoded, { line: index + 1, column });
    result.push({
      generated: index + 1,
      source: position.source,
      line: position.line == null ? null : position.line,
      column: position.column == null ? null : position.column,
    });
  });
  return result;
}

function mappedSourceLines(code, map) {
  return new Set(
    mappedLines(code, map)
      .filter((entry) => entry.line != null)
      .map((entry) => entry.line)
  );
}

describe("generated-code source maps", function () {
  it("emits valid v3 maps at every optimization level in both security modes", function () {
    for (const optimization of OPTIMIZATION_LEVELS) {
      for (const security of ["sandbox", "trusted"]) {
        const result = compile(STATEMENT_SOURCE, { optimization, security, sourceMap: true });
        assert.ok(result.map, `${optimization}/${security} map missing`);
        const map = JSON.parse(result.map);
        assert.strictEqual(map.version, 3);
        assert.strictEqual(map.file, "generated.cjs");
        assert.deepStrictEqual(map.sources, ["<sablejs-input>"]);
        assert.deepStrictEqual(map.names, []);
        assert.ok(map.mappings.length > 0, `${optimization}/${security} mappings empty`);
        assert.ok(!("sourcesContent" in map), `${optimization}/${security} leaks source content`);
        // No private markers, control bytes, or absolute host paths escape.
        assert.ok(
          !result.code.includes("") && !result.code.includes(""),
          `${optimization}/${security} left a private marker in code`
        );
        assert.ok(!result.code.includes(process.cwd()), `${optimization}/${security} leaks cwd`);
      }
    }
  });

  it("maps every statement line at all four optimization levels", function () {
    for (const optimization of OPTIMIZATION_LEVELS) {
      const result = compile(STATEMENT_SOURCE, { optimization, sourceMap: true });
      const mapped = mappedSourceLines(result.code, result.map);
      for (const line of STATEMENT_LINES) {
        assert.ok(mapped.has(line), `${optimization} did not map statement line ${line}`);
      }
    }
  });

  it("maps nested lexical function bodies to their own source lines", function () {
    const result = compile(STATEMENT_SOURCE, { optimization: "O2", sourceMap: true });
    const mapped = mappedSourceLines(result.code, result.map);
    assert.ok(mapped.has(3), "function body line not mapped");
    const nested = compile(
      "function outer() {\n  function inner() {\n    return 7;\n  }\n  return inner();\n}\nvar r = outer();",
      { optimization: "O2", sourceMap: true }
    );
    const nestedMapped = mappedSourceLines(nested.code, nested.map);
    assert.ok(nestedMapped.has(3), "inner function body line not mapped");
    assert.ok(nestedMapped.has(5), "outer body line not mapped");
  });

  it("maps function declaration lines to their generated factory headers", function () {
    // A devtools breakpoint on a guest function declaration must resolve to
    // the generated factory line (scope entry marker), at every level.
    for (const optimization of OPTIMIZATION_LEVELS) {
      const result = compile(STATEMENT_SOURCE, { optimization, sourceMap: true });
      const mapped = mappedLines(result.code, result.map);
      const factory = mapped.find(
        (entry) => entry.source === "<sablejs-input>" && entry.line === 2
      );
      assert.ok(factory, `${optimization}: function declaration line 2 has no factory mapping`);
      const factoryLine = result.code.split("\n")[factory.generated - 1];
      assert.ok(
        factoryLine.trimStart().startsWith("function $exec"),
        `${optimization}: generated:${factory.generated} is not a $exec factory: ${factoryLine
          .trim()
          .slice(0, 40)}`
      );
      assert.ok(
        mapped.some((entry) => entry.line === 3),
        `${optimization}: body statement line 3 must stay mapped`
      );
    }
  });

  it("keeps module prologue, factories, scope table, and exports unmapped", function () {
    const result = compile(STATEMENT_SOURCE, { optimization: "O2", sourceMap: true });
    const lines = result.code.split("\n");
    const entries = mappedLines(result.code, result.map);
    const unmappedPrefix = entries.filter((entry) => entry.generated <= 5);
    assert.ok(
      unmappedPrefix.every((entry) => entry.line == null),
      "module prologue lines must be unmapped"
    );
    const exportsIndex = lines.findIndex((line) => line.includes("module.exports"));
    const exportsEntry = entries.find((entry) => entry.generated === exportsIndex + 1);
    assert.ok(exportsEntry && exportsEntry.line == null, "module.exports must be unmapped");
  });

  it("maps folded constants, native literals, and loop bodies to their statement", function () {
    const folded = compile("var x = 1 + 2;\nvar y = { a: 1, b: [2, 3] };\nvar z = [4, 5];", {
      optimization: "O2",
      sourceMap: true,
    });
    const foldedLines = folded.code.split("\n");
    const foldedEntries = mappedLines(folded.code, folded.map);
    // O2 folds `1 + 2` into the native assignment `const $v0_1 = 3;`, which
    // must inherit the statement's line rather than the expression's.
    const literal = foldedEntries.find((entry) =>
      foldedLines[entry.generated - 1].includes("= 3;")
    );
    assert.ok(literal && literal.line === 1, "folded literal did not inherit statement line 1");
    const objectLiteral = foldedEntries.find((entry) =>
      foldedLines[entry.generated - 1].includes('"b": [2, 3]')
    );
    assert.ok(
      objectLiteral && objectLiteral.line === 2,
      "native object literal did not inherit line 2"
    );
    const arrayLiteral = foldedEntries.find((entry) =>
      foldedLines[entry.generated - 1].includes("const $v0_3 = [4, 5]")
    );
    assert.ok(
      arrayLiteral && arrayLiteral.line === 3,
      "native array literal did not inherit line 3"
    );
    const loops = compile("var s = 0;\nfor (var i = 0; i < 100; i += 1) { s += i; }\nvar t = s;", {
      optimization: "O2",
      sourceMap: true,
    });
    const loopMapped = mappedSourceLines(loops.code, loops.map);
    assert.ok(loopMapped.has(2), "loop body statement not mapped");
  });

  it("produces identical code and maps on repeated compiles", function () {
    for (const optimization of ["O2", "Os"]) {
      const first = compile(STATEMENT_SOURCE, { optimization, sourceMap: { sourceFile: "a.js" } });
      const second = compile(STATEMENT_SOURCE, { optimization, sourceMap: { sourceFile: "a.js" } });
      assert.strictEqual(first.code, second.code, `${optimization} code not deterministic`);
      assert.strictEqual(first.map, second.map, `${optimization} map not deterministic`);
    }
  });

  it("keeps Os candidate selection on marker-free bytes", function () {
    const result = compile(STATEMENT_SOURCE, { optimization: "Os", sourceMap: true });
    const candidates = result.stats.codegen.sizeOptimization.costModel.candidates;
    assert.strictEqual(candidates.length, 2);
    // Candidate bytes must equal the marker-free code length: markers and
    // map comments never participate in the size cost model. Replicate the
    // compile pipeline (lowering, optimization, codegen) so the recomputation
    // sees the exact HIR the cost model measured.
    const { generate } = require("../../src/codegen");
    const { optimizeProgram } = require("../../src/backend/optimizer");
    const { lowerToHIR } = require("../../src/compiler");
    const hir = lowerToHIR(STATEMENT_SOURCE, {});
    optimizeProgram(hir, "Os", { retainSourceLocations: true });
    const candidateBytes = [false, true].map((perScopeFactories) =>
      Buffer.byteLength(
        stripMarkers(
          generate(hir, {
            optimization: "Os",
            security: "sandbox",
            perScopeFactories,
            retainSourceLocations: true,
            mapSettings: { mode: "external" },
          })
        )
      )
    );
    assert.deepStrictEqual(
      candidates.map((candidate) => candidate.bytes),
      candidateBytes
    );
    // The marker-free Os build must select the same strategy as the map-off build.
    const off = compile(STATEMENT_SOURCE, { optimization: "Os" });
    assert.strictEqual(
      off.stats.codegen.sizeOptimization.costModel.selected,
      result.stats.codegen.sizeOptimization.costModel.selected
    );
  });

  it("appends an inline data URL that round-trips through the map", function () {
    const result = compile(STATEMENT_SOURCE, { optimization: "O2", sourceMap: "inline" });
    const comment = result.code.trimEnd().split("\n").pop();
    assert.ok(
      comment.startsWith("//# sourceMappingURL=data:application/json;charset=utf-8;base64,")
    );
    const base64 = comment.split(",")[1];
    const map = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
    assert.deepStrictEqual(map, JSON.parse(result.map));
    // The inline artifact still runs. STATEMENT_SOURCE ends with a throwing
    // IIFE, so compare the runtime error both paths surface.
    assert.throws(() => run(STATEMENT_SOURCE, { optimization: "O2", sourceMap: "inline" }), /boom/);
    assert.throws(() => run(STATEMENT_SOURCE, { optimization: "O2" }), /boom/);
  });

  it("appends an external URL comment only when sourceMapURL is supplied", function () {
    const without = compile(STATEMENT_SOURCE, { optimization: "O2", sourceMap: true });
    assert.ok(!without.code.includes("sourceMappingURL"), "no URL comment without sourceMapURL");
    const withURL = compile(STATEMENT_SOURCE, {
      optimization: "O2",
      sourceMap: { sourceMapURL: "rules.cjs.map" },
    });
    assert.ok(
      withURL.code.trimEnd().endsWith(sourceMapURLComment("rules.cjs.map")),
      "URL comment not appended"
    );
    assert.strictEqual(
      withURL.code,
      stripMarkers(without.code) + "\n" + sourceMapURLComment("rules.cjs.map")
    );
  });

  it("embeds sourcesContent only when explicitly requested", function () {
    const source = "var a = 1;\nvar b = a + 2;\n";
    const omitted = compile(source, { optimization: "O2", sourceMap: true });
    assert.ok(!("sourcesContent" in JSON.parse(omitted.map)));
    const embedded = compile(source, {
      optimization: "O2",
      sourceMap: { sourcesContent: true },
    });
    assert.deepStrictEqual(JSON.parse(embedded.map).sourcesContent, [source]);
  });

  it("uses caller-provided logical filenames and never infers paths", function () {
    const result = compile(STATEMENT_SOURCE, {
      optimization: "O2",
      sourceMap: {
        sourceFile: "rules/input.js",
        generatedFile: "rules.cjs",
      },
    });
    const map = JSON.parse(result.map);
    assert.strictEqual(map.file, "rules.cjs");
    assert.deepStrictEqual(map.sources, ["rules/input.js"]);
    assert.ok(!result.map.includes(process.cwd()), "map leaks an absolute path");
    assert.ok(result.metadata.sourceMap, "normalized settings missing from metadata");
    assert.deepStrictEqual(result.metadata.sourceMap, {
      mode: "external",
      sourceFile: "rules/input.js",
      generatedFile: "rules.cjs",
      sourceMapURL: undefined,
      sourcesContent: false,
    });
    assert.ok(!("map" in result.metadata), "map contents must not be copied into metadata");
  });

  it("maps static eval and dynamic Function bodies to their virtual sources", function () {
    const source = [
      'var g = Function("return 7;");',
      "var r = g();",
      'var e = eval("var z = 9; z + 1;");',
      "var done = r + e;",
    ].join("\n");
    for (const optimization of OPTIMIZATION_LEVELS) {
      const result = compile(source, { optimization, sourceMap: true });
      const map = JSON.parse(result.map);
      // Synthetic bodies get stable virtual identities derived from the root
      // source name; their call sites map to the root file.
      assert.deepStrictEqual(
        map.sources,
        ["<sablejs-input>", "<sablejs-input>#eval-1", "<sablejs-input>#dynamic-1"],
        `${optimization} virtual sources missing`
      );
      const entries = mappedLines(result.code, result.map);
      const rootLines = new Set(
        entries.filter((entry) => entry.source === "<sablejs-input>").map((entry) => entry.line)
      );
      assert.ok(rootLines.has(1) && rootLines.has(3), `${optimization} lost call-site mappings`);
      // eval("var z = 9; z + 1;") — both statements map into the eval source
      // at their real columns; the dynamic body maps to its own source.
      const evalEntries = entries.filter((entry) => entry.source === "<sablejs-input>#eval-1");
      assert.ok(evalEntries.length > 0, `${optimization} eval body unmapped`);
      assert.ok(
        evalEntries.some((entry) => entry.line === 1 && entry.column === 0),
        `${optimization} eval first statement lost`
      );
      assert.ok(
        evalEntries.some((entry) => entry.line === 1 && entry.column === 11),
        `${optimization} eval second statement lost its column`
      );
      const dynamicEntries = entries.filter(
        (entry) => entry.source === "<sablejs-input>#dynamic-1"
      );
      assert.ok(
        dynamicEntries.some((entry) => entry.line === 1 && entry.column === 0),
        `${optimization} dynamic body unmapped`
      );
    }
  });

  it("translates strict eval prefixes and multi-line dynamic bodies", function () {
    const strictEval = compile(
      "function s() {\n  'use strict';\n  return eval(\"var q = 1; q;\");\n}\ns();",
      { optimization: "O2", sourceMap: { sourcesContent: true } }
    );
    const strictMap = JSON.parse(strictEval.map);
    assert.deepStrictEqual(strictMap.sources, ["<sablejs-input>", "<sablejs-input>#eval-1"]);
    // sourcesContent embeds the guest-recognizable eval string — not the
    // compiler-injected `'use strict';` prefix.
    assert.deepStrictEqual(strictMap.sourcesContent, [
      "function s() {\n  'use strict';\n  return eval(\"var q = 1; q;\");\n}\ns();",
      "var q = 1; q;",
    ]);
    // The injected `'use strict';` prefix is 13 columns; the parsed statement
    // starts at column 13 of the synthetic text, so the guest-recognizable
    // eval source starts it at column 0.
    const strictEntries = mappedLines(strictEval.code, strictEval.map).filter(
      (entry) => entry.source === "<sablejs-input>#eval-1"
    );
    assert.ok(
      strictEntries.some((entry) => entry.line === 1 && entry.column === 0),
      "strict eval first statement not translated to column 0"
    );
    assert.ok(
      strictEntries.some((entry) => entry.line === 1 && entry.column === 11),
      "strict eval second statement wrong column"
    );

    const multi = compile('var f = Function("a", "var b = a * 2;\\nreturn b;");\nf(3);', {
      optimization: "O2",
      sourceMap: true,
    });
    const multiEntries = mappedLines(multi.code, multi.map).filter(
      (entry) => entry.source === "<sablejs-input>#dynamic-1"
    );
    assert.ok(
      multiEntries.some((entry) => entry.line === 1 && entry.column === 0),
      "dynamic body line 1 not mapped"
    );
    assert.ok(
      multiEntries.some((entry) => entry.line === 2 && entry.column === 0),
      "dynamic body line 2 lost its line position"
    );

    // Multi-line parameter strings (a param literal may itself contain
    // newlines) shift the parsed body by the wrapper's extra lines; the
    // prefix geometry must count them so the body still starts at line 1
    // column 0 of the virtual source at every optimization level.
    for (const level of OPTIMIZATION_LEVELS) {
      const multiParam = compile('var f = Function("a,\\n b", "return a + b;");\nf(3, 4);', {
        optimization: level,
        sourceMap: true,
      });
      const multiParamEntries = mappedLines(multiParam.code, multiParam.map).filter(
        (entry) => entry.source === "<sablejs-input>#dynamic-1"
      );
      assert.ok(
        multiParamEntries.some((entry) => entry.line === 1 && entry.column === 0),
        `level ${level}: multi-line params lost the body start position`
      );
    }
  });

  it("writes code.js.map through custom dumpDir adapters without path leakage", function () {
    const files = {};
    const dumpFs = {
      mkdirSync() {},
      writeFileSync(file, text) {
        files[file] = text;
      },
      join(...parts) {
        return parts.join("/");
      },
    };
    const result = compile(STATEMENT_SOURCE, {
      optimization: "Os",
      sourceMap: { sourceFile: "rules/input.js" },
      dumpDir: "/absolute/dump",
      fs: dumpFs,
    });
    assert.ok(files["/absolute/dump/code.js.map"], "code.js.map not written");
    assert.ok(files["/absolute/dump/code.js"], "code.js not written");
    assert.ok(
      !files["/absolute/dump/code.js"].includes("/absolute"),
      "dump leaks the absolute dumpDir"
    );
    assert.ok(!files["/absolute/dump/code.js"].includes(""), "dump contains a private marker");
    assert.ok(
      files["/absolute/dump/code.js"].trimEnd().endsWith(sourceMapURLComment("code.js.map")),
      "dumped code.js must use code.js.map as its URL"
    );
    assert.ok(!result.code.includes("code.js.map"), "returned artifact must keep logical names");
    // The dumped map's `file` field describes the artifact it sits next to —
    // code.js — while the returned map keeps the caller's logical names.
    assert.strictEqual(
      JSON.parse(files["/absolute/dump/code.js.map"]).file,
      "code.js",
      "dump map file must match the dumped artifact name"
    );
    assert.strictEqual(
      JSON.parse(result.map).file,
      "generated.cjs",
      "returned map must keep the caller's generatedFile"
    );
    // Inline mode embeds the data URL in the dump but still writes the map.
    const inlineFiles = {};
    const inlineFs = {
      mkdirSync() {},
      writeFileSync(file, text) {
        inlineFiles[file] = text;
      },
      join(...parts) {
        return parts.join("/");
      },
    };
    compile(STATEMENT_SOURCE, {
      optimization: "O2",
      sourceMap: "inline",
      dumpDir: "out",
      fs: inlineFs,
    });
    assert.ok(inlineFiles["out/code.js.map"], "inline dump must also write code.js.map");
    assert.ok(
      inlineFiles["out/code.js"].includes("data:application/json"),
      "inline dump must embed the data URL"
    );
  });

  it("aligns sourcesContent with the map's own source order", function () {
    // GenMapping assigns source indices by first-segment order, which is not
    // guaranteed to match the registry order encoded in the markers (a
    // nested eval's factory can be emitted before the root eval's). The
    // serialized sources array must be GenMapping's own, and sourcesContent
    // must follow it by name — otherwise a nested eval's segments resolve to
    // the root eval's identity, a legal but wrong map.
    const source = [
      'var x = eval("1");',
      "function g() {",
      '  return eval("2");',
      "}",
      "g();",
    ].join("\n");
    for (const optimization of OPTIMIZATION_LEVELS) {
      const result = compile(source, {
        optimization,
        sourceMap: { sourceFile: "root.js", generatedFile: "out.cjs", sourcesContent: true },
      });
      const map = JSON.parse(result.map);
      const evalIndex1 = map.sources.indexOf("root.js#eval-1");
      const evalIndex2 = map.sources.indexOf("root.js#eval-2");
      assert.ok(evalIndex1 >= 0 && evalIndex2 >= 0, `${optimization}: virtual sources missing`);
      assert.strictEqual(
        map.sourcesContent[evalIndex1],
        "1",
        `${optimization}: root eval content misaligned`
      );
      assert.strictEqual(
        map.sourcesContent[evalIndex2],
        "2",
        `${optimization}: nested eval content misaligned`
      );
      // Each eval's own factory must resolve into its own virtual source.
      const decoded = new TraceMap(result.map);
      const bySource = { "root.js#eval-1": 0, "root.js#eval-2": 0 };
      result.code.split("\n").forEach((line, index) => {
        const column = line.search(/\S/);
        if (column < 0) return;
        const position = originalPositionFor(decoded, { line: index + 1, column });
        if (position.source && bySource[position.source] !== undefined) {
          bySource[position.source] += 1;
        }
      });
      assert.ok(bySource["root.js#eval-1"] > 0, `${optimization}: root eval has no mapped lines`);
      assert.ok(bySource["root.js#eval-2"] > 0, `${optimization}: nested eval has no mapped lines`);
    }
  });

  it("maps functions declared inside static eval into the virtual source", function () {
    // A lexical descendant of a synthetic scope keeps LOC offsets relative
    // to the same parsed text: it must inherit the nearest synthetic source
    // identity and descriptor, never map into the root file.
    const source = 'eval("function inside(){\\n  return 41;\\n}\\ninside() + 1;");';
    for (const optimization of OPTIMIZATION_LEVELS) {
      const result = compile(source, {
        optimization,
        sourceMap: { sourceFile: "root.js", generatedFile: "out.cjs", sourcesContent: true },
      });
      const decoded = new TraceMap(result.map);
      const positions = [];
      result.code.split("\n").forEach((line, index) => {
        const column = line.search(/\S/);
        if (column < 0) return;
        const position = originalPositionFor(decoded, { line: index + 1, column });
        if (position.source && position.line != null) {
          positions.push({ source: position.source, line: position.line });
        }
      });
      assert.ok(
        positions.some((p) => p.source === "root.js#eval-1" && p.line === 2),
        `${optimization}: inside body (eval line 2) must map into the virtual source`
      );
      assert.ok(
        positions.some((p) => p.source === "root.js#eval-1"),
        `${optimization}: inside factory must map into the virtual source`
      );
      assert.ok(
        !positions.some((p) => p.source === "root.js" && p.line >= 2),
        `${optimization}: eval-internal lines must not map to the root file`
      );
    }
  });

  it("base64-encodes inline maps without TextEncoder (btoa fallback)", function () {
    // The btoa branch chunks bytes with subarray; encodeUtf8 must return a
    // typed array there, or an embedded host with btoa but no TextEncoder
    // crashes on the inline data URL.
    const savedBuffer = globalThis.Buffer;
    const savedEncoder = globalThis.TextEncoder;
    let base64;
    try {
      globalThis.Buffer = undefined;
      globalThis.TextEncoder = undefined;
      const result = compile('var x = "中文"; x;', {
        sourceMap: { mode: "inline", sourcesContent: true },
      });
      base64 = result.code.split("data:application/json;charset=utf-8;base64,")[1];
      assert.ok(base64, "inline data URL missing");
    } finally {
      globalThis.Buffer = savedBuffer;
      globalThis.TextEncoder = savedEncoder;
    }
    const decoded = Buffer.from(base64, "base64").toString("utf8");
    assert.ok(
      decoded.includes('"sources"') && decoded.includes("中文"),
      "inline map content did not round-trip"
    );
  });

  it("rejects malformed sourceMap options during normalization", function () {
    const cases = [
      [{ sourceMap: { mode: "browser" } }, /sourceMap mode/],
      [{ sourceMap: { sourceFile: "" } }, /sourceFile/],
      [{ sourceMap: { sourceFile: 5 } }, /sourceFile/],
      [{ sourceMap: { generatedFile: "" } }, /generatedFile/],
      [{ sourceMap: { sourceMapURL: "a\nb" } }, /sourceMapURL/],
      [{ sourceMap: { sourceMapURL: "a\rb" } }, /sourceMapURL/],
      [{ sourceMap: { sourceMapURL: "" } }, /sourceMapURL/],
      [{ sourceMap: { sourcesContent: "true" } }, /sourcesContent/],
      [{ sourceMap: 42 }, /sourceMap/],
      [{ sourceMap: [] }, /sourceMap/],
      [{ sourceMap: "external-only" }, /sourceMap/],
    ];
    for (const [options, pattern] of cases) {
      assert.throws(() => compile("var x = 1;", options), pattern, JSON.stringify(options));
    }
  });

  it("suppresses runtime line writes in map-only mode and keeps both when requested", function () {
    const mapOnly = compile(STATEMENT_SOURCE, { optimization: "O2", sourceMap: true });
    assert.ok(
      !mapOnly.code.includes("$f.line"),
      "map-only mode must not pay runtime location cost"
    );
    // Both modes requested: every level and lowering path (including the
    // stack-to-local fallback, which is what O0/O1 and stackToLocal:false
    // use) must emit the runtime write alongside the compile-time marker.
    for (const optimization of OPTIMIZATION_LEVELS) {
      for (const extra of [{}, { stackToLocal: false }]) {
        const both = compile(STATEMENT_SOURCE, {
          optimization,
          sourceMap: true,
          preserveSourceLocations: true,
          ...extra,
        });
        assert.ok(
          both.code.includes("$f.line"),
          `${optimization}${
            extra.stackToLocal === false ? "/no-stackToLocal" : ""
          }: preserveSourceLocations lost the runtime write`
        );
        assert.ok(both.map.length > 0, `${optimization}: map missing`);
        assert.ok(!both.code.includes(""), `${optimization}: marker leaked`);
      }
    }
  });

  it("leaves generated code and compiler statistics unchanged when disabled", function () {
    const baseline = compile(STATEMENT_SOURCE, { optimization: "Os" });
    const disabled = compile(STATEMENT_SOURCE, { optimization: "Os", sourceMap: false });
    assert.strictEqual(disabled.code, baseline.code, "map-off code changed");
    assert.strictEqual(disabled.map, undefined);
    // Pass timings are wall-clock noise; compare the structural statistics.
    const stable = (stats) =>
      JSON.parse(JSON.stringify(stats, (key, value) => (key === "durationMs" ? undefined : value)));
    assert.deepStrictEqual(
      stable(disabled.stats),
      stable(baseline.stats),
      "map-off statistics changed"
    );
    assert.strictEqual(disabled.metadata.sourceMap, undefined);
    const enabled = compile(STATEMENT_SOURCE, { optimization: "Os", sourceMap: true });
    assert.strictEqual(
      enabled.stats.codegen.sizeOptimization.outputBytes,
      Buffer.byteLength(enabled.code),
      "outputBytes must measure the final artifact"
    );
    // Runtime behavior must be identical with and without the map: the source
    // ends with a throwing IIFE, so both paths surface the same runtime error.
    assert.throws(() => run(STATEMENT_SOURCE, { optimization: "Os" }), /boom/);
    assert.throws(() => run(STATEMENT_SOURCE, { optimization: "Os", sourceMap: true }), /boom/);
  });

  it('marks sourceMap:true, sourceMap:"external", and sourceMap:"inline" as documented shorthands', function () {
    const external = compile("var x = 1;", { sourceMap: true });
    assert.strictEqual(JSON.parse(external.map).file, "generated.cjs");
    assert.ok(!external.code.includes("sourceMappingURL"));
    const explicit = compile("var x = 1;", { sourceMap: "external" });
    assert.strictEqual(explicit.map, external.map);
    const inline = compile("var x = 1;", { sourceMap: "inline" });
    assert.ok(inline.code.includes("data:application/json"));
  });
});
