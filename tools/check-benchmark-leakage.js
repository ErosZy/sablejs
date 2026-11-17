"use strict";

const fs = require("fs");
const path = require("path");

const repositoryRoot = path.resolve(__dirname, "..");
const productionRoots = [path.join(repositoryRoot, "src")];
const benchmarkNames = [
  "richards",
  "deltablue",
  "raytrace",
  "navierstokes",
  "octane",
  "sunspider",
  "kraken",
  "v8-suite",
];

function stripComments(source) {
  // This check is deliberately lexical. It is not a JavaScript parser or a
  // semantic security boundary; its job is to reject the concrete leakage
  // shapes that should never be present in production compiler/runtime code.
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function analyzeSource(filename, source) {
  const findings = [];
  const code = stripComments(source);
  const importPattern = /(?:require\s*\(\s*|from\s+)["'][^"']*benchmark[^"']*["']/gi;
  const namePattern = new RegExp(`\\b(?:${benchmarkNames.join("|")})\\b`, "gi");
  // A source offset may be compared with a boundary computed from verified
  // metadata. A literal equality check is the brittle payload-binding shape
  // this gate rejects; array indexes and loop counters are intentionally out
  // of scope.
  const fixedOffsetPattern =
    /(?:\b[A-Za-z_$][\w$]*\.)?offset\s*(?:===|==)\s*\d+|\d+\s*(?:===|==)\s*(?:\b[A-Za-z_$][\w$]*\.)?offset\b/g;
  const fixtureHashPattern =
    /(?:fixture|benchmark)(?:Hash|Digest)\s*(?:===|==)\s*["'][a-f0-9]{8,}["']/gi;

  for (const [kind, pattern] of [
    ["benchmark-import", importPattern],
    ["benchmark-name", namePattern],
    ["fixed-offset-predicate", fixedOffsetPattern],
    ["fixture-hash-predicate", fixtureHashPattern],
  ]) {
    let match;
    while ((match = pattern.exec(code))) {
      const line = code.slice(0, match.index).split("\n").length;
      findings.push({ filename, line, kind, text: match[0] });
    }
  }
  return findings;
}

function filesUnder(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...filesUnder(filename));
    else if (entry.isFile() && /\.(?:c?js|mjs|ts)$/.test(entry.name)) output.push(filename);
  }
  return output;
}

function scanProduction() {
  return productionRoots
    .flatMap((root) => filesUnder(root))
    .flatMap((filename) =>
      analyzeSource(path.relative(repositoryRoot, filename), fs.readFileSync(filename, "utf8"))
    );
}

function main() {
  const findings = scanProduction();
  if (findings.length) {
    findings.forEach((finding) => {
      console.error(`${finding.filename}:${finding.line}: ${finding.kind}: ${finding.text}`);
    });
    process.exitCode = 1;
    return;
  }
  console.log(`benchmark leakage check passed (${productionRoots.length} production root)`);
}

module.exports = { analyzeSource, benchmarkNames, scanProduction, stripComments };

if (require.main === module) main();
