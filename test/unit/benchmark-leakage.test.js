"use strict";

const assert = require("assert");
const { describe, it } = require("node:test");
const { analyzeSource, scanProduction } = require("../../tools/check-benchmark-leakage");

describe("benchmark leakage gate", function () {
  it("accepts the production compiler and runtime", function () {
    assert.deepStrictEqual(scanProduction(), []);
  });

  it("rejects benchmark imports, names, fixture hashes, and fixed offsets", function () {
    const findings = analyzeSource(
      "candidate.js",
      `
      const fixture = require("../benchmark/v8-suite");
      if (scope.name === "Richards") enableFastPath();
      if (op.offset === 129) eliminate(op);
      if (benchmarkHash === "deadbeefcafebabe") specialize();
    `
    );
    assert.deepStrictEqual(findings.map((finding) => finding.kind).sort(), [
      "benchmark-import",
      "benchmark-name",
      "benchmark-name",
      "fixed-offset-predicate",
      "fixture-hash-predicate",
    ]);
  });

  it("does not turn historical comments or computed boundaries into predicates", function () {
    const findings = analyzeSource(
      "candidate.js",
      `
      // Richards once exposed this generic call-shape issue.
      /* SunSpider is not a dispatch key. */
      if (op.offset === region.end) retain(op);
    `
    );
    assert.deepStrictEqual(findings, []);
  });
});
