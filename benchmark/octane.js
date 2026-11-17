"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { performance } = require("perf_hooks");
const { compile } = require("../src/compiler");
const { capability } = require("../src/runtime");
const { octane: pinnedOctane } = require("../tools/upstreams");

const repositoryRoot = path.resolve(__dirname, "..");
const octaneRoot = path.resolve(
  process.env.sablejs_octane_dir || path.join(repositoryRoot, ".cache/octane")
);
const runtimeModule = path.resolve(repositoryRoot, "src/runtime");

const SUITES = Object.freeze({
  Richards: ["richards.js"],
  DeltaBlue: ["deltablue.js"],
  Crypto: ["crypto.js"],
  RayTrace: ["raytrace.js"],
  EarleyBoyer: ["earley-boyer.js"],
  RegExp: ["regexp.js"],
  Splay: ["splay.js"],
  NavierStokes: ["navier-stokes.js"],
  PdfJS: ["pdfjs.js"],
  Mandreel: ["mandreel.js"],
  Gameboy: ["gbemu-part1.js", "gbemu-part2.js"],
  CodeLoad: ["code-load.js"],
  Box2D: ["box2d.js"],
  zlib: ["zlib.js", "zlib-data.js"],
  Typescript: ["typescript.js", "typescript-input.js", "typescript-compiler.js"],
});

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function read(name) {
  return fs.readFileSync(path.join(octaneRoot, name), "utf8");
}

if (!fs.existsSync(path.join(octaneRoot, "base.js"))) {
  throw new Error("Pinned Octane checkout is missing. Run: npm run upstream:fetch");
}
const revisionResult = spawnSync("git", ["-C", octaneRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
});
if (revisionResult.status !== 0)
  throw new Error(revisionResult.stderr || "Unable to read Octane revision");
const revision = revisionResult.stdout.trim();
if (revision !== pinnedOctane.commit) {
  throw new Error(`Octane revision mismatch: expected=${pinnedOctane.commit}, actual=${revision}`);
}

const requested = argument("suite", "Richards");
const selectedNames =
  requested.toLowerCase() === "all" ? Object.keys(SUITES) : requested.split(",").filter(Boolean);
selectedNames.forEach((name) => {
  if (!SUITES[name]) throw new Error(`Unknown Octane suite ${name}`);
});

const footer = `
var __sableOctaneSuccess = true;
function __sableOctaneResult(name, result) { print(name + ': ' + result); }
function __sableOctaneError(name, error) {
  __sableOctaneResult(name, error);
  __sableOctaneSuccess = false;
}
function __sableOctaneScore(score) {
  if (__sableOctaneSuccess) {
    print('----');
    print('Score (version ' + BenchmarkSuite.version + '): ' + score);
  }
}
BenchmarkSuite.config.doWarmup = undefined;
BenchmarkSuite.config.doDeterministic = undefined;
BenchmarkSuite.RunSuites({
  NotifyResult: __sableOctaneResult,
  NotifyError: __sableOctaneError,
  NotifyScore: __sableOctaneScore
});
if (!__sableOctaneSuccess) throw new Error('One or more Octane suites failed');
`;

const sourceParts = [read("base.js")];
selectedNames.forEach((name) =>
  SUITES[name].forEach((filename) => sourceParts.push(read(filename)))
);
sourceParts.push(footer);
let source = sourceParts.join("\n");
const optimization = argument("optimization", "O1");
const security = argument("security", "trusted");
const backend = argument("backend", "");
const useQuickJS = backend === "quickjs";
const identifierProtection = argument("identifier-protection", "alias");
const compileOnly = process.argv.includes("--compile-only");
const inlineHostIntrinsics = !process.argv.includes("--no-inline-host-intrinsics");
const inlineMemberIntrinsics = !process.argv.includes("--no-inline-member-intrinsics");
const deferBranchTest = !process.argv.includes("--no-branch-test-deferral");
const leafFrames = argument("leaf-frames", "true") !== "false";
const perScopeFactories =
  argument("per-scope-factories", optimization === "Os" ? "false" : "true") !== "false";

// Sandbox mode rejects assignments to shared intrinsics, so BenchmarkSuite's
// deterministic RNG must target a guest global instead of Math.random. The
// base.js ResetRNG body reassigns the renamed binding, which the guest is
// allowed to rebind; the fallback reads the host Math.random once.
if (security === "sandbox" && !useQuickJS) {
  source = source.replace(/\bMath\.random\b/g, "__sableOctaneRandom");
  // RayTrace assigns a local extend helper onto the shared Object intrinsic.
  source = source.replace(/\bObject\.extend\b/g, "__sableOctaneExtend");
  // DeltaBlue installs inheritsFrom on Object.prototype; sandbox mode
  // correctly rejects shared-intrinsic mutation, so lower it to a local
  // helper like the V8 benchmark suite does.
  source = source.replace(
    /Object\.defineProperty\(Object\.prototype, "inheritsFrom", \{[\s\S]*?\n\}\);/,
    "function __sableInheritsFrom(constructor, shuper) {\n" +
      "  function Inheriter() { }\n" +
      "  Inheriter.prototype = shuper.prototype;\n" +
      "  constructor.prototype = new Inheriter();\n" +
      "  constructor.superConstructor = shuper;\n" +
      "}"
  );
  source = source.replace(/([A-Za-z0-9_$\]\.]+)\.inheritsFrom\(/g, "__sableInheritsFrom($1, ");
  source =
    "var __sableOctaneRandom = Math.random;\n" +
    "var __sableOctaneExtend = function(){};\n" +
    source;
}

const compileStartedAt = performance.now();
const compiled = useQuickJS
  ? null
  : compile(source, {
      optimization,
      security,
      identifierProtection,
      leafFrames,
      perScopeFactories,
      inlineHostIntrinsics,
      inlineMemberIntrinsics,
      deferBranchTest,
      runtimeModule,
    });
const compileMs = performance.now() - compileStartedAt;
const generatedModule = { exports: {} };
if (!useQuickJS) {
  new Function("require", "module", "exports", compiled.code)(
    require,
    generatedModule,
    generatedModule.exports
  );
}

if (useQuickJS) {
  console.log(
    `[Octane v${9}] backend=quickjs revision=${revision}, suites=${selectedNames.join(",")}, ` +
      `source=${(Buffer.byteLength(source) / 1000).toFixed(1)} KB`
  );
} else {
  console.log(
    `[Octane v${9}] revision=${revision}, suites=${selectedNames.join(",")}, ` +
      `compile=${compileMs.toFixed(1)} ms, source=${(Buffer.byteLength(source) / 1000).toFixed(
        1
      )} KB, ` +
      `code=${(Buffer.byteLength(compiled.code) / 1000).toFixed(1)} KB, fast=${
        compiled.stats.codegen.fastFrameScopes
      }, ` +
      `leaf=${compiled.stats.codegen.leafFrameScopes}, fallback=${compiled.stats.codegen.fallbackScopes}, ` +
      `aliases=${compiled.stats.codegen.identifierProtection.aliasedBindings}, ` +
      `intrinsic=${compiled.stats.codegen.inlining.hostIntrinsicCallSites}`
  );
}

if (!compileOnly) {
  if (useQuickJS) {
    const { createQuickJSRunner } = require("./quickjs-runner");
    createQuickJSRunner((value) => console.log(value))
      .then((runner) => {
        try {
          runner.evaluate(source, "octane.js");
        } finally {
          runner.dispose();
        }
      })
      .catch((error) => {
        console.error((error && error.stack) || error);
        process.exitCode = 1;
      });
  } else {
    const globals =
      security === "sandbox"
        ? { print: capability((value) => console.log(value), { name: "print" }) }
        : {
            performance,
            print(value) {
              console.log(value);
            },
          };
    const instance = generatedModule.exports.createInstance({ globals });
    try {
      instance.run();
    } finally {
      instance.dispose();
    }
  }
}
