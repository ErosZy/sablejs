"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { compile } = require("../src/compiler");
const { capability } = require("../src/runtime");
const { createQuickJSRunner } = require("./quickjs-runner");
const { environment, loadManifest, writeArtifact } = require("./evidence");

const SUITES = ["Richards", "Crypto", "RayTrace", "NavierStokes", "DeltaBlue"];
const repositoryRoot = path.resolve(__dirname, "..");
const runtimeModule = path.join(repositoryRoot, "src/runtime");
const source = fs.readFileSync(path.join(__dirname, "v8-suite.js"), "utf8");

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const samples = Number(argument("samples", "3"));
const warmup = Number(argument("warmup", "1"));
const optimization = argument("optimization", "O1");
const protocol = argument("protocol", "warm");
const output = argument("output", "");
const disabledPasses = argument("disable-pass", "").split(",").filter(Boolean);
const passOptions = {
  sccp: "sparseConditionalConstantPropagation",
  "copy-propagation": "copyPropagation",
  dce: "deadCodeElimination",
  gvn: "globalValueNumbering",
  licm: "loopInvariantCodeMotion",
  dse: "deadStoreElimination",
};
const backendArgument = argument("backend", "all");
const requestedBackends =
  backendArgument === "all"
    ? ["sablejs-sandbox", "sablejs-trusted", "quickjs"]
    : backendArgument.split(",").filter(Boolean);
const backends = [
  ...new Set(
    requestedBackends.map((backend) => (backend === "sablejs" ? "sablejs-trusted" : backend))
  ),
];
if (!Number.isInteger(samples) || samples < 3) throw new Error("--samples must be an integer >= 3");
if (!Number.isInteger(warmup) || warmup < 0)
  throw new Error("--warmup must be a non-negative integer");
if (!["cold", "warm"].includes(protocol)) throw new Error("--protocol must be cold or warm");
disabledPasses.forEach((name) => {
  if (!passOptions[name]) throw new Error(`Unknown optimizer pass ${name}`);
});
backends.forEach((backend) => {
  if (!["sablejs-sandbox", "sablejs-trusted", "quickjs"].includes(backend)) {
    throw new Error(`Unknown backend ${backend}`);
  }
});

function percentile(values, fraction) {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(values) {
  const median = percentile(values, 0.5);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const absoluteDeviations = values.map((value) => Math.abs(value - median));
  return {
    median,
    p05: percentile(values, 0.05),
    p95: percentile(values, 0.95),
    min: Math.min(...values),
    max: Math.max(...values),
    relativeMadPct: median === 0 ? 0 : (percentile(absoluteDeviations, 0.5) / median) * 100,
    coefficientOfVariationPct: mean === 0 ? 0 : (Math.sqrt(variance) / mean) * 100,
    samples: values,
  };
}

function parseOutput(lines) {
  const scores = {};
  let total;
  for (const line of lines) {
    const suite = line.match(/^(Richards|Crypto|RayTrace|NavierStokes|DeltaBlue):\s*([0-9.]+)$/);
    if (suite) scores[suite[1]] = Number(suite[2]);
    const overall = line.match(/^Score \(version 7\):\s*([0-9.]+)$/);
    if (overall) total = Number(overall[1]);
  }
  assert.deepStrictEqual(
    Object.keys(scores).sort(),
    SUITES.slice().sort(),
    `Incomplete suite output: ${lines.join(" | ")}`
  );
  assert(Number.isFinite(total), `Missing overall score: ${lines.join(" | ")}`);
  return { ...scores, total };
}

function captureConsole(run) {
  const lines = [];
  run((value) => lines.push(String(value)));
  return parseOutput(lines);
}

function prepareCompiler(security) {
  const optimizerOptions = Object.fromEntries(
    disabledPasses.map((name) => [passOptions[name], false])
  );
  const compiled = compile(source, { optimization, runtimeModule, security, ...optimizerOptions });
  const generatedModule = { exports: {} };
  new Function("require", "module", "exports", compiled.code)(
    require,
    generatedModule,
    generatedModule.exports
  );
  return {
    compiled,
    program: generatedModule.exports,
    security,
    evidence: {
      metadata: compiled.metadata,
      optimizer: compiled.stats,
      generatedBytes: Buffer.byteLength(compiled.code),
    },
  };
}

function runCompiler(prepared) {
  return captureConsole((emit) => {
    const print = prepared.security === "sandbox" ? capability(emit, { name: "print" }) : emit;
    const instance = prepared.program.createInstance({ globals: { print } });
    try {
      instance.run();
    } finally {
      instance.dispose();
    }
  });
}

async function prepareQuickJS() {
  const lines = [];
  const runner = await createQuickJSRunner((value) => lines.push(value));
  const execute = runner.prepare(source, "v8-suite.js");
  return { lines, execute, dispose: () => runner.dispose() };
}

async function runQuickJS(prepared) {
  prepared.lines.length = 0;
  prepared.execute();
  return parseOutput(prepared.lines);
}

async function collect(name, prepare, execute) {
  let prepared = null;
  let preparation = null;
  async function once(timed) {
    let candidate = prepared;
    const startedAt = timed ? performance.now() : 0;
    if (protocol === "cold") candidate = await prepare();
    try {
      const result = await execute(candidate);
      if (!preparation && candidate && candidate.evidence) preparation = candidate.evidence;
      return timed ? { ...result, elapsedMs: performance.now() - startedAt } : result;
    } finally {
      if (protocol === "cold" && candidate && typeof candidate.dispose === "function")
        candidate.dispose();
    }
  }
  try {
    if (protocol === "warm") {
      prepared = await prepare();
      preparation = prepared.evidence || null;
    }
    for (let index = 0; index < warmup; index += 1) await once(false);
    const rounds = [];
    for (let index = 0; index < samples; index += 1) {
      if (typeof global.gc === "function") global.gc();
      const result = await once(true);
      rounds.push(result);
      console.error(`[release] ${name} ${index + 1}/${samples}: score=${result.total}`);
    }
    const metrics = {};
    for (const metric of [...SUITES, "total", "elapsedMs"]) {
      metrics[metric] = summarize(rounds.map((round) => round[metric]));
    }
    return { rounds, metrics, preparation };
  } finally {
    if (prepared && typeof prepared.dispose === "function") prepared.dispose();
  }
}

async function main() {
  const corpus = loadManifest();
  const result = {
    schemaVersion: 1,
    environment: environment(),
    corpus: {
      path: corpus.path,
      sha256: corpus.sha256,
      counts: {
        tuning: corpus.value.tuning.length,
        heldout: corpus.value.heldout.length,
        adversarial: corpus.value.adversarial.length,
      },
    },
    configuration: {
      samples,
      warmup,
      protocol,
      optimization,
      disabledPasses,
      suites: SUITES,
      expectedSuiteCount: SUITES.length,
      backends,
    },
    backends: {},
    errors: [],
  };
  try {
    if (backends.includes("sablejs-sandbox")) {
      result.backends["sablejs-sandbox"] = await collect(
        "sablejs-sandbox",
        () => prepareCompiler("sandbox"),
        runCompiler
      );
    }
    if (backends.includes("sablejs-trusted")) {
      result.backends["sablejs-trusted"] = await collect(
        "sablejs-trusted",
        () => prepareCompiler("trusted"),
        runCompiler
      );
    }
    if (backends.includes("quickjs")) {
      result.backends.quickjs = await collect("quickjs", prepareQuickJS, runQuickJS);
    }
    const sandbox = result.backends["sablejs-sandbox"];
    const trusted = result.backends["sablejs-trusted"];
    if (sandbox && trusted) {
      // Sandbox tax = 1 - sandbox / trusted; the fraction of throughput the
      // boundary costs on each workload. Lower is better.
      result.sandboxTax = {};
      console.error("[release] sandbox tax (1 - sandbox/trusted):");
      for (const metric of [...SUITES, "total"]) {
        const tax = 1 - sandbox.metrics[metric].median / trusted.metrics[metric].median;
        result.sandboxTax[metric] = Number(tax.toFixed(4));
        console.error(`  ${metric}: ${(tax * 100).toFixed(1)}%`);
      }
    }
  } catch (error) {
    result.errors.push({
      name: error && error.name,
      message: String((error && error.message) || error),
    });
    process.exitCode = 1;
  }
  if (output) result.output = writeArtifact(output, result);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error((error && error.stack) || error);
  process.exitCode = 1;
});
