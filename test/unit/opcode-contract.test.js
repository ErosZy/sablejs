"use strict";

const assert = require("assert");
const { describe, it } = require("node:test");
const Opcode = require("../../src/frontend/opcode");
const OperationSpec = require("../../src/operation-spec");
const IRSpec = require("../../src/ir/op-spec");

describe("canonical operation contract", function () {
  it("derives every frontend numeric opcode from the IR operation table", function () {
    assert.strictEqual(IRSpec, OperationSpec);
    assert.equal(Object.keys(Opcode).length, OperationSpec.count);
    OperationSpec.byCode.forEach((spec, code) => {
      assert.equal(spec.code, code, spec.name);
      assert.equal(Opcode[spec.name], code, spec.name);
      assert.strictEqual(OperationSpec.byName[spec.name], spec);
      assert.equal(typeof spec.mayThrow, "boolean", spec.name);
      assert(
        ["push", "peek", "unary", "binary", "noStack", "special"].includes(spec.mir),
        spec.name
      );
    });
    Object.entries(Opcode).forEach(([name, code]) => {
      assert.equal(OperationSpec.byCode[code].name, name);
    });
  });

  it("keeps the canonical tables immutable", function () {
    assert(Object.isFrozen(Opcode));
    assert(Object.isFrozen(OperationSpec.byCode));
    assert(Object.isFrozen(OperationSpec.byName));
    OperationSpec.byCode.forEach((spec) => assert(Object.isFrozen(spec)));
  });
});
