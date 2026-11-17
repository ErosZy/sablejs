"use strict";

const OperationSpec = require("../operation-spec");

// The frontend emitter still writes compact numeric operations, but their
// codes are derived from the same contract decoded by HIR/MIR.
module.exports = Object.freeze(
  Object.fromEntries(OperationSpec.byCode.map((spec) => [spec.name, spec.code]))
);
