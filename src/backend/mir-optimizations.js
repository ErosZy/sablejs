"use strict";

const { lowerToMIR, verifyMIR } = require("../ir/mir");
const { solveBackward } = require("./dataflow");
const { buildNormalCFG, buildSemanticCFG, verifyCFG } = require("../ir/cfg");
const { hasDynamicChain, hasProtectedControlFlow, hasWithEvalChain } = require("./scope-effects");

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function constant(value) {
  return { known: true, value };
}

function unknown() {
  return { known: false };
}

function instructionMap(scope) {
  return new Map(scope.instructions.map((instruction) => [instruction.offset, instruction]));
}

// Locals in a lightweight function are backed by a private array and cannot be
// observed by with/eval or captured closures. Parameters are deliberately
// excluded in sloppy mode because the mapped `arguments` object can alias
// them; in strict mode `arguments` is unmapped and `fn.arguments`/`fn.caller`
// are poison-pill accessors, so no aliasing path exists and parameters are
// propagable like any private local.
function canPropagateLocal(scope, index) {
  if (!scope.lightweight || scope.script) return false;
  return index > scope.parameterCount || scope.strict;
}

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

function runCopyPropagation(hirProgram, stats, existingMIR) {
  const mir = analysisMIR(hirProgram, stats, existingMIR);
  let propagated = 0;

  mir.scopes.forEach((mirScope) => {
    const hirScope = hirProgram.scopes.find((scope) => scope.id === mirScope.id);
    const instructions = instructionMap(hirScope);
    const baseValues = new Map(
      mirScope.values.map((value) => [
        value.id,
        own(value, "constant") ? constant(value.constant) : unknown(),
      ])
    );

    // Start with an empty environment in every block. This is intentionally
    // intra-block until local memory Phi nodes are introduced.
    mirScope.blocks.forEach((block) => {
      const locals = new Map();
      const values = new Map(baseValues);
      block.operations.forEach((operation) => {
        if (["GETLOCAL", "GETLOCAL2"].includes(operation.op)) {
          const index = operation.args[0];
          const local = locals.get(index);
          if (canPropagateLocal(hirScope, index) && local && local.known) {
            const instruction = instructions.get(operation.offset);
            instruction.optimized = { kind: "literal", value: local.value };
            operation.outputs.forEach((output) => values.set(output, local));
            propagated += 1;
          }
          return;
        }

        if (["SETLOCAL", "SETLOCAL2"].includes(operation.op)) {
          const index = operation.args[0];
          if (!canPropagateLocal(hirScope, index)) {
            locals.delete(index);
            return;
          }
          const input = values.get(operation.inputs[0]) || unknown();
          if (input.known) locals.set(index, input);
          else locals.delete(index);
          return;
        }

        if (["DELLOCAL", "DELLOCAL2"].includes(operation.op)) {
          locals.delete(operation.args[0]);
        }
      });
    });
  });

  stats.copyPropagation = { constantsPropagated: propagated };
  return mir;
}

function runLocalCSE(hirProgram, stats, existingMIR) {
  const mir = analysisMIR(hirProgram, stats, existingMIR);
  let eliminated = 0;

  mir.scopes.forEach((mirScope) => {
    const hirScope = hirProgram.scopes.find((scope) => scope.id === mirScope.id);
    if (!hirScope.lightweight || hirScope.script) return;
    const instructions = instructionMap(hirScope);

    mirScope.blocks.forEach((block) => {
      let previous = null;
      block.operations.forEach((operation) => {
        if (operation.op === "LOC") return;
        if (
          ["GETLOCAL", "GETLOCAL2"].includes(operation.op) &&
          previous &&
          previous.op === operation.op &&
          previous.args[0] === operation.args[0]
        ) {
          const instruction = instructions.get(operation.offset);
          if (!instruction.optimized) {
            instruction.optimized = { kind: "duplicate" };
            eliminated += 1;
          }
        }
        previous = operation;
      });
    });
  });

  stats.localCSE = { loadsEliminated: eliminated };
  return mir;
}

function sameAvailable(left, right) {
  if (left === right) return true;
  if (left === null || right === null || left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

function meetAvailable(predecessors, outgoing) {
  let result = null;
  for (const predecessor of predecessors) {
    const available = outgoing.get(predecessor);
    // Whole-state null is uninitialized, so cyclic regions wait rather than
    // expose a provisional producer. This intentionally sacrifices some loop
    // reuse until a bounded per-slot lattice/worklist replaces it.
    if (available === null) return null;
    if (result === null) {
      result = new Map(available);
      continue;
    }
    for (const [index, offset] of result) {
      if (available.get(index) !== offset) result.delete(index);
    }
  }
  return result;
}

function transferAvailable(block, incoming, hirInstructions, annotate, eligibleLocal) {
  if (incoming === null) return null;
  const available = new Map(incoming);
  const operations = block.operations || block.instructions;
  operations.forEach((operation) => {
    if (operation.elided || operation.unreachable) return;
    if (["SETLOCAL", "SETLOCAL2", "DELLOCAL", "DELLOCAL2"].includes(operation.op)) {
      available.delete(operation.args[0]);
      return;
    }
    if (!["GETLOCAL", "GETLOCAL2"].includes(operation.op)) return;
    const instruction = hirInstructions.get(operation.offset);
    const index = operation.args[0];
    if (!eligibleLocal(index)) return;
    const producer = available.get(index);
    if (producer !== undefined && annotate && instruction && !instruction.optimized) {
      instruction.optimized = { kind: "reuse", sourceOffset: producer };
    } else if (producer === undefined) {
      available.set(index, operation.offset);
    }
  });
  return available;
}

// This is a conservative memory-aware GVN slice for private function locals.
// A value number remains available across blocks only when every predecessor
// carries the exact same dominating load and no path writes that local.
function runGlobalValueNumbering(hirProgram, stats, existingMIR) {
  const mir = analysisMIR(hirProgram, stats, existingMIR);
  let loadsEliminated = 0;
  let crossBlockLoadsEliminated = 0;
  let scopesSkipped = 0;
  let semanticScopes = 0;
  const scopesById = new Map(hirProgram.scopes.map((scope) => [scope.id, scope]));
  const withEvalMemo = new Map();

  mir.scopes.forEach((mirScope) => {
    const hirScope = hirProgram.scopes.find((scope) => scope.id === mirScope.id);
    if (!hirScope.lightweight || hirScope.script) return;
    // With/eval can mutate a function binding through name lookup without a
    // SETLOCAL operation. Real catch bodies likewise use a dynamic binding
    // environment. A catch-free TryFinally's synthetic empty catch is safe:
    // semantic CFG edges model its actual try/finally execution directly.
    const hasRealCatch = (hirScope.controlRegions || []).some(
      (region) => region.kind === "TryCatch" || (region.kind === "TryFinally" && region.hasCatch)
    );
    if (hasWithEvalChain(hirScope, scopesById, withEvalMemo) || hasRealCatch) {
      scopesSkipped += 1;
      return;
    }
    const needsSemanticCFG =
      (hirScope.controlRegions || []).some(
        (region) => region.kind === "TryCatch" || region.kind === "TryFinally"
      ) || (hirScope.syntheticRanges || []).some((range) => range.kind === "AbruptFinally");
    // Without an in-scope handler/finalizer, a throwing edge exits the scope
    // and cannot rejoin a later local load. Normal CFG is therefore the full
    // proof domain and avoids needlessly splitting large ordinary graphs at
    // every mayThrow operation.
    const valueCFG = needsSemanticCFG ? buildSemanticCFG(hirScope) : buildNormalCFG(hirScope);
    verifyCFG(valueCFG, hirScope);
    if (needsSemanticCFG) semanticScopes += 1;
    const reachable = valueCFG.reachable;
    const instructions = instructionMap(hirScope);
    const incoming = new Map();
    const outgoing = new Map();
    valueCFG.blocks.forEach((block) => {
      incoming.set(block.start, block.start === valueCFG.entry ? new Map() : null);
      outgoing.set(block.start, block.start === valueCFG.entry ? new Map() : null);
    });

    let changed = true;
    let iterations = 0;
    while (changed) {
      changed = false;
      if (iterations++ > Math.max(100, valueCFG.blocks.length * valueCFG.blocks.length * 2)) {
        throw new Error(`GVN did not converge in scope ${mirScope.id}`);
      }
      valueCFG.blocks.forEach((block) => {
        if (!reachable.has(block.start)) return;
        const nextIncoming =
          block.start === valueCFG.entry
            ? new Map()
            : meetAvailable(
                block.predecessors.filter((predecessor) => reachable.has(predecessor)),
                outgoing
              );
        const nextOutgoing = transferAvailable(block, nextIncoming, instructions, false, (index) =>
          canPropagateLocal(hirScope, index)
        );
        if (!sameAvailable(incoming.get(block.start), nextIncoming)) {
          incoming.set(block.start, nextIncoming);
          changed = true;
        }
        if (!sameAvailable(outgoing.get(block.start), nextOutgoing)) {
          outgoing.set(block.start, nextOutgoing);
          changed = true;
        }
      });
    }

    const blockForOffset = new Map();
    valueCFG.blocks.forEach((block) =>
      block.instructions.forEach((operation) => {
        blockForOffset.set(operation.offset, block.start);
      })
    );
    valueCFG.blocks.forEach((block) => {
      if (!reachable.has(block.start)) return;
      const before = Array.from(instructions.values()).filter(
        (instruction) => instruction.optimized && instruction.optimized.kind === "reuse"
      ).length;
      transferAvailable(block, incoming.get(block.start), instructions, true, (index) =>
        canPropagateLocal(hirScope, index)
      );
      const reused = Array.from(instructions.values())
        .filter((instruction) => instruction.optimized && instruction.optimized.kind === "reuse")
        .slice(before);
      loadsEliminated += reused.length;
      reused.forEach((instruction) => {
        if (blockForOffset.get(instruction.optimized.sourceOffset) !== block.start) {
          crossBlockLoadsEliminated += 1;
        }
      });
    });
  });

  stats.globalValueNumbering = {
    loadsEliminated,
    crossBlockLoadsEliminated,
    scopesSkipped,
    semanticScopes,
  };
  return mir;
}

function naturalLoopBlocks(scope, loop) {
  const blocks = new Map(scope.blocks.map((block) => [block.start, block]));
  const members = new Set([loop.header, loop.backedge]);
  const work = loop.backedge === loop.header ? [] : [loop.backedge];
  while (work.length) {
    const start = work.pop();
    const block = blocks.get(start);
    if (!block) continue;
    block.predecessors.forEach((predecessor) => {
      if (members.has(predecessor)) return;
      members.add(predecessor);
      if (predecessor !== loop.header) work.push(predecessor);
    });
  }
  return members;
}

function loopRegionForHeader(hirScope, header) {
  return (hirScope.controlRegions || []).find(
    (region) =>
      ["While", "DoWhile", "For", "ForIn"].includes(region.kind) &&
      [region.testStart, region.bodyStart, region.start].includes(header)
  );
}

// Item 6 (local promotion) mirror: codegen promotes every non-parameter
// slot of a direct-variable scope with no closures, no capture-visible slot
// ops, and no dynamic-function fallback — and, since Phase 2, every slot
// including parameters when the scope is strict (`arguments` is unmapped
// there) — to a real `$p<scope>_<index>` prologue variable
// (src/codegen/index.js, `promotedLocalPlans`). Since Phase 3 the plan has
// no security term. A LICM hoist of such a slot would compile to
// `const $h = $p...;` — a pure alias of a register read — so the pass skips
// it. The mirror is conservative: a mismatch in either direction costs an
// alias or a lost load elimination, never a miscompile, and codegen's
// post-generation assertion catches the unsafe drift.
function isPromotionEligibleScope(scope) {
  if (scope.dynamicFunctions.length) return false;
  return !scope.instructions.some(
    (instruction) =>
      instruction.op === "CLOSURE" ||
      instruction.op === "GETLOCAL2" ||
      instruction.op === "SETLOCAL2"
  );
}

// Only private non-parameter local reads are hoisted. Such reads cannot invoke
// guest code, and lightweight scopes prove that with/eval/closures cannot
// mutate the slot. A loop-local write remains a hard kill.
function runLoopInvariantCodeMotion(hirProgram, stats, existingMIR, options = {}) {
  const mir = analysisMIR(hirProgram, stats, existingMIR);
  let loadsHoisted = 0;
  let usesReplaced = 0;
  let scopesSkipped = 0;
  const scopesById = new Map(hirProgram.scopes.map((scope) => [scope.id, scope]));
  const dynamicChainMemo = new Map();
  // Mirrors the codegen plan (which has no security term since Phase 3).
  const promotionEligible = true;

  mir.scopes.forEach((mirScope) => {
    const hirScope = hirProgram.scopes.find((scope) => scope.id === mirScope.id);
    // Codegen emits hoisted reads as direct frame accesses (`$l[index]`),
    // which only exist for scopes with a static local layout. Scopes with a
    // dynamic chain (with/eval/catch ops, own or inherited) have no frame
    // layout, and the runtime's stack-based getLocal cannot serve as a
    // hoisted value expression — so their loads must not be hoisted.
    if (!hirScope.lightweight || hirScope.script || !mirScope.loops.length) return;
    if (
      hasDynamicChain(hirScope, scopesById, dynamicChainMemo) ||
      hasProtectedControlFlow(hirScope)
    ) {
      scopesSkipped += 1;
      return;
    }
    const instructions = instructionMap(hirScope);
    const loopPlans = mirScope.loops
      .map((loop) => ({
        ...loop,
        blocks: naturalLoopBlocks(mirScope, loop),
        region: loopRegionForHeader(hirScope, loop.header),
      }))
      .filter((loop) => loop.region);
    if (!loopPlans.length) return;
    loopPlans.sort((left, right) => left.blocks.size - right.blocks.size);

    const operationsByBlock = new Map(
      mirScope.blocks.map((block) => [block.start, block.operations])
    );
    loopPlans.forEach((loop) => {
      loop.writes = new Set();
      loop.blocks.forEach((start) =>
        (operationsByBlock.get(start) || []).forEach((operation) => {
          if (["SETLOCAL", "SETLOCAL2", "DELLOCAL", "DELLOCAL2"].includes(operation.op)) {
            loop.writes.add(operation.args[0]);
          }
        })
      );
      loop.hoisted = new Map();
    });

    mirScope.blocks.forEach((block) =>
      block.operations.forEach((operation) => {
        if (!["GETLOCAL", "GETLOCAL2"].includes(operation.op)) return;
        const index = operation.args[0];
        if (!canPropagateLocal(hirScope, index)) return;
        if (
          promotionEligible &&
          isPromotionEligibleScope(hirScope) &&
          (index > hirScope.parameterCount || hirScope.strict)
        )
          return;
        const loop = loopPlans.find(
          (candidate) => candidate.blocks.has(block.start) && !candidate.writes.has(index)
        );
        if (!loop) return;
        const instruction = instructions.get(operation.offset);
        if (!instruction || instruction.optimized) return;
        if (!loop.hoisted.has(index)) {
          loop.hoisted.set(index, operation.offset);
          loadsHoisted += 1;
        }
        instruction.optimized = {
          kind: "licm",
          header: loop.header,
          sourceOffset: loop.hoisted.get(index),
          localIndex: index,
        };
        usesReplaced += 1;
      })
    );

    hirScope.loopInvariantLoads = loopPlans.flatMap((loop) =>
      Array.from(loop.hoisted, ([localIndex, sourceOffset]) => ({
        header: loop.header,
        localIndex,
        sourceOffset,
      }))
    );
  });

  stats.loopInvariantCodeMotion = { loadsHoisted, usesReplaced, scopesSkipped };
  return mir;
}

// Item 7a (dead-store elimination): a SETLOCAL whose value is never read on
// any path before the next store (or delete, or scope exit) is dead —
// "must-use" liveness over the MIR CFG (backward fixpoint: a slot is live
// at a position iff some path from there reads it before the next
// store/delete; live grows monotonically and converges in loop-depth passes).
// This subsumes the same-block store->store case (the kill is simply in the
// same block) and the scope-level never-read case (the name-binding prologue
// `CURRENT SETLOCAL name POP` when the body never references its own name,
// and `var x = init` whose every read was folded by copy-prop). Reads that
// earlier passes rewrote (`optimized` marks: literal/duplicate/reuse/licm)
// no longer read the slot — their value comes from the folded literal or a
// dominating load — so they neither consume nor kill. DELLOCAL is also a
// no-op here: deleteLocal pushes false for lightweight frames without
// touching the slot, so the stored value stays observable to later reads
// (only the op's own no-op body runs; nothing removes the binding).
// Eligibility is canPropagateLocal (private locals, sloppy non-parameter
// slots, strict parameters since item 4): mapped sloppy `arguments` can
// observe PARAMETER slots at runtime through frame.locals (the proxy reads
// the slot lazily), script scopes are globals, and with/eval/closure scopes
// have env-chain observers — all excluded. Scopes with a dynamic chain
// (with/eval/catch ops, own or inherited — hasDynamicChain, same gate as
// LICM and the codegen's frame layout) are additionally skipped wholesale:
// every try/catch/finally region carries a CATCH op, so a try body's stores
// can be read on the exception path (handler/finally/continuation), which
// the MIR CFG has no edge for, and the runtime name-walk can reach the env
// node of a nested catch scope that reads this frame's locals by name.
// Frame-layout scopes can contain none of these, so eliding their dead
// stores is unobservable. Everything else is unreachable
// from the runtime name-walk (the promotion soundness argument, Phase 3:
// no security term), so eliding a store to a never-read slot is
// unobservable. SETLOCAL is a stack PEEK
// (codegen's direct path reads the stack top without popping), so eliding a
// dead store is a pure instruction-skip — no stack traffic to clean, unlike
// DCE's POP chains; the stored value keeps its original consumer. Elision
// happens after every value-moving pass (copy-prop, LICM, GVN, local-CSE),
// so the provenance mark written later cannot go stale.
function runDeadStoreElimination(hirProgram, stats, existingMIR, options = {}) {
  const mir = analysisMIR(hirProgram, stats, existingMIR);
  let storesEliminated = 0;
  let slotsAnalyzed = 0;
  let bailedOutSlots = 0;
  let blockVisits = 0;
  const bailouts = [];
  const maxVisits =
    options.deadStoreEliminationBudget === undefined
      ? Infinity
      : options.deadStoreEliminationBudget;
  // Shared across scopes: hasDynamicChain is a pure function of the scope
  // graph (walking own ops, then the parent chain), so ancestor results are
  // reused instead of recomputed for every nested scope.
  const scopesById = new Map(hirProgram.scopes.map((scope) => [scope.id, scope]));
  const dynamicChainMemo = new Map();

  mir.scopes.forEach((mirScope) => {
    if (!mirScope.blocks.length) return;
    const hirScope = hirProgram.scopes.find((scope) => scope.id === mirScope.id);
    // Scopes with a dynamic chain (with/eval/catch ops, own or inherited) are
    // skipped wholesale, mirroring LICM and the codegen's frame-layout
    // decision: their loads run through the runtime's stack-based getLocal,
    // their env node is reachable from the runtime name-walk (a nested catch
    // scope can read this frame's locals by name — a read no op-level
    // liveness can see), and every try/catch/finally region carries a CATCH
    // op, so the try body's stores can be read on the exception path (the
    // handler/finally/continuation), which the MIR CFG has no edge for.
    // Frame-layout scopes can contain none of these, so eliding their dead
    // stores is unobservable. (test262 S12.14_A15: a `result += 2` store
    // inside `try {} finally { break }` was mis-elided because the THROW
    // block has no successors — the finally's `break` path reads the slot.)
    if (
      hasDynamicChain(hirScope, scopesById, dynamicChainMemo) ||
      hasProtectedControlFlow(hirScope)
    )
      return;
    const instructions = instructionMap(hirScope);
    const isRead = (operation) => {
      if (operation.op !== "GETLOCAL" && operation.op !== "GETLOCAL2") return false;
      const instruction = instructions.get(operation.offset);
      // Unmarked (or missing) reads consume the slot. `literal`/`duplicate`/
      // `licm` reads were rewritten by copy-prop/local-CSE/LICM and no longer
      // touch it (folded literal, stack-top copy of an adjacent load, or
      // hoisted-load alias whose own real read DSE sees). `reuse` remains a
      // conservative read here as defense in depth: codegen now requires its
      // verified live producer and never falls back to a fresh slot read, but
      // retaining the use cannot authorize an unsafe store deletion.
      if (!instruction || instruction.elided) return false;
      if (instruction.optimized && instruction.optimized.kind !== "reuse") return false;
      return true;
    };
    const isStore = (operation) => operation.op === "SETLOCAL" || operation.op === "SETLOCAL2";
    const isSlotAccess = (operation) =>
      isStore(operation) || operation.op === "GETLOCAL" || operation.op === "GETLOCAL2";

    // Per-slot must-use liveness. Slots with no stores are skipped; every
    // access of an eligible slot is assessed exactly once per fixpoint pass.
    const slots = new Set();
    mirScope.blocks.forEach((block) =>
      block.operations.forEach((operation) => {
        if (isSlotAccess(operation)) slots.add(operation.args[0]);
      })
    );

    slots.forEach((slot) => {
      if (!canPropagateLocal(hirScope, slot)) return;
      // Successors are block START OFFSETS (mirScope.loops headers/backedges
      // are too), so the liveness maps are keyed by block.start.
      slotsAnalyzed += 1;
      const transfer = (block, liveOut) => {
        // Backward transfer: live at a position = live after the block
        // (needed by some successor) plus any read after the position; a
        // store satisfies earlier needs and kills them. Optimized reads and
        // DELLOCAL follow the classification above. The access filter gates
        // on the op FIRST so numeric immediates cannot collide with a slot.
        let live = liveOut;
        for (let i = block.operations.length - 1; i >= 0; i -= 1) {
          const operation = block.operations[i];
          if (!isSlotAccess(operation) || operation.args[0] !== slot) continue;
          if (operation.op === "GETLOCAL" || operation.op === "GETLOCAL2") {
            if (isRead(operation)) live = true;
          } else if (isStore(operation)) {
            live = false;
          }
        }
        return live;
      };
      const solved = solveBackward({
        blocks: mirScope.blocks,
        bottom: () => false,
        meet: (successors) => successors.some(Boolean),
        transfer,
        maxVisits,
      });
      blockVisits += solved.visits;
      if (!solved.converged) {
        bailedOutSlots += 1;
        bailouts.push({ scopeId: mirScope.id, slot, reason: "budget-exhausted" });
        return;
      }
      const liveOut = solved.outState;
      // Fixpoint is stable: elide every store at a dead position. Same
      // transfer as above — optimized reads and DELLOCAL are no-ops, so a
      // store that a folded read or a no-op delete sits between and a real
      // downstream read (same block or successor) stays live.
      mirScope.blocks.forEach((block) => {
        let live = liveOut.get(block.start);
        for (let i = block.operations.length - 1; i >= 0; i -= 1) {
          const operation = block.operations[i];
          if (!isSlotAccess(operation) || operation.args[0] !== slot) continue;
          if (operation.op === "GETLOCAL" || operation.op === "GETLOCAL2") {
            if (isRead(operation)) live = true;
            continue;
          }
          if (isStore(operation) && !live) {
            const instruction = instructions.get(operation.offset);
            if (instruction && !instruction.elided) {
              instruction.elided = true;
              storesEliminated += 1;
            }
          }
          live = false;
        }
      });
    });
  });

  stats.deadStoreElimination = {
    storesEliminated,
    slotsAnalyzed,
    bailedOutSlots,
    blockVisits,
    scopesSkipped: mir.scopes.filter((mirScope) => {
      const hirScope = hirProgram.scopes.find((scope) => scope.id === mirScope.id);
      return (
        hirScope &&
        (hasDynamicChain(hirScope, scopesById, dynamicChainMemo) ||
          hasProtectedControlFlow(hirScope))
      );
    }).length,
    bailouts,
  };
  return mir;
}

function runDeadCodeElimination(hirProgram, stats, existingMIR) {
  const mir = analysisMIR(hirProgram, stats, existingMIR);
  let operationsRemoved = 0;
  let stackDropsInserted = 0;

  mir.scopes.forEach((mirScope) => {
    const hirScope = hirProgram.scopes.find((scope) => scope.id === mirScope.id);
    const instructions = instructionMap(hirScope);
    const values = new Map(mirScope.values.map((value) => [value.id, value]));

    mirScope.blocks.forEach((block) => {
      for (let index = 0; index < block.operations.length; index += 1) {
        const producer = block.operations[index];
        if (producer.effect !== "Pure" || producer.outputs.length !== 1) continue;
        const output = values.get(producer.outputs[0]);
        if (!output || output.uses.length !== 1 || output.uses[0].kind !== "Operation") continue;

        let consumerIndex = index + 1;
        while (
          consumerIndex < block.operations.length &&
          block.operations[consumerIndex].op === "LOC"
        ) {
          consumerIndex += 1;
        }
        const consumer = block.operations[consumerIndex];
        if (!consumer || consumer.op !== "POP" || consumer.inputs[0] !== output.id) continue;

        const producerInstruction = instructions.get(producer.offset);
        const popInstruction = instructions.get(consumer.offset);
        if (
          !producerInstruction ||
          !popInstruction ||
          producerInstruction.elided ||
          popInstruction.elided
        )
          continue;

        if (producer.inputs.length === 0) {
          producerInstruction.elided = true;
        } else {
          producerInstruction.optimized = { kind: "drop-inputs", count: producer.inputs.length };
          stackDropsInserted += producer.inputs.length;
        }
        popInstruction.elided = true;
        operationsRemoved += 2;
      }
    });
  });

  stats.deadCodeElimination = { operationsRemoved, stackDropsInserted };
  stats.deadOperationsRemoved += operationsRemoved;
  return mir;
}

module.exports = {
  runCopyPropagation,
  runDeadCodeElimination,
  runDeadStoreElimination,
  runGlobalValueNumbering,
  runLocalCSE,
  runLoopInvariantCodeMotion,
};
