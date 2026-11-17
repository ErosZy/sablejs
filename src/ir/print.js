"use strict";

// Human-readable IR dumps for the generated-code inspection mode
// (`compile({ dumpDir })`). Prints the HIR and MIR exactly as codegen and the
// backend consume them: every scope, instruction, and block is listed in
// offset order, annotated with whatever the passes recorded (elided,
// unreachable, constant folds, branch rewrites, guest-object marks). Pure
// string builders — writing the files is the compiler's job.

function formatArgs(args) {
  return args
    .map((arg) => {
      if (typeof arg === "number") return arg;
      // The CLOSURE operand is the nested scope object; print a reference, not
      // the whole scope graph.
      if (arg && arg.kind === "FunctionHIR") {
        return `scope:${JSON.stringify(arg.name)} #${arg.id}`;
      }
      return JSON.stringify(arg);
    })
    .join(", ");
}

function instructionLine(instruction) {
  const annotations = [];
  if (instruction.elided) annotations.push("elided");
  if (instruction.unreachable) annotations.push("unreachable");
  if (instruction.optimized) {
    if (instruction.optimized.kind === "literal") {
      annotations.push(`literal=${formatArgs([instruction.optimized.value])}`);
    }
  }
  if (instruction.optimizedBranchTarget !== undefined) {
    const proof = instruction.optimizedBranchProof && instruction.optimizedBranchProof.kind;
    annotations.push(`branch->${instruction.optimizedBranchTarget}${proof ? `:${proof}` : ""}`);
  }
  if (instruction.guestObjectOutput) annotations.push("guest");
  const line =
    `${String(instruction.offset).padStart(6)}  ${instruction.op}` +
    (instruction.args.length ? ` ${formatArgs(instruction.args)}` : "");
  return annotations.length ? `${line}  ; ${annotations.join(" ")}` : line;
}

function printScope(scope) {
  const lines = [];
  lines.push(
    `scope ${JSON.stringify(scope.name)} #${scope.id}` +
      (scope.parentId != null ? ` parent=#${scope.parentId}` : "") +
      ` codeLength=${scope.codeLength}`
  );
  scope.instructions.forEach((instruction) => lines.push(`  ${instructionLine(instruction)}`));
  if (scope.controlRegions && scope.controlRegions.length) {
    lines.push("  control regions:");
    scope.controlRegions.forEach((region) => {
      lines.push(
        `    ${region.kind} ${region.start}..${region.end}` +
          (region.entry != null ? ` entry=${region.entry}` : "") +
          (region.exit != null ? ` exit=${region.exit}` : "")
      );
    });
  }
  if (scope.syntheticRanges && scope.syntheticRanges.length) {
    lines.push(
      `  synthetic temp ranges: ${scope.syntheticRanges
        .map((range) => `${range.start}..${range.end}`)
        .join(", ")}`
    );
  }
  return lines.join("\n");
}

function printProgram(program) {
  const lines = [
    `ProgramHIR version=${program.version} entry=#${program.entry} scopes=${program.scopes.length}`,
  ];
  program.scopes.forEach((scope) => {
    lines.push("");
    lines.push(printScope(scope));
  });
  return `${lines.join("\n")}\n`;
}

function valueLabel(value) {
  const definition = value.definition;
  const detail =
    definition.kind === "Operation"
      ? `Operation@${definition.offset}`
      : definition.kind === "Phi"
      ? `Phi@${definition.block}`
      : `Exception@${definition.offset}`;
  return `#${value.id} ${value.type}${
    value.constant !== undefined ? ` const=${formatArgs([value.constant])}` : ""
  } def=${detail}`;
}

function printMirScope(scope) {
  const lines = [];
  lines.push(`mir scope #${scope.id} blocks=${scope.blocks.length} values=${scope.values.length}`);
  scope.blocks.forEach((block) => {
    lines.push(
      `  block ${block.start}..${block.end}` +
        (block.predecessors.length ? ` pred=[${block.predecessors.join(",")}]` : "") +
        (block.successors.length ? ` succ=[${block.successors.join(",")}]` : "")
    );
    block.phis.forEach((phi) => {
      lines.push(
        `    phi #${phi.id} slot=${phi.slot} <- [${phi.inputs
          .map((input) => `${input.block}:#${input.value}`)
          .join(", ")}]`
      );
    });
    block.operations.forEach((operation) => {
      lines.push(
        `    ${String(operation.offset).padStart(6)}  ${operation.op}` +
          (operation.inputs.length ? ` in=[${operation.inputs.join(",")}]` : "") +
          (operation.outputs.length ? ` out=[${operation.outputs.join(",")}]` : "")
      );
    });
  });
  lines.push("  values:");
  scope.values.forEach((value) => lines.push(`    ${valueLabel(value)}`));
  return lines.join("\n");
}

function printMIR(mir) {
  const lines = ["MIR scopes=" + mir.scopes.length];
  mir.scopes.forEach((scope) => {
    lines.push("");
    lines.push(printMirScope(scope));
  });
  return `${lines.join("\n")}\n`;
}

function printCFG(programCFG) {
  const scopes = programCFG.scopes || [programCFG];
  const lines = [`CFG edgeModel=${programCFG.edgeModel || "semantic"} scopes=${scopes.length}`];
  scopes.forEach((cfg) => {
    lines.push("");
    lines.push(
      `cfg scope #${cfg.scopeId} entry=${cfg.entry == null ? "none" : cfg.entry}` +
        ` blocks=${cfg.blocks.length}`
    );
    cfg.blocks.forEach((block) => {
      lines.push(
        `  block ${block.start}..${block.end}` +
          (cfg.reachable.has(block.start) ? " reachable" : " unreachable")
      );
      block.edges.forEach((edge) => {
        const annotations = [
          `class=${edge.class || "normal"}`,
          `kind=${edge.kind}`,
          `completion=${edge.completion || "normal"}`,
        ];
        if (edge.ownerRegion != null) annotations.push(`region=${edge.ownerRegion}`);
        if (edge.resumeTarget != null) annotations.push(`resume=${edge.resumeTarget}`);
        if (edge.sourceOffset != null) annotations.push(`source=${edge.sourceOffset}`);
        lines.push(`    -> ${edge.target} ${annotations.join(" ")}`);
      });
    });
  });
  return `${lines.join("\n")}\n`;
}

module.exports = { printProgram, printMIR, printCFG };
