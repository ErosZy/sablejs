"use strict";

const { buildNormalCFG, buildSemanticCFG, verifyCFG } = require("../ir/cfg");
const { lowerToMIR, verifyMIR } = require("../ir/mir");
const { PassManager, liveInstructionCount } = require("./pass-manager");
const {
  runCopyPropagation,
  runDeadCodeElimination,
  runDeadStoreElimination,
  runGlobalValueNumbering,
  runLocalCSE,
  runLoopInvariantCodeMotion,
} = require("./mir-optimizations");
const { refreshBranchProofs, runSCCP } = require("./sccp");
const { runGuestProvenance } = require("./guest-provenance");

const LEVELS = new Set(["O0", "O1", "O2", "Os"]);
const OPTIMIZER_PIPELINE_VERSION = 2;
const INVALIDATE_MIR = Object.freeze({ preserves: [], invalidates: ["mir"] });
const PRESERVE_MIR = Object.freeze({ preserves: ["mir"], invalidates: [] });
const REBUILD_MIR = Object.freeze({ preserves: ["mir"], invalidates: ["mir"] });
const OPTIONAL_REBUILD_MIR = Object.freeze({
  preserves: ["mir"],
  invalidates: ["mir"],
  failureMode: "rollback",
  bailoutReason: "candidate-mir-invalid",
});
const OPTIONAL_GUEST_PROVENANCE_MIR = Object.freeze({
  preserves: ["mir"],
  invalidates: ["mir"],
  failureMode: "rollback",
  bailoutReason: "guest-provenance-proof-invalid",
});
const BINARY_FOLDERS = {
  MUL: (left, right) => left * right,
  DIV: (left, right) => left / right,
  MOD: (left, right) => left % right,
  ADD: (left, right) => left + right,
  SUB: (left, right) => left - right,
  SHL: (left, right) => left << right,
  SHR: (left, right) => left >> right,
  USHR: (left, right) => left >>> right,
  BITAND: (left, right) => left & right,
  BITXOR: (left, right) => left ^ right,
  BITOR: (left, right) => left | right,
  STRICTEQ: (left, right) => left === right,
  STRICTNE: (left, right) => left !== right,
};
const UNARY_FOLDERS = {
  POS: (value) => +value,
  NEG: (value) => -value,
  BITNOT: (value) => ~value,
  LOGNOT: (value) => !value,
  TYPEOF: (value) => typeof value,
};

function normalizeLevel(level) {
  const aliases = { 0: "O0", 1: "O1", 2: "O2", s: "Os", S: "Os" };
  const raw = String(level == null ? "O1" : level).replace(/^-/, "");
  const normalized = aliases[raw] || (raw[0] === "o" ? `O${raw.slice(1)}` : raw);
  if (!LEVELS.has(normalized)) throw new Error(`Unknown optimization level ${level}`);
  return normalized;
}

function literalValue(instruction) {
  if (instruction.elided) return { known: false };
  if (instruction.optimized && instruction.optimized.kind === "literal") {
    return { known: true, value: instruction.optimized.value };
  }
  switch (instruction.op) {
    case "INTEGER":
    case "NUMBER":
    case "STRING":
      return { known: true, value: instruction.args[0] };
    case "UNDEF":
      return { known: true, value: undefined };
    case "NULL":
      return { known: true, value: null };
    case "TRUE":
      return { known: true, value: true };
    case "FALSE":
      return { known: true, value: false };
    default:
      return { known: false };
  }
}

function jumpTargets(scope) {
  const targets = new Set();
  scope.instructions.forEach((instruction) => {
    if (["JUMP", "JTRUE", "JFALSE", "JCASE", "TRY"].includes(instruction.op)) {
      targets.add(instruction.args[0]);
    }
    if (
      instruction.optimized &&
      (instruction.optimized.kind === "reuse" || instruction.optimized.kind === "licm")
    ) {
      targets.add(instruction.optimized.sourceOffset);
    }
  });
  return targets;
}

function foldConstants(scope, stats) {
  const targets = jumpTargets(scope);
  const instructions = scope.instructions;
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    const unary = UNARY_FOLDERS[instruction.op];
    if (unary && index >= 1) {
      const input = instructions[index - 1];
      const literal = literalValue(input);
      if (literal.known && !targets.has(input.offset) && !targets.has(instruction.offset)) {
        input.elided = true;
        instruction.optimized = { kind: "literal", value: unary(literal.value) };
        stats.constantsFolded += 1;
      }
      continue;
    }

    const binary = BINARY_FOLDERS[instruction.op] || BINARY_FOLDERS[instruction.op.split("_")[0]];
    if (binary && index >= 2) {
      const leftInstruction = instructions[index - 2];
      const rightInstruction = instructions[index - 1];
      const left = literalValue(leftInstruction);
      const right = literalValue(rightInstruction);
      if (
        left.known &&
        right.known &&
        !targets.has(leftInstruction.offset) &&
        !targets.has(rightInstruction.offset) &&
        !targets.has(instruction.offset)
      ) {
        leftInstruction.elided = true;
        rightInstruction.elided = true;
        instruction.optimized = { kind: "literal", value: binary(left.value, right.value) };
        stats.constantsFolded += 1;
      }
    }
  }
}

function eliminateDeadConstants(scope, stats) {
  const targets = jumpTargets(scope);
  const instructions = scope.instructions;
  for (let index = 1; index < instructions.length; index += 1) {
    const pop = instructions[index];
    const producer = instructions[index - 1];
    if (
      pop.op === "POP" &&
      literalValue(producer).known &&
      !targets.has(producer.offset) &&
      !targets.has(pop.offset)
    ) {
      producer.elided = true;
      pop.elided = true;
      stats.deadOperationsRemoved += 2;
    }
  }
}

function stripSourceLocations(scope, stats) {
  scope.instructions.forEach((instruction) => {
    if (instruction.op !== "LOC" || instruction.elided) return;
    instruction.elided = true;
    stats.sourceLocationsRemoved += 1;
    stats.deadOperationsRemoved += 1;
  });
}

function foldConstantBranches(scope, stats) {
  const targets = jumpTargets(scope);
  const instructions = scope.instructions;
  for (let index = 1; index < instructions.length; index += 1) {
    const branch = instructions[index];
    if (branch.op !== "JTRUE" && branch.op !== "JFALSE") continue;
    const condition = instructions[index - 1];
    const literal = literalValue(condition);
    if (!literal.known || targets.has(condition.offset) || targets.has(branch.offset)) continue;

    const taken = branch.op === "JTRUE" ? Boolean(literal.value) : !Boolean(literal.value);
    branch.optimizedBranchTarget = taken ? branch.args[0] : branch.end;
    branch.optimizedBranchProof = {
      kind: "literal",
      sourceOffset: condition.offset,
      value: literal.value,
    };
    stats.constantBranchesFolded += 1;
  }
}

function eliminateUnreachableBlocks(scope, stats) {
  const normalCFG = buildNormalCFG(scope);
  verifyCFG(normalCFG, scope);
  const needsCompletionReachability =
    (scope.controlRegions || []).some(
      (region) => region.kind === "TryCatch" || region.kind === "TryFinally"
    ) || (scope.syntheticRanges || []).some((range) => range.kind === "AbruptFinally");
  let reachable = normalCFG.reachable;
  if (needsCompletionReachability) {
    // Reachability needs only labelled successors. Avoid dominator
    // construction on the finer mayThrow-split graph; GVN and proof consumers
    // request the fully analyzed form separately. Scopes without an internal
    // handler/finalizer cannot gain an internal target from a completion edge.
    const semanticCFG = buildSemanticCFG(scope, { analyze: false });
    verifyCFG(semanticCFG, scope);
    // Normal reachability retains lowering scaffolding whose exception-stack
    // values MIR still consumes. Semantic reachability retains real finalizer
    // paths. A block is removable only when neither contract needs it.
    reachable = new Set(normalCFG.reachable);
    const semanticRanges = semanticCFG.blocks.filter((block) =>
      semanticCFG.reachable.has(block.start)
    );
    normalCFG.blocks.forEach((block) => {
      if (semanticRanges.some((range) => range.start < block.end && block.start < range.end)) {
        reachable.add(block.start);
      }
    });
  }
  stats.cfg.blocks += normalCFG.blocks.length;
  stats.cfg.edges += normalCFG.blocks.reduce((count, block) => count + block.edges.length, 0);
  stats.cfg.loops += normalCFG.loops.length;
  normalCFG.blocks.forEach((block) => {
    if (reachable.has(block.start)) return;
    const newlyUnreachable = block.instructions.filter((instruction) => !instruction.unreachable);
    if (!newlyUnreachable.length) return;
    stats.unreachableBlocksRemoved += 1;
    newlyUnreachable.forEach((instruction) => {
      instruction.unreachable = true;
      stats.deadOperationsRemoved += 1;
    });
  });
}

function rebuildMIR(program, stats, passes, reason) {
  const mir = lowerToMIR(program);
  stats.mir.builds += 1;
  verifyMIR(mir, program);
  passes.setAnalysis("mir", mir, reason);
  return mir;
}

function optimizeProgram(program, requestedLevel, options = {}) {
  const level = normalizeLevel(requestedLevel);
  const stats = {
    level,
    pipelineVersion: OPTIMIZER_PIPELINE_VERSION,
    passes: [],
    disabledPasses: [],
    constantsFolded: 0,
    constantBranchesFolded: 0,
    deadOperationsRemoved: 0,
    unreachableBlocksRemoved: 0,
    cfg: { blocks: 0, edges: 0, loops: 0 },
    mir: { builds: 0 },
    sourceLocationsRemoved: 0,
  };
  stats.nodesBefore = liveInstructionCount(program);
  if (level === "O0") {
    stats.nodesAfter = stats.nodesBefore;
    return stats;
  }
  // Pass pipeline contract.
  // - Every pass preserves program semantics exactly; PassManager re-verifies
  //   the HIR after each pass and records live-instruction deltas.
  // - Passes communicate only through the fields they are licensed to write:
  //   `elided` / `unreachable` marks, `instruction.optimized` literal folds,
  //   `instruction.optimizedBranchTarget` branch rewrites, and the
  //   `guestObjectOutput` provenance mark. Everything else is input to every
  //   later pass.
  // - Security-sensitive passes (guest-object-provenance) may only move data
  //   toward the sandbox fast path when the proof travels with the mark
  //   itself; see the per-pass notes below and guest-provenance.js.
  const passes = new PassManager(program, stats, options);

  passes.run(
    "constant-folding",
    (currentProgram) => {
      // Folds constant unary/binary chains into `optimized` literals and elides
      // their inputs. Never folds across or into jump targets (offset-based
      // peephole guards), never folds allocate ops (NEW*/CLOSURE are not
      // literals), and preserves the instruction stream's offset layout.
      currentProgram.scopes.forEach((scope) => foldConstants(scope, stats));
    },
    INVALIDATE_MIR
  );

  passes.run(
    "constant-branches",
    (currentProgram) => {
      // Rewrites JTRUE/JFALSE on known literal conditions to a direct
      // `optimizedBranchTarget` (taken target or fall-through `end`). The
      // condition instruction stays live; CFG reachability is resolved by the
      // next pass from the rewritten target.
      currentProgram.scopes.forEach((scope) => foldConstantBranches(scope, stats));
    },
    INVALIDATE_MIR
  );

  passes.run(
    "cfg-unreachable-code",
    (currentProgram) => {
      // Removes a block only when neither semantic execution nor the current
      // normal-lowering/MIR scaffolding can reach it. Finalizers are retained by
      // explicit completion edges instead of a byte-range exception.
      currentProgram.scopes.forEach((scope) => eliminateUnreachableBlocks(scope, stats));
    },
    INVALIDATE_MIR
  );

  // Source-map generation consumes LOC positions at compile time, so it
  // retains them exactly like preserveSourceLocations does for runtime
  // frame-location tracking.
  const retainSourceLocations =
    options.retainSourceLocations === true || options.preserveSourceLocations === true;
  if ((level === "O2" || level === "Os") && !retainSourceLocations) {
    passes.run(
      "strip-source-locations",
      (currentProgram) => {
        // Elides LOC instructions (debug markers only, no runtime effect).
        currentProgram.scopes.forEach((scope) => stripSourceLocations(scope, stats));
      },
      INVALIDATE_MIR
    );
  }

  passes.run(
    "ssa-sccp",
    (currentProgram) => {
      // Sparse conditional constant propagation over the MIR value graph.
      // Constants flow only through SSA values, never across the sandbox
      // boundary. The pass replaces its input generation with a freshly lowered,
      // verified MIR; later mutating passes do the same before another consumer
      // can observe their changed use-def or control-flow facts.
      if (options.sparseConditionalConstantPropagation === false) {
        stats.disabledPasses.push("ssa-sccp");
      } else {
        runSCCP(currentProgram, stats);
      }
      rebuildMIR(currentProgram, stats, passes, "post-sccp-control-flow");
    },
    REBUILD_MIR
  );

  passes.run(
    "ssa-copy-propagation",
    (currentProgram) => {
      // Propagates known literals into private lightweight locals (intra-block;
      // parameters excluded — sloppy arguments can alias them). Kills on any
      // unknown store. Literals only, so guest-allocated values never get
      // aliased into slots the provenance pass would misjudge.
      if (options.copyPropagation === false) {
        stats.disabledPasses.push("ssa-copy-propagation");
        return;
      }
      runCopyPropagation(currentProgram, stats, passes.getAnalysis("mir"));
    },
    PRESERVE_MIR
  );

  if (level === "O2") {
    passes.run(
      "loop-invariant-code-motion",
      (currentProgram) => {
        // Hoists private non-parameter local reads out of loops (O2 only). Such
        // reads cannot invoke guest code, and lightweight scopes prove no
        // with/eval/closures can mutate the slot; a loop-local write is a hard
        // kill. Trusted-mode slots that codegen will promote (Item 6) are
        // skipped: their hoist would be a pure alias of a register read.
        if (options.loopInvariantCodeMotion === false) {
          stats.disabledPasses.push("loop-invariant-code-motion");
          return;
        }
        runLoopInvariantCodeMotion(currentProgram, stats, passes.getAnalysis("mir"), options);
      },
      PRESERVE_MIR
    );

    passes.run(
      "global-value-numbering",
      (currentProgram) => {
        // Memory-aware cross-block CSE for private locals (O2 only): a load is
        // available across a semantic-CFG block only when every reachable
        // predecessor carries the same dominating load and no path writes that
        // local. Real catch/with/eval scopes retain a fail-closed bailout.
        if (options.globalValueNumbering === false) {
          stats.disabledPasses.push("global-value-numbering");
          return;
        }
        runGlobalValueNumbering(currentProgram, stats, passes.getAnalysis("mir"));
      },
      PRESERVE_MIR
    );
  }

  if (level === "O2" || level === "Os") {
    passes.run(
      "local-cse",
      (currentProgram) => {
        // Same-block CSE (O2/Os).
        runLocalCSE(currentProgram, stats, passes.getAnalysis("mir"));
      },
      PRESERVE_MIR
    );

    passes.run(
      "dead-store-elimination",
      (currentProgram) => {
        // Elides SETLOCALs whose value is never read on any path before the
        // next store/delete (must-use liveness over the MIR CFG). Private
        // propagable slots only — same eligibility as copy propagation,
        // widened by item 4 to strict parameters. Reads rewritten by earlier
        // passes (literal/duplicate/reuse/licm marks) no longer consume the
        // slot, so stores orphaned by copy-prop and the unused name-binding
        // prologue are caught too. SETLOCAL is a stack PEEK, so the elision
        // leaves the stack untouched (no drop-inputs needed, unlike DCE's POP
        // chains). Runs after every value-moving pass and before the final
        // DCE, so the provenance mark written later cannot go stale.
        if (options.deadStoreElimination === false) {
          stats.disabledPasses.push("dead-store-elimination");
          return;
        }
        runDeadStoreElimination(currentProgram, stats, passes.getAnalysis("mir"), options);
        rebuildMIR(currentProgram, stats, passes, "post-dse-use-def");
      },
      REBUILD_MIR
    );
  }

  passes.run(
    "ssa-dead-code-elimination",
    (currentProgram) => {
      // Removes Pure-effect operations whose single output is consumed by POP.
      // Pure-only: nothing with observable effects or multiple uses is touched.
      // The last SSA pass — later passes see the final MIR shape.
      if (options.deadCodeElimination === false) {
        stats.disabledPasses.push("ssa-dead-code-elimination");
        return;
      }
      runDeadCodeElimination(currentProgram, stats, passes.getAnalysis("mir"));
      rebuildMIR(currentProgram, stats, passes, "post-dce-use-def");
    },
    OPTIONAL_REBUILD_MIR
  );

  passes.run(
    "copy-folding",
    (currentProgram) => {
      // Peephole re-runs after the SSA passes: SSA passes rewrite the
      // instruction stream (elisions, replaced operands), so the offset-based
      // peepholes are re-applied to the final HIR to keep their decisions
      // consistent with what codegen will emit.
      currentProgram.scopes.forEach((scope) => foldConstants(scope, stats));
    },
    INVALIDATE_MIR
  );

  passes.run(
    "copy-constant-branches",
    (currentProgram) => {
      currentProgram.scopes.forEach((scope) => foldConstantBranches(scope, stats));
      const removed = refreshBranchProofs(currentProgram);
      if (stats.sccp) stats.sccp.branchesFolded -= removed;
    },
    INVALIDATE_MIR
  );

  passes.run(
    "copy-unreachable-code",
    (currentProgram) => {
      currentProgram.scopes.forEach((scope) => eliminateUnreachableBlocks(scope, stats));
    },
    INVALIDATE_MIR
  );

  if (level === "O2" || level === "Os") {
    passes.run(
      "guest-object-provenance",
      (currentProgram) => {
        // SECURITY-SENSITIVE. Proves GETLOCAL outputs and NEW results are
        // guest-created and marks them `guestObjectOutput` — the fast-path
        // ticket for sandbox property writes. This deliberately runs after
        // every copy/CFG rewrite and rebuilds MIR from the final HIR, so no
        // later pass can invalidate the proof. The mark seeds exclusively at
        // allocate ops (NEWARRAY/NEWOBJECT/NEWREGEXP/CLOSURE), flows only
        // through slots and phi joins (AND meet), and NEW outputs additionally
        // require a constructor pinned to one return-safe closure scope.
        const mir = rebuildMIR(currentProgram, stats, passes, "post-copy-guest-provenance");
        runGuestProvenance(currentProgram, stats, mir);
      },
      OPTIONAL_GUEST_PROVENANCE_MIR
    );
  }
  stats.nodesAfter = liveInstructionCount(program);
  return stats;
}

module.exports = {
  LEVELS,
  OPTIMIZER_PIPELINE_VERSION,
  normalizeLevel,
  optimizeProgram,
};
