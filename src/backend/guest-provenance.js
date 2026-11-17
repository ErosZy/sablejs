"use strict";

// Guest-object provenance: proves which GETLOCAL loads produce guest-created
// objects (object/array/regexp literals and closures) so sandbox property
// writes to them can skip writeTarget resolution — the dominant sandbox-tax
// lever (write-dominated workloads spend hundreds of millions of
// per-write WeakMap + protected-set lookups on provably local objects).
//
// The mark seeds at the allocate ops (NEWARRAY/NEWOBJECT/NEWREGEXP/CLOSURE),
// flows only through SETLOCAL slots and phi joins (AND meet), and is written
// back onto the HIR as `instruction.guestObjectOutput = true` on
// GETLOCAL/GETLOCAL2 and NEW, which codegen replays as a "guest-object"
// temporary origin. Nothing unmarked ever takes the fast path: a marked value
// is guest-created by construction, hence never a wrapper, a capability
// token, or a protected intrinsic, so writeTarget would be a no-op for it.
//
// NEW marking (v2): a NEW's output is marked iff its constructor is a marked
// value whose provenance pins the constructor to a single CLOSURE scope, and
// that scope is return-safe — every live RETURN returns this/undefined/null/a
// primitive, so `new` always yields the fresh object rather than a value the
// constructor returned. Return-safety is deliberately static and coarse:
// constructor code with a single risky RETURN (a GETVAR result, a jump
// target as producer, any optimized producer) forfeits the mark entirely.
//
// Marked-value stability: allocate ops are never folded, never DCE'd, and
// never copy-propagated, and NEW results are never rewritten either. The pass
// runs after the final literal and CFG peepholes against freshly rebuilt MIR,
// so no later transform can stale a mark.
//
// Deliberately NOT marked: `new Array(...)` and friends. Standard intrinsic
// names are imported as globals through OBJECT_DEFINE_PROPERTY at instance
// creation, so a host can inject a hostile constructor under the same name;
// a static mark would let a protected/mediated result take the unguarded
// write path.

const { lowerToMIR, verifyMIR } = require("../ir/mir");
const { hasDynamicChain, hasProtectedControlFlow } = require("./scope-effects");

function analysisMIR(hirProgram, stats, existingMIR) {
  if (existingMIR) {
    verifyMIR(existingMIR, hirProgram);
    return existingMIR;
  }
  const mir = lowerToMIR(hirProgram);
  if (stats.mir) stats.mir.builds += 1;
  verifyMIR(mir, hirProgram);
  return mir;
}

const ALLOCATE_OPS = new Set(["NEWARRAY", "NEWOBJECT", "NEWREGEXP", "CLOSURE"]);
const SET_OPS = new Set(["SETLOCAL", "SETLOCAL2"]);
const GET_OPS = new Set(["GETLOCAL", "GETLOCAL2"]);
const DEL_OPS = new Set(["DELLOCAL", "DELLOCAL2"]);
const NEW_OPS = new Set(["NEW"]);

// A value state is { marked, scopeId }: marked means "provably guest-created
// object or closure", scopeId pins the value to closures of exactly one
// scope (null when the value is an object literal or the pin is lost).
const UNMARKED = { marked: false, scopeId: null };
const OBJECT_MARK = { marked: true, scopeId: null };

function allocationState(operation) {
  return operation.op === "CLOSURE" ? { marked: true, scopeId: operation.args[0].id } : OBJECT_MARK;
}

function sameState(left, right) {
  if (!left || !right) return false;
  if (left.size !== right.size) return false;
  return Array.from(left.entries()).every(([index, state]) => {
    const other = right.get(index);
    return other != null && other.marked === state.marked && other.scopeId === state.scopeId;
  });
}

function analyzeScope(mirScope, returnSafeByScopeId) {
  const values = new Map(mirScope.values.map((value) => [value.id, value]));
  const opsByOffset = new Map();
  const blockByOffset = new Map();
  mirScope.blocks.forEach((block) =>
    block.operations.forEach((operation) => {
      opsByOffset.set(operation.offset, operation);
      blockByOffset.set(operation.offset, block.start);
    })
  );
  const cap = Math.max(100, mirScope.blocks.length * mirScope.blocks.length * 4);

  // Phi states persist across outer iterations and only grow (monotone):
  // a phi is marked iff every input is marked, and its scopeId pin survives
  // only while every input pins the same scope.
  const phiState = new Map();
  // Complete per-block slot states (localIndex -> state). Entry states are
  // the AND meet of predecessor exit states; absent slots are unmarked.
  const entryState = new Map();
  const exitState = new Map();
  const getLocalStateByBlock = new Map();

  // State of a value in the current outer iteration. Same-block outputs are
  // recorded by the walk itself (SSA dominance guarantees they precede their
  // uses); cross-block values are phis, which consult phiState.
  function inputState(valueId, slots, valueState) {
    if (valueState.has(valueId)) return valueState.get(valueId);
    const definition = values.get(valueId).definition;
    if (definition.kind === "Phi") return phiState.get(valueId) || UNMARKED;
    if (definition.kind === "Operation") {
      const operation = opsByOffset.get(definition.offset);
      if (ALLOCATE_OPS.has(operation.op)) return allocationState(operation);
      if (GET_OPS.has(operation.op)) return valueState.get(valueId) || UNMARKED;
    }
    return UNMARKED;
  }

  function walk(block, entry) {
    const slots = new Map(entry);
    const valueState = new Map();
    const getLocalState = new Map();
    const newMarked = new Set();
    block.operations.forEach((operation) => {
      if (SET_OPS.has(operation.op)) {
        slots.set(operation.args[0], inputState(operation.inputs[0], slots, valueState));
      } else if (DEL_OPS.has(operation.op)) {
        slots.set(operation.args[0], UNMARKED);
      } else if (GET_OPS.has(operation.op)) {
        const state = slots.get(operation.args[0]) || UNMARKED;
        valueState.set(operation.outputs[0], state);
        getLocalState.set(operation.offset, state);
      } else if (NEW_OPS.has(operation.op)) {
        // inputs[0] is the constructor (stack order: constructor, args...).
        const constructor = inputState(operation.inputs[0], slots, valueState);
        const returnSafe =
          constructor.scopeId != null && returnSafeByScopeId.get(constructor.scopeId) === true;
        const state = returnSafe ? OBJECT_MARK : UNMARKED;
        valueState.set(operation.outputs[0], state);
        if (returnSafe) newMarked.add(operation.offset);
      }
    });
    return { slots, getLocalState, newMarked };
  }

  function mergeEntry(block) {
    const merged = new Map();
    block.predecessors.forEach((predecessor) => {
      const exit = exitState.get(predecessor);
      if (!exit) return;
      exit.forEach((state, index) => {
        const previous = merged.get(index);
        const scopeId =
          previous != null && previous.scopeId === state.scopeId ? state.scopeId : null;
        merged.set(index, {
          marked: previous ? previous.marked && state.marked : state.marked,
          scopeId: previous != null ? scopeId : state.scopeId,
        });
      });
    });
    return merged;
  }

  // Outer loop: grow phi states (monotone), then re-solve the slot flow with
  // them. Terminates because each outer iteration adds at least one phi mark
  // or refines a phi's scopeId pin, and both are bounded.
  let outerChanged = true;
  let outerIterations = 0;
  while (outerChanged) {
    outerChanged = false;
    outerIterations += 1;
    if (outerIterations > cap) {
      throw new Error(`guest-object provenance did not converge in scope ${mirScope.id}`);
    }

    let changed = true;
    let iterations = 0;
    while (changed) {
      changed = false;
      iterations += 1;
      if (iterations > cap) {
        throw new Error(`guest-object provenance did not converge in scope ${mirScope.id}`);
      }
      mirScope.blocks.forEach((block) => {
        const entry = mergeEntry(block);
        const result = walk(block, entry);
        getLocalStateByBlock.set(block.start, result.getLocalState);
        const entryChanged = !sameState(entryState.get(block.start), entry);
        const exitChanged = !sameState(exitState.get(block.start), result.slots);
        if (!entryChanged && !exitChanged) return;
        entryState.set(block.start, entry);
        exitState.set(block.start, result.slots);
        changed = true;
      });
    }

    let phiChanged = true;
    while (phiChanged) {
      phiChanged = false;
      mirScope.blocks.forEach((block) => {
        block.phis.forEach((phi) => {
          const joined = { marked: true, scopeId: null };
          let first = true;
          phi.inputs.forEach((input) => {
            const state = (() => {
              const definition = values.get(input.value).definition;
              if (definition.kind === "Phi") return phiState.get(input.value) || UNMARKED;
              if (definition.kind === "Operation") {
                const operation = opsByOffset.get(definition.offset);
                if (ALLOCATE_OPS.has(operation.op)) return allocationState(operation);
                if (GET_OPS.has(operation.op)) {
                  const perBlock = getLocalStateByBlock.get(blockByOffset.get(operation.offset));
                  return (perBlock && perBlock.get(operation.offset)) || UNMARKED;
                }
              }
              return UNMARKED;
            })();
            if (!state.marked) joined.marked = false;
            if (first) {
              joined.scopeId = state.scopeId;
              first = false;
            } else if (state.scopeId !== joined.scopeId) {
              joined.scopeId = null;
            }
          });
          const current = phiState.get(phi.id);
          if (current && current.marked === joined.marked && current.scopeId === joined.scopeId)
            return;
          phiState.set(phi.id, joined.marked ? joined : UNMARKED);
          phiChanged = true;
          outerChanged = true;
        });
      });
    }
  }

  // Final deterministic walk with the converged entry states; collect the
  // marked GETLOCAL and NEW offsets for the HIR writeback.
  const markedOffsets = new Set();
  const markedNews = new Set();
  mirScope.blocks.forEach((block) => {
    const result = walk(block, entryState.get(block.start) || new Map());
    result.getLocalState.forEach((state, offset) => {
      if (state.marked) markedOffsets.add(offset);
    });
    result.newMarked.forEach((offset) => markedNews.add(offset));
  });
  return { markedOffsets, markedNews };
}

// Producers of RETURN that provably return a non-object value. `new` yields
// the fresh object for those (this/undefined/null/primitives are replaced by
// the constructed instance); any other producer forfeits the constructor's
// mark.
const RETURN_SAFE_OPS = new Set([
  "THIS",
  "UNDEF",
  "NULL",
  "TRUE",
  "FALSE",
  "INTEGER",
  "NUMBER",
  "STRING",
]);

// A constructor is return-safe when every live RETURN's value producer is a
// non-object literal that no jump can enter with a different stack. Jump
// targets are every branch argument plus every structured-region boundary
// offset: both are places control can land without executing the producer.
function returnSafeAnalysis(hirScope) {
  if (!hirScope.lightweight || hirScope.script) return false;
  const jumpTargets = new Set();
  hirScope.instructions.forEach((instruction) => {
    if (["JUMP", "JTRUE", "JFALSE", "JCASE"].includes(instruction.op)) {
      jumpTargets.add(instruction.args[0]);
    }
  });
  (hirScope.controlRegions || []).forEach((region) => {
    Object.values(region).forEach((value) => {
      if (typeof value === "number" && Number.isInteger(value)) jumpTargets.add(value);
    });
  });
  const live = hirScope.instructions.filter(
    (instruction) => !instruction.elided && !instruction.unreachable
  );
  for (let index = 0; index < live.length; index += 1) {
    const instruction = live[index];
    if (instruction.op !== "RETURN") continue;
    const producer = live[index - 1];
    if (
      !producer ||
      !RETURN_SAFE_OPS.has(producer.op) ||
      producer.optimized ||
      jumpTargets.has(producer.offset)
    ) {
      return false;
    }
  }
  return true;
}

function runGuestProvenance(hirProgram, stats, existingMIR) {
  const mir = analysisMIR(hirProgram, stats, existingMIR);
  const scopesById = new Map(hirProgram.scopes.map((scope) => [scope.id, scope]));
  const dynamicChainMemo = new Map();
  const returnSafeByScopeId = new Map();
  hirProgram.scopes.forEach((scope) => {
    returnSafeByScopeId.set(scope.id, returnSafeAnalysis(scope));
  });
  let markedLoads = 0;
  let markedNews = 0;
  let scopesSkipped = 0;
  mir.scopes.forEach((mirScope) => {
    const hirScope = hirProgram.scopes.find((scope) => scope.id === mirScope.id);
    if (!hirScope) return;
    if (
      hasDynamicChain(hirScope, scopesById, dynamicChainMemo) ||
      hasProtectedControlFlow(hirScope)
    ) {
      scopesSkipped += 1;
      return;
    }
    const instructions = new Map(
      hirScope.instructions.map((instruction) => [instruction.offset, instruction])
    );
    const { markedOffsets, markedNews: newsOffsets } = analyzeScope(mirScope, returnSafeByScopeId);
    markedOffsets.forEach((offset) => {
      const instruction = instructions.get(offset);
      if (instruction) {
        instruction.guestObjectOutput = true;
        markedLoads += 1;
      }
    });
    newsOffsets.forEach((offset) => {
      const instruction = instructions.get(offset);
      if (instruction) {
        instruction.guestObjectOutput = true;
        markedNews += 1;
      }
    });
  });
  stats.guestProvenance = { markedLoads, markedNews, scopesSkipped };
  return mir;
}

module.exports = { runGuestProvenance };
