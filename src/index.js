"use strict";

const runtime = require("./runtime");
const worker = require("./worker");
const compiler = require("./compiler");

module.exports = {
  ...compiler,
  capability: runtime.capability,
  runtime,
  worker,
};

// Node's ESM interop (cjs-module-lexer) surfaces `module.exports.NAME = ...`
// assignments verbatim; shorthand properties inside the object literal above
// and the `...compiler` spread are not detected. Re-assert every public name
// in the detectable form so `import { compile, runtime } from "sablejs"`
// works. The values are identical — nothing changes for CommonJS consumers.
module.exports.compile = compiler.compile;
module.exports.AOTCompiler = compiler.AOTCompiler;
module.exports.lowerToHIR = compiler.lowerToHIR;
module.exports.lowerToMIR = compiler.lowerToMIR;
module.exports.normalizeSecurity = compiler.normalizeSecurity;
module.exports.normalizeSourceMapOptions = compiler.normalizeSourceMapOptions;
module.exports.normalizeTransformOptions = compiler.normalizeTransformOptions;
module.exports.transformToES5 = compiler.transformToES5;
module.exports.capability = runtime.capability;
module.exports.runtime = runtime;
module.exports.worker = worker;
