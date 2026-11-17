"use strict";

// Shared harness for SunSpider-shaped suites (SunSpider 1.0 and Kraken 1.1):
// each test is a self-contained script that executes its workload on load,
// optionally preceded by an untimed -data.js companion. Lower totals are
// better. Backends: sablejs-sandbox, sablejs-trusted, quickjs.

const { performance } = require("perf_hooks");
const { compile } = require("../src/compiler");
const { createQuickJSRunner } = require("./quickjs-runner");

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function runSuite(options) {
  const backend = argument("backend", "sablejs-sandbox");
  const samples = Number(argument("samples", "3"));
  const optimization = argument("optimization", "O1");
  const requested = argument("suite", "");
  const selection = requested ? new Set(requested.split(",").filter(Boolean)) : null;
  if (selection) {
    const unknown = Array.from(selection).filter((name) => !options.list.includes(name));
    if (unknown.length)
      throw new Error(`Unknown ${options.suiteName} tests: ${unknown.join(", ")}`);
  }
  const tests = options.list.filter((name) => !selection || selection.has(name));
  const missing = tests.filter((name) => !options.hasTest(name));
  if (missing.length) throw new Error(`Missing ${options.suiteName} tests: ${missing.join(", ")}`);
  const summary = {
    suite: options.suiteName,
    backend,
    optimization: backend === "quickjs" ? null : optimization,
    samples,
    expectedCount: tests.length,
    results: {},
    skipped: {},
    totals: [],
  };

  const measure = (fn) => {
    const startedAt = performance.now();
    fn();
    return performance.now() - startedAt;
  };

  if (backend === "quickjs") {
    const lines = [];
    const runner = await createQuickJSRunner((value) => lines.push(value));
    const prepared = new Map();
    for (const name of tests) {
      prepared.set(name, runner.prepare(options.source(name), `${name}.js`));
    }
    for (let sample = 0; sample < samples; sample += 1) {
      let total = 0;
      for (const name of tests) {
        try {
          const ms = measure(() => prepared.get(name)());
          summary.results[name] = (summary.results[name] || []).concat(ms);
          total += ms;
          console.log(`[${sample + 1}/${samples}] ${name}: ${ms.toFixed(1)} ms`);
        } catch (error) {
          summary.skipped[name] = String(error.message);
          console.log(`[${sample + 1}/${samples}] SKIP ${name}: ${error.message}`);
        }
      }
      summary.totals.push(total);
    }
    runner.dispose();
  } else {
    const security = backend === "sablejs-sandbox" ? "sandbox" : "trusted";
    // Compile each test once; samples re-run the same compiled program.
    const programs = new Map();
    for (const name of tests) {
      try {
        const compileStartedAt = performance.now();
        const compiled = compile(options.source(name), {
          optimization,
          security,
          runtimeModule: options.runtimeModule,
        });
        const compileMs = performance.now() - compileStartedAt;
        const generatedModule = { exports: {} };
        new Function("require", "module", "exports", compiled.code)(
          require,
          generatedModule,
          generatedModule.exports
        );
        programs.set(name, generatedModule.exports);
        console.log(
          `compile ${name}: ${compileMs.toFixed(0)} ms, code ${(
            Buffer.byteLength(compiled.code) / 1000
          ).toFixed(0)} KB`
        );
      } catch (error) {
        summary.skipped[name] = String(error.message);
        console.log(`SKIP ${name}: ${error.message}`);
      }
    }
    for (let sample = 0; sample < samples; sample += 1) {
      let total = 0;
      for (const name of tests) {
        if (!programs.has(name)) continue;
        try {
          const instance = programs.get(name).createInstance({});
          const ms = measure(() => instance.run());
          instance.dispose();
          summary.results[name] = (summary.results[name] || []).concat(ms);
          total += ms;
          console.log(`[${sample + 1}/${samples}] ${name}: ${ms.toFixed(1)} ms`);
        } catch (error) {
          summary.skipped[name] = String(error.message);
          console.log(`[${sample + 1}/${samples}] SKIP ${name}: ${error.message}`);
        }
      }
      summary.totals.push(total);
    }
  }

  for (const name of tests) {
    const values = summary.results[name];
    console.log(
      values && values.length
        ? `${name}: ${median(values).toFixed(1)} ms`
        : `SKIP ${name}: ${summary.skipped[name] || "no result"}`
    );
  }
  const skipped = tests.filter((name) => !summary.results[name]);
  const incomplete = tests.filter(
    (name) => !summary.results[name] || summary.results[name].length !== samples
  );
  const total = summary.totals.length ? median(summary.totals) : 0;
  console.log(
    `RESULT ${options.suiteName} ${backend}: total=${total.toFixed(1)} ms, ` +
      `ran=${tests.length - skipped.length}/${tests.length}, ` +
      `skipped=[${skipped.join(", ") || "none"}]`
  );
  if (incomplete.length || Object.keys(summary.skipped).length) {
    throw new Error(
      `${options.suiteName} incomplete: expected ${tests.length} tests x ${samples} samples; ` +
        `incomplete=[${incomplete.join(", ") || "none"}]`
    );
  }
  return { summary, total, skipped };
}

module.exports = { runSuite };
