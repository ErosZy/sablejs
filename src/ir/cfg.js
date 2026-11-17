"use strict";

const OpSpec = require("./op-spec");

const TERMINATORS = new Set([
  "JUMP",
  "JTRUE",
  "JFALSE",
  "JCASE",
  "RETURN",
  "THROW",
  "TRY",
  "ENDTRY",
]);
const TARGETED = new Set(["JUMP", "JTRUE", "JFALSE", "JCASE", "TRY"]);

function unique(values) {
  return Array.from(new Set(values));
}

function buildBasicBlocks(scope, options = {}) {
  const boundaries = new Set([0, scope.codeLength]);
  scope.instructions.forEach((instruction) => {
    if (TARGETED.has(instruction.op)) boundaries.add(instruction.args[0]);
    if (TERMINATORS.has(instruction.op)) boundaries.add(instruction.end);
    if (options.semantic && OpSpec.byName[instruction.op].mayThrow) {
      boundaries.add(instruction.offset);
      boundaries.add(instruction.end);
    }
  });
  if (options.semantic) {
    (scope.controlRegions || []).forEach((region) => {
      Object.entries(region).forEach(([key, value]) => {
        if (key !== "id" && Number.isInteger(value) && 0 <= value && value <= scope.codeLength) {
          boundaries.add(value);
        }
      });
    });
    (scope.syntheticRanges || []).forEach((range) => {
      boundaries.add(range.start);
      boundaries.add(range.end);
    });
  }

  const starts = Array.from(boundaries).sort((left, right) => left - right);
  const blocks = [];
  let instructionIndex = 0;
  for (let index = 0; index < starts.length - 1; index += 1) {
    const start = starts[index];
    const end = starts[index + 1];
    if (start === end) continue;
    const instructions = [];
    while (
      instructionIndex < scope.instructions.length &&
      scope.instructions[instructionIndex].offset < end
    ) {
      const instruction = scope.instructions[instructionIndex];
      if (instruction.offset >= start) instructions.push(instruction);
      instructionIndex += 1;
    }
    blocks.push({ id: blocks.length, start, end, instructions });
  }
  return blocks;
}

function regionPhase(region, offset) {
  if (region.tryBodyStart <= offset && offset < region.tryBodyEnd) return "try";
  if (
    Number.isInteger(region.catchBodyStart) &&
    region.catchBodyStart <= offset &&
    offset < region.catchBodyEnd
  )
    return "catch";
  return null;
}

function protectedRegions(scope) {
  return (scope.controlRegions || [])
    .filter((region) => region.kind === "TryCatch" || region.kind === "TryFinally")
    .slice()
    .sort((left, right) => left.end - left.start - (right.end - right.start));
}

// Route a pending JavaScript completion through the innermost active
// handler/finalizer. Finalizer bodies are deliberately not active for their
// own region, so a completion created there continues to an outer region.
function completionRoute(scope, offset, completion, excludedRegionIds = new Set()) {
  for (const region of protectedRegions(scope)) {
    if (excludedRegionIds.has(region.id)) continue;
    const phase = regionPhase(region, offset);
    if (!phase) continue;
    if (completion === "throw") {
      if (region.kind === "TryCatch" && phase === "try") {
        return { target: region.catchBodyStart, ownerRegion: region.id, via: "catch" };
      }
      if (region.kind === "TryFinally") {
        if (phase === "try" && region.hasCatch) {
          return { target: region.catchBodyStart, ownerRegion: region.id, via: "catch" };
        }
        return { target: region.finalizerStart, ownerRegion: region.id, via: "finally" };
      }
    } else if (region.kind === "TryFinally") {
      return { target: region.finalizerStart, ownerRegion: region.id, via: "finally" };
    }
  }
  return { target: scope.codeLength, ownerRegion: null, via: "exit" };
}

function structuredCompletions(scope) {
  const exits = new Map();
  (scope.controlRegions || []).forEach((region) => {
    (region.exits || []).forEach((exit) => exits.set(exit.offset, exit));
  });
  return (scope.syntheticRanges || [])
    .map((range) => {
      const owner = protectedRegions(scope).find(
        (region) =>
          region.kind === "TryFinally" && region.start <= range.start && range.end <= region.end
      );
      if (!owner) return null;
      const abrupt = scope.instructions.find(
        (instruction) =>
          instruction.offset >= range.end &&
          instruction.offset < owner.end &&
          (instruction.op === "RETURN" ||
            (instruction.op === "JUMP" && exits.has(instruction.offset)))
      );
      if (!abrupt) return null;
      const exit = exits.get(abrupt.offset);
      return {
        owner,
        range,
        abrupt,
        completion: abrupt.op === "RETURN" ? "return" : exit.kind,
        resumeTarget: abrupt.op === "RETURN" ? scope.codeLength : abrupt.args[0],
      };
    })
    .filter(Boolean);
}

function semanticSuccessorEdges(scope, block, options = {}) {
  const last = block.instructions[block.instructions.length - 1];
  let edges = successorEdges(block, scope.codeLength, options).map((edge) => ({
    ...edge,
    class: "normal",
    completion: "normal",
  }));
  if (!last) return edges;

  // TRY/CATCH/ENDTRY are lowering markers. Structured execution enters the
  // source try body; exceptional paths are added from their real producers.
  if (last.op === "TRY") {
    edges = [
      {
        target: last.args[0],
        kind: "structured-enter",
        class: "normal",
        completion: "normal",
      },
    ];
  }

  const completions = structuredCompletions(scope);
  const startingCompletion = completions.find((entry) => entry.range.start === block.end);
  if (startingCompletion) {
    edges = [
      {
        target: startingCompletion.owner.finalizerStart,
        kind: "finally",
        class: "abrupt",
        completion: startingCompletion.completion,
        ownerRegion: startingCompletion.owner.id,
        resumeTarget: startingCompletion.resumeTarget,
      },
    ];
  }

  const spec = OpSpec.byName[last.op];
  if (spec.mayThrow) {
    const route = completionRoute(scope, last.offset, "throw");
    edges.push({
      target: route.target,
      kind: route.via,
      class: "exceptional",
      completion: "throw",
      ownerRegion: route.ownerRegion,
      sourceOffset: last.offset,
    });
  }

  if (last.op === "RETURN") {
    const alreadyFinalized = completions.find((entry) => entry.abrupt.offset === last.offset);
    const excluded = alreadyFinalized ? new Set([alreadyFinalized.owner.id]) : new Set();
    const route = completionRoute(scope, last.offset, "return", excluded);
    edges = [
      {
        target: route.target,
        kind: route.via,
        class: "abrupt",
        completion: "return",
        ownerRegion: route.ownerRegion,
        sourceOffset: last.offset,
      },
    ];
  } else if (last.op === "JUMP") {
    const exit = (scope.controlRegions || [])
      .flatMap((region) => region.exits || [])
      .find((candidate) => candidate.offset === last.offset);
    if (exit) {
      edges = [
        {
          target: last.args[0],
          kind: exit.kind,
          class: "abrupt",
          completion: exit.kind,
          sourceOffset: last.offset,
        },
      ];
    }
  }

  // A normally completing finalizer resumes each pending completion that can
  // enter it. These labelled edges encode the completion state explicitly;
  // consumers may conservatively meet them at the same target block.
  const finalizer = protectedRegions(scope).find(
    (region) =>
      region.kind === "TryFinally" &&
      region.finalizerEnd === block.end &&
      last.op !== "RETURN" &&
      last.op !== "THROW"
  );
  if (finalizer) {
    completions
      .filter((entry) => entry.owner.id === finalizer.id)
      .forEach((entry) => {
        edges.push({
          target: entry.range.end,
          kind: "resume",
          class: "abrupt",
          completion: entry.completion,
          ownerRegion: finalizer.id,
          resumeTarget: entry.resumeTarget,
        });
      });
    if (!finalizer.hasCatch) {
      const route = completionRoute(
        scope,
        finalizer.finalizerStart,
        "throw",
        new Set([finalizer.id])
      );
      edges.push({
        target: route.target,
        kind: route.via,
        class: "exceptional",
        completion: "throw",
        ownerRegion: route.ownerRegion,
      });
    }
  }

  const seen = new Set();
  return edges.filter((edge) => {
    const key = `${edge.target}|${edge.class}|${edge.completion}|${edge.kind}|${edge.ownerRegion}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function successorEdges(block, codeLength, options = {}) {
  const last = block.instructions[block.instructions.length - 1];
  if (!last) return block.end < codeLength ? [{ target: block.end, kind: "fallthrough" }] : [];
  const ignoreOptimized =
    options.ignoreOptimizedBranches ||
    (options.ignoreOptimizedBranchOffsets && options.ignoreOptimizedBranchOffsets.has(last.offset));
  if (!ignoreOptimized && last.optimizedBranchTarget !== undefined) {
    return [{ target: last.optimizedBranchTarget, kind: "optimized" }];
  }
  switch (last.op) {
    case "JUMP":
      return [{ target: last.args[0], kind: "jump" }];
    case "JTRUE":
    case "JFALSE":
    case "JCASE":
      return unique([last.args[0], last.end]).map((target) => ({
        target,
        kind: target === last.args[0] ? "taken" : "fallthrough",
      }));
    case "TRY":
      return unique([last.args[0], last.end]).map((target) => ({
        target,
        kind: target === last.args[0] ? "try" : "exception",
      }));
    case "ENDTRY":
      return last.end < codeLength ? [{ target: last.end, kind: "continuation" }] : [];
    case "RETURN":
    case "THROW":
      return [];
    default:
      return block.end < codeLength ? [{ target: block.end, kind: "fallthrough" }] : [];
  }
}

function computeDominators(blocks, reachable, entry) {
  const reachableSet = new Set(reachable);
  const all = new Set(reachable);
  const dominators = new Map();
  reachable.forEach((start) =>
    dominators.set(start, start === entry ? new Set([entry]) : new Set(all))
  );

  let changed = true;
  while (changed) {
    changed = false;
    for (const block of blocks) {
      if (block.start === entry || !reachableSet.has(block.start)) continue;
      const predecessors = block.predecessors.filter((start) => reachableSet.has(start));
      let next = predecessors.length ? new Set(dominators.get(predecessors[0])) : new Set();
      for (let index = 1; index < predecessors.length; index += 1) {
        const other = dominators.get(predecessors[index]);
        next = new Set(Array.from(next).filter((value) => other.has(value)));
      }
      next.add(block.start);
      const current = dominators.get(block.start);
      if (current.size !== next.size || Array.from(current).some((value) => !next.has(value))) {
        dominators.set(block.start, next);
        changed = true;
      }
    }
  }
  return dominators;
}

function computeImmediateDominators(reachable, dominators, entry) {
  const immediateDominators = new Map([[entry, null]]);
  reachable.forEach((start) => {
    if (start === entry) return;
    const strict = Array.from(dominators.get(start)).filter((value) => value !== start);
    let immediate = null;
    for (const candidate of strict) {
      if (strict.every((other) => other === candidate || dominators.get(candidate).has(other))) {
        immediate = candidate;
        break;
      }
    }
    immediateDominators.set(start, immediate);
  });
  return immediateDominators;
}

function buildGraph(scope, semantic, analyze = true, options = {}) {
  const blocks = buildBasicBlocks(scope, { semantic });
  const byStart = new Map(blocks.map((block) => [block.start, block]));
  blocks.forEach((block) => {
    block.edges = semantic
      ? semanticSuccessorEdges(scope, block, options)
      : successorEdges(block, scope.codeLength, options);
    // Multiple semantic completions may share a target. The labelled edges
    // remain distinct, while the graph relation used by dataflow is a set.
    block.successors = unique(
      block.edges.map((edge) => edge.target).filter((target) => byStart.has(target))
    );
    block.predecessors = [];
  });
  blocks.forEach((block) =>
    block.successors.forEach((target) => {
      byStart.get(target).predecessors.push(block.start);
    })
  );

  const entry = blocks.length ? blocks[0].start : null;
  const reachable = [];
  const seen = new Set();
  const work = entry === null ? [] : [entry];
  while (work.length) {
    const start = work.pop();
    if (seen.has(start)) continue;
    seen.add(start);
    reachable.push(start);
    const block = byStart.get(start);
    for (let index = block.successors.length - 1; index >= 0; index -= 1) {
      work.push(block.successors[index]);
    }
  }
  reachable.sort((left, right) => left - right);

  const dominators =
    entry === null || !analyze ? new Map() : computeDominators(blocks, reachable, entry);
  const immediateDominators =
    entry === null || !analyze
      ? new Map()
      : computeImmediateDominators(reachable, dominators, entry);
  const loops = [];
  if (analyze) {
    blocks.forEach((block) =>
      block.successors.forEach((target) => {
        if (seen.has(block.start) && dominators.get(block.start).has(target)) {
          loops.push({ header: target, backedge: block.start });
        }
      })
    );
  }

  return {
    kind: "ControlFlowGraph",
    edgeModel: semantic ? "semantic" : "normal",
    analyzed: analyze,
    scopeId: scope.id,
    codeLength: scope.codeLength,
    entry,
    blocks,
    byStart,
    reachable: seen,
    dominators,
    immediateDominators,
    loops,
  };
}

function buildNormalCFG(scope, options = {}) {
  return buildGraph(scope, false, options.analyze !== false, options);
}

// Backward-compatible internal name. New CFG consumers must choose
// buildNormalCFG or buildSemanticCFG explicitly.
const buildCFG = buildNormalCFG;

function buildSemanticCFG(scope, options = {}) {
  return buildGraph(scope, true, options.analyze !== false, options);
}

function edgeSignature(edge) {
  return JSON.stringify([
    edge.target,
    edge.kind,
    edge.class,
    edge.completion,
    edge.ownerRegion,
    edge.resumeTarget,
    edge.sourceOffset,
  ]);
}

function verifyCFG(cfg, sourceScope = null) {
  if (!cfg || cfg.kind !== "ControlFlowGraph" || !Array.isArray(cfg.blocks)) {
    throw new TypeError("Invalid ControlFlowGraph");
  }
  if (cfg.blocks.length && cfg.entry !== cfg.blocks[0].start) {
    throw new Error(`CFG scope ${cfg.scopeId} has an invalid entry`);
  }
  let previousEnd = 0;
  const starts = new Set();
  cfg.blocks.forEach((block, index) => {
    if (block.id !== index || block.start !== previousEnd || block.end <= block.start) {
      throw new Error(`Malformed basic block ${block.id} in scope ${cfg.scopeId}`);
    }
    if (starts.has(block.start)) throw new Error(`Duplicate basic block ${block.start}`);
    starts.add(block.start);
    previousEnd = block.end;
  });
  if (previousEnd !== cfg.codeLength)
    throw new Error(`CFG scope ${cfg.scopeId} does not cover its HIR`);

  cfg.blocks.forEach((block) => {
    block.edges.forEach((edge) => {
      if (edge.target !== cfg.codeLength && !starts.has(edge.target)) {
        throw new Error(`CFG edge from ${block.start} has invalid target ${edge.target}`);
      }
      if (
        cfg.edgeModel === "semantic" &&
        (!["normal", "exceptional", "abrupt"].includes(edge.class) ||
          typeof edge.completion !== "string")
      ) {
        throw new Error(`CFG edge from ${block.start} has an invalid semantic class`);
      }
    });
    block.successors.forEach((target) => {
      const successor = cfg.byStart.get(target);
      if (!successor || !successor.predecessors.includes(block.start)) {
        throw new Error(`CFG successor/predecessor mismatch at ${block.start} -> ${target}`);
      }
    });
    block.predecessors.forEach((source) => {
      const predecessor = cfg.byStart.get(source);
      if (!predecessor || !predecessor.successors.includes(block.start)) {
        throw new Error(`CFG predecessor/successor mismatch at ${source} -> ${block.start}`);
      }
    });
  });

  if (sourceScope) {
    if (sourceScope.id !== cfg.scopeId || sourceScope.codeLength !== cfg.codeLength) {
      throw new Error(`CFG source mismatch for scope ${cfg.scopeId}`);
    }
    const expected = buildGraph(sourceScope, cfg.edgeModel === "semantic", false);
    if (expected.blocks.length !== cfg.blocks.length) {
      throw new Error(`CFG block reconstruction mismatch in scope ${cfg.scopeId}`);
    }
    cfg.blocks.forEach((block, index) => {
      const expectedBlock = expected.blocks[index];
      const actualEdges = block.edges.map(edgeSignature).sort();
      const expectedEdges = expectedBlock.edges.map(edgeSignature).sort();
      if (
        block.start !== expectedBlock.start ||
        block.end !== expectedBlock.end ||
        actualEdges.length !== expectedEdges.length ||
        actualEdges.some((edge, edgeIndex) => edge !== expectedEdges[edgeIndex])
      ) {
        throw new Error(
          `CFG edge reconstruction mismatch at block ${block.start} in scope ${cfg.scopeId}`
        );
      }
    });
  }

  if (cfg.analyzed !== false)
    cfg.reachable.forEach((start) => {
      const dominators = cfg.dominators.get(start);
      if (!dominators || !dominators.has(start) || !dominators.has(cfg.entry)) {
        throw new Error(`Invalid dominators for reachable block ${start}`);
      }
      const immediate = cfg.immediateDominators.get(start);
      if (start === cfg.entry ? immediate !== null : !dominators.has(immediate)) {
        throw new Error(`Invalid immediate dominator for block ${start}`);
      }
    });
  if (cfg.analyzed !== false)
    cfg.loops.forEach((loop) => {
      const dominators = cfg.dominators.get(loop.backedge);
      if (!dominators || !dominators.has(loop.header)) {
        throw new Error(`Invalid natural loop ${loop.backedge} -> ${loop.header}`);
      }
    });
  return true;
}

module.exports = {
  buildBasicBlocks,
  buildCFG,
  buildNormalCFG,
  buildSemanticCFG,
  completionRoute,
  verifyCFG,
};
