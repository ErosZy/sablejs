"use strict";

// Differential fuzzing for the ES5.1 semantics: generate random programs,
// run each in sablejs (trusted), native V8, and QuickJS-WASM, and compare
// the JSON-stringified result or the exception name. Mismatching cases are
// saved with their seed and minimized by statement-level delta debugging.
//
//   node test/differential/fuzz.js --seed=1 --cases=2000 [--minimize]
//
// Native V8 is the ES5.1 reference oracle; QuickJS is a second witness.
// sablejs must agree with V8; three-way disagreements are reported with
// both witnesses.

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const UglifyJS = require("uglify-js");
const { compile } = require("../../src/compiler");

const runtimeModule = path.resolve(__dirname, "../../src/runtime");
const failureDirectory = path.resolve(__dirname, "../../.cache/differential-failures");
const LEVELS = ["O0", "O1", "O2", "Os"];
const GENERATOR_VERSION = 3;

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random, items) {
  return items[Math.floor(random() * items.length)];
}

class Generator {
  constructor(seed) {
    this.random = mulberry32(seed);
  }

  number() {
    const roll = this.random();
    if (roll < 0.2) return String(Math.floor(this.random() * 100) - 50);
    if (roll < 0.4) return String(Math.floor(this.random() * 10));
    if (roll < 0.5) return (this.random() * 100).toFixed(3);
    return String(Math.floor(this.random() * 4));
  }

  string() {
    const fragments = ["a", "ab", "abc", "1", "1.5", "true", "null", "", "-0", "1e3", " "];
    return JSON.stringify(
      pick(this.random, fragments) + (this.random() < 0.5 ? pick(this.random, fragments) : "")
    );
  }

  expression(depth, variables) {
    const random = this.random;
    if (depth <= 0 || random() < 0.25) {
      const kind = Math.floor(random() * 5);
      if (kind === 0) return this.number();
      if (kind === 1) return this.string();
      if (kind === 2) return pick(random, ["true", "false", "null", "void 0"]);
      if (kind === 3 && variables.length) return pick(random, variables);
      return this.number();
    }
    const kind = Math.floor(random() * 8);
    switch (kind) {
      case 0: {
        const operator = pick(random, [
          "+",
          "-",
          "*",
          "/",
          "%",
          "<",
          ">",
          "<=",
          ">=",
          "==",
          "!=",
          "===",
          "!==",
          "&",
          "|",
          "^",
          "<<",
          ">>",
        ]);
        return `(${this.expression(depth - 1, variables)} ${operator} ${this.expression(
          depth - 1,
          variables
        )})`;
      }
      case 1: {
        const operator = pick(random, ["&&", "||"]);
        return `(${this.expression(depth - 1, variables)} ${operator} ${this.expression(
          depth - 1,
          variables
        )})`;
      }
      case 2:
        return `(${pick(random, ["!", "-", "+", "~", "typeof "])}${this.expression(
          depth - 1,
          variables
        )})`;
      case 3:
        return `(${this.expression(depth - 1, variables)} ? ${this.expression(
          depth - 1,
          variables
        )} : ${this.expression(depth - 1, variables)})`;
      case 4:
        return `[${this.expression(depth - 1, variables)}, ${this.expression(
          depth - 1,
          variables
        )}, ${this.expression(depth - 1, variables)}]`;
      case 5:
        return `({ a: ${this.expression(depth - 1, variables)}, b: ${this.expression(
          depth - 1,
          variables
        )} })`;
      case 6:
        return `(${this.expression(depth - 1, variables)})[${pick(random, [
          '"a"',
          '"b"',
          '"length"',
          "0",
          "1",
        ])}]`;
      case 7:
      default:
        return `${pick(random, ["f0", "f1"])}(${this.expression(
          depth - 1,
          variables
        )}, ${this.expression(depth - 1, variables)})`;
    }
  }

  statement(depth, variables, output, allowTry = false) {
    const random = this.random;
    const maxKind = depth > 0 ? (allowTry ? 8 : 7) : 6;
    const kind = Math.floor(random() * maxKind);
    switch (kind) {
      case 0: {
        const name = `v${Math.floor(random() * 4)}`;
        output.push(`var ${name} = ${this.expression(depth, variables)};`);
        return name;
      }
      case 1: {
        const name = `v${Math.floor(random() * 4)}`;
        output.push(`${name} = ${this.expression(depth, variables)};`);
        return name;
      }
      case 2: {
        output.push(`if (${this.expression(depth, variables)}) {`);
        output.push(`  v1 = ${this.expression(depth, variables)};`);
        output.push("} else {");
        output.push(`  v2 = ${this.expression(depth, variables)};`);
        output.push("}");
        return null;
      }
      case 3: {
        output.push(`for (var i = 0; i < ${1 + Math.floor(random() * 4)}; i++) {`);
        output.push(`  v3 = ${this.expression(depth, variables)};`);
        output.push("}");
        return null;
      }
      case 4: {
        output.push(`while (${this.expression(depth, variables)}) {`);
        output.push(`  v0 = ${this.expression(depth, variables)};`);
        output.push("  break;");
        output.push("}");
        return null;
      }
      case 5:
        output.push(`${this.expression(depth, variables)};`);
        return null;
      case 6: {
        const disc =
          random() < 0.5
            ? pick(random, ["0", "1", "true", "null"])
            : this.expression(depth - 1, variables);
        const c0 = pick(random, ["0", "1", "true", '"a"', this.expression(depth - 1, variables)]);
        const c1 = pick(random, ["0", "1", "false", '"b"', this.expression(depth - 1, variables)]);
        output.push(`switch (${disc}) {`);
        output.push(`  case ${c0}:`);
        output.push(
          `    ${pick(random, ["v0", "v1", "v2", "v3"])} = ${this.expression(
            depth - 1,
            variables
          )};`
        );
        if (random() < 0.6) output.push("    break;");
        output.push(`  case ${c1}:`);
        output.push(
          `    ${pick(random, ["v0", "v1", "v2", "v3"])} = ${this.expression(
            depth - 1,
            variables
          )};`
        );
        if (random() < 0.6) output.push("    break;");
        if (random() < 0.5) {
          output.push("  default:");
          output.push(
            `    ${pick(random, ["v0", "v1", "v2", "v3"])} = ${this.expression(
              depth - 1,
              variables
            )};`
          );
        }
        output.push("}");
        return null;
      }
      case 7:
      default: {
        const form = Math.floor(random() * 3);
        output.push("try {");
        this.statement(depth - 1, variables, output, false);
        if (form === 0 || form === 2) {
          output.push("} catch (e) {");
          output.push("  if (e instanceof RangeError) throw e;");
          output.push(`  v0 = ${this.expression(0, variables)};`);
        }
        if (form === 1 || form === 2) {
          output.push("} finally {");
          output.push(`  v1 = ${this.expression(0, variables)};`);
        }
        output.push("}");
        return null;
      }
    }
  }

  functionBody(depth, allowTry = false) {
    const output = [];
    const variables = ["a", "b", "v0", "v1", "v2", "v3"];
    for (let index = 0; index < 4; index += 1) {
      output.push(`var v${index} = ${this.expression(depth - 1, variables)};`);
    }
    for (let index = 0; index < 3; index += 1) this.statement(depth, variables, output, allowTry);
    output.push(`return ${this.expression(depth - 1, variables)};`);
    return output;
  }

  program() {
    const lines = ['"use strict";'];
    for (let index = 0; index < 2; index += 1) {
      const depth = 1 + Math.floor(this.random() * 3);
      lines.push(`function f${index}(a, b) {`);
      this.functionBody(depth, false).forEach((line) => lines.push(`  ${line}`));
      lines.push("}");
    }
    lines.push("function main() {");
    this.functionBody(2 + Math.floor(this.random() * 2), true).forEach((line) =>
      lines.push(`  ${line}`)
    );
    lines.push("}");
    // The completion value is the stringified result; all three engines
    // (indirect eval, sablejs run, quickjs evalCode) agree on it.
    lines.push("JSON.stringify(main());");
    return lines.join("\n");
  }
}

function runNative(source) {
  try {
    const indirectEval = globalThis.eval;
    return { ok: true, value: indirectEval(source) };
  } catch (error) {
    return { ok: false, error: error && error.name };
  }
}

function runSableJS(source, optimization = "O2", security = "trusted") {
  try {
    const compiled = compile(source, { optimization, security, runtimeModule });
    const generatedModule = { exports: {} };
    new Function("require", "module", "exports", compiled.code)(
      require,
      generatedModule,
      generatedModule.exports
    );
    const instance = generatedModule.exports.createInstance({});
    try {
      return { ok: true, value: instance.run() };
    } finally {
      instance.dispose();
    }
  } catch (error) {
    return { ok: false, error: error && error.name };
  }
}

async function createQuickJS() {
  const { newQuickJSWASMModule } = require("quickjs-emscripten/variants");
  // One context per case: a WASM stack overflow (infinite recursion in a
  // generated program) surfaces as a native throw that leaves the runtime
  // dirty; a dirty context cannot even be disposed, so it is intentionally
  // leaked and a fresh context serves the next case. The module itself
  // survives a few such aborts but eventually stops producing trustworthy
  // results (every eval returns an error whose name dumps as ""), so any
  // dirty event or empty-name error recreates the whole isolated module.
  let modulePromise = newQuickJSWASMModule();
  return {
    async run(source) {
      let module = await modulePromise;
      let context;
      let dirty = false;
      try {
        context = module.newContext();
        const result = context.evalCode(source, "fuzz.js");
        if (result.error) {
          const error = context.dump(result.error);
          result.error.dispose();
          if (error && error.name === "") {
            // Poisoned-module signature: repeated wasm aborts left the
            // module returning corrupt exceptions; never trust it again.
            dirty = true;
          }
          return { ok: false, error: error && error.name };
        }
        const value = context.dump(result.value);
        result.value.dispose();
        return { ok: true, value };
      } catch (error) {
        dirty = true;
        return { ok: false, error: error && error.name };
      } finally {
        if (context && !dirty) context.dispose();
        if (dirty) modulePromise = newQuickJSWASMModule();
      }
    },
    dispose() {},
  };
}

function same(left, right) {
  return (
    left.ok === right.ok && (left.ok ? left.value === right.value : left.error === right.error)
  );
}

function minimize(source, seed, optimization = "O2", security = "trusted") {
  // AST-aware delta debugging removes complete statements from Program and
  // block bodies. It never slices tokens, so loops/branches/functions stay
  // syntactically structured while the original mismatch predicate is kept.
  let ast;
  try {
    ast = UglifyJS.parse(source);
  } catch (_) {
    return source;
  }
  function statementLists(node, output = [], seen = new Set()) {
    if (!node || typeof node !== "object" || seen.has(node)) return output;
    seen.add(node);
    Object.keys(node).forEach((key) => {
      const value = node[key];
      if (Array.isArray(value)) {
        if (value.length && value.every((entry) => entry instanceof UglifyJS.AST_Statement)) {
          output.push(value);
        }
        value.forEach((entry) => statementLists(entry, output, seen));
      } else if (value instanceof UglifyJS.AST_Node) {
        statementLists(value, output, seen);
      }
    });
    return output;
  }
  function mismatches(candidateSource) {
    return !same(runNative(candidateSource), runSableJS(candidateSource, optimization, security));
  }
  let changed = true;
  while (changed) {
    changed = false;
    const lists = statementLists(ast);
    for (const list of lists) {
      for (let index = 0; index < list.length; index += 1) {
        const removed = list.splice(index, 1)[0];
        const candidateSource = ast.print_to_string({ beautify: true });
        if (mismatches(candidateSource)) {
          changed = true;
          break;
        }
        list.splice(index, 0, removed);
      }
      if (changed) break;
    }
  }
  return ast.print_to_string({ beautify: true });
}

function saveFailureEvidence({ seed, source, security, failedLevels, minimizedSource = null }) {
  const directory = path.join(failureDirectory, `seed-${seed}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "source.js"), source);
  if (minimizedSource) fs.writeFileSync(path.join(directory, "minimized.js"), minimizedSource);
  const metadata = {
    generator: "general",
    generatorVersion: GENERATOR_VERSION,
    seed,
    security,
    levels: LEVELS,
    failedLevels,
  };
  fs.writeFileSync(path.join(directory, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  failedLevels.forEach((optimization) => {
    const dumpDir = path.join(directory, `${optimization}-${security}`);
    try {
      compile(source, { optimization, security, runtimeModule, dumpDir });
    } catch (error) {
      fs.mkdirSync(dumpDir, { recursive: true });
      fs.writeFileSync(path.join(dumpDir, "error.txt"), String((error && error.stack) || error));
    }
  });
}

async function main() {
  const seed = Number(argument("seed", "1"));
  const cases = Number(argument("cases", "1000"));
  const shouldMinimize = process.argv.includes("--minimize");
  const quiet = process.argv.includes("--quiet");
  fs.mkdirSync(failureDirectory, { recursive: true });
  const quickjs = await createQuickJS();
  const startedAt = performance.now();
  const mismatches = [];

  for (let index = 0; index < cases; index += 1) {
    const caseSeed = seed + index;
    const source = new Generator(caseSeed).program();
    const native = runNative(source);
    // Rotate the security profile across cases, but compare every optimizer
    // level for each generated program. This keeps the matrix affordable
    // while making cross-level disagreement directly attributable.
    const security = caseSeed % 2 === 0 ? "sandbox" : "trusted";
    const sableByLevel = Object.fromEntries(
      LEVELS.map((optimization) => [optimization, runSableJS(source, optimization, security)])
    );
    const quick = await quickjs.run(source);

    const failedLevels = LEVELS.filter((optimization) => !same(native, sableByLevel[optimization]));
    if (failedLevels.length) {
      mismatches.push({
        seed: caseSeed,
        source,
        security,
        failedLevels,
        native,
        sableByLevel,
        quick,
      });
      const suffix = shouldMinimize ? ".min.js" : ".js";
      fs.writeFileSync(path.join(failureDirectory, `seed-${caseSeed}${suffix}`), source);
      let minimized = null;
      if (shouldMinimize) {
        minimized = minimize(source, caseSeed, failedLevels[0], security);
        fs.writeFileSync(path.join(failureDirectory, `seed-${caseSeed}.min.js`), minimized);
      }
      saveFailureEvidence({
        seed: caseSeed,
        source,
        security,
        failedLevels,
        minimizedSource: minimized,
      });
      if (!quiet) {
        console.log(
          `MISMATCH seed=${caseSeed} security=${security} levels=${failedLevels.join(
            ","
          )}: native=${JSON.stringify(native)} sablejs=${JSON.stringify(
            sableByLevel
          )} quickjs=${JSON.stringify(quick)}`
        );
      }
    }
    if (!quiet && (index + 1) % 500 === 0) {
      console.log(`[differential] ${index + 1}/${cases} cases, ${mismatches.length} mismatches`);
    }
  }
  quickjs.dispose();
  const elapsedMs = performance.now() - startedAt;
  console.log(
    JSON.stringify(
      {
        seed,
        cases,
        mismatches: mismatches.length,
        elapsedMs: Math.round(elapsedMs),
        levels: LEVELS,
        securityMode: "rotating",
        failures: mismatches.slice(0, 10).map((m) => ({
          seed: m.seed,
          security: m.security,
          failedLevels: m.failedLevels,
          native: m.native,
          sablejs: m.sableByLevel,
          quickjs: m.quick,
        })),
      },
      null,
      2
    )
  );
  if (mismatches.length) process.exitCode = 1;
}

module.exports = {
  GENERATOR_VERSION,
  Generator,
  argument,
  createQuickJS,
  minimize,
  mulberry32,
  pick,
  runNative,
  runSableJS,
  same,
};

if (require.main === module) {
  main().catch((error) => {
    console.error((error && error.stack) || error);
    process.exitCode = 1;
  });
}
