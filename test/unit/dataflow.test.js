"use strict";

const assert = require("assert");
const { describe, it } = require("node:test");
const { solveBackward } = require("../../src/backend/dataflow");

function reference(blocks, transfer) {
  const input = new Map(blocks.map((block) => [block.start, false]));
  const output = new Map(blocks.map((block) => [block.start, false]));
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      const nextOutput = block.successors.some((start) => input.get(start));
      const nextInput = transfer(block, nextOutput);
      if (nextOutput !== output.get(block.start) || nextInput !== input.get(block.start)) {
        changed = true;
        output.set(block.start, nextOutput);
        input.set(block.start, nextInput);
      }
    }
  }
  return { input, output };
}

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("backward data-flow solver", function () {
  it("matches an independent reference on generated cyclic graphs", function () {
    for (let seed = 1; seed <= 200; seed += 1) {
      const next = random(seed);
      const size = 2 + Math.floor(next() * 30);
      const blocks = Array.from({ length: size }, (_, start) => ({
        start,
        reads: next() < 0.25,
        kills: next() < 0.25,
        successors: [],
      }));
      blocks.forEach((block, index) => {
        if (index + 1 < size) block.successors.push(index + 1);
        for (let target = 0; target < size; target += 1) {
          if (next() < 0.04 && !block.successors.includes(target)) block.successors.push(target);
        }
      });
      const transfer = (block, live) => block.reads || (live && !block.kills);
      const expected = reference(blocks, transfer);
      const actual = solveBackward({
        blocks,
        bottom: () => false,
        meet: (states) => states.some(Boolean),
        transfer,
      });
      assert(actual.converged, `seed ${seed}`);
      blocks.forEach((block) => {
        assert.equal(
          actual.inState.get(block.start),
          expected.input.get(block.start),
          `in seed ${seed}`
        );
        assert.equal(
          actual.outState.get(block.start),
          expected.output.get(block.start),
          `out seed ${seed}`
        );
      });
    }
  });

  it("reports budget exhaustion instead of claiming convergence", function () {
    const blocks = [{ start: 0, successors: [] }];
    const result = solveBackward({
      blocks,
      bottom: () => false,
      meet: () => false,
      transfer: () => true,
      maxVisits: 0,
    });
    assert.equal(result.converged, false);
    assert.equal(result.visits, 0);
  });
});
