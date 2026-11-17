"use strict";

const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");
const { compile } = require("../../src/compiler");

const repositoryRoot = path.resolve(__dirname, "../..");
const outputDirectory = path.join(repositoryRoot, ".cache/e2e");
const generatedPath = path.join(outputDirectory, "generated.cjs");
const entryPath = path.join(outputDirectory, "entry.cjs");
const outputPath = path.join(outputDirectory, "program.js");
const compilerEntryPath = path.join(outputDirectory, "compiler-entry.cjs");
const compilerOutputPath = path.join(outputDirectory, "compiler-browser.js");
const mapInlineEntryPath = path.join(outputDirectory, "map-inline-entry.cjs");
const mapInlineOutputPath = path.join(outputDirectory, "map-inline.js");
const runtimeModule = path.join(repositoryRoot, "src/runtime");

const source = `
var total = 0;

// Bundled runs hoist "use strict" over the whole bundle, which turns the
// runtime's arguments capture strict; this probe keeps the sloppy ES5
// arguments semantics regression (callee, mapped parameters) covered there.
function probeArgs(a, b) {
  var mapped = arguments;
  a = 9;
  return [mapped.length, mapped[0], mapped.callee === probeArgs].join(":");
}

var argsProbe = probeArgs(2, 3);

function Counter(start) {
  this.value = start;
}

Counter.prototype.add = function (step) {
  this.value += step;
  return this.value;
};

function multiplier(factor) {
  return function (value) {
    return value * factor;
  };
}

var counter = new Counter(seed);
var twice = multiplier(2);

for (var index = 0; index < 4; index += 1) {
  total += twice(counter.add(index));
}

({ total: total, finalValue: counter.value, label: platformLabel, argsProbe: argsProbe });
`;

const compiled = compile(source, { runtimeModule });
if (compiled.optimization !== "O1") {
  throw new Error(`implicit optimization must be O1, got ${compiled.optimization}`);
}

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(generatedPath, compiled.code);
fs.writeFileSync(
  entryPath,
  `
"use strict";

const program = require(${JSON.stringify(generatedPath)});
const instance = program.createInstance({
  globals: { seed: 7, platformLabel: "portable" },
});

let value;
try {
  value = instance.run();
} finally {
  instance.dispose();
}

const actual = {
  total: value.total,
  finalValue: value.finalValue,
  label: value.label,
  argsProbe: value.argsProbe,
};
const expected = { total: 76, finalValue: 13, label: "portable", argsProbe: "2:9:true" };

if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.log("sablejs E2E debug: actual=" + JSON.stringify(actual));
  throw new Error("sablejs E2E mismatch: " + JSON.stringify(actual));
}

globalThis.__sablejs_e2e_result__ = actual;
console.log("sablejs E2E: " + JSON.stringify(actual));
`
);

esbuild.buildSync({
  entryPoints: [entryPath],
  outfile: outputPath,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  logLevel: "warning",
});

fs.writeFileSync(
  compilerEntryPath,
  `
"use strict";

const { compile } = require(${JSON.stringify(path.join(repositoryRoot, "src"))});
const result = compile("var value = input * 2; value;", {
  optimization: "Os",
  runtimeModule: "sablejs/runtime",
});
globalThis.__sablejs_compiler_e2e_result__ = {
  format: result.format,
  inputLanguage: result.metadata.inputLanguage,
  security: result.metadata.security,
  hasCreateProgram: result.code.includes("createProgram"),
  outputBytes: result.stats.codegen.sizeOptimization.outputBytes,
};
`
);

esbuild.buildSync({
  entryPoints: [compilerEntryPath],
  outfile: compilerOutputPath,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  logLevel: "warning",
  external: ["fs", "path"],
});

// Inline source-map evidence: compile a throwing guest program with
// sourceMap: "inline" inside the browser bundle, run the inline-mapped
// artifact in-page through a CommonJS shim backed by the bundled runtime,
// and stash the compile-time map plus the runtime outcome. The data URL
// exercises the browser base64 path (no Buffer) end to end.
fs.writeFileSync(
  mapInlineEntryPath,
  `
"use strict";

const { compile } = require(${JSON.stringify(path.join(repositoryRoot, "src"))});
const source = [
  "function fail() {",
  "  throw new Error(\\"guest boom\\");",
  "}",
  "fail();",
].join("\\n");
const result = compile(source, {
  optimization: "O2",
  runtimeModule: "sablejs/runtime",
  sourceMap: "inline",
});

const requireShim = (id) => {
  if (id === "sablejs/runtime") return require("sablejs/runtime");
  throw new Error("unexpected module: " + id);
};
let outcome = null;
try {
  const module = { exports: {} };
  new Function("require", "module", "exports", result.code)(requireShim, module, module.exports);
  module.exports.createInstance({}).run();
} catch (error) {
  outcome = { name: error.name, message: error.message };
}
globalThis.__sablejs_map_inline_e2e_result__ = {
  code: result.code,
  map: result.map,
  outcome,
};
`
);

esbuild.buildSync({
  entryPoints: [mapInlineEntryPath],
  outfile: mapInlineOutputPath,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  logLevel: "warning",
  external: ["fs", "path"],
});

console.log(
  `Built ${path.relative(repositoryRoot, outputPath)} ` +
    `(${(fs.statSync(outputPath).size / 1000).toFixed(1)} KB)`
);
console.log(
  `Built ${path.relative(repositoryRoot, compilerOutputPath)} ` +
    `(${(fs.statSync(compilerOutputPath).size / 1000).toFixed(1)} KB)`
);
console.log(
  `Built ${path.relative(repositoryRoot, mapInlineOutputPath)} ` +
    `(${(fs.statSync(mapInlineOutputPath).size / 1000).toFixed(1)} KB)`
);
