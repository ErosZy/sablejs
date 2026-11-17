"use strict";

const fs = require("fs");
const path = require("path");
const { kraken: pinnedKraken } = require("../tools/upstreams");
const { runSuite } = require("./sunspider-style");

const repositoryRoot = path.resolve(__dirname, "..");
const suiteRoot = path.resolve(
  process.env.sablejs_kraken_dir || path.join(repositoryRoot, ".cache/kraken/tests/kraken-1.1")
);
const runtimeModule = path.resolve(repositoryRoot, "src/runtime");

// The imaging tests embed ~1.8 MB flat array literals. Their historical
// exclusions (quadratic table dedup, quadratic SCCP result scan, O2 const
// scope overflow, 47 MB generated code per test) are all fixed; the codegen
// folds constant literal-array chains into native literals (~1.8 MB output
// per test), so the full LIST runs on every backend.
const EXCLUDED = new Set([]);

// ai-astar installs helpers on the shared Array prototype. Sandbox mode
// rejects shared-intrinsic mutation, so lower them to local functions for
// every backend (the rewrite is semantics-preserving).
function adaptSharedIntrinsics(source) {
  source = source.replace(
    /Array\.prototype\.each\s*=\s*function\s*\(f\)\s*\{[\s\S]*?\n\}/,
    "function __sableEach(array, f) {\n" +
      "  if (!f.apply) return;\n" +
      "  for (var i = 0; i < array.length; i++) {\n" +
      "    f.apply(array[i], [i, array]);\n" +
      "  }\n" +
      "}"
  );
  source = source.replace(
    /Array\.prototype\.findGraphNode\s*=\s*function\s*\(obj\)\s*\{[\s\S]*?\n\}/,
    "function __sableFindGraphNode(array, obj) {\n" +
      "  for (var i = 0; i < array.length; i++) {\n" +
      "    if (array[i].pos == obj.pos) { return array[i]; }\n" +
      "  }\n" +
      "  return false;\n" +
      "}"
  );
  source = source.replace(
    /Array\.prototype\.removeGraphNode\s*=\s*function\s*\(obj\)\s*\{[\s\S]*?\n\}/,
    "function __sableRemoveGraphNode(array, obj) {\n" +
      "  for (var i = 0; i < array.length; i++) {\n" +
      "    if (array[i].pos == obj.pos) { array.splice(i, 1); }\n" +
      "  }\n" +
      "  return false;\n" +
      "}"
  );
  source = source.replace(/([A-Za-z0-9_$\]\.]+)\.findGraphNode\(/g, "__sableFindGraphNode($1, ");
  source = source.replace(
    /([A-Za-z0-9_$\]\.]+)\.removeGraphNode\(/g,
    "__sableRemoveGraphNode($1, "
  );
  return source;
}

const list = fs
  .readFileSync(path.join(suiteRoot, "LIST"), "utf8")
  .trim()
  .split(/\s+/)
  .filter(Boolean)
  .filter((name) => !EXCLUDED.has(name));

runSuite({
  suiteName: "kraken",
  runtimeModule,
  list,
  hasTest(name) {
    return fs.existsSync(path.join(suiteRoot, `${name}.js`));
  },
  source(name) {
    // The harness contract: data files load first and are not timed.
    const dataPath = path.join(suiteRoot, `${name}-data.js`);
    const data = fs.existsSync(dataPath) ? fs.readFileSync(dataPath, "utf8") + "\n" : "";
    return adaptSharedIntrinsics(
      data + fs.readFileSync(path.join(suiteRoot, `${name}.js`), "utf8")
    );
  },
})
  .then(({ total, skipped }) => {
    console.log(`[kraken] pinned=${pinnedKraken.commit}, skipped=${skipped.length}`);
  })
  .catch((error) => {
    console.error((error && error.stack) || error);
    process.exitCode = 1;
  });
