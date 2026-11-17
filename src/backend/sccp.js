"use strict";

const { lowerToMIR, verifyMIR } = require("../ir/mir");

const OVERDEFINED = Object.freeze({ kind: "Overdefined" });
const UNKNOWN = Object.freeze({ kind: "Unknown" });
const BINARY = {
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
const UNARY = {
  POS: (value) => +value,
  NEG: (value) => -value,
  BITNOT: (value) => ~value,
  LOGNOT: (value) => !value,
  TYPEOF: (value) => typeof value,
};

function constant(value) {
  return { kind: "Constant", value };
}

function sameLattice(left, right) {
  return (
    left.kind === right.kind && (left.kind !== "Constant" || Object.is(left.value, right.value))
  );
}

function join(left, right) {
  if (left.kind === "Unknown") return right;
  if (right.kind === "Unknown") return left;
  if (left.kind === "Overdefined" || right.kind === "Overdefined") return OVERDEFINED;
  return Object.is(left.value, right.value) ? left : OVERDEFINED;
}

function operationFolder(operation) {
  const base = operation.op.split("_")[0];
  return operation.inputs.length === 1 ? UNARY[base] : BINARY[base];
}

function analyzeScope(scope) {
  const values = new Map(
    scope.values.map((value) => [
      value.id,
      Object.prototype.hasOwnProperty.call(value, "constant") ? constant(value.constant) : UNKNOWN,
    ])
  );
  const blocks = new Map(scope.blocks.map((block) => [block.start, block]));
  const executableBlocks = new Set(scope.entry === null ? [] : [scope.entry]);
  const executableEdges = new Set();
  let changed = true;
  let iterations = 0;

  function update(id, next) {
    const current = values.get(id);
    const merged = join(current, next);
    if (!sameLattice(current, merged)) {
      values.set(id, merged);
      changed = true;
    }
  }

  function markEdge(source, target) {
    const key = `${source}->${target}`;
    if (!executableEdges.has(key)) {
      executableEdges.add(key);
      executableBlocks.add(target);
      changed = true;
    }
  }

  while (changed) {
    changed = false;
    if (iterations++ > Math.max(100, scope.blocks.length * scope.values.length * 2)) {
      throw new Error(`SCCP did not converge in scope ${scope.id}`);
    }
    for (const block of scope.blocks) {
      if (!executableBlocks.has(block.start)) continue;
      for (const phi of block.phis) {
        let result = UNKNOWN;
        for (const input of phi.inputs) {
          if (executableEdges.has(`${input.block}->${block.start}`)) {
            result = join(result, values.get(input.value));
          }
        }
        update(phi.id, result);
      }

      for (const operation of block.operations) {
        if (!operation.outputs.length) continue;
        const existingConstants = operation.outputs.map((output) => values.get(output));
        if (existingConstants.every((value) => value.kind === "Constant")) continue;
        const inputs = operation.inputs.map((input) => values.get(input));
        const folder = operationFolder(operation);
        if (folder && inputs.every((input) => input.kind === "Constant")) {
          try {
            update(operation.outputs[0], constant(folder(...inputs.map((input) => input.value))));
          } catch (_) {
            operation.outputs.forEach((output) => update(output, OVERDEFINED));
          }
        } else if (!folder || inputs.some((input) => input.kind === "Overdefined")) {
          operation.outputs.forEach((output) => update(output, OVERDEFINED));
        }
      }

      const terminator = block.operations[block.operations.length - 1];
      let selected = null;
      if (terminator && ["JTRUE", "JFALSE"].includes(terminator.op)) {
        const condition = values.get(terminator.inputs[0]);
        if (condition.kind === "Constant") {
          const taken =
            terminator.op === "JTRUE" ? Boolean(condition.value) : !Boolean(condition.value);
          selected = taken ? terminator.args[0] : terminator.end;
        }
      } else if (terminator && terminator.op === "JCASE") {
        const [left, right] = terminator.inputs.map((input) => values.get(input));
        if (left.kind === "Constant" && right.kind === "Constant") {
          selected = left.value === right.value ? terminator.args[0] : terminator.end;
        }
      }
      if (selected !== null && blocks.has(selected)) {
        markEdge(block.start, selected);
      } else {
        block.successors.forEach((target) => markEdge(block.start, target));
      }
    }
  }

  return { values, executableBlocks, executableEdges };
}

// Independent, deliberately less powerful branch-proof analysis: every Phi
// input participates, including SCCP-inexecutible edges. SCCP may discover
// more constants, but a control-flow rewrite is emitted only when this
// path-insensitive must-proof agrees. Lost folds are a safe product bailout.
function conservativeConstantFacts(scope) {
  const values = new Map(
    scope.values.map((value) => [
      value.id,
      Object.prototype.hasOwnProperty.call(value, "constant") ? constant(value.constant) : UNKNOWN,
    ])
  );
  function update(id, next) {
    const current = values.get(id);
    const merged = join(current, next);
    if (sameLattice(current, merged)) return false;
    values.set(id, merged);
    return true;
  }
  let changed = true;
  let iterations = 0;
  while (changed) {
    changed = false;
    if (iterations++ > Math.max(100, scope.blocks.length * scope.values.length * 2)) {
      throw new Error(`SCCP branch proof did not converge in scope ${scope.id}`);
    }
    scope.blocks.forEach((block) => {
      block.phis.forEach((phi) => {
        const result = phi.inputs.reduce(
          (current, input) => join(current, values.get(input.value)),
          UNKNOWN
        );
        if (update(phi.id, result)) changed = true;
      });
      block.operations.forEach((operation) => {
        if (
          !operation.outputs.length ||
          operation.outputs.every((output) => values.get(output).kind === "Constant")
        )
          return;
        const inputs = operation.inputs.map((input) => values.get(input));
        const folder = operationFolder(operation);
        if (folder && inputs.every((input) => input.kind === "Constant")) {
          try {
            if (
              update(operation.outputs[0], constant(folder(...inputs.map((input) => input.value))))
            )
              changed = true;
          } catch (_) {
            operation.outputs.forEach((output) => {
              if (update(output, OVERDEFINED)) changed = true;
            });
          }
        } else if (!folder || inputs.some((input) => input.kind === "Overdefined")) {
          operation.outputs.forEach((output) => {
            if (update(output, OVERDEFINED)) changed = true;
          });
        }
      });
    });
  }
  return values;
}

// Branch annotations themselves change CFG predecessor sets and can therefore
// canonicalize a later branch input from a Phi ID to its sole producer ID.
// Rebind every retained proof against the post-annotation MIR. If the current
// all-predecessor facts no longer prove the same successor, discard that
// candidate and repeat: removing one branch can expand a later Phi again.
function refreshBranchProofs(hirProgram) {
  const retained = hirProgram.scopes.reduce(
    (total, scope) =>
      total +
      scope.instructions.filter(
        (instruction) =>
          instruction.optimizedBranchProof && instruction.optimizedBranchProof.kind === "sccp"
      ).length,
    0
  );
  if (retained === 0) return 0;
  let removed = 0;
  let changed = true;
  let iterations = 0;
  while (changed) {
    changed = false;
    if (
      iterations++ >
      hirProgram.scopes.reduce((total, scope) => total + scope.instructions.length, 0)
    ) {
      throw new Error("SCCP branch proof refresh did not converge");
    }
    const mir = lowerToMIR(hirProgram);
    verifyMIR(mir, hirProgram);
    mir.scopes.forEach((scope) => {
      const facts = conservativeConstantFacts(scope);
      const operations = new Map(
        scope.blocks
          .flatMap((block) => block.operations)
          .map((operation) => [operation.offset, operation])
      );
      const hirScope = hirProgram.scopes.find((candidate) => candidate.id === scope.id);
      hirScope.instructions.forEach((instruction) => {
        if (!instruction.optimizedBranchProof || instruction.optimizedBranchProof.kind !== "sccp")
          return;
        const operation = operations.get(instruction.offset);
        const inputs = operation && operation.inputs.map((input) => facts.get(input));
        const proved =
          operation &&
          operation.op === instruction.op &&
          inputs.length === (operation.op === "JCASE" ? 2 : 1) &&
          inputs.every((input) => input && input.kind === "Constant");
        let expected = null;
        if (proved) {
          const taken =
            operation.op === "JCASE"
              ? inputs[0].value === inputs[1].value
              : operation.op === "JTRUE"
              ? Boolean(inputs[0].value)
              : !Boolean(inputs[0].value);
          expected = taken ? operation.args[0] : operation.end;
        }
        if (!proved || expected !== instruction.optimizedBranchTarget) {
          delete instruction.optimizedBranchTarget;
          delete instruction.optimizedBranchProof;
          removed += 1;
          changed = true;
          return;
        }
        instruction.optimizedBranchProof.inputs = operation.inputs.map((input, index) => ({
          valueId: input,
          value: inputs[index].value,
        }));
      });
    });
  }
  return removed;
}

function runSCCP(hirProgram, stats, existingMIR) {
  const mir = existingMIR || lowerToMIR(hirProgram);
  if (!existingMIR && stats.mir) stats.mir.builds += 1;
  verifyMIR(mir, hirProgram);
  let propagated = 0;
  let branches = 0;
  let executableBlocks = 0;
  mir.scopes.forEach((scope) => {
    const result = analyzeScope(scope);
    const retainedFacts = conservativeConstantFacts(scope);
    executableBlocks += result.executableBlocks.size;
    const valueById = new Map(scope.values.map((value) => [value.id, value]));
    result.values.forEach((lattice, id) => {
      const original = valueById.get(id);
      if (
        lattice.kind === "Constant" &&
        !Object.prototype.hasOwnProperty.call(original, "constant")
      ) {
        propagated += 1;
      }
    });
    const hirScope = hirProgram.scopes.find((candidate) => candidate.id === scope.id);
    scope.blocks.forEach((block) => {
      if (!result.executableBlocks.has(block.start)) return;
      const terminator = block.operations[block.operations.length - 1];
      if (!terminator || !["JTRUE", "JFALSE", "JCASE"].includes(terminator.op)) return;
      const outgoing = block.successors.filter((target) =>
        result.executableEdges.has(`${block.start}->${target}`)
      );
      if (outgoing.length !== 1 || block.successors.length <= 1) return;
      if (
        !terminator.inputs.every((input) => {
          const retained = retainedFacts.get(input);
          const sccp = result.values.get(input);
          return (
            retained &&
            sccp &&
            retained.kind === "Constant" &&
            sccp.kind === "Constant" &&
            Object.is(retained.value, sccp.value)
          );
        })
      )
        return;
      const instruction = hirScope.instructions.find(
        (candidate) => candidate.offset === terminator.offset
      );
      if (instruction && instruction.optimizedBranchTarget === undefined) {
        instruction.optimizedBranchTarget = outgoing[0];
        instruction.optimizedBranchProof = {
          kind: "sccp",
          inputs: terminator.inputs.map((input) => ({
            valueId: input,
            value: result.values.get(input).value,
          })),
        };
        branches += 1;
      }
    });
  });
  if (branches > 0) branches -= refreshBranchProofs(hirProgram);
  stats.sccp = { constantsPropagated: propagated, branchesFolded: branches, executableBlocks };
  return mir;
}

module.exports = { analyzeScope, conservativeConstantFacts, refreshBranchProofs, runSCCP };
