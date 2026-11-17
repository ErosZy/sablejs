"use strict";

// Precompile at build time. The compiler never runs in the shipped app:
// this script turns guest source into a self-contained CommonJS artifact
// plus its source map and metadata, and everything the runtime app needs is
// just files on disk.
//
//   node examples/precompile/build.cjs
//   node examples/precompile/run.cjs          (no compiler involved)
//
// The artifact's only runtime dependency is the sablejs runtime module —
// pin it as a normal dependency and ship the artifact as a normal file.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { compile } = require("sablejs");

const guestPath = path.join(__dirname, "guest.js");
const outDir = path.join(__dirname, "out");
const source = fs.readFileSync(guestPath, "utf8");

// The compile options are part of the artifact's identity: the cache example
// keys on source + options together.
const compileOptions = {
  optimization: "O1",
  security: "sandbox",
  sourceMap: {
    mode: "external",
    sourceFile: "guest.js",
    generatedFile: "program.cjs",
    sourceMapURL: "program.cjs.map",
    sourcesContent: true, // devtools show guest.js inline — omit for privacy
  },
};

console.log(`building from ${guestPath} (${source.length} bytes)...`);
const result = compile(source, compileOptions);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "program.cjs"), result.code);
fs.writeFileSync(path.join(outDir, "program.cjs.map"), result.map);
fs.writeFileSync(
  path.join(outDir, "metadata.json"),
  JSON.stringify({ ...result.metadata, sourceKey: artifactKey(source, compileOptions) }, null, 2)
);

console.log("wrote out/program.cjs", result.code.length, "bytes");
console.log("wrote out/program.cjs.map", result.map.length, "bytes");
console.log(
  "wrote out/metadata.json (",
  result.metadata.security,
  "/",
  result.metadata.optimize,
  ")"
);
console.log("ship out/ + the sablejs runtime; the compiler is not needed at runtime");

// Deterministic identity for the artifact — used by the caching example.
function artifactKey(sourceText, options) {
  return crypto
    .createHash("sha256")
    .update(sourceText)
    .update(JSON.stringify(options))
    .digest("hex");
}
