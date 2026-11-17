"use strict";

const assert = require("assert");
const path = require("path");
const { describe, it } = require("node:test");
const { compile } = require("../../src/compiler");
const { verifyProgram } = require("../../src/ir/verify");
const { lowerToMIR, verifyMIR } = require("../../src/ir/mir");
const { PassManager } = require("../../src/backend/pass-manager");

const runtimeModule = path.resolve(__dirname, "../../src/runtime");

describe("optimized HIR verifier", function () {
  it("rejects a corrupted reuse source", function () {
    const result = compile("function f(flag){var x=7,y=x;if(flag){y++;}return y+x;}f(true);", {
      optimization: "O2",
      security: "trusted",
      runtimeModule,
      includeHIR: true,
    });
    const reuse = result.hir.scopes
      .flatMap((scope) => scope.instructions)
      .find((instruction) => instruction.optimized && instruction.optimized.kind === "reuse");
    assert(reuse, "fixture must exercise GVN reuse");
    reuse.optimized.sourceOffset = -1;
    assert.throws(() => verifyProgram(result.hir), /Invalid reuse source/);
  });

  it("rejects invalid branch and provenance proof shapes", function () {
    const branchResult = compile("if(true){1;}2;", {
      optimization: "O1",
      runtimeModule,
      includeHIR: true,
    });
    const branch = branchResult.hir.scopes
      .flatMap((scope) => scope.instructions)
      .find((instruction) => instruction.optimizedBranchTarget !== undefined);
    assert(branch, "fixture must exercise an optimized branch");
    branch.optimizedBranchTarget =
      branch.optimizedBranchTarget === branch.args[0] ? branch.end : branch.args[0];
    assert.throws(() => verifyProgram(branchResult.hir), /Invalid optimized branch proof/);

    const switchResult = compile("switch (0) { case 0: 1; break; default: 2; }", {
      optimization: "O1",
      runtimeModule,
      includeHIR: true,
    });
    const jcase = switchResult.hir.scopes
      .flatMap((scope) => scope.instructions)
      .find(
        (instruction) =>
          instruction.op === "JCASE" && instruction.optimizedBranchTarget !== undefined
      );
    assert(jcase, "fixture must exercise an optimized JCASE branch");
    jcase.optimizedBranchTarget =
      jcase.optimizedBranchTarget === jcase.args[0] ? jcase.end : jcase.args[0];
    assert.throws(() => verifyProgram(switchResult.hir), /Invalid optimized branch proof/);

    const provenanceResult = compile("var o={};o.x=1;o;", {
      optimization: "O2",
      runtimeModule,
      includeHIR: true,
    });
    const instruction = provenanceResult.hir.scopes[0].instructions[0];
    instruction.guestObjectOutput = true;
    assert.throws(() => verifyProgram(provenanceResult.hir), /Invalid guest-object proof/);

    const plausibleProvenance = compile("function f(value){return value;}f({});", {
      optimization: "O0",
      runtimeModule,
      includeHIR: true,
    });
    const parameterLoad = plausibleProvenance.hir.scopes
      .find((scope) => scope.name === "f")
      .instructions.find((candidate) => candidate.op === "GETLOCAL" && candidate.args[0] === 1);
    assert(parameterLoad, "fixture must contain a parameter GETLOCAL");
    parameterLoad.guestObjectOutput = true;
    assert.throws(() => verifyProgram(plausibleProvenance.hir), /Invalid guest-object proof/);
  });

  it("rejects MIR edge, Phi, definition, effect, and use-list mutations", function () {
    const result = compile("var x=1;if(flag){x=2;}while(x<4){x++;}x;", {
      optimization: "O0",
      runtimeModule,
      includeHIR: true,
    });
    const fresh = () => lowerToMIR(result.hir);

    const edgeMIR = fresh();
    const edgeScope = edgeMIR.scopes[0];
    const edgeBlock = edgeScope.blocks.find((block) => block.successors.length);
    const edgeTarget = edgeScope.blocks.find((block) => block.start === edgeBlock.successors[0]);
    edgeTarget.predecessors = edgeTarget.predecessors.filter((start) => start !== edgeBlock.start);
    assert.throws(() => verifyMIR(edgeMIR), /Invalid MIR edge/);

    const phiMIR = fresh();
    const phi = phiMIR.scopes[0].blocks.flatMap((block) => block.phis)[0];
    assert(phi && phi.inputs.length > 1, "fixture must contain a multi-input Phi");
    phi.inputs[1].block = phi.inputs[0].block;
    assert.throws(() => verifyMIR(phiMIR), /Invalid Phi/);

    const definitionMIR = fresh();
    const definitionScope = definitionMIR.scopes[0];
    const output = definitionScope.blocks
      .flatMap((block) => block.operations)
      .find((operation) => operation.outputs.length).outputs[0];
    definitionScope.values.find((value) => value.id === output).definition.output += 1;
    assert.throws(() => verifyMIR(definitionMIR), /Invalid MIR output definition/);

    const effectMIR = fresh();
    effectMIR.scopes[0].blocks.flatMap((block) => block.operations)[0].effect = "HostEffect";
    assert.throws(() => verifyMIR(effectMIR), /Invalid MIR operation/);

    const useMIR = fresh();
    const used = useMIR.scopes[0].values.find((value) => value.uses.length);
    used.uses[0] = { ...used.uses[0], input: 999 };
    assert.throws(() => verifyMIR(useMIR), /Invalid use-def chain/);

    const stackMIR = fresh();
    const stackScope = stackMIR.scopes[0];
    const stackEdge = stackScope.blocks
      .flatMap((block) => block.outgoingStacks)
      .find((edge) => edge.values.length);
    assert(stackEdge, "fixture must contain a non-empty MIR edge stack");
    stackEdge.values.pop();
    assert.throws(() => verifyMIR(stackMIR), /edge stack height mismatch/);
  });

  it("rejects a reuse clobbered on an exceptional path into finally", function () {
    const result = compile("function f(){var x=1,y=x;try{x=2;throw 0;}finally{return x;}}f();", {
      optimization: "O0",
      runtimeModule,
      includeHIR: true,
    });
    const scope = result.hir.scopes.find((candidate) => candidate.parentId !== null);
    const region = scope.controlRegions.find((candidate) => candidate.kind === "TryFinally");
    const source = scope.instructions.find(
      (instruction) => instruction.op === "GETLOCAL" && instruction.offset < region.start
    );
    const use = scope.instructions.find(
      (instruction) =>
        instruction.op === "GETLOCAL" &&
        region.finalizerStart <= instruction.offset &&
        instruction.offset < region.finalizerEnd
    );
    assert(source && use && source.args[0] === use.args[0]);
    use.optimized = { kind: "reuse", sourceOffset: source.offset };
    assert.throws(() => verifyProgram(result.hir), /clobbered before/);
  });

  it("rejects malformed structured-region contracts", function () {
    const source =
      "function f(obj){outer:for(var k in obj){try{if(k){continue outer;}}" +
      "finally{obj.x=1;}}switch(1){case 1:break;default:break;}return 0;}f({a:1});";
    const fresh = () =>
      compile(source, {
        optimization: "O0",
        runtimeModule,
        includeHIR: true,
      }).hir;

    const missing = fresh();
    const missingScope = missing.scopes.find((scope) =>
      scope.controlRegions.some((region) => region.kind === "TryFinally")
    );
    const missingFinally = missingScope.controlRegions.find(
      (region) => region.kind === "TryFinally"
    );
    delete missingFinally.finalizerStart;
    assert.throws(() => verifyProgram(missing), /missing required field finalizerStart/);

    const badBackedge = fresh();
    const backedgeScope = badBackedge.scopes.find((scope) =>
      scope.controlRegions.some((region) => region.kind === "ForIn")
    );
    const forIn = backedgeScope.controlRegions.find((region) => region.kind === "ForIn");
    backedgeScope.instructions.find(
      (instruction) => instruction.offset === forIn.backedge
    ).args[0] = forIn.end;
    assert.throws(() => verifyProgram(badBackedge), /invalid for-in targets/);

    const overlap = fresh();
    const overlapScope = overlap.scopes.find((scope) =>
      scope.controlRegions.some((region) => region.kind === "TryFinally")
    );
    const outerLoop = overlapScope.controlRegions.find((region) => region.kind === "ForIn");
    const nestedFinally = overlapScope.controlRegions.find(
      (region) =>
        region.kind === "TryFinally" &&
        outerLoop.start <= region.start &&
        region.end <= outerLoop.end
    );
    const laterBoundary = overlapScope.instructions.find(
      (instruction) => instruction.offset > outerLoop.end
    ).offset;
    nestedFinally.end = laterBoundary;
    nestedFinally.finalizerEnd = laterBoundary;
    assert.throws(() => verifyProgram(overlap), /partially overlap/);

    const orphan = fresh();
    const orphanScope = orphan.scopes.find((scope) => scope.syntheticRanges.length);
    orphanScope.syntheticRanges[0].start = 0;
    orphanScope.syntheticRanges[0].end = orphanScope.instructions[0].end;
    assert.throws(() => verifyProgram(orphan), /no owning TryFinally/);
  });

  it("rejects an elided store that still reaches a consuming read", function () {
    const result = compile("function f(){var x=1;return x;}f();", {
      optimization: "O0",
      runtimeModule,
      includeHIR: true,
    });
    const scope = result.hir.scopes.find((candidate) => candidate.name === "f");
    const slot = scope.variables.indexOf("x") + 1;
    const store = scope.instructions.find(
      (instruction) => instruction.op === "SETLOCAL" && instruction.args[0] === slot
    );
    assert(store, "fixture must contain the local initialization store");
    store.elided = true;
    assert.throws(() => verifyProgram(result.hir), /is read at/);
  });

  it("rejects a valid-looking LICM annotation with the wrong loop header", function () {
    const result = compile("function f(n){var x=n+1,s=0;while(n-->0){s+=x;}return s;}f(3);", {
      optimization: "O0",
      security: "trusted",
      runtimeModule,
      includeHIR: true,
    });
    const scope = result.hir.scopes.find((candidate) => candidate.name === "f");
    const region = scope.controlRegions.find((candidate) => candidate.kind === "While");
    const slot = scope.variables.indexOf("x") + 1;
    const use = scope.instructions.find(
      (instruction) =>
        instruction.op === "GETLOCAL" &&
        instruction.args[0] === slot &&
        region.bodyStart <= instruction.offset &&
        instruction.offset < region.bodyEnd
    );
    assert(use, "fixture must contain an invariant loop load");
    const wrongHeader = scope.instructions.find(
      (instruction) => instruction.offset !== region.testStart && instruction.offset !== use.offset
    ).offset;
    use.optimized = {
      kind: "licm",
      header: wrongHeader,
      localIndex: slot,
      sourceOffset: use.offset,
    };
    scope.loopInvariantLoads = [
      {
        header: wrongHeader,
        localIndex: slot,
        sourceOffset: use.offset,
      },
    ];
    assert.throws(() => verifyProgram(result.hir), /Invalid LICM proof/);
  });

  it("rolls back a failed pass and rejects stale analysis generations", function () {
    const result = compile("function f(){return 1;}f();", {
      optimization: "O0",
      runtimeModule,
      includeHIR: true,
    });
    const stats = { passes: [] };
    const passes = new PassManager(result.hir, stats);
    const instruction = result.hir.scopes[0].instructions[0];
    assert.equal(instruction.optimized, undefined);
    assert.throws(
      () =>
        passes.run(
          "invalid-candidate",
          () => {
            instruction.optimized = { kind: "not-a-contract" };
          },
          { preserves: [], invalidates: ["mir"] }
        ),
      /Unknown optimization annotation/
    );
    assert.equal(instruction.optimized, undefined);
    assert.equal(stats.analysis.rollbacks, 1);
    assert.equal(stats.analysis.generation, 0);

    passes.setAnalysis("mir", { fresh: true }, "test-fixture");
    passes.run("invalidate-analysis", () => {}, {
      preserves: [],
      invalidates: ["mir"],
    });
    assert.throws(() => passes.getAnalysis("mir"), /stale or unavailable/);

    const optionalStats = { passes: [] };
    const optionalPasses = new PassManager(result.hir, optionalStats);
    const optionalInstruction = result.hir.scopes[0].instructions[0];
    const outcome = optionalPasses.run(
      "optional-invalid-candidate",
      () => {
        optionalInstruction.optimized = { kind: "not-a-contract" };
      },
      {
        preserves: [],
        invalidates: ["mir"],
        failureMode: "rollback",
        bailoutReason: "test-candidate-invalid",
      }
    );
    assert.equal(outcome.committed, false);
    assert.equal(optionalInstruction.optimized, undefined);
    assert.deepStrictEqual(optionalStats.analysis.bailouts, [
      {
        pass: "optional-invalid-candidate",
        reason: "test-candidate-invalid",
      },
    ]);
  });
});
