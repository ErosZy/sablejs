"use strict";

// Real-world workload benchmark. Each workload is a self-contained ES5.1
// source defining `workload(input)`. Dynamic mode (the default) passes a
// varying JSON payload at runtime; static mode explicitly embeds one input in
// the compiled source so partial-evaluation results remain separately named.
// The driver runs the workload repeatedly and reports ops/sec. Backends:
// sablejs-sandbox, sablejs-trusted, quickjs, and native (plain new Function —
// the performance ceiling, NOT a security alternative). Results are compared
// across backends so a divergent backend fails the run.

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { compile } = require("../src/compiler");
const { createQuickJSRunner } = require("./quickjs-runner");

const workloadDirectory = path.resolve(__dirname, "workloads");
const runtimeModule = path.resolve(__dirname, "../src/runtime");

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const INPUTS = {
  "json-transform": {
    rows: (() => {
      const rows = [];
      for (let i = 0; i < 500; i += 1) {
        rows.push({
          id: i,
          amount: 10 + (i % 50),
          discount: (i % 10) / 100,
          customer: { name: "customer-" + i, region: ["east", "west", "north", "south"][i % 4] },
          tags: i % 3 ? ["retail", "b2b", "trial"] : null,
        });
      }
      return rows;
    })(),
  },
  "pricing-rules": {
    rules: [
      { category: "electronics", percent: 5 },
      { category: "clothing", flat: 2 },
      { category: "grocery", percent: 10 },
      { minBase: 100, percent: 8 },
      { maxBase: 20, flat: 1 },
      { percent: 3 },
    ],
    items: (() => {
      const items = [];
      for (let i = 0; i < 2000; i += 1) {
        items.push({
          base: 1 + (i % 200),
          category: ["electronics", "clothing", "grocery", "other"][i % 4],
          qty: 1 + (i % 5),
        });
      }
      return items;
    })(),
  },
  "form-validator": {
    form: {
      email: "user@example.com",
      username: "sablejs-user",
      age: 30,
      password: "s3cret-password",
      confirm: "s3cret-password",
    },
    phones: ["13800138000", "123456", "13911112222", "999"],
  },
  "spreadsheet-formulas": {
    names: (() => {
      const names = [];
      for (let i = 0; i < 50; i += 1) names.push("cell" + i);
      return names;
    })(),
    values: (() => {
      const values = [];
      for (let i = 0; i < 50; i += 1) values.push(i + 1);
      return values;
    })(),
    formulas: (() => {
      const formulas = [];
      for (let i = 2; i < 50; i += 1) {
        formulas.push({
          a: "cell" + (i - 2),
          b: "cell" + (i - 1),
          op: ["add", "mul", "sub"][i % 3],
          target: "cell" + i,
        });
      }
      return formulas;
    })(),
  },
  "workflow-rules": {
    record: { status: "pending", amount: 250, region: "east", note: "priority-order" },
    rules: (() => {
      const rules = [];
      for (let i = 0; i < 30; i += 1) {
        rules.push({
          conditions: [
            { field: "amount", op: "gt", value: i * 10 },
            { field: "status", op: "eq", value: i % 2 ? "pending" : "open" },
          ],
          actions: i % 3 ? [{ tag: "rule-" + i }] : [{ set: "status", to: "escalated-" + i }],
        });
      }
      return rules;
    })(),
  },
  "template-logic": {
    template:
      "Hello {name}, you have {each orders}{item} {end}. {if vip}VIP discount applied.{end} Total: {total}",
    data: { name: "sablejs", vip: true, total: 42, orders: ["first", "second", "third"] },
  },
  "data-aggregation": {
    from: 1000,
    to: 9000,
    events: (() => {
      const events = [];
      for (let i = 0; i < 5000; i += 1) {
        events.push({
          at: i * 2,
          kind: ["click", "view", "purchase", "signup"][i % 4],
          value: i % 97,
        });
      }
      return events;
    })(),
  },
  "mini-parser": {
    expression: "((12 + 34) * (56 - 7) + 8) * 2 - 100 + (3 * (4 + 5))",
  },
};

function assembleProgram(source, input, inputMode) {
  if (inputMode === "static") {
    return `var input = ${JSON.stringify(input)};\n${source}\nworkload(input);`;
  }
  return `${source}\nworkload(JSON.parse(inputJSON));`;
}

function normalize(value) {
  return JSON.stringify(value);
}

function varyInput(name, input, iteration) {
  const value = JSON.parse(JSON.stringify(input));
  const delta = iteration % 17;
  switch (name) {
    case "json-transform":
      value.rows[0].amount += delta;
      break;
    case "pricing-rules":
      value.items[0].base += delta;
      break;
    case "form-validator":
      value.form.age += delta;
      value.form.username += delta;
      break;
    case "spreadsheet-formulas":
      value.values[0] += delta;
      break;
    case "workflow-rules":
      value.record.amount += delta;
      value.record.note += delta;
      break;
    case "template-logic":
      value.data.total += delta;
      value.data.name += delta;
      break;
    case "data-aggregation":
      value.from += delta;
      break;
    case "mini-parser":
      value.expression += ` + ${delta}`;
      break;
    default:
      throw new Error(`No dynamic input variation for ${name}`);
  }
  return value;
}

function inputJSON(name, iteration) {
  return JSON.stringify(varyInput(name, INPUTS[name], iteration));
}

function runSableJS(
  security,
  programSource,
  globals = {},
  inlineHostIntrinsics = true,
  optimization = "O1"
) {
  const compiled = compile(programSource, {
    optimization,
    security,
    runtimeModule,
    inlineHostIntrinsics,
  });
  const generatedModule = { exports: {} };
  new Function("require", "module", "exports", compiled.code)(
    require,
    generatedModule,
    generatedModule.exports
  );
  const instance = generatedModule.exports.createInstance({ globals });
  const value = instance.run();
  instance.dispose();
  return value;
}

async function main() {
  const backend = argument("backend", "sablejs-sandbox");
  const optimization = argument("optimization", "O1");
  const inputMode = argument("input-mode", "dynamic");
  const iterations = Number(argument("iterations", "500"));
  const workloadFilter = argument("workload", "");
  const profileBoundary = process.argv.includes("--profile-boundary");
  const names = Object.keys(INPUTS).filter((name) => !workloadFilter || name === workloadFilter);
  const security = backend === "sablejs-sandbox" ? "sandbox" : "trusted";
  const nativeResults = {};
  if (!["dynamic", "static"].includes(inputMode)) {
    throw new Error("--input-mode must be dynamic or static");
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error("--iterations must be a positive integer");
  }

  for (const name of names) {
    const source = fs.readFileSync(path.join(workloadDirectory, `${name}.js`), "utf8");
    const programSource = assembleProgram(source, INPUTS[name], inputMode);
    const nativeProgram =
      inputMode === "dynamic"
        ? new Function("inputJSON", `${source}\nreturn workload(JSON.parse(inputJSON));`)
        : null;
    const nativeOracle = (iteration) =>
      inputMode === "dynamic"
        ? nativeProgram(inputJSON(name, iteration))
        : globalThis.eval(programSource);

    let execute;
    let dispose = null;
    let boundaryTotals = null;
    let optimizerEvidence = null;
    if (backend === "quickjs") {
      const runner = await createQuickJSRunner(() => {});
      const preparedSource = programSource.replace(
        /\nworkload\((?:input|JSON\.parse\(inputJSON\))\);\s*$/,
        inputMode === "dynamic"
          ? "\nreturn workload(JSON.parse(inputJSON));"
          : "\nreturn workload(input);"
      );
      const prepared = runner.prepare(preparedSource, `${name}.js`);
      execute = (iteration) => {
        if (inputMode === "dynamic") runner.setGlobal("inputJSON", inputJSON(name, iteration));
        return prepared();
      };
      dispose = () => runner.dispose();
    } else if (backend === "native") {
      execute = nativeOracle;
    } else {
      const inlineHostIntrinsics = !process.argv.includes("--no-inline-host-intrinsics");
      const inlineMemberIntrinsics = !process.argv.includes("--no-inline-member-intrinsics");
      const deferBranchTest = !process.argv.includes("--no-branch-test-deferral");
      const compiled = compile(programSource, {
        optimization,
        security,
        runtimeModule,
        inlineHostIntrinsics,
        inlineMemberIntrinsics,
        deferBranchTest,
      });
      optimizerEvidence = {
        metadata: compiled.metadata,
        optimizer: compiled.stats,
        generatedBytes: Buffer.byteLength(compiled.code),
      };
      const generatedModule = { exports: {} };
      new Function("require", "module", "exports", compiled.code)(
        require,
        generatedModule,
        generatedModule.exports
      );
      if (profileBoundary) {
        // run() is single-run, so accumulate the per-instance counters.
        boundaryTotals = {};
        execute = (iteration) => {
          const globals = inputMode === "dynamic" ? { inputJSON: inputJSON(name, iteration) } : {};
          const instance = generatedModule.exports.createInstance({
            globals,
            profileBoundary: true,
          });
          try {
            const value = instance.run();
            const stats = instance.boundaryStats();
            for (const key of Object.keys(stats))
              boundaryTotals[key] = (boundaryTotals[key] || 0) + stats[key];
            return value;
          } finally {
            instance.dispose();
          }
        };
      } else {
        execute = (iteration) => {
          const globals = inputMode === "dynamic" ? { inputJSON: inputJSON(name, iteration) } : {};
          const instance = generatedModule.exports.createInstance({ globals });
          try {
            return instance.run();
          } finally {
            instance.dispose();
          }
        };
      }
    }

    // Correctness probes use an independent native oracle and include multiple
    // dynamic payloads before any timing result is accepted.
    for (const probe of [0, 1, 7]) {
      const expected = nativeOracle(probe);
      const actual = execute(probe);
      if (normalize(actual) !== normalize(expected)) {
        throw new Error(`[workloads] ${name}/${inputMode}/probe-${probe} diverged from native`);
      }
    }
    execute(0);
    const startedAt = performance.now();
    for (let index = 0; index < iterations; index += 1) execute(index);
    const elapsedMs = performance.now() - startedAt;

    const finalIteration = iterations + 1;
    const reference = nativeOracle(finalIteration);
    const result = execute(finalIteration);
    if (normalize(result) !== normalize(reference)) {
      console.error(`[workloads] ${name} diverged from the native reference`);
      process.exitCode = 1;
    }
    nativeResults[name] = result;

    console.log(
      `${name}: ${(iterations / (elapsedMs / 1000)).toFixed(
        0
      )} ops/sec (${inputMode}, ${iterations} iterations, ${elapsedMs.toFixed(1)} ms)`
    );
    if (optimizerEvidence) {
      const optimizer = optimizerEvidence.optimizer;
      console.log(
        `  optimizer ${name}: ${JSON.stringify({
          disabledPasses: optimizer.disabledPasses,
          bailouts: optimizer.analysis ? optimizer.analysis.bailouts : [],
          sccp: optimizer.sccp || null,
          copyPropagation: optimizer.copyPropagation || null,
          gvn: optimizer.globalValueNumbering || null,
          licm: optimizer.loopInvariantCodeMotion || null,
          dse: optimizer.deadStoreElimination || null,
          inlining: optimizer.codegen.inlining,
          generatedBytes: optimizerEvidence.generatedBytes,
        })}`
      );
    }
    if (boundaryTotals) {
      console.log(`  boundary ${name}: ${JSON.stringify(boundaryTotals)}`);
    }
    if (dispose) dispose();
  }
  console.log(
    `RESULT workloads ${backend}/${inputMode}: ${names.length} workloads verified against native reference`
  );
}

module.exports = { INPUTS, assembleProgram, inputJSON, normalize, runSableJS, varyInput };

if (require.main === module) {
  main().catch((error) => {
    console.error((error && error.stack) || error);
    process.exitCode = 1;
  });
}
