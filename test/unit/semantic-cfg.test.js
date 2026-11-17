"use strict";

const assert = require("assert");
const { describe, it } = require("node:test");
const { lowerToHIR } = require("../../src/compiler");
const { buildSemanticCFG, verifyCFG } = require("../../src/ir/cfg");
const { printCFG } = require("../../src/ir/print");

function functionScope(source) {
  return lowerToHIR(source).scopes.find((scope) => scope.parentId !== null);
}

function containingBlock(cfg, offset) {
  return cfg.blocks.find((block) =>
    block.instructions.some((instruction) => instruction.offset === offset)
  );
}

describe("completion-aware semantic CFG", function () {
  it("routes explicit and implicit throws through active handlers/finalizers", function () {
    const finallyScope = functionScope(
      "function f(){var x=1,y=x;try{x=2;throw 0;}finally{return x;}}f();"
    );
    const finallyRegion = finallyScope.controlRegions.find(
      (region) => region.kind === "TryFinally"
    );
    const sourceThrow = finallyScope.instructions.find(
      (instruction) =>
        instruction.op === "THROW" &&
        finallyRegion.tryBodyStart <= instruction.offset &&
        instruction.offset < finallyRegion.tryBodyEnd
    );
    const finallyCFG = buildSemanticCFG(finallyScope);
    verifyCFG(finallyCFG, finallyScope);
    const throwBlock = containingBlock(finallyCFG, sourceThrow.offset);
    assert(
      throwBlock.edges.some(
        (edge) =>
          edge.target === finallyRegion.finalizerStart &&
          edge.class === "exceptional" &&
          edge.completion === "throw"
      )
    );

    const catchScope = functionScope("function f(){try{g();}catch(e){return e.name;}}f();");
    const catchRegion = catchScope.controlRegions.find((region) => region.kind === "TryCatch");
    const call = catchScope.instructions.find((instruction) => instruction.op === "CALL");
    const catchCFG = buildSemanticCFG(catchScope);
    const callBlock = containingBlock(catchCFG, call.offset);
    assert(
      callBlock.edges.some(
        (edge) =>
          edge.target === catchRegion.catchBodyStart &&
          edge.class === "exceptional" &&
          edge.completion === "throw"
      )
    );
    assert(callBlock.edges.some((edge) => edge.class === "normal"));
  });

  it("labels return/break/continue pending completions around finalizers", function () {
    const sources = [
      "function f(){try{return 1;}finally{var x=2;}}f();",
      "function f(){while(true){try{break;}finally{var x=2;}}return 3;}f();",
      "function f(){for(var i=0;i<2;i++){try{continue;}finally{i=i+1;}}return i;}f();",
    ];
    const expected = ["return", "break", "continue"];
    sources.forEach((source, index) => {
      const scope = functionScope(source);
      const region = scope.controlRegions.find((candidate) => candidate.kind === "TryFinally");
      const range = scope.syntheticRanges[0];
      const cfg = buildSemanticCFG(scope);
      verifyCFG(cfg, scope);
      const entry = cfg.blocks.find((block) => block.end === range.start);
      assert(
        entry.edges.some(
          (edge) =>
            edge.target === region.finalizerStart &&
            edge.class === "abrupt" &&
            edge.completion === expected[index]
        ),
        expected[index]
      );
      const finalizerExit = cfg.blocks.find((block) => block.end === region.finalizerEnd);
      assert(
        finalizerExit.edges.some(
          (edge) =>
            edge.target === range.end &&
            edge.class === "abrupt" &&
            edge.completion === expected[index]
        ),
        `resume ${expected[index]}`
      );
    });
  });

  it("lets a finalizer completion override a pending return", function () {
    const scope = functionScope("function f(){try{return 1;}finally{return 2;}}f();");
    const region = scope.controlRegions.find((candidate) => candidate.kind === "TryFinally");
    const cfg = buildSemanticCFG(scope);
    const finalizerExit = cfg.blocks.find((block) => block.end === region.finalizerEnd);
    assert(
      finalizerExit.edges.some(
        (edge) =>
          edge.class === "abrupt" &&
          edge.completion === "return" &&
          edge.target === scope.codeLength
      )
    );
    assert(!finalizerExit.edges.some((edge) => edge.kind === "resume"));
  });

  it("threads throws through nested finalizers at depths one through eight", function () {
    function nested(depth, level = 0) {
      if (level === depth) return "throw 1;";
      return `try{${nested(depth, level + 1)}}finally{marker=marker+1;}`;
    }
    for (let depth = 1; depth <= 8; depth += 1) {
      const scope = functionScope(
        `function f(){var marker=0;try{${nested(depth)}}catch(e){return marker;}}f();`
      );
      const cfg = buildSemanticCFG(scope);
      verifyCFG(cfg);
      const finalizers = scope.controlRegions
        .filter((region) => region.kind === "TryFinally")
        .sort((left, right) => left.end - left.start - (right.end - right.start));
      const sourceThrow = scope.instructions.find(
        (instruction) =>
          instruction.op === "THROW" &&
          finalizers[0].tryBodyStart <= instruction.offset &&
          instruction.offset < finalizers[0].tryBodyEnd
      );
      assert(
        containingBlock(cfg, sourceThrow.offset).edges.some(
          (edge) => edge.class === "exceptional" && edge.target === finalizers[0].finalizerStart
        ),
        `innermost depth ${depth}`
      );
      finalizers.forEach((region, index) => {
        const exit = cfg.blocks.find((block) => block.end === region.finalizerEnd);
        const target = finalizers[index + 1]
          ? finalizers[index + 1].finalizerStart
          : scope.controlRegions.find((candidate) => candidate.kind === "TryCatch").catchBodyStart;
        assert(
          exit.edges.some(
            (edge) =>
              edge.class === "exceptional" && edge.completion === "throw" && edge.target === target
          ),
          `finalizer ${index} depth ${depth}`
        );
      });
    }
  });

  it("prints edge class and pending completion and rejects corrupted labels", function () {
    const scope = functionScope("function f(){try{throw 1;}finally{var x=2;}}f();");
    const cfg = buildSemanticCFG(scope);
    const text = printCFG({ edgeModel: "semantic", scopes: [cfg] });
    assert.match(text, /class=exceptional kind=finally completion=throw/);
    const edge = cfg.blocks
      .flatMap((block) => block.edges)
      .find((candidate) => candidate.class === "exceptional");
    edge.class = "guessed";
    assert.throws(() => verifyCFG(cfg, scope), /invalid semantic class/);

    const plausible = buildSemanticCFG(scope);
    const plausibleEdge = plausible.blocks
      .flatMap((block) => block.edges)
      .find((candidate) => candidate.class === "exceptional");
    plausibleEdge.target = plausible.blocks.find(
      (block) => block.start !== plausibleEdge.target
    ).start;
    assert.throws(() => verifyCFG(plausible, scope), /edge reconstruction mismatch/);
  });
});
