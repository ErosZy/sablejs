"use strict";

// Generic backward worklist solver. States are immutable from the solver's
// point of view: meet/transfer return the state that should be stored, and
// equals decides whether a predecessor needs to be revisited.
//
// A visit budget is diagnostic/resource control only. On exhaustion the
// caller receives converged:false and MUST discard the returned partial maps.
function solveBackward({
  blocks,
  bottom,
  meet,
  transfer,
  equals = Object.is,
  maxVisits = Infinity,
}) {
  if (!Array.isArray(blocks)) throw new TypeError("dataflow blocks must be an array");
  if (
    typeof bottom !== "function" ||
    typeof meet !== "function" ||
    typeof transfer !== "function" ||
    typeof equals !== "function"
  ) {
    throw new TypeError("invalid backward dataflow callbacks");
  }
  if (maxVisits !== Infinity && (!Number.isInteger(maxVisits) || maxVisits < 0)) {
    throw new RangeError("dataflow maxVisits must be a non-negative integer or Infinity");
  }

  const byStart = new Map(blocks.map((block) => [block.start, block]));
  if (byStart.size !== blocks.length) {
    throw new Error("dataflow block starts must be unique");
  }
  const predecessors = new Map(blocks.map((block) => [block.start, []]));
  blocks.forEach((block) => {
    if (!Array.isArray(block.successors)) {
      throw new TypeError(`dataflow block ${block.start} successors must be an array`);
    }
    block.successors.forEach((start) => {
      if (predecessors.has(start)) predecessors.get(start).push(block.start);
    });
  });
  const inState = new Map();
  const outState = new Map();
  blocks.forEach((block) => {
    inState.set(block.start, bottom(block, "in"));
    outState.set(block.start, bottom(block, "out"));
  });

  // Blocks are normally stored in source order. Popping from this array starts
  // at exits and propagates facts toward entry quickly, but correctness does
  // not depend on that order.
  const worklist = blocks.slice();
  const queued = new Set(blocks.map((block) => block.start));
  let visits = 0;

  while (worklist.length) {
    if (visits >= maxVisits) {
      return { converged: false, inState, outState, visits };
    }
    const block = worklist.pop();
    queued.delete(block.start);
    visits += 1;

    const successorStates = block.successors
      .filter((start) => byStart.has(start))
      .map((start) => inState.get(start));
    const nextOut = meet(successorStates, block);
    const nextIn = transfer(block, nextOut);
    const inputChanged = !equals(inState.get(block.start), nextIn);
    outState.set(block.start, nextOut);
    inState.set(block.start, nextIn);
    if (!inputChanged) continue;

    predecessors.get(block.start).forEach((start) => {
      const predecessor = byStart.get(start);
      if (!predecessor || queued.has(start)) return;
      queued.add(start);
      worklist.push(predecessor);
    });
  }

  return { converged: true, inState, outState, visits };
}

module.exports = { solveBackward };
