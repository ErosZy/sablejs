"use strict";

const OpSpec = require("./op-spec");

function assertTableIndex(table, index, type, scopeId, offset) {
  if (!Number.isInteger(index) || index < 0 || index >= table.length) {
    throw new Error(`Invalid ${type} ${index} in scope ${scopeId} at bytecode offset ${offset}`);
  }
}

function resolveOperand(type, value, scope, scopeId, offset, decodeNested) {
  switch (type) {
    case "numberIndex":
      assertTableIndex(scope.nt, value, type, scopeId, offset);
      return Number(scope.nt[value]);
    case "stringIndex":
      assertTableIndex(scope.st, value, type, scopeId, offset);
      return scope.st[value];
    case "functionIndex":
      assertTableIndex(scope.ft, value, type, scopeId, offset);
      return decodeNested(scope.ft[value]);
    case "evalIndex":
      assertTableIndex(scope.et, value, type, scopeId, offset);
      return scope.et[value] === -1 ? -1 : decodeNested(scope.et[value]);
    case "jumpTarget":
    case "localIndex":
    case "count":
    case "line":
    case "column":
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(
          `Invalid ${type} ${value} in scope ${scopeId} at bytecode offset ${offset}`
        );
      }
      return value;
    default:
      throw new Error(`Unknown operand type ${type}`);
  }
}

function decodeProgram(rootScope) {
  let nextScopeId = 0;
  const scopes = [];
  const seen = new Map();

  function decodeScope(scope, parentId = null) {
    if (seen.has(scope)) return seen.get(scope);
    if (!scope || !Array.isArray(scope.opcode)) {
      throw new TypeError("Expected a compiler scope with an opcode array");
    }

    const hir = {
      kind: "FunctionHIR",
      id: nextScopeId++,
      parentId,
      name: scope.name || "",
      script: !!scope.script,
      strict: !!scope.strict,
      lightweight: !!scope.lightweight,
      usesArguments: !!scope.arguments,
      parameterCount: scope.numparams || 0,
      parameters: (scope.ps || []).slice(),
      variables: (scope.vt || []).slice(),
      dynamicFunctions: [],
      controlRegions: (scope.controlRegions || []).map((region) => ({
        ...region,
        exits: (region.exits || []).map((exit) => ({ ...exit })),
        cases: (region.cases || []).map((caseRegion) => ({ ...caseRegion })),
      })),
      syntheticRanges: (scope.syntheticRanges || []).map((range) => ({ ...range })),
      // Frontend-attached descriptor for synthetic eval/Function sources
      // (see src/frontend/compiler.js): { text, lines, columns } mapping the
      // parsed synthetic text to the guest-recognizable source. Absent for
      // ordinary root/lexical scopes.
      syntheticSource: scope.syntheticSource || null,
      instructions: [],
      codeLength: scope.opcode.length,
    };
    seen.set(scope, hir);
    scopes.push(hir);
    const decodeNested = (nestedScope) => decodeScope(nestedScope, hir.id);

    let offset = 0;
    while (offset < scope.opcode.length) {
      const code = scope.opcode[offset];
      const spec = OpSpec.byCode[code];
      if (!spec) {
        throw new Error(`Unknown opcode ${code} in scope ${hir.id} at bytecode offset ${offset}`);
      }

      const end = offset + 1 + spec.operands.length;
      if (end > scope.opcode.length) {
        throw new Error(`Truncated ${spec.name} in scope ${hir.id} at bytecode offset ${offset}`);
      }

      const rawArgs = scope.opcode.slice(offset + 1, end);
      const args = rawArgs.map((value, index) =>
        resolveOperand(spec.operands[index], value, scope, hir.id, offset, decodeNested)
      );
      hir.instructions.push({
        kind: "Op",
        offset,
        end,
        op: spec.name,
        args,
        rawArgs,
      });
      offset = end;
    }

    hir.dynamicFunctions = (scope.dft || []).map((dynamicScope) =>
      dynamicScope === -1 ? -1 : decodeScope(dynamicScope)
    );

    return hir;
  }

  const entry = decodeScope(rootScope);
  return { kind: "ProgramHIR", version: 1, entry: entry.id, scopes };
}

module.exports = decodeProgram;
