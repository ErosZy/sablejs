"use strict";

// Compiled-artifact cache. compile() is the expensive part of the pipeline;
// when the guest source (and the compile options) are unchanged, the
// artifact is deterministic, so the cache is a plain content-addressable
// store: key = sha256(source + canonical options), value = artifact files.
//
//   node examples/caching/cache.cjs
//
// Run it twice: the second run compiles nothing. Then edit guest.js (or the
// options) and the cache invalidates by key. The cache persists across
// processes in examples/.cache/caching (gitignored) — the example's own
// labels depend on what is already cached, which is exactly the point.
// (The CI test clears the cache first for a deterministic miss/hit/miss
// sequence.)

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { compile } = require("sablejs");
const compilerVersion = require("../../package.json").version;
const CACHE_SCHEMA_VERSION = 2;
const DEFAULT_OPTIMIZATION = "O1";

const guestPath = path.join(__dirname, "..", "precompile", "guest.js");
const cacheDir = path.join(__dirname, "..", ".cache", "caching");

const compileOptions = {
  security: "sandbox",
  sourceMap: { mode: "external", sourceFile: "guest.js", generatedFile: "program.cjs" },
};

function keyFor(source, options) {
  // JSON.stringify is deterministic here because option objects are written
  // with literal key order; canonicalize explicitly if you build options
  // dynamically (e.g. sort keys recursively).
  return crypto
    .createHash("sha256")
    .update(source)
    .update(
      JSON.stringify({
        cacheSchema: CACHE_SCHEMA_VERSION,
        compilerVersion,
        options: { optimization: DEFAULT_OPTIMIZATION, ...options },
      })
    )
    .digest("hex");
}

function loadArtifact(key) {
  const dir = path.join(cacheDir, key);
  const codePath = path.join(dir, "program.cjs");
  if (!fs.existsSync(codePath)) return null;
  return {
    code: fs.readFileSync(codePath, "utf8"),
    map: fs.existsSync(path.join(dir, "program.cjs.map"))
      ? fs.readFileSync(path.join(dir, "program.cjs.map"), "utf8")
      : undefined,
  };
}

function compileIntoCache(key, source) {
  const dir = path.join(cacheDir, key);
  const result = compile(source, compileOptions);
  if (result.optimization !== DEFAULT_OPTIMIZATION) {
    throw new Error(
      `cache default mismatch: expected ${DEFAULT_OPTIMIZATION}, got ${result.optimization}`
    );
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "program.cjs"), result.code);
  if (result.map) fs.writeFileSync(path.join(dir, "program.cjs.map"), result.map);
  return result;
}

function run(source, label) {
  const key = keyFor(source, compileOptions);
  const start = process.hrtime.bigint();
  const artifact = loadArtifact(key);
  const cache = artifact !== null;
  const result = artifact || compileIntoCache(key, source);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  // The artifact is loaded the same way in both cases — the cache only
  // changes *when* code is generated.
  const loaded = loadFromString(result.code);
  const instance = loaded.createInstance({
    globals: { input: { vip: true, items: [{ price: 10, count: 2 }] } },
  });
  let value;
  try {
    value = instance.run();
  } finally {
    instance.dispose();
  }

  console.log(
    `${cache ? "cache hit " : "cache miss"} · ${elapsedMs.toFixed(1)} ms · key ${key.slice(0, 12)}…`
  );
  return value;
}

// Minimal artifact loader: generated code only imports "sablejs/runtime".
// (A require()-based loader works in Node; this string loader mirrors how
// bundlers and workers load artifacts.)
function loadFromString(code) {
  const module = { exports: {} };
  const runtimeRequire = (specifier) => {
    if (specifier === "sablejs/runtime" || specifier === "sablejs") {
      return require("sablejs/runtime");
    }
    throw new Error(`unexpected module ${specifier}`);
  };
  new Function("require", "module", "exports", code)(runtimeRequire, module, module.exports);
  return module.exports;
}

// --- demo: three runs, one cache miss, two hits, then a source change ----

// A fresh checkout (or CI) runs cold: run 1 misses, runs 2-3 hit, and the
// changed source misses again. With a warm cache the first run hits instead
// — the labels reflect what actually happened on this process's disk.
const original = fs.readFileSync(guestPath, "utf8");

console.log("run 1 — first source (cold only on a fresh cache):");
console.log("  ", JSON.stringify(run(original, "run 1")));

console.log("run 2 — same source, cache should hit:");
console.log("  ", JSON.stringify(run(original, "run 2")));

console.log("run 3 — same source again:");
console.log("  ", JSON.stringify(run(original, "run 3")));

// Any source change produces a different key (and a fresh artifact).
const modified = original.replace("ship: input.items.length > 2 ? 0 : 10", "ship: 5");
console.log("run 4 — source changed, new key (misses unless cached earlier):");
console.log("  ", JSON.stringify(run(modified, "run 4")));
