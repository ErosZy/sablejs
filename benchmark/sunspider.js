"use strict";

const fs = require("fs");
const path = require("path");
const { sunspider: pinnedSunspider } = require("../tools/upstreams");
const { runSuite } = require("./sunspider-style");

const repositoryRoot = path.resolve(__dirname, "..");
const suiteRoot = path.resolve(
  process.env.sablejs_sunspider_dir ||
    path.join(repositoryRoot, ".cache/sunspider/benchmark_suites/sunspider-1.0")
);
const runtimeModule = path.resolve(repositoryRoot, "src/runtime");

// These three tests extend shared intrinsics (Date.prototype helpers,
// per-type toJSONString methods) and are therefore excluded from every
// backend so sandbox, trusted, and quickjs compare the same subset.
const EXCLUDED = new Set(["date-format-tofte", "date-format-xparb", "string-tagcloud"]);

const list = fs
  .readFileSync(path.join(suiteRoot, "LIST"), "utf8")
  .trim()
  .split(/\s+/)
  .filter(Boolean)
  .filter((name) => !EXCLUDED.has(name));

runSuite({
  suiteName: "sunspider",
  runtimeModule,
  list,
  hasTest(name) {
    return fs.existsSync(path.join(suiteRoot, `${name}.js`));
  },
  source(name) {
    return fs.readFileSync(path.join(suiteRoot, `${name}.js`), "utf8");
  },
})
  .then(({ total, skipped }) => {
    console.log(`[sunspider] pinned=${pinnedSunspider.commit}, skipped=${skipped.length}`);
  })
  .catch((error) => {
    console.error((error && error.stack) || error);
    process.exitCode = 1;
  });
