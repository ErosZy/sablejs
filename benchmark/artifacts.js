"use strict";

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const prettier = require("prettier");
const uglify = require("uglify-js");
const { compile } = require("../src/compiler");

const sourcePath = path.resolve(__dirname, "v8-suite.js");
const rawPath = path.resolve(__dirname, "v8-suite.aot.cjs");
const minPath = path.resolve(__dirname, "v8-suite.aot.min.cjs");
const formattedPath = path.resolve(__dirname, "v8-suite.aot.formatted.cjs");
const source = fs.readFileSync(sourcePath, "utf8");
const optimizationArgument = process.argv.find((entry) => entry.startsWith("--optimization="));
const optimization = optimizationArgument
  ? optimizationArgument.slice("--optimization=".length)
  : "O1";

const startedAt = performance.now();
const compiled = compile(source, {
  optimization,
  identifierProtection: "alias",
  runtimeModule: "../src/runtime",
  security: "trusted",
});
const compileMs = performance.now() - startedAt;
const minified = uglify.minify(compiled.code, {
  compress: { passes: 3 },
  mangle: { toplevel: true },
  output: { comments: false },
});
if (minified.error) throw minified.error;
const formatted = prettier.format(compiled.code, { parser: "babel" });

fs.writeFileSync(rawPath, compiled.code);
fs.writeFileSync(minPath, minified.code);
fs.writeFileSync(formattedPath, formatted);

console.log(
  JSON.stringify(
    {
      optimization: compiled.optimization,
      identifierProtection: compiled.metadata.identifierProtection,
      compileMs,
      sourceBytes: Buffer.byteLength(source),
      rawBytes: Buffer.byteLength(compiled.code),
      minifiedBytes: Buffer.byteLength(minified.code),
      formattedBytes: Buffer.byteLength(formatted),
      codegen: compiled.stats.codegen,
    },
    null,
    2
  )
);
