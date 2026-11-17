"use strict";

const assert = require("assert");
const path = require("path");
const vm = require("vm");
const { describe, it } = require("node:test");
const { compile } = require("../../src/compiler");

const runtimeModule = path.resolve(__dirname, "../../src/runtime");
const LEVELS = ["O0", "O1", "O2", "Os"];
const SECURITY_MODES = ["trusted", "sandbox"];

function execute(source, options = {}, globals = {}) {
  const compiled = compile(source, { runtimeModule, ...options });
  const generatedModule = { exports: {} };
  new Function("require", "module", "exports", compiled.code)(
    require,
    generatedModule,
    generatedModule.exports
  );
  const instance = generatedModule.exports.createInstance({ globals });
  try {
    return { compiled, value: instance.run() };
  } finally {
    instance.dispose();
  }
}

function nativeCompletion(source, globals = {}) {
  return vm.runInNewContext(source, globals);
}

function chainedConditionalSource(count) {
  let source = "function f(){var x=42;";
  for (let index = 0; index < count; index += 1) {
    source += `if(g[${index}]){}`;
  }
  return `${source}return x;}f();`;
}

function nestedFinallySource(depth) {
  function body(level) {
    if (level === depth) return "x=10;throw 0;";
    const outerReturn = level === 0 ? "return x;" : "";
    return `try{${body(level + 1)}}finally{x=x+1;${outerReturn}}`;
  }
  return `function f(){var x=0;${body(0)}}f();`;
}

describe("CFG/SSA hardening regressions", function() {
  it("uses O1 as the implicit containment profile", function() {
    const result = compile("1 + 2;", { runtimeModule });
    assert.equal(result.optimization, "O1");
    assert.equal(result.stats.level, "O1");
    assert.equal(result.metadata.optimize, "O1");
    assert.equal(result.metadata.optimizerPipelineVersion, result.stats.pipelineVersion);
    assert.deepStrictEqual(
      result.metadata.optimizerPasses,
      result.stats.passes.map((pass) => pass.name)
    );
  });

  it("records attributable pass-level A/B kill switches", function() {
    const options = {
      optimization: "O2",
      security: "trusted",
      sparseConditionalConstantPropagation: false,
      copyPropagation: false,
      deadCodeElimination: false,
      loopInvariantCodeMotion: false,
      globalValueNumbering: false,
      deadStoreElimination: false,
    };
    const result = execute(
      "function f(a){var x=1;if(a){x=2;}return x;}f(true);",
      options
    );
    const expected = [
      "ssa-sccp",
      "ssa-copy-propagation",
      "loop-invariant-code-motion",
      "global-value-numbering",
      "dead-store-elimination",
      "ssa-dead-code-elimination",
    ];
    assert.equal(result.value, 2);
    assert.deepStrictEqual(result.compiled.stats.disabledPasses, expected);
    assert.deepStrictEqual(result.compiled.metadata.optimizerDisabledPasses, expected);
    assert(result.compiled.metadata.optimizerPasses.includes("ssa-sccp"));
    assert.equal(result.compiled.stats.sccp, undefined);
    assert.equal(result.compiled.stats.copyPropagation, undefined);
    assert.equal(result.compiled.stats.globalValueNumbering, undefined);
    assert.equal(result.compiled.stats.deadStoreElimination, undefined);
  });

  it("rebinds adjacent SCCP branch proofs after CFG predecessor folding", function() {
    const source = "function f(){var x=(true||true)?{a:1}:false;return x.a;}f();";
    for (const optimization of LEVELS) {
      for (const security of SECURITY_MODES) {
        const result = execute(source, { optimization, security, includeHIR: true });
        assert.equal(result.value, 1, `${optimization}/${security}`);
        if (optimization !== "O0") {
          const proofs = result.compiled.hir.scopes.flatMap((scope) => scope.instructions)
            .filter((instruction) => instruction.optimizedBranchProof &&
              instruction.optimizedBranchProof.kind === "sccp");
          assert(proofs.length >= 2, `${optimization}/${security}`);
          assert(proofs.every((instruction) => instruction.optimizedBranchProof.inputs.every(
            (input) => typeof input.valueId === "string"
          )));
        }
      }
    }
  });

  it("keeps deep-CFG stores live across the former DSE convergence cliff", function() {
    const counts = process.env.sablejs_deep_cfg === "1"
      ? [1, 2, 127, 128, 129, 255, 256, 257, 512, 1024]
      : [127, 128, 129, 255, 256, 257];
    for (const count of counts) {
      const source = chainedConditionalSource(count);
      const expected = nativeCompletion(source, { g: {} });
      assert.equal(expected, 42);
      for (const optimization of LEVELS) {
        for (const security of SECURITY_MODES) {
          const result = execute(source, { optimization, security }, { g: {} });
          assert.equal(result.value, expected, `${count}/${optimization}/${security}`);
          if (optimization === "O2" || optimization === "Os") {
            assert.equal(result.compiled.stats.deadStoreElimination.bailedOutSlots, 0);
          }
        }
      }
    }
  });

  it("keeps liveness correct across joins, loops, and multiple exits", function() {
    const cases = [
      "function f(a,b){var x=1;if(a){x=2;}if(b){return x;}return x+1;}f(true,false);",
      "function f(n){var x=3;while(n--){if(n===2){x=9;}}return x;}f(5);",
      "function f(a){var x=1;do{x=x+1;if(a&&x>2){return x;}}while(x<4);return x;}f(false);",
      "function f(a){var x=1;switch(a){case 0:x=2;break;case 1:return x;default:x=4;}return x;}f(0);",
    ];
    cases.forEach((source, index) => {
      const expected = nativeCompletion(source);
      for (const optimization of LEVELS) {
        for (const security of SECURITY_MODES) {
          assert.equal(
            execute(source, { optimization, security }).value,
            expected,
            `${index}/${optimization}/${security}`
          );
        }
      }
    });
  });

  it("fails DSE closed when a diagnostic work budget is exhausted", function() {
    const source = "function f(a){var x=1;x=a;return x;}f(5);";
    const result = execute(source, {
      optimization: "O2",
      security: "trusted",
      deadStoreEliminationBudget: 0,
    });
    assert.equal(result.value, 5);
    assert.equal(result.compiled.stats.deadStoreElimination.storesEliminated, 0);
    assert(result.compiled.stats.deadStoreElimination.bailedOutSlots > 0);
    assert(result.compiled.stats.deadStoreElimination.bailouts.every(
      (entry) => entry.reason === "budget-exhausted"
    ));
  });

  it("rolls back a DCE candidate whose freshly rebuilt MIR is inconsistent", function() {
    const source = "var input={length:9};function f(a,b){var v0=3;" +
      "var v1=input[0];var v2=2;var v3=false;if(Object.keys(input).length){" +
      "v1=(input.self===input>\" \");}else{v2=[4,-3,9];}" +
      "var b={a:void 0,b:1};return 2;}f();";
    for (const security of SECURITY_MODES) {
      const result = execute(source, { optimization: "O2", security });
      assert.equal(result.value, 2);
      assert.deepStrictEqual(result.compiled.metadata.optimizerBailouts, [{
        pass: "ssa-dead-code-elimination",
        reason: "candidate-mir-invalid",
        scopeId: 1,
        diagnosticCode: "mir-stack-height-mismatch",
      }]);
    }
  });

  it("preserves writes observed by throw-to-finally completion flow", function() {
    const source =
      "function f(){var x=1,y=x;try{x=2;throw 0;}finally{return x;}} f();";
    const expected = nativeCompletion(source);
    assert.equal(expected, 2);
    for (const optimization of LEVELS) {
      for (const security of SECURITY_MODES) {
        const result = execute(source, { optimization, security });
        assert.equal(result.value, expected, `${optimization}/${security}`);
        if (optimization === "O2") {
          assert(result.compiled.stats.globalValueNumbering.semanticScopes > 0);
          assert.equal(result.compiled.stats.globalValueNumbering.scopesSkipped, 0);
        }
      }
    }
  });

  it("allows GVN in catch-free finally only when every semantic path is unclobbered", function() {
    const safe = execute(
      "function f(flag){var x=7,y=x;try{if(flag){y=y+1;}}finally{return x;}}f(true);",
      { optimization: "O2", security: "trusted", includeHIR: true }
    );
    assert.equal(safe.value, 7);
    assert(safe.compiled.stats.globalValueNumbering.crossBlockLoadsEliminated > 0);
    const scope = safe.compiled.hir.scopes.find((candidate) => candidate.parentId !== null);
    const region = scope.controlRegions.find((candidate) => candidate.kind === "TryFinally");
    const finalizerLoad = scope.instructions.find((instruction) =>
      instruction.op === "GETLOCAL" &&
      region.finalizerStart <= instruction.offset && instruction.offset < region.finalizerEnd
    );
    assert.equal(finalizerLoad.optimized.kind, "reuse");

    const clobbered = execute(
      "function f(){var x=1,y=x;try{x=2;throw 0;}finally{return x;}}f();",
      { optimization: "O2", security: "trusted", includeHIR: true }
    );
    const clobberedScope = clobbered.compiled.hir.scopes.find(
      (candidate) => candidate.parentId !== null
    );
    const clobberedRegion = clobberedScope.controlRegions.find(
      (candidate) => candidate.kind === "TryFinally"
    );
    const clobberedLoad = clobberedScope.instructions.find((instruction) =>
      instruction.op === "GETLOCAL" &&
      clobberedRegion.finalizerStart <= instruction.offset &&
      instruction.offset < clobberedRegion.finalizerEnd
    );
    assert.equal(clobbered.value, 2);
    assert.equal(clobberedLoad.optimized, undefined);
  });

  it("ignores proof annotations made unreachable by a later branch fold", function() {
    const result = execute(
      "function f(){var c=1,x=7,y=0;if(c+1===2){return 1;}" +
      "else{y=x;return x+y;}}f();",
      { optimization: "O2", security: "trusted", includeHIR: true }
    );
    assert.equal(result.value, 1);
    const unreachableReuse = result.compiled.hir.scopes.flatMap((scope) => scope.instructions)
      .find((instruction) => instruction.unreachable &&
        instruction.optimized && instruction.optimized.kind === "reuse");
    assert(unreachableReuse, "fixture must retain a now-unreachable proof annotation");
  });

  it("keeps a folded-literal GVN producer materialized for its later use", function() {
    const result = execute(
      "function f(flag){var x=1,sink={a:[[x]]};" +
      "if(flag){sink={a:[true,1,x-null]};}return sink.a[2];}f(true);",
      { optimization: "O2", security: "trusted", includeHIR: true }
    );
    assert.equal(result.value, 1);
    const scope = result.compiled.hir.scopes.find((candidate) =>
      candidate.instructions.some((instruction) =>
        instruction.optimized && instruction.optimized.kind === "reuse"
      )
    );
    const reuse = scope && scope.instructions.find((instruction) =>
      instruction.optimized && instruction.optimized.kind === "reuse"
    );
    assert(reuse, "fixture must exercise cross-region GVN");
    const producer = scope.instructions.find((instruction) =>
      instruction.offset === reuse.optimized.sourceOffset
    );
    assert(producer && !producer.elided && !producer.unreachable);
  });

  it("preserves nested exceptional and abrupt completion semantics", function() {
    const cases = [
      ...Array.from({ length: 8 }, (_, index) => nestedFinallySource(index + 1)),
      "function f(){var x=1;try{x=2;return x;}finally{x=3;}}f();",
      "function f(){var x=1;try{x=2;return x;}finally{x=3;return x;}}f();",
      "function f(){var x=0;for(var i=0;i<3;i++){try{x=x+1;if(i===1)break;}finally{x=x+10;}}return x;}f();",
      "function f(){var x=0;for(var i=0;i<3;i++){try{x=x+1;continue;}finally{x=x+10;}}return x;}f();",
      "function f(){var x=1;try{x=2;throw new Error('x');}catch(e){return x;}}f();",
    ];
    cases.forEach((source, index) => {
      const expected = nativeCompletion(source);
      for (const optimization of LEVELS) {
        for (const security of SECURITY_MODES) {
          assert.equal(
            execute(source, { optimization, security }).value,
            expected,
            `${index}/${optimization}/${security}`
          );
        }
      }
    });
  });

  it("supports an attributable GVN kill switch", function() {
    const source = "function f(flag){var stable=7,first=stable;" +
      "if(flag){first++;}return first+stable;}f(true)+f(false);";
    const enabled = execute(source, { optimization: "O2", security: "trusted" });
    const disabled = execute(source, {
      optimization: "O2",
      security: "trusted",
      globalValueNumbering: false,
    });
    assert.equal(enabled.value, 29);
    assert.equal(disabled.value, enabled.value);
    assert(enabled.compiled.stats.globalValueNumbering.crossBlockLoadsEliminated > 0);
    assert.equal(disabled.compiled.stats.globalValueNumbering, undefined);
  });

  it("preserves MIR stack height for folded switch cases inside try and control joins", function() {
    const issue46 = "var r = []; try { switch (0) { case 0: r.push(1); } } catch (e) {} r";
    const defaultCompiled = execute(issue46);
    assert.equal(defaultCompiled.compiled.optimization, "O1");
    assert.deepStrictEqual(defaultCompiled.value, [1]);

    const cases = [
      { source: issue46, expected: [1] },
      { source: "var r = []; try { switch (0) { case 0: } } catch (e) {} r", expected: [] },
      {
        source: "var r = []; try { switch (0) { case 0: r.push(1); } } finally { r.push(2); } r",
        expected: [1, 2],
      },
      {
        source: "var r = []; try { switch (0) { case 0: r.push(1); } } catch (e) { r.push(9); } finally { r.push(2); } r",
        expected: [1, 2],
      },
      {
        source: "function f() { var r = []; try { switch (0) { case 0: r.push(1); return r; } } finally { r.push(2); } } f()",
        expected: [1, 2],
      },
      {
        source: "var r = []; switch (0) { case 0: try { r.push(1); break; } finally { r.push(2); } r.push(3); } r",
        expected: [1, 2],
      },
      {
        source: "function f(flag) { var r = []; if (flag) { switch (0) { case 0: r.push(1); } } return r; } [f(true), f(false)]",
        expected: [[1], []],
      },
      {
        source: "var r = []; switch (0) { case 1: r.push(1); case 0: r.push(2); case 2: r.push(3); default: r.push(4); } r",
        expected: [2, 3, 4],
      },
      {
        source: "function run(v) { var r = []; try { switch (0) { case v: r.push(1); case 0: r.push(2); } } catch (e) {} return r; } [run(0), run(1)]",
        expected: [[1, 2], [2]],
      },
      { source: "42; switch (0) {}", expected: 42, checkNative: false },
      { source: "42; switch (0) { default: }", expected: 42, checkNative: false },
      { source: "switch (2) { case 2: 7; break; }", expected: 7 },
      { source: "switch (2) { case 2: 7; ; break; }", expected: undefined, checkNative: false },
    ];

    cases.forEach(({ source, expected, checkNative = true }, index) => {
      if (checkNative) {
        const native = nativeCompletion(source);
        assert.deepStrictEqual(JSON.stringify(native), JSON.stringify(expected), `native ${index}`);
      }
      for (const optimization of LEVELS) {
        for (const security of SECURITY_MODES) {
          const result = execute(source, { optimization, security });
          assert.deepStrictEqual(
            result.value,
            expected,
            `${index}/${optimization}/${security}`
          );
        }
      }
    });
  });

  it("materializes fallback GVN reuse producers in catch-free try/finally scopes", function() {
    const cases = [
      "function f(){var r=[];try{r.push(1);return r;}finally{r.push(2);}}f();",
      "function f(){var r=[];try{r.push(1);r.push(2);}finally{}return r;}f();",
    ];
    cases.forEach((source, index) => {
      const expected = nativeCompletion(source);
      for (const optimization of LEVELS) {
        for (const security of SECURITY_MODES) {
          const result = execute(source, { optimization, security });
          assert.deepStrictEqual(
            JSON.stringify(result.value),
            JSON.stringify(expected),
            `${index}/${optimization}/${security}`
          );
        }
      }
    });
  });

  it("keeps GVN reuse producers materialized when switch case tests fold to literals", function() {
    const cases = [
      "\"use strict\"; function f(){var v1=9,v2=0,v3=1;switch(v1){case v2:v3=v2;break;case false:v2=7;break;}return v3;}f();",
      "\"use strict\"; function f(){var v0=false,v1=1,v2=2;switch(true){case v0:v2=3;case 3:v2=4;default:v1=v0;}return [v1,v2];}f();",
    ];
    cases.forEach((source, index) => {
      const expected = nativeCompletion(source);
      for (const optimization of LEVELS) {
        for (const security of SECURITY_MODES) {
          const result = execute(source, { optimization, security });
          assert.deepStrictEqual(
            JSON.stringify(result.value),
            JSON.stringify(expected),
            `${index}/${optimization}/${security}`
          );
        }
      }
    });
  });
});
