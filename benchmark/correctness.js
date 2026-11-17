"use strict";

const fs = require("fs");
const path = require("path");
const { compile } = require("../src/compiler");
const { environment, loadManifest, writeArtifact } = require("./evidence");
const { INPUTS, assembleProgram, inputJSON, normalize } = require("./workloads");

const runtimeModule = path.resolve(__dirname, "../src/runtime");
const workloadDirectory = path.join(__dirname, "workloads");
const levels = ["O0", "O1", "O2", "Os"];
const securities = ["trusted", "sandbox"];

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function prepare(source, optimization, security) {
  const compiled = compile(source, { optimization, security, runtimeModule });
  const generatedModule = { exports: {} };
  new Function("require", "module", "exports", compiled.code)(
    require,
    generatedModule,
    generatedModule.exports
  );
  return {
    compiled,
    run(globals) {
      const instance = generatedModule.exports.createInstance({ globals });
      try {
        return instance.run();
      } finally {
        instance.dispose();
      }
    },
  };
}

function main() {
  const filter = argument("workload", "");
  const output = argument("output", "");
  const modes = argument("input-mode", "dynamic,static").split(",").filter(Boolean);
  modes.forEach((mode) => {
    if (!["dynamic", "static"].includes(mode)) throw new Error(`Unknown input mode ${mode}`);
  });
  const names = Object.keys(INPUTS).filter((name) => !filter || name === filter);
  if (!names.length) throw new Error(`Unknown workload ${filter}`);
  const corpus = loadManifest();
  const report = {
    schemaVersion: 1,
    environment: environment(),
    corpus: { path: corpus.path, sha256: corpus.sha256 },
    configuration: { levels, securities, modes, seeds: [0, 1, 7, 16] },
    cases: [],
    errors: [],
  };

  for (const name of names) {
    const workloadSource = fs.readFileSync(path.join(workloadDirectory, `${name}.js`), "utf8");
    for (const mode of modes) {
      const source = assembleProgram(workloadSource, INPUTS[name], mode);
      const nativeProgram =
        mode === "dynamic"
          ? new Function("inputJSON", `${workloadSource}\nreturn workload(JSON.parse(inputJSON));`)
          : null;
      const expectedBySeed = new Map(
        report.configuration.seeds.map((seed) => [
          seed,
          mode === "dynamic" ? nativeProgram(inputJSON(name, seed)) : globalThis.eval(source),
        ])
      );
      for (const optimization of levels) {
        for (const security of securities) {
          try {
            const candidate = prepare(source, optimization, security);
            for (const seed of report.configuration.seeds) {
              const globals = mode === "dynamic" ? { inputJSON: inputJSON(name, seed) } : {};
              const actual = candidate.run(globals);
              const expected = expectedBySeed.get(seed);
              if (normalize(actual) !== normalize(expected)) {
                throw new Error(`result mismatch at seed ${seed}`);
              }
            }
            report.cases.push({
              name,
              mode,
              optimization,
              security,
              ok: true,
              disabledPasses: candidate.compiled.metadata.optimizerDisabledPasses,
              bailouts: candidate.compiled.metadata.optimizerBailouts,
            });
          } catch (error) {
            report.errors.push({
              name,
              mode,
              optimization,
              security,
              error: String((error && error.stack) || error),
            });
          }
        }
      }
    }
  }
  report.expectedCaseCount = names.length * modes.length * levels.length * securities.length;
  report.actualCaseCount = report.cases.length;
  report.ok = report.errors.length === 0 && report.actualCaseCount === report.expectedCaseCount;
  if (output) report.output = writeArtifact(output, report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) main();
