"use strict";

const assert = require("assert");
const { describe, it } = require("node:test");
const { environment, loadManifest } = require("../../benchmark/evidence");
const { validateManifest } = require("../../benchmark/check");

describe("benchmark evidence contract", function () {
  it("pins every visible tuning source and records its manifest hash", function () {
    const result = validateManifest(false);
    assert.deepStrictEqual(result.errors, []);
    assert.equal(result.counts.tuning, 9);
    assert.match(result.loaded.sha256, /^[a-f0-9]{64}$/);
    assert.equal(loadManifest().sha256, result.loaded.sha256);
  });

  it("fails the O2 release gate while the held-out corpus is incomplete", function () {
    const result = validateManifest(true);
    assert(result.errors.some((error) => /O2 release requires 20/.test(error)));
  });

  it("captures replay-relevant host and repository fields", function () {
    const value = environment();
    assert.match(value.node, /^v\d+/);
    assert(value.cpu);
    assert(Object.prototype.hasOwnProperty.call(value, "commit"));
    assert(Object.prototype.hasOwnProperty.call(value, "dirty"));
    assert(Object.prototype.hasOwnProperty.call(value, "affinity"));
  });
});
