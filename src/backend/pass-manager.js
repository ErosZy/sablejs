"use strict";

const { verifyProgram } = require("../ir/verify");
const { monotonicNow } = require("../platform");

function liveInstructionCount(program) {
  return program.scopes.reduce(
    (total, scope) =>
      total +
      scope.instructions.reduce(
        (count, instruction) => count + (instruction.elided || instruction.unreachable ? 0 : 1),
        0
      ),
    0
  );
}

const INSTRUCTION_MUTATIONS = [
  "elided",
  "unreachable",
  "optimized",
  "optimizedBranchTarget",
  "optimizedBranchProof",
  "guestObjectOutput",
];

function cloneData(value) {
  if (Array.isArray(value)) return value.map(cloneData);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneData(entry)]));
  }
  return value;
}

function restoreData(target, snapshot) {
  Object.keys(target).forEach((key) => delete target[key]);
  Object.entries(snapshot).forEach(([key, value]) => {
    target[key] = cloneData(value);
  });
}

function captureCandidate(program) {
  return program.scopes.map((scope) => ({
    scope,
    loopInvariantLoads: Object.prototype.hasOwnProperty.call(scope, "loopInvariantLoads")
      ? cloneData(scope.loopInvariantLoads)
      : undefined,
    hadLoopInvariantLoads: Object.prototype.hasOwnProperty.call(scope, "loopInvariantLoads"),
    instructions: scope.instructions.map((instruction) => ({
      instruction,
      fields: Object.fromEntries(
        INSTRUCTION_MUTATIONS.map((field) => [
          field,
          {
            present: Object.prototype.hasOwnProperty.call(instruction, field),
            value: cloneData(instruction[field]),
          },
        ])
      ),
    })),
  }));
}

function restoreCandidate(snapshot) {
  snapshot.forEach((scopeState) => {
    if (scopeState.hadLoopInvariantLoads) {
      scopeState.scope.loopInvariantLoads = scopeState.loopInvariantLoads;
    } else {
      delete scopeState.scope.loopInvariantLoads;
    }
    scopeState.instructions.forEach(({ instruction, fields }) => {
      Object.entries(fields).forEach(([field, state]) => {
        if (state.present) instruction[field] = state.value;
        else delete instruction[field];
      });
    });
  });
}

class PassManager {
  constructor(program, stats, options = {}) {
    this.program = program;
    this.stats = stats;
    this.trace = typeof options.tracePasses === "function" ? options.tracePasses : null;
    this.generation = 0;
    this.analyses = new Map();
    this.stats.analysis = {
      generation: 0,
      rebuilds: [],
      rollbacks: 0,
      bailouts: [],
    };
  }

  setAnalysis(name, value, reason = "pass-output") {
    this.analyses.set(name, { value, generation: this.generation });
    this.stats.analysis.rebuilds.push({
      name,
      generation: this.generation + 1,
      reason,
    });
  }

  getAnalysis(name) {
    const analysis = this.analyses.get(name);
    if (!analysis || analysis.generation !== this.generation) {
      throw new Error(`Analysis ${name} is stale or unavailable at generation ${this.generation}`);
    }
    return analysis.value;
  }

  run(name, transform, contract) {
    if (!contract || !Array.isArray(contract.preserves) || !Array.isArray(contract.invalidates)) {
      throw new Error(`Pass ${name} must declare preserves and invalidates`);
    }
    this.analyses.forEach((_analysis, analysisName) => {
      if (
        !contract.preserves.includes(analysisName) &&
        !contract.invalidates.includes(analysisName)
      ) {
        throw new Error(`Pass ${name} does not declare analysis ${analysisName}`);
      }
    });
    const before = liveInstructionCount(this.program);
    const startedAt = monotonicNow();
    const candidate = captureCandidate(this.program);
    const analysesBefore = new Map(this.analyses);
    const statsBefore = cloneData(this.stats);
    try {
      transform(this.program, this.stats);
      verifyProgram(this.program);
    } catch (error) {
      restoreCandidate(candidate);
      this.analyses = analysesBefore;
      restoreData(this.stats, statsBefore);
      this.stats.analysis.rollbacks += 1;
      if (contract.failureMode === "rollback") {
        const reason = contract.bailoutReason || "candidate-verification-failed";
        this.stats.analysis.bailouts.push({
          pass: name,
          reason,
          ...(Number.isInteger(error.scopeId) ? { scopeId: error.scopeId } : {}),
          ...(typeof error.code === "string" ? { diagnosticCode: error.code } : {}),
        });
        return { name, committed: false, bailedOut: true, reason };
      }
      throw error;
    }
    const nextGeneration = this.generation + 1;
    this.analyses.forEach((analysis, analysisName) => {
      if (contract.preserves.includes(analysisName)) analysis.generation = nextGeneration;
      else if (contract.invalidates.includes(analysisName)) this.analyses.delete(analysisName);
    });
    this.generation = nextGeneration;
    this.stats.analysis.generation = this.generation;
    const after = liveInstructionCount(this.program);
    const pass = {
      name,
      generation: this.generation,
      preserves: contract.preserves.slice(),
      invalidates: contract.invalidates.slice(),
      durationMs: monotonicNow() - startedAt,
      nodesBefore: before,
      nodesAfter: after,
      nodesChanged: after - before,
    };
    this.stats.passes.push(pass);
    if (this.trace) this.trace(pass);
    return pass;
  }
}

module.exports = { PassManager, liveInstructionCount };
