"use strict";

// Runs every runnable example exactly as examples/README.md documents and
// asserts on its stable output lines, so the example corpus stays working
// (npm run check:examples). Node examples run unconditionally; the Deno and
// Bun examples skip when their runtime is not installed.
//
// The precompile example regenerates examples/precompile/out/, the caching
// example writes examples/.cache/, and the browser example rebuilds
// examples/browser/dist/ — all gitignored.

const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");

function run(script, args, options = {}) {
  return execFileSync(script, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    ...options,
  });
}

function nodeExample(examplePath) {
  return run(process.execPath, [examplePath]);
}

function hasBin(bin) {
  return spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
}

test("node/basic.cjs — compile → artifact → run → dispose", () => {
  const out = nodeExample("examples/node/basic.cjs");
  assert.match(out, /guest returned: \{ total: 120, units: 2 \}/);
});

test("node/error-handling.cjs — every failure mode", () => {
  const out = nodeExample("examples/node/error-handling.cjs");
  assert.match(out, /bad option\s+: Unknown sablejs security mode paranoid/);
  assert.match(out, /guest throw\s+: Error - guest boom/);
  assert.match(out, /sandbox cap\s+: TypeError - host database is down - stackless/);
  assert.match(out, /trusted cap\s+: TypeError - raw host error - stack: present/);
  assert.match(out, /boundary\s+: stack deleted/);
  assert.match(out, /can only run once/);
  assert.match(out, /Cannot run a disposed sablejs instance/);
});

test("node/functions.cjs — guest function calls", () => {
  const out = nodeExample("examples/node/functions.cjs");
  assert.match(out, /guest closure\s*: 1 3 6 \(state kept between calls\)/);
  assert.match(out, /via globals\s*: \{ line: 20, tax: 4, qty: 2 \}/);
  assert.match(out, /via argument\s*: 12/);
  assert.match(out, /capability\(\)\s*: \{ sum: 1003, ok: true \}/);
  assert.match(out, /only numbers/);
  assert.match(out, /input global\s*: \{ total: 120 \}/);
});

test("trusted/trusted.cjs — trusted-mode direct globalThis access", () => {
  const out = nodeExample("examples/trusted/trusted.cjs");
  assert.match(out, /trusted globalThis: \[true,"object"/);
  assert.match(out, /host sees marker\s+: 123/);
  assert.match(
    out,
    /sandbox contrast\s+: sablejs sandbox boundary: globals\.GLOBAL contains an ambient host object/
  );
  assert.match(out, /reference identity: true \| host\.count now 2/);
  assert.match(out, /prototype chain\s*: \[37,true\]/);
  assert.match(out, /raw host error\s*: \["Error","raw boom","string"\]/);
  assert.match(out, /token unwraps\s*: \[true,20\]/);
  assert.match(out, /host sees 'guestOnly': undefined/);
});

test("precompile/ — build-time compile, runtime app never imports the compiler", () => {
  run(process.execPath, ["examples/precompile/build.cjs"]);
  const out = nodeExample("examples/precompile/run.cjs");
  assert.match(out, /artifact: es5\.1 · sandbox · O1/);
  assert.match(out, /receipt: \{ line: 32, ship: 10 \}/);
});

test("caching/ — artifact cache: hits, then miss on source change", () => {
  // The example keeps a persistent cache across processes (that is its
  // point); the test clears it first so the outcome is deterministic:
  // run 1 misses, runs 2-3 hit, run 4 misses again on the changed source.
  fs.rmSync(path.join(ROOT, "examples/.cache/caching"), { recursive: true, force: true });
  const out = nodeExample("examples/caching/cache.cjs");
  assert.match(out, /run 1 — first source/);
  assert.match(out, /\{"line":16,"ship":10\}/);
  assert.match(out, /run 3 — same source again:/);
  assert.match(out, /run 4 — source changed, new key/);
  assert.match(out, /\{"line":16,"ship":5\}/); // the changed source actually ran
  // The hit/miss labels must match the actual outcome (cache was cleared).
  assert.deepStrictEqual(
    [...out.matchAll(/cache (hit|miss) +·/g)].map((m) => m[1]),
    ["miss", "hit", "hit", "miss"],
    "cache labels diverged from the real outcome"
  );
});

test("worker/host.cjs — Worker isolation with timeouts (Node adapter)", () => {
  const out = nodeExample("examples/worker/host.cjs");
  assert.match(out, /\[worker\] sandbox worker ready/);
  assert.match(out, /run\(\)\s*: \{ line: 32, ship: 10 \}/);
  assert.match(out, /evaluate\(\) : \{ reversed: 'sjelbas' \}/);
  assert.match(out, /timed out after 300 ms/);
  assert.match(out, /done/);
});

test("browser/ — esbuild bundle of a precompiled artifact runs", () => {
  const buildOut = run(process.execPath, ["examples/browser/build.cjs"]);
  assert.match(buildOut, /built dist\/bundle\.js \(\d+ bytes\)/);

  // Execute the IIFE bundle in a bare context: the entry stashes the guest's
  // return value on the page global, exactly like index.html would.
  const bundle = fs.readFileSync(path.join(ROOT, "examples/browser/dist/bundle.js"), "utf8");
  const context = vm.createContext({});
  vm.runInContext(bundle, context);
  // JSON round-trip: the result object was created inside the VM realm, so
  // its prototype is the VM's, not this test's.
  const result = JSON.parse(JSON.stringify(context.__sablejsResult__));
  assert.deepStrictEqual(result, {
    total: 4,
    longest: "ahead-of-time",
    stamp: "from index.html",
  });

  // The final bundle must carry the map the page promises: esbuild chains
  // the artifact's inline data-URL map, so decoding the bundle's own inline
  // map must reach the guest source (and its first statement, at least).
  const { TraceMap, eachMapping } = require("@jridgewell/trace-mapping");
  const mapComment = bundle.match(
    /\n\/\/# sourceMappingURL=data:application\/json[^,]*;base64,(.*)\s*$/
  );
  assert.ok(mapComment, "final bundle has no inline source map");
  const decoded = new TraceMap(JSON.parse(Buffer.from(mapComment[1], "base64").toString("utf8")));
  assert.ok(
    decoded.sources.includes("guest.js"),
    `bundle map sources ${JSON.stringify(decoded.sources)} never reach guest.js`
  );
  let mapsToGuest = 0;
  eachMapping(decoded, (m) => {
    // eachMapping reports the source *name*, not the sources[] index.
    if (m.source === "guest.js" && m.originalLine >= 1) mapsToGuest += 1;
  });
  assert.ok(mapsToGuest > 0, "no bundle segment resolves to the guest source");
});

test("deno/ — bundle for a neutral platform, run under Deno", { skip: !hasBin("deno") }, () => {
  run(process.execPath, ["examples/deno/build.mjs"]);
  const out = run("deno", ["run", "examples/deno/main.ts"]);
  assert.match(out, /deno guest returned: \{"line":32,"ship":10\}/);
});

test("bun/ — run under Bun", { skip: !hasBin("bun") }, () => {
  const out = run("bun", ["examples/bun/main.ts"]);
  assert.match(out, /compiled: O1 · sandbox · \d+ bytes/);
  assert.match(out, /bun guest returned: 15/);
});
