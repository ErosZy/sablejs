"use strict";

const OpSpec = require("./op-spec");
const { buildNormalCFG, buildSemanticCFG, verifyCFG } = require("./cfg");
const { lowerScope } = require("./mir");

const LOCAL_WRITES = new Set(["SETLOCAL", "SETLOCAL2", "DELLOCAL", "DELLOCAL2"]);
const PROOF_BINARY = Object.freeze({
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
});
const PROOF_UNARY = Object.freeze({
  POS: (value) => +value,
  NEG: (value) => -value,
  BITNOT: (value) => ~value,
  LOGNOT: (value) => !value,
  TYPEOF: (value) => typeof value,
});
const REGION_FIELDS = Object.freeze({
  If: ["testStart", "branch", "consequentStart", "consequentEnd"],
  Conditional: [
    "testStart",
    "branch",
    "alternateStart",
    "alternateEnd",
    "alternateExit",
    "consequentStart",
    "consequentEnd",
  ],
  Logical: ["leftStart", "branch", "rightStart", "rightEnd"],
  While: [
    "testStart",
    "branch",
    "bodyStart",
    "bodyEnd",
    "backedge",
    "continueTarget",
    "breakTarget",
  ],
  DoWhile: ["bodyStart", "bodyEnd", "testStart", "branch", "continueTarget", "breakTarget"],
  For: [
    "initStart",
    "initEnd",
    "testStart",
    "bodyStart",
    "bodyEnd",
    "updateStart",
    "updateEnd",
    "backedge",
    "continueTarget",
    "breakTarget",
  ],
  ForIn: [
    "iteratorStart",
    "iteratorEnd",
    "testStart",
    "branch",
    "bodyStart",
    "bodyEnd",
    "backedge",
    "continueTarget",
    "breakTarget",
  ],
  Switch: ["discriminantStart", "discriminantEnd", "dispatchPop", "dispatchExit", "breakTarget"],
  TryCatch: [
    "tryEnter",
    "catchStart",
    "catchBodyStart",
    "catchBodyEnd",
    "catchExit",
    "tryBodyStart",
    "tryBodyEnd",
    "tryExit",
  ],
  TryFinally: [
    "tryEnter",
    "innerTryEnter",
    "exceptionalFinalizerStart",
    "exceptionalFinalizerEnd",
    "exceptionThrow",
    "catchStart",
    "catchBodyStart",
    "catchBodyEnd",
    "innerTryExit",
    "catchExit",
    "tryBodyStart",
    "tryBodyEnd",
    "tryExit",
    "finalizerStart",
    "finalizerEnd",
  ],
  Label: ["bodyStart", "bodyEnd"],
});

function instructionAt(instructionsByOffset, region, field, expected) {
  const instruction = instructionsByOffset.get(region[field]);
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!instruction || !allowed.includes(instruction.op)) {
    throw new Error(`Control region ${region.id} ${field} must point to ${allowed.join("/")}`);
  }
  return instruction;
}

function requireOrdered(region, fields) {
  let previous = region.start;
  fields.forEach((field) => {
    const value = region[field];
    if (value === null || value === undefined) return;
    if (value < previous || value > region.end) {
      throw new Error(`Control region ${region.id} has invalid ${field} ordering`);
    }
    previous = value;
  });
}

function verifyRegionShape(region, boundaries, instructionsByOffset) {
  const required = REGION_FIELDS[region.kind];
  required.forEach((field) => {
    if (!Number.isInteger(region[field]) || !boundaries.has(region[field])) {
      throw new Error(`Control region ${region.id} is missing required field ${field}`);
    }
  });
  if (!Array.isArray(region.exits) || !Array.isArray(region.cases)) {
    throw new Error(`Control region ${region.id} has invalid exits/cases metadata`);
  }

  switch (region.kind) {
    case "If": {
      const branch = instructionAt(instructionsByOffset, region, "branch", ["JTRUE", "JFALSE"]);
      const hasAlternate = region.alternateStart !== null || region.alternateEnd !== null;
      if (hasAlternate) {
        for (const field of ["alternateStart", "alternateEnd", "alternateExit"]) {
          if (!Number.isInteger(region[field]) || !boundaries.has(region[field])) {
            throw new Error(`Control region ${region.id} has incomplete alternate metadata`);
          }
        }
        if (branch.op !== "JTRUE" || branch.args[0] !== region.consequentStart) {
          throw new Error(`Control region ${region.id} has an invalid alternate branch`);
        }
        const exit = instructionAt(instructionsByOffset, region, "alternateExit", "JUMP");
        if (exit.args[0] !== region.end) {
          throw new Error(`Control region ${region.id} alternate exit has an invalid target`);
        }
        requireOrdered(region, [
          "testStart",
          "branch",
          "alternateStart",
          "alternateEnd",
          "alternateExit",
          "consequentStart",
          "consequentEnd",
        ]);
      } else {
        if (
          region.alternateStart !== null ||
          region.alternateEnd !== null ||
          region.alternateExit !== undefined
        ) {
          throw new Error(`Control region ${region.id} has inconsistent alternate metadata`);
        }
        if (branch.op !== "JFALSE" || branch.args[0] !== region.end) {
          throw new Error(`Control region ${region.id} has an invalid no-alternate branch`);
        }
        requireOrdered(region, ["testStart", "branch", "consequentStart", "consequentEnd"]);
      }
      break;
    }
    case "Conditional": {
      const branch = instructionAt(instructionsByOffset, region, "branch", "JTRUE");
      const exit = instructionAt(instructionsByOffset, region, "alternateExit", "JUMP");
      if (branch.args[0] !== region.consequentStart || exit.args[0] !== region.end) {
        throw new Error(`Control region ${region.id} has invalid conditional targets`);
      }
      requireOrdered(region, [
        "testStart",
        "branch",
        "alternateStart",
        "alternateEnd",
        "alternateExit",
        "consequentStart",
        "consequentEnd",
      ]);
      break;
    }
    case "Logical": {
      if (!["&&", "||"].includes(region.operator)) {
        throw new Error(`Control region ${region.id} has an invalid logical operator`);
      }
      const expected = region.operator === "||" ? "JTRUE" : "JFALSE";
      const branch = instructionAt(instructionsByOffset, region, "branch", expected);
      if (branch.args[0] !== region.end) {
        throw new Error(`Control region ${region.id} has an invalid logical target`);
      }
      requireOrdered(region, ["leftStart", "branch", "rightStart", "rightEnd"]);
      break;
    }
    case "While": {
      const branch = instructionAt(instructionsByOffset, region, "branch", "JFALSE");
      const backedge = instructionAt(instructionsByOffset, region, "backedge", "JUMP");
      if (
        branch.args[0] !== region.breakTarget ||
        region.breakTarget !== region.end ||
        backedge.args[0] !== region.testStart ||
        region.continueTarget !== region.testStart
      ) {
        throw new Error(`Control region ${region.id} has invalid while targets`);
      }
      requireOrdered(region, ["testStart", "branch", "bodyStart", "bodyEnd", "backedge"]);
      break;
    }
    case "DoWhile": {
      const branch = instructionAt(instructionsByOffset, region, "branch", "JTRUE");
      if (
        branch.args[0] !== region.bodyStart ||
        region.continueTarget !== region.testStart ||
        region.breakTarget !== region.end
      ) {
        throw new Error(`Control region ${region.id} has invalid do-while targets`);
      }
      requireOrdered(region, ["bodyStart", "bodyEnd", "testStart", "branch"]);
      break;
    }
    case "For": {
      if (region.branch !== null) {
        if (!Number.isInteger(region.branch) || !boundaries.has(region.branch)) {
          throw new Error(`Control region ${region.id} has an invalid for branch`);
        }
        const branch = instructionAt(instructionsByOffset, region, "branch", "JFALSE");
        if (branch.args[0] !== region.breakTarget) {
          throw new Error(`Control region ${region.id} has an invalid for exit`);
        }
      }
      const backedge = instructionAt(instructionsByOffset, region, "backedge", "JUMP");
      if (
        backedge.args[0] !== region.testStart ||
        region.continueTarget !== region.updateStart ||
        region.breakTarget !== region.end
      ) {
        throw new Error(`Control region ${region.id} has invalid for targets`);
      }
      requireOrdered(region, [
        "initStart",
        "initEnd",
        "testStart",
        "branch",
        "bodyStart",
        "bodyEnd",
        "updateStart",
        "updateEnd",
        "backedge",
      ]);
      break;
    }
    case "ForIn": {
      const branch = instructionAt(instructionsByOffset, region, "branch", "JFALSE");
      const backedge = instructionAt(instructionsByOffset, region, "backedge", "JUMP");
      const next = Array.from(instructionsByOffset.values()).find(
        (instruction) => instruction.end === region.branch
      );
      if (
        !next ||
        next.op !== "NEXTITER" ||
        branch.args[0] !== region.breakTarget ||
        backedge.args[0] !== region.testStart ||
        region.continueTarget !== region.testStart ||
        region.breakTarget !== region.end
      ) {
        throw new Error(`Control region ${region.id} has invalid for-in targets`);
      }
      requireOrdered(region, [
        "iteratorStart",
        "iteratorEnd",
        "testStart",
        "branch",
        "bodyStart",
        "bodyEnd",
        "backedge",
      ]);
      break;
    }
    case "Switch": {
      instructionAt(instructionsByOffset, region, "dispatchPop", "POP");
      const dispatchExit = instructionAt(instructionsByOffset, region, "dispatchExit", "JUMP");
      if (
        region.breakTarget !== region.end ||
        !Array.isArray(region.cases) ||
        dispatchExit.args[0] > region.end
      ) {
        throw new Error(`Control region ${region.id} has invalid switch metadata`);
      }
      let priorBody = region.dispatchExit;
      let defaults = 0;
      region.cases.forEach((caseRegion, index) => {
        if (!caseRegion || caseRegion.index !== index || typeof caseRegion.default !== "boolean") {
          throw new Error(`Control region ${region.id} has an invalid switch case`);
        }
        for (const field of ["bodyStart", "bodyEnd"]) {
          if (!Number.isInteger(caseRegion[field]) || !boundaries.has(caseRegion[field])) {
            throw new Error(`Control region ${region.id} case ${index} has invalid ${field}`);
          }
        }
        if (
          caseRegion.bodyStart < priorBody ||
          caseRegion.bodyEnd < caseRegion.bodyStart ||
          caseRegion.bodyEnd > region.end
        ) {
          throw new Error(`Control region ${region.id} case ${index} has invalid ordering`);
        }
        priorBody = caseRegion.bodyStart;
        if (caseRegion.default) {
          defaults += 1;
          if (caseRegion.testStart !== null || caseRegion.branch !== null) {
            throw new Error(`Control region ${region.id} default case has a test`);
          }
        } else {
          for (const field of ["testStart", "testEnd", "branch"]) {
            if (!Number.isInteger(caseRegion[field]) || !boundaries.has(caseRegion[field])) {
              throw new Error(`Control region ${region.id} case ${index} has invalid ${field}`);
            }
          }
          const branch = instructionAt(instructionsByOffset, caseRegion, "branch", "JCASE");
          if (branch.args[0] !== caseRegion.bodyStart) {
            throw new Error(`Control region ${region.id} case ${index} has an invalid target`);
          }
        }
      });
      if (defaults > 1) throw new Error(`Control region ${region.id} has multiple defaults`);
      break;
    }
    case "TryCatch": {
      const enter = instructionAt(instructionsByOffset, region, "tryEnter", "TRY");
      instructionAt(instructionsByOffset, region, "catchStart", "CATCH");
      instructionAt(instructionsByOffset, region, "catchBodyEnd", "ENDCATCH");
      const catchExit = instructionAt(instructionsByOffset, region, "catchExit", "JUMP");
      instructionAt(instructionsByOffset, region, "tryBodyEnd", "ENDTRY");
      if (
        enter.args[0] !== region.tryBodyStart ||
        catchExit.args[0] !== region.end ||
        region.tryExit !== region.tryBodyEnd
      ) {
        throw new Error(`Control region ${region.id} has invalid try/catch targets`);
      }
      requireOrdered(region, [
        "tryEnter",
        "catchStart",
        "catchBodyStart",
        "catchBodyEnd",
        "catchExit",
        "tryBodyStart",
        "tryBodyEnd",
      ]);
      break;
    }
    case "TryFinally": {
      if (typeof region.hasCatch !== "boolean") {
        throw new Error(`Control region ${region.id} has invalid hasCatch metadata`);
      }
      const enter = instructionAt(instructionsByOffset, region, "tryEnter", "TRY");
      const inner = instructionAt(instructionsByOffset, region, "innerTryEnter", "TRY");
      instructionAt(instructionsByOffset, region, "exceptionThrow", "THROW");
      instructionAt(instructionsByOffset, region, "catchStart", "CATCH");
      instructionAt(instructionsByOffset, region, "catchBodyEnd", "ENDCATCH");
      instructionAt(instructionsByOffset, region, "innerTryExit", "ENDTRY");
      const catchExit = instructionAt(instructionsByOffset, region, "catchExit", "JUMP");
      instructionAt(instructionsByOffset, region, "tryExit", "ENDTRY");
      if (
        enter.args[0] !== region.tryBodyStart ||
        inner.args[0] !== region.catchStart ||
        catchExit.args[0] !== region.finalizerStart ||
        region.tryBodyEnd !== region.tryExit ||
        region.exceptionalFinalizerEnd !== region.exceptionThrow ||
        region.finalizerEnd !== region.end
      ) {
        throw new Error(`Control region ${region.id} has invalid try/finally targets`);
      }
      requireOrdered(region, [
        "tryEnter",
        "innerTryEnter",
        "exceptionalFinalizerStart",
        "exceptionalFinalizerEnd",
        "exceptionThrow",
        "catchStart",
        "catchBodyStart",
        "catchBodyEnd",
        "innerTryExit",
        "catchExit",
        "tryBodyStart",
        "tryBodyEnd",
        "finalizerStart",
        "finalizerEnd",
      ]);
      break;
    }
    case "Label": {
      if (
        typeof region.label !== "string" ||
        region.bodyStart !== region.start ||
        region.bodyEnd !== region.end
      ) {
        throw new Error(`Control region ${region.id} has invalid label metadata`);
      }
      break;
    }
  }

  region.exits.forEach((exit) => {
    if (
      !exit ||
      !["break", "continue"].includes(exit.kind) ||
      !Number.isInteger(exit.offset) ||
      !boundaries.has(exit.offset)
    ) {
      throw new Error(`Control region ${region.id} has an invalid structured exit`);
    }
    const jump = instructionAt(instructionsByOffset, exit, "offset", "JUMP");
    const expected =
      exit.kind === "break"
        ? region.breakTarget === undefined
          ? region.end
          : region.breakTarget
        : region.continueTarget;
    if (!Number.isInteger(expected) || jump.args[0] !== expected) {
      throw new Error(`Control region ${region.id} has an invalid ${exit.kind} target`);
    }
  });
}

function verifyRegionNesting(regions, scopeId) {
  const ordered = regions
    .slice()
    .sort((left, right) => left.start - right.start || right.end - left.end || left.id - right.id);
  const stack = [];
  ordered.forEach((region) => {
    while (stack.length && region.start >= stack[stack.length - 1].end) stack.pop();
    if (stack.length && region.end > stack[stack.length - 1].end) {
      throw new Error(
        `Control regions ${stack[stack.length - 1].id} and ${
          region.id
        } partially overlap in scope ${scopeId}`
      );
    }
    stack.push(region);
  });
}

function verifyReuseProofs(scope) {
  const reuses = scope.instructions.filter(
    (instruction) =>
      !instruction.elided &&
      !instruction.unreachable &&
      instruction.optimized &&
      instruction.optimized.kind === "reuse"
  );
  if (!reuses.length) return;
  const cfg = buildSemanticCFG(scope);
  verifyCFG(cfg, scope);
  const blockByOffset = new Map();
  cfg.blocks.forEach((block) =>
    block.instructions.forEach((instruction) => {
      blockByOffset.set(instruction.offset, block);
    })
  );
  const instructionsByOffset = new Map(
    scope.instructions.map((instruction) => [instruction.offset, instruction])
  );

  reuses.forEach((use) => {
    const source = instructionsByOffset.get(use.optimized.sourceOffset);
    const sourceBlock = source && blockByOffset.get(source.offset);
    const useBlock = blockByOffset.get(use.offset);
    // A branch proof may make this use semantically unreachable one pass
    // before unreachable-code cleanup writes the HIR flag. Such an annotation
    // is never consumed by codegen and has no live proof obligation.
    if (useBlock && !cfg.reachable.has(useBlock.start)) return;
    if (!source || source.elided || source.unreachable || !sourceBlock || !useBlock) {
      throw new Error(`Reuse at ${use.offset} in scope ${scope.id} has no live source`);
    }
    const dominators = cfg.dominators.get(useBlock.start);
    if (
      !dominators ||
      !dominators.has(sourceBlock.start) ||
      (sourceBlock === useBlock && source.offset >= use.offset)
    ) {
      throw new Error(
        `Reuse source ${source.offset} does not semantically dominate ${use.offset} in scope ${scope.id}`
      );
    }

    const slot = use.args[0];
    const work = [
      {
        block: sourceBlock,
        index:
          sourceBlock.instructions.findIndex(
            (instruction) => instruction.offset === source.offset
          ) + 1,
        clobbered: false,
      },
    ];
    const seen = new Set();
    let reached = false;
    while (work.length) {
      const state = work.pop();
      const key = `${state.block.start}:${state.index}:${state.clobbered}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let clobbered = state.clobbered;
      let stopped = false;
      for (let index = state.index; index < state.block.instructions.length; index += 1) {
        const instruction = state.block.instructions[index];
        // A loop may execute the producer instruction again. The generated
        // temporary is refreshed at that dynamic instance, so no-clobber is
        // measured from the most recent source execution, not permanently
        // from the first trip through the loop.
        if (instruction.offset === source.offset) clobbered = false;
        if (instruction.offset === use.offset) {
          reached = true;
          if (clobbered) {
            throw new Error(
              `Reuse source ${source.offset} is clobbered before ${use.offset} in scope ${scope.id}`
            );
          }
          stopped = true;
          break;
        }
        if (
          !instruction.elided &&
          !instruction.unreachable &&
          LOCAL_WRITES.has(instruction.op) &&
          instruction.args[0] === slot
        ) {
          clobbered = true;
        }
      }
      if (stopped) continue;
      state.block.successors.forEach((target) => {
        const successor = cfg.byStart.get(target);
        if (successor) work.push({ block: successor, index: 0, clobbered });
      });
    }
    if (!reached) {
      throw new Error(
        `Reuse ${use.offset} is unreachable from source ${source.offset} in scope ${scope.id}`
      );
    }
  });
}

function proofLiteral(instruction) {
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

function independentlyEvaluateMIRConstants(mirScope) {
  const UNKNOWN = Object.freeze({ kind: "unknown" });
  const OVERDEFINED = Object.freeze({ kind: "overdefined" });
  const facts = new Map(
    mirScope.values.map((value) => [
      value.id,
      Object.prototype.hasOwnProperty.call(value, "constant")
        ? { kind: "constant", value: value.constant }
        : UNKNOWN,
    ])
  );
  function same(left, right) {
    return (
      left.kind === right.kind && (left.kind !== "constant" || Object.is(left.value, right.value))
    );
  }
  function join(left, right) {
    if (left.kind === "unknown") return right;
    if (right.kind === "unknown") return left;
    if (left.kind === "overdefined" || right.kind === "overdefined") return OVERDEFINED;
    return Object.is(left.value, right.value) ? left : OVERDEFINED;
  }
  function update(id, next) {
    const merged = join(facts.get(id), next);
    if (same(facts.get(id), merged)) return false;
    facts.set(id, merged);
    return true;
  }
  let changed = true;
  let iterations = 0;
  while (changed) {
    changed = false;
    if (iterations++ > Math.max(100, mirScope.blocks.length * mirScope.values.length * 2)) {
      throw new Error(`Branch fact verification did not converge in scope ${mirScope.id}`);
    }
    mirScope.blocks.forEach((block) => {
      block.phis.forEach((phi) => {
        const result = phi.inputs.reduce(
          (current, input) => join(current, facts.get(input.value)),
          UNKNOWN
        );
        if (update(phi.id, result)) changed = true;
      });
      block.operations.forEach((operation) => {
        if (
          !operation.outputs.length ||
          operation.outputs.every((output) => facts.get(output).kind === "constant")
        )
          return;
        const inputs = operation.inputs.map((input) => facts.get(input));
        const base = operation.op.split("_")[0];
        const folder = operation.inputs.length === 1 ? PROOF_UNARY[base] : PROOF_BINARY[base];
        if (folder && inputs.every((input) => input.kind === "constant")) {
          try {
            if (
              update(operation.outputs[0], {
                kind: "constant",
                value: folder(...inputs.map((input) => input.value)),
              })
            )
              changed = true;
          } catch (_) {
            operation.outputs.forEach((output) => {
              if (update(output, OVERDEFINED)) changed = true;
            });
          }
        } else if (!folder || inputs.some((input) => input.kind === "overdefined")) {
          operation.outputs.forEach((output) => {
            if (update(output, OVERDEFINED)) changed = true;
          });
        }
      });
    });
  }
  return facts;
}

function verifyOptimizedBranchProofs(scope) {
  const branches = scope.instructions.filter(
    (instruction) =>
      !instruction.elided &&
      !instruction.unreachable &&
      instruction.optimizedBranchTarget !== undefined
  );
  if (!branches.length) return;
  const needsMIR = branches.some(
    (branch) => branch.optimizedBranchProof && branch.optimizedBranchProof.kind === "sccp"
  );
  const mirOperations = new Map();
  let mirFacts = null;
  if (needsMIR) {
    const proofMIR = lowerScope(scope);
    mirFacts = independentlyEvaluateMIRConstants(proofMIR);
    proofMIR.blocks.forEach((block) =>
      block.operations.forEach((operation) => {
        mirOperations.set(operation.offset, operation);
      })
    );
  }
  branches.forEach((branch) => {
    const proof = branch.optimizedBranchProof;
    if (!proof || !["literal", "sccp"].includes(proof.kind)) {
      throw new Error(`Missing optimized branch proof at ${branch.offset} in scope ${scope.id}`);
    }
    const index = scope.instructions.indexOf(branch);
    const producer = scope.instructions[index - 1];
    let inputs;
    if (proof.kind === "literal") {
      const literal =
        producer && producer.end === branch.offset ? proofLiteral(producer) : { known: false };
      if (
        !["JTRUE", "JFALSE"].includes(branch.op) ||
        !literal.known ||
        proof.sourceOffset !== producer.offset ||
        !Object.is(proof.value, literal.value)
      ) {
        throw new Error(`Invalid optimized branch proof at ${branch.offset} in scope ${scope.id}`);
      }
      inputs = [proof.value];
    } else {
      const operation = mirOperations.get(branch.offset);
      const count = branch.op === "JCASE" ? 2 : 1;
      if (
        !operation ||
        operation.op !== branch.op ||
        !Array.isArray(proof.inputs) ||
        proof.inputs.length !== count ||
        operation.inputs.length !== count ||
        proof.inputs.some(
          (input, inputIndex) =>
            !input ||
            typeof input.valueId !== "string" ||
            !Object.prototype.hasOwnProperty.call(input, "value") ||
            input.valueId !== operation.inputs[inputIndex] ||
            !mirFacts.has(input.valueId) ||
            mirFacts.get(input.valueId).kind !== "constant" ||
            !Object.is(mirFacts.get(input.valueId).value, input.value)
        )
      ) {
        throw new Error(`Invalid optimized branch proof at ${branch.offset} in scope ${scope.id}`);
      }
      inputs = proof.inputs.map((input) => input.value);
    }
    const taken =
      branch.op === "JCASE"
        ? inputs[0] === inputs[1]
        : branch.op === "JTRUE"
        ? Boolean(inputs[0])
        : !Boolean(inputs[0]);
    const expected = taken ? branch.args[0] : branch.end;
    if (branch.optimizedBranchTarget !== expected) {
      throw new Error(`Invalid optimized branch proof at ${branch.offset} in scope ${scope.id}`);
    }
  });
}

function naturalLoopBlocks(cfg, loop) {
  const members = new Set([loop.header, loop.backedge]);
  const work = loop.backedge === loop.header ? [] : [loop.backedge];
  while (work.length) {
    const start = work.pop();
    const block = cfg.byStart.get(start);
    if (!block) continue;
    block.predecessors.forEach((predecessor) => {
      if (members.has(predecessor)) return;
      members.add(predecessor);
      if (predecessor !== loop.header) work.push(predecessor);
    });
  }
  return members;
}

function verifyLICMProofs(scope, scopesById, dynamicMemo) {
  const uses = scope.instructions.filter(
    (instruction) =>
      !instruction.elided &&
      !instruction.unreachable &&
      instruction.optimized &&
      instruction.optimized.kind === "licm"
  );
  const plans = scope.loopInvariantLoads || [];
  if (!Array.isArray(plans)) {
    throw new Error(`Invalid LICM plan in scope ${scope.id}`);
  }
  if (!uses.length) {
    if (plans.length) throw new Error(`Orphan LICM plan in scope ${scope.id}`);
    return;
  }
  const protectedFlow =
    (scope.controlRegions || []).some(
      (region) => region.kind === "TryCatch" || region.kind === "TryFinally"
    ) || (scope.syntheticRanges || []).some((range) => range.kind === "AbruptFinally");
  if (
    !scope.lightweight ||
    scope.script ||
    protectedFlow ||
    hasDynamicObserverChain(scope, scopesById, dynamicMemo)
  ) {
    throw new Error(`Scope ${scope.id} contains LICM in an observable environment`);
  }

  const cfg = buildNormalCFG(scope);
  verifyCFG(cfg, scope);
  const instructions = new Map(
    scope.instructions.map((instruction) => [instruction.offset, instruction])
  );
  const blockByOffset = new Map();
  cfg.blocks.forEach((block) =>
    block.instructions.forEach((instruction) => {
      blockByOffset.set(instruction.offset, block);
    })
  );
  const loops = cfg.loops.map((loop) => ({ ...loop, members: naturalLoopBlocks(cfg, loop) }));
  const planKeys = new Set();
  plans.forEach((plan) => {
    if (
      !plan ||
      !Number.isInteger(plan.header) ||
      !Number.isInteger(plan.localIndex) ||
      !Number.isInteger(plan.sourceOffset)
    ) {
      throw new Error(`Invalid LICM plan in scope ${scope.id}`);
    }
    const key = `${plan.header}:${plan.localIndex}:${plan.sourceOffset}`;
    if (planKeys.has(key)) throw new Error(`Duplicate LICM plan ${key} in scope ${scope.id}`);
    planKeys.add(key);
  });

  const usedPlans = new Set();
  uses.forEach((use) => {
    const annotation = use.optimized;
    const source = instructions.get(annotation.sourceOffset);
    const useBlock = blockByOffset.get(use.offset);
    const sourceBlock = source && blockByOffset.get(source.offset);
    const loop = loops.find(
      (candidate) =>
        candidate.header === annotation.header &&
        useBlock &&
        sourceBlock &&
        candidate.members.has(useBlock.start) &&
        candidate.members.has(sourceBlock.start)
    );
    const planKey = `${annotation.header}:${annotation.localIndex}:${annotation.sourceOffset}`;
    if (
      !loop ||
      !planKeys.has(planKey) ||
      !source ||
      source.elided ||
      source.unreachable ||
      !source.optimized ||
      source.optimized.kind !== "licm" ||
      source.optimized.header !== annotation.header ||
      source.optimized.localIndex !== annotation.localIndex ||
      source.optimized.sourceOffset !== annotation.sourceOffset ||
      !(annotation.localIndex > scope.parameterCount || scope.strict) ||
      !cfg.dominators.get(useBlock.start).has(loop.header)
    ) {
      throw new Error(`Invalid LICM proof at ${use.offset} in scope ${scope.id}`);
    }
    for (const start of loop.members) {
      const block = cfg.byStart.get(start);
      if (
        block.instructions.some(
          (instruction) =>
            !instruction.elided &&
            !instruction.unreachable &&
            LOCAL_WRITES.has(instruction.op) &&
            instruction.args[0] === annotation.localIndex
        )
      ) {
        throw new Error(
          `LICM slot ${annotation.localIndex} is written in loop ${loop.header} in scope ${scope.id}`
        );
      }
    }
    usedPlans.add(planKey);
  });
  if (usedPlans.size !== planKeys.size) {
    throw new Error(`Orphan LICM plan in scope ${scope.id}`);
  }
}

const PROVENANCE_ALLOCATIONS = new Set(["NEWARRAY", "NEWOBJECT", "NEWREGEXP", "CLOSURE"]);
const PROVENANCE_GETS = new Set(["GETLOCAL", "GETLOCAL2"]);
const PROVENANCE_SETS = new Set(["SETLOCAL", "SETLOCAL2"]);
const PROVENANCE_DELETES = new Set(["DELLOCAL", "DELLOCAL2"]);
const RETURN_SAFE_PRODUCERS = new Set([
  "THIS",
  "UNDEF",
  "NULL",
  "TRUE",
  "FALSE",
  "INTEGER",
  "NUMBER",
  "STRING",
]);
const UNPROVEN_GUEST = Object.freeze({ marked: false, scopeId: null });
const PROVEN_GUEST = Object.freeze({ marked: true, scopeId: null });

function sameGuestState(left, right) {
  if (!left || !right || left.size !== right.size) return false;
  return Array.from(left.entries()).every(([slot, state]) => {
    const other = right.get(slot);
    return other && other.marked === state.marked && other.scopeId === state.scopeId;
  });
}

function independentlyReturnSafe(scope) {
  if (!scope.lightweight || scope.script) return false;
  const targets = new Set();
  scope.instructions.forEach((instruction) => {
    if (["JUMP", "JTRUE", "JFALSE", "JCASE"].includes(instruction.op)) {
      targets.add(instruction.args[0]);
    }
  });
  (scope.controlRegions || []).forEach((region) =>
    Object.values(region).forEach((value) => {
      if (Number.isInteger(value)) targets.add(value);
    })
  );
  const live = scope.instructions.filter(
    (instruction) => !instruction.elided && !instruction.unreachable
  );
  for (let index = 0; index < live.length; index += 1) {
    if (live[index].op !== "RETURN") continue;
    const producer = live[index - 1];
    if (
      !producer ||
      !RETURN_SAFE_PRODUCERS.has(producer.op) ||
      producer.optimized ||
      targets.has(producer.offset)
    )
      return false;
  }
  return true;
}

function independentlyProvenGuestOffsets(mirScope, returnSafeByScopeId) {
  const values = new Map(mirScope.values.map((value) => [value.id, value]));
  const operations = new Map();
  const blockByOffset = new Map();
  mirScope.blocks.forEach((block) =>
    block.operations.forEach((operation) => {
      operations.set(operation.offset, operation);
      blockByOffset.set(operation.offset, block.start);
    })
  );
  const phiState = new Map();
  const entryState = new Map();
  const exitState = new Map();
  const loadStates = new Map();
  const cap = Math.max(100, mirScope.blocks.length * mirScope.blocks.length * 4);

  function allocationState(operation) {
    return operation.op === "CLOSURE"
      ? { marked: true, scopeId: operation.args[0].id }
      : PROVEN_GUEST;
  }
  function inputState(valueId, localValues) {
    if (localValues.has(valueId)) return localValues.get(valueId);
    const value = values.get(valueId);
    if (!value) return UNPROVEN_GUEST;
    if (value.definition.kind === "Phi") return phiState.get(valueId) || UNPROVEN_GUEST;
    if (value.definition.kind === "Operation") {
      const operation = operations.get(value.definition.offset);
      if (operation && PROVENANCE_ALLOCATIONS.has(operation.op)) return allocationState(operation);
    }
    return UNPROVEN_GUEST;
  }
  function mergeEntry(block) {
    if (!block.predecessors.length) return new Map();
    const predecessorStates = block.predecessors
      .map((predecessor) => exitState.get(predecessor))
      .filter(Boolean);
    if (!predecessorStates.length) return new Map();
    const slots = new Set(predecessorStates.flatMap((state) => Array.from(state.keys())));
    const merged = new Map();
    slots.forEach((slot) => {
      const states = predecessorStates.map((state) => state.get(slot) || UNPROVEN_GUEST);
      const marked = states.every((state) => state.marked);
      const scopeId =
        marked && states.every((state) => state.scopeId === states[0].scopeId)
          ? states[0].scopeId
          : null;
      merged.set(slot, marked ? { marked: true, scopeId } : UNPROVEN_GUEST);
    });
    return merged;
  }
  function walk(block, entry) {
    const slots = new Map(entry);
    const localValues = new Map();
    const loads = new Map();
    const news = new Set();
    block.operations.forEach((operation) => {
      if (PROVENANCE_SETS.has(operation.op)) {
        slots.set(operation.args[0], inputState(operation.inputs[0], localValues));
      } else if (PROVENANCE_DELETES.has(operation.op)) {
        slots.set(operation.args[0], UNPROVEN_GUEST);
      } else if (PROVENANCE_GETS.has(operation.op)) {
        const state = slots.get(operation.args[0]) || UNPROVEN_GUEST;
        localValues.set(operation.outputs[0], state);
        loads.set(operation.offset, state);
      } else if (operation.op === "NEW") {
        const constructor = inputState(operation.inputs[0], localValues);
        const state =
          constructor.scopeId != null && returnSafeByScopeId.get(constructor.scopeId)
            ? PROVEN_GUEST
            : UNPROVEN_GUEST;
        localValues.set(operation.outputs[0], state);
        if (state.marked) news.add(operation.offset);
      }
    });
    return { slots, loads, news };
  }

  let outerChanged = true;
  let outerIterations = 0;
  while (outerChanged) {
    outerChanged = false;
    if (outerIterations++ > cap) {
      throw new Error(`Guest proof did not converge in scope ${mirScope.id}`);
    }
    let changed = true;
    let iterations = 0;
    while (changed) {
      changed = false;
      if (iterations++ > cap)
        throw new Error(`Guest proof did not converge in scope ${mirScope.id}`);
      mirScope.blocks.forEach((block) => {
        const entry = mergeEntry(block);
        const result = walk(block, entry);
        loadStates.set(block.start, result.loads);
        if (!sameGuestState(entryState.get(block.start), entry)) {
          entryState.set(block.start, entry);
          changed = true;
        }
        if (!sameGuestState(exitState.get(block.start), result.slots)) {
          exitState.set(block.start, result.slots);
          changed = true;
        }
      });
    }
    mirScope.blocks.forEach((block) =>
      block.phis.forEach((phi) => {
        const states = phi.inputs.map((input) => {
          const value = values.get(input.value);
          if (value.definition.kind === "Phi") return phiState.get(input.value) || UNPROVEN_GUEST;
          if (value.definition.kind !== "Operation") return UNPROVEN_GUEST;
          const operation = operations.get(value.definition.offset);
          if (PROVENANCE_ALLOCATIONS.has(operation.op)) return allocationState(operation);
          if (PROVENANCE_GETS.has(operation.op)) {
            const perBlock = loadStates.get(blockByOffset.get(operation.offset));
            return (perBlock && perBlock.get(operation.offset)) || UNPROVEN_GUEST;
          }
          return UNPROVEN_GUEST;
        });
        const marked = states.length > 0 && states.every((state) => state.marked);
        const scopeId =
          marked && states.every((state) => state.scopeId === states[0].scopeId)
            ? states[0].scopeId
            : null;
        const next = marked ? { marked: true, scopeId } : UNPROVEN_GUEST;
        const current = phiState.get(phi.id);
        if (!current || current.marked !== next.marked || current.scopeId !== next.scopeId) {
          phiState.set(phi.id, next);
          outerChanged = true;
        }
      })
    );
  }

  const proven = new Set();
  mirScope.blocks.forEach((block) => {
    const result = walk(block, entryState.get(block.start) || new Map());
    result.loads.forEach((state, offset) => {
      if (state.marked) proven.add(offset);
    });
    result.news.forEach((offset) => proven.add(offset));
  });
  return proven;
}

function verifyGuestObjectProofs(scope, scopesById, dynamicMemo) {
  const marked = scope.instructions.filter(
    (instruction) =>
      !instruction.elided && !instruction.unreachable && instruction.guestObjectOutput
  );
  if (!marked.length) return;
  const protectedFlow = (scope.controlRegions || []).some(
    (region) => region.kind === "TryCatch" || region.kind === "TryFinally"
  );
  if (protectedFlow || hasDynamicObserverChain(scope, scopesById, dynamicMemo)) {
    throw new Error(`Scope ${scope.id} contains a guest-object proof in an observable environment`);
  }
  const returnSafe = new Map(
    Array.from(scopesById, ([id, candidate]) => [id, independentlyReturnSafe(candidate)])
  );
  const proven = independentlyProvenGuestOffsets(lowerScope(scope), returnSafe);
  marked.forEach((instruction) => {
    if (!proven.has(instruction.offset)) {
      throw new Error(`Invalid guest-object proof at ${instruction.offset} in scope ${scope.id}`);
    }
  });
}

const DYNAMIC_OBSERVER_OPS = new Set(["WITH", "ENDWITH", "EVAL", "CATCH", "ENDCATCH"]);

function hasDynamicObserverChain(scope, scopesById, memo) {
  if (memo.has(scope.id)) return memo.get(scope.id);
  const parent = scope.parentId == null ? null : scopesById.get(scope.parentId);
  const result =
    scope.instructions.some((instruction) => DYNAMIC_OBSERVER_OPS.has(instruction.op)) ||
    (parent != null && hasDynamicObserverChain(parent, scopesById, memo));
  memo.set(scope.id, result);
  return result;
}

function optimizedLoadConsumesSlot(instruction) {
  if (!instruction.optimized) return true;
  return instruction.optimized.kind === "reuse";
}

function verifyElidedStoreProofs(scope, scopesById, dynamicMemo) {
  const stores = scope.instructions.filter(
    (instruction) =>
      instruction.elided &&
      !instruction.unreachable &&
      (instruction.op === "SETLOCAL" || instruction.op === "SETLOCAL2")
  );
  if (!stores.length) return;
  const protectedFlow =
    (scope.controlRegions || []).some(
      (region) => region.kind === "TryCatch" || region.kind === "TryFinally"
    ) || (scope.syntheticRanges || []).some((range) => range.kind === "AbruptFinally");
  if (
    !scope.lightweight ||
    scope.script ||
    protectedFlow ||
    hasDynamicObserverChain(scope, scopesById, dynamicMemo)
  ) {
    throw new Error(`Scope ${scope.id} contains an elided store in an observable environment`);
  }

  const cfg = buildSemanticCFG(scope, { analyze: false });
  verifyCFG(cfg, scope);
  const blockByOffset = new Map();
  cfg.blocks.forEach((block) =>
    block.instructions.forEach((instruction) => {
      blockByOffset.set(instruction.offset, block);
    })
  );

  stores.forEach((store) => {
    const slot = store.args[0];
    if (!(slot > scope.parameterCount || scope.strict)) {
      throw new Error(
        `Elided store ${store.offset} in scope ${scope.id} can be observed through mapped arguments`
      );
    }
    const sourceBlock = blockByOffset.get(store.offset);
    if (!sourceBlock || !cfg.reachable.has(sourceBlock.start)) return;
    const work = [
      {
        block: sourceBlock,
        index:
          sourceBlock.instructions.findIndex((instruction) => instruction.offset === store.offset) +
          1,
      },
    ];
    const seen = new Set();
    while (work.length) {
      const state = work.pop();
      const key = `${state.block.start}:${state.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let killed = false;
      for (let index = state.index; index < state.block.instructions.length; index += 1) {
        const instruction = state.block.instructions[index];
        if (instruction.unreachable) continue;
        if (
          ["GETLOCAL", "GETLOCAL2"].includes(instruction.op) &&
          instruction.args[0] === slot &&
          !instruction.elided &&
          optimizedLoadConsumesSlot(instruction)
        ) {
          throw new Error(
            `Elided store ${store.offset} is read at ${instruction.offset} in scope ${scope.id}`
          );
        }
        if (
          ["SETLOCAL", "SETLOCAL2"].includes(instruction.op) &&
          instruction.args[0] === slot &&
          !instruction.elided
        ) {
          killed = true;
          break;
        }
      }
      if (killed) continue;
      state.block.successors.forEach((target) => {
        const successor = cfg.byStart.get(target);
        if (successor) work.push({ block: successor, index: 0 });
      });
    }
  });
}

function verifyScope(
  scope,
  scopeIds,
  scopesById = new Map([[scope.id, scope]]),
  dynamicMemo = new Map()
) {
  if (!scope || scope.kind !== "FunctionHIR") throw new Error("Invalid FunctionHIR node");
  const boundaries = new Set([scope.codeLength]);
  let previousEnd = 0;

  scope.instructions.forEach((instruction) => {
    if (instruction.offset !== previousEnd) {
      throw new Error(`Non-contiguous HIR in scope ${scope.id} at ${instruction.offset}`);
    }
    const spec = OpSpec.byName[instruction.op];
    if (!spec) throw new Error(`Unknown HIR operation ${instruction.op}`);
    if (instruction.args.length !== spec.operands.length) {
      throw new Error(`Wrong operand count for ${instruction.op} in scope ${scope.id}`);
    }
    boundaries.add(instruction.offset);
    previousEnd = instruction.end;
  });

  scope.instructions.forEach((instruction, index) => {
    if (instruction.op !== "NEXTITER") return;
    const next = scope.instructions[index + 1];
    if (!next || !["JTRUE", "JFALSE"].includes(next.op) || instruction.end !== next.offset) {
      throw new Error(
        `NEXTITER at ${instruction.offset} in scope ${scope.id} must be immediately followed by JTRUE/JFALSE`
      );
    }
  });

  if (previousEnd !== scope.codeLength) {
    throw new Error(`HIR length mismatch in scope ${scope.id}`);
  }

  scope.instructions.forEach((instruction) => {
    const spec = OpSpec.byName[instruction.op];
    spec.operands.forEach((type, index) => {
      const value = instruction.args[index];
      if (type === "jumpTarget" && !boundaries.has(value)) {
        throw new Error(
          `Jump from ${instruction.offset} targets the middle of an instruction: ${value}`
        );
      }
      if ((type === "functionIndex" || type === "evalIndex") && value !== -1) {
        if (!value || !scopeIds.has(value.id)) {
          throw new Error(`Invalid nested scope reference from scope ${scope.id}`);
        }
      }
    });
  });

  scope.dynamicFunctions.forEach((dynamicScope) => {
    if (dynamicScope !== -1 && (!dynamicScope || !scopeIds.has(dynamicScope.id))) {
      throw new Error(`Invalid dynamic function reference from scope ${scope.id}`);
    }
  });

  if (!Array.isArray(scope.controlRegions)) {
    throw new Error(`Missing control-region metadata in scope ${scope.id}`);
  }
  const instructionsByOffset = new Map(
    scope.instructions.map((instruction) => [instruction.offset, instruction])
  );
  const regionIds = new Set();
  scope.controlRegions.forEach((region) => {
    if (
      !region ||
      !Number.isInteger(region.id) ||
      regionIds.has(region.id) ||
      ![
        "If",
        "Conditional",
        "Logical",
        "While",
        "DoWhile",
        "For",
        "ForIn",
        "Switch",
        "TryCatch",
        "TryFinally",
        "Label",
      ].includes(region.kind)
    ) {
      throw new Error(`Invalid control region in scope ${scope.id}`);
    }
    regionIds.add(region.id);
    if (!boundaries.has(region.start) || !boundaries.has(region.end) || region.end < region.start) {
      throw new Error(`Invalid ${region.kind} region range in scope ${scope.id}`);
    }
    Object.keys(region).forEach((key) => {
      if (["id", "kind"].includes(key) || region[key] === null) return;
      if (typeof region[key] === "number" && key !== "id" && !boundaries.has(region[key])) {
        throw new Error(`Control region ${region.id} ${key} is not an instruction boundary`);
      }
    });
    verifyRegionShape(region, boundaries, instructionsByOffset);
  });
  verifyRegionNesting(scope.controlRegions, scope.id);
  if (!Array.isArray(scope.syntheticRanges)) {
    throw new Error(`Missing synthetic-range metadata in scope ${scope.id}`);
  }
  scope.syntheticRanges.forEach((range) => {
    if (
      !range ||
      range.kind !== "AbruptFinally" ||
      !boundaries.has(range.start) ||
      !boundaries.has(range.end) ||
      range.end <= range.start
    ) {
      throw new Error(`Invalid synthetic range in scope ${scope.id}`);
    }
    const owners = scope.controlRegions.filter(
      (region) =>
        region.kind === "TryFinally" && region.start <= range.start && range.end <= region.end
    );
    if (!owners.length) {
      throw new Error(
        `Synthetic range ${range.id} has no owning TryFinally region in scope ${scope.id}`
      );
    }
  });
  scope.instructions.forEach((instruction) => {
    if (instruction.optimizedBranchTarget !== undefined) {
      if (
        !["JTRUE", "JFALSE", "JCASE"].includes(instruction.op) ||
        !boundaries.has(instruction.optimizedBranchTarget) ||
        ![instruction.args[0], instruction.end].includes(instruction.optimizedBranchTarget)
      ) {
        throw new Error(`Invalid optimized branch at ${instruction.offset} in scope ${scope.id}`);
      }
    }
    if (
      instruction.guestObjectOutput &&
      !["GETLOCAL", "GETLOCAL2", "NEW"].includes(instruction.op)
    ) {
      throw new Error(`Invalid guest-object proof at ${instruction.offset} in scope ${scope.id}`);
    }
    if (!instruction.optimized) return;
    const annotation = instruction.optimized;
    if (!annotation || typeof annotation.kind !== "string") {
      throw new Error(
        `Invalid optimization annotation at ${instruction.offset} in scope ${scope.id}`
      );
    }
    if (annotation.kind === "literal" || annotation.kind === "duplicate") return;
    if (annotation.kind === "drop-inputs") {
      if (!Number.isInteger(annotation.count) || annotation.count < 0) {
        throw new Error(
          `Invalid drop-inputs annotation at ${instruction.offset} in scope ${scope.id}`
        );
      }
      return;
    }
    if (annotation.kind === "reuse" || annotation.kind === "licm") {
      const source = instructionsByOffset.get(annotation.sourceOffset);
      const localIndex = annotation.kind === "licm" ? annotation.localIndex : instruction.args[0];
      if (
        !source ||
        !["GETLOCAL", "GETLOCAL2"].includes(instruction.op) ||
        !["GETLOCAL", "GETLOCAL2"].includes(source.op) ||
        source.args[0] !== localIndex ||
        instruction.args[0] !== localIndex
      ) {
        throw new Error(
          `Invalid ${annotation.kind} source at ${instruction.offset} in scope ${scope.id}`
        );
      }
      if (annotation.kind === "licm" && !boundaries.has(annotation.header)) {
        throw new Error(`Invalid LICM header at ${instruction.offset} in scope ${scope.id}`);
      }
      return;
    }
    throw new Error(
      `Unknown optimization annotation ${annotation.kind} at ${instruction.offset} in scope ${scope.id}`
    );
  });

  verifyReuseProofs(scope);
  verifyOptimizedBranchProofs(scope);
  verifyLICMProofs(scope, scopesById, dynamicMemo);
  verifyElidedStoreProofs(scope, scopesById, dynamicMemo);
  verifyGuestObjectProofs(scope, scopesById, dynamicMemo);

  return true;
}

function verifyProgram(program) {
  if (!program || program.kind !== "ProgramHIR" || !Array.isArray(program.scopes)) {
    throw new TypeError("Invalid ProgramHIR");
  }
  const ids = new Set(program.scopes.map((scope) => scope.id));
  if (ids.size !== program.scopes.length || !ids.has(program.entry)) {
    throw new Error("ProgramHIR has duplicate scopes or an invalid entry scope");
  }
  const scopesById = new Map(program.scopes.map((scope) => [scope.id, scope]));
  const dynamicMemo = new Map();
  program.scopes.forEach((scope) => verifyScope(scope, ids, scopesById, dynamicMemo));
  return true;
}

module.exports = { verifyProgram, verifyScope };
