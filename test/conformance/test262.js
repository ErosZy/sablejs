"use strict";

process.env.BROWSERSLIST_IGNORE_OLD_DATA = "true";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const acorn = require("acorn");
const babel = require("@babel/core");
const presetEnv = require("@babel/preset-env");
const { parse: parseYaml } = require("yaml");
const { compile } = require("../../src/compiler");
const { test262: pinnedTest262 } = require("../../tools/upstreams");

const repositoryRoot = path.resolve(__dirname, "../..");
const test262Root = path.resolve(
  process.env.sablejs_test262_dir || path.join(repositoryRoot, ".cache/test262")
);
const testRoot = path.join(test262Root, "test");
const harnessRoot = path.join(test262Root, "harness");
const runtimeModule = path.resolve(repositoryRoot, "src/runtime");
const runtimeSource = fs.readFileSync(path.join(runtimeModule, "index.js"), "utf8");
const sloppyRuntimeSource = fs.readFileSync(path.join(runtimeModule, "sloppy.js"), "utf8");
const securityRuntimeSource = fs.readFileSync(path.join(runtimeModule, "security.js"), "utf8");
const optimization = process.env.sablejs_optimization || "O1";
const matchPath = process.env.sablejs_test_match || "";
const limit = Number(process.env.sablejs_test_limit || 0);
const startIndex = Number(process.env.sablejs_test_start_index || 0);
const quiet = process.env.sablejs_test_quiet === "1";
const allowFailures = process.env.sablejs_test262_allow_failures === "1";
const maxFailureDetails = Number(process.env.sablejs_test262_failure_details || 30);
const hostFailurePolicyPath = path.join(__dirname, "host-failures.json");
const hostFailurePolicy = JSON.parse(fs.readFileSync(hostFailurePolicyPath, "utf8"));
if (!Array.isArray(hostFailurePolicy)) {
  throw new TypeError("Test262 host-failure policy must be an array");
}
const hostFailurePolicyByVariant = new Map();
for (const entry of hostFailurePolicy) {
  if (
    !entry ||
    typeof entry.path !== "string" ||
    !entry.path.endsWith(".js") ||
    !["strict", "sloppy"].includes(entry.mode) ||
    typeof entry.sableReason !== "string" ||
    typeof entry.nativeReason !== "string"
  ) {
    throw new TypeError(
      "Each Test262 host-failure policy entry needs path, strict/sloppy mode, " +
        "sableReason, and nativeReason strings"
    );
  }
  const key = `${entry.path}#${entry.mode}`;
  if (hostFailurePolicyByVariant.has(key)) {
    throw new Error(`Duplicate Test262 host-failure policy entry ${key}`);
  }
  hostFailurePolicyByVariant.set(key, entry);
}
const observedHostFailureVariants = new Set();

const summaries = {
  files: 0,
  variants: 0,
  passed: 0,
  negativePassed: 0,
  es5Adjusted: 0,
  policyExcluded: 0,
  hostFailures: 0,
  allowedHostFailures: 0,
  hostFailurePolicyDrift: 0,
  failed: 0,
};
const failures = [];
const codegenTotals = { straightScopes: 0, structuredScopes: 0, fallbackScopes: 0 };

function listJavaScriptFiles(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filepath = path.join(directory, entry.name);
    if (entry.isDirectory()) listJavaScriptFiles(filepath, output);
    else if (entry.isFile() && entry.name.endsWith(".js")) output.push(filepath);
  }
  return output;
}

function metadata(source, filepath) {
  const match = source.match(/\/\*---\r?\n([\s\S]*?)\r?\n---\*\//);
  if (!match) return null;
  return parseYaml(match[1]) || {};
}

function readHarness(name) {
  return fs.readFileSync(path.join(harnessRoot, name), "utf8");
}

const defaultHarness = `${readHarness("sta.js")}\n${readHarness("assert.js")}\n`;

function buildSource(source, data, strict) {
  const flags = new Set(data.flags || []);
  if (flags.has("raw")) return `${strict ? '"use strict";\n' : ""}${source}`;
  const includes = (data.includes || []).map(readHarness).join("\n");
  return `${strict ? '"use strict";\n' : ""}${defaultHarness}${includes}\n${source}`;
}

function hasES5SourceAdjustment(filepath) {
  return filepath === "language/statements/function/13.2-15-1.js";
}

function normalizePositiveSyntax(source, data, filepath) {
  if (hasES5SourceAdjustment(filepath)) {
    // The current Test262 copy kept this ES5 id but updated the expected
    // Function length descriptor to the ES2015+ configurable form. sablejs
    // targets ES5.1, whose 13.2 step 15 uses [[Configurable]]: false.
    source = source.replace("configurable: true", "configurable: false");
  }
  const negative = data.negative;
  if (negative && (negative.phase === "parse" || negative.phase === "early")) return source;
  try {
    acorn.parse(source, { ecmaVersion: 5 });
    return source;
  } catch (_) {
    const transformed = babel.transformSync(source, {
      babelrc: false,
      configFile: false,
      comments: false,
      compact: false,
      filename: filepath,
      presets: [
        [
          presetEnv,
          {
            bugfixes: false,
            loose: false,
            modules: false,
            targets: { ie: "11" },
            useBuiltIns: false,
          },
        ],
      ],
      sourceType: "script",
    });
    return transformed.code;
  }
}

function variants(data) {
  const flags = new Set(data.flags || []);
  if (flags.has("onlyStrict")) return [true];
  if (flags.has("noStrict") || flags.has("raw")) return [false];
  return [false, true];
}

function isDynamicCodePolicyExcluded(relativePath, source) {
  if (
    relativePath.startsWith("built-ins/eval/") ||
    relativePath === "built-ins/Object/getOwnPropertyNames/15.2.3.4-4-1.js"
  ) {
    // The Object test does not invoke eval, but explicitly requires the eval
    // global to exist. Sable intentionally removes that dynamic-code surface.
    return true;
  }

  // Tokenize instead of matching raw text: Test262 descriptions, comments,
  // string literals and regular expressions frequently contain the words
  // "eval" or "Function" without executing dynamic source. Acorn's tokenizer
  // also accepts most early-error inputs because it does not need to build a
  // valid syntax tree. If tokenization itself is the tested early error, the
  // file cannot execute dynamic code and remains eligible.
  let tokens;
  try {
    const tokenizer = acorn.tokenizer(source, { ecmaVersion: "latest" });
    tokens = [];
    for (;;) {
      const token = tokenizer.getToken();
      if (token.type.label === "eof") break;
      tokens.push(token);
    }
  } catch (_) {
    return false;
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type.label !== "name") continue;
    if (token.value === "eval") return true;
    if (token.value !== "Function") continue;
    const next = tokens[index + 1];
    if (next && next.type.label === "(") return true;
    const method = tokens[index + 2];
    const call = tokens[index + 3];
    if (
      next &&
      next.type.label === "." &&
      method &&
      method.type.label === "name" &&
      ["call", "apply", "bind"].includes(method.value) &&
      call &&
      call.type.label === "("
    ) {
      return true;
    }
  }
  return false;
}

function errorName(error) {
  if (error && error.constructor && error.constructor.name) return error.constructor.name;
  if (error && error.name) return error.name;
  return typeof error;
}

function expectedError(data) {
  return data.negative && data.negative.type;
}

function es5VariantMetadata(data, relativePath, strict) {
  const duplicateProperty = relativePath.startsWith("language/expressions/object/prop-dup-");
  const dataData = relativePath.endsWith("prop-dup-data-data.js");
  if (duplicateProperty && (strict || !dataData)) {
    return { ...data, negative: { phase: "early", type: "SyntaxError" } };
  }
  const strictEs5EarlyError =
    relativePath === "language/expressions/object/11.1.5-2gs.js" ||
    relativePath === "language/statements/break/S12.8_A3.js" ||
    relativePath.startsWith("language/statements/break/S12.8_A4_");
  if (strict && strictEs5EarlyError) {
    return { ...data, negative: { phase: "early", type: "SyntaxError" } };
  }
  return data;
}

function matchesExpectedError(error, data) {
  return errorName(error) === expectedError(data);
}

function createRealmRuntime(context) {
  const sloppyContainer = { exports: {} };
  const sloppyWrapper = vm.runInContext(
    `(function(require, module, exports) { ${sloppyRuntimeSource}\n})`,
    context
  );
  sloppyWrapper(require, sloppyContainer, sloppyContainer.exports);

  const securityContainer = { exports: {} };
  const securityWrapper = vm.runInContext(
    `(function(require, module, exports) { ${securityRuntimeSource}\n})`,
    context
  );
  securityWrapper(require, securityContainer, securityContainer.exports);

  const runtimeContainer = { exports: {} };
  const runtimeWrapper = vm.runInContext(
    `(function(require, module, exports) { ${runtimeSource}\n})`,
    context
  );
  runtimeWrapper(
    (request) => {
      if (request === "./sloppy") return sloppyContainer.exports;
      if (request === "./security") return securityContainer.exports;
      return require(request);
    },
    runtimeContainer,
    runtimeContainer.exports
  );
  return runtimeContainer.exports;
}

function compileTest(source) {
  // Test262 observes diagnostic names in a few non-ES5 harness paths. Keep
  // source spelling here; production AOT output defaults to alias protection.
  const result = compile(source, {
    optimization,
    runtimeModule,
    identifierProtection: "preserve",
    security: "trusted",
    transform: false,
  });
  for (const key of Object.keys(codegenTotals)) {
    codegenTotals[key] += result.stats.codegen[key];
  }
  return result;
}

function executeSable(source, filepath) {
  const result = compileTest(source);
  const context = vm.createContext({});
  const realmRuntime = createRealmRuntime(context);
  const generatedModule = { exports: {} };
  const generatedWrapper = vm.runInContext(
    `(function(require, module, exports) { ${result.code}\n})`,
    context,
    { filename: `${filepath}.aot.cjs` }
  );
  generatedWrapper(
    (request) => (request === runtimeModule ? realmRuntime : require(request)),
    generatedModule,
    generatedModule.exports
  );
  const instance = generatedModule.exports.createInstance({ globals: { print() {} } });
  try {
    return instance.run();
  } finally {
    instance.dispose();
  }
}

function executeNative(source, filepath) {
  const context = vm.createContext({ print() {} });
  return vm.runInContext(source, context, { filename: filepath });
}

function evaluate(execute, source, data, filepath) {
  const negative = data.negative;
  if (negative && (negative.phase === "parse" || negative.phase === "early")) {
    try {
      execute === executeSable
        ? compileTest(source)
        : new vm.Script(source, { filename: filepath });
    } catch (error) {
      return matchesExpectedError(error, data)
        ? { pass: true, negative: true }
        : {
            pass: false,
            reason: `expected ${expectedError(data)}, got ${errorName(error)}`,
            error,
          };
    }
    return {
      pass: false,
      reason: `expected ${expectedError(data)} during ${negative.phase}, but parsing succeeded`,
    };
  }

  try {
    execute(source, filepath);
    if (negative) {
      return {
        pass: false,
        reason: `expected runtime ${expectedError(data)}, but execution succeeded`,
      };
    }
    return { pass: true, negative: false };
  } catch (error) {
    if (negative && matchesExpectedError(error, data)) return { pass: true, negative: true };
    return {
      pass: false,
      reason: negative
        ? `expected runtime ${expectedError(data)}, got ${errorName(error)}`
        : `${errorName(error)}: ${(error && error.message) || String(error)}`,
      error,
    };
  }
}

function recordFailure(
  relativePath,
  strict,
  sableResult,
  nativeResult,
  allowedHostFailure = false
) {
  const entry = {
    path: relativePath,
    mode: strict ? "strict" : "sloppy",
    reason: sableResult.reason,
    native: nativeResult.pass ? "pass" : nativeResult.reason,
    allowedHostFailure,
  };
  failures.push(entry);
  if (!quiet && failures.length <= maxFailureDetails) {
    console.error(`[FAIL ${entry.mode}] ${entry.path}: ${entry.reason}; native=${entry.native}`);
  }
}

function isAllowedHostFailure(relativePath, strict, sableResult, nativeResult) {
  const mode = strict ? "strict" : "sloppy";
  const key = `${relativePath}#${mode}`;
  observedHostFailureVariants.add(key);
  const expected = hostFailurePolicyByVariant.get(key);
  return (
    !!expected &&
    expected.sableReason === sableResult.reason &&
    expected.nativeReason === nativeResult.reason
  );
}

if (!fs.existsSync(testRoot) || !fs.existsSync(harnessRoot)) {
  throw new Error("Pinned Test262 checkout is missing. Run: npm run upstream:fetch");
}

const revision = require("child_process")
  .spawnSync("git", ["-C", test262Root, "rev-parse", "HEAD"], { encoding: "utf8" })
  .stdout.trim();
if (revision !== pinnedTest262.commit) {
  throw new Error(
    `Test262 revision mismatch: expected=${pinnedTest262.commit}, actual=${revision}`
  );
}

const candidates = [
  ...listJavaScriptFiles(path.join(testRoot, "language")),
  ...listJavaScriptFiles(path.join(testRoot, "built-ins")),
].sort();
let eligibleIndex = 0;
const startedAt = Date.now();

for (const filepath of candidates) {
  const source = fs.readFileSync(filepath, "utf8");
  const data = metadata(source, filepath);
  if (!data || data.es5id == null) continue;
  const relativePath = path.relative(testRoot, filepath).split(path.sep).join("/");
  if (matchPath && !relativePath.includes(matchPath)) continue;
  eligibleIndex += 1;
  if (eligibleIndex <= startIndex) continue;
  if (limit && summaries.files >= limit) break;
  summaries.files += 1;

  if (isDynamicCodePolicyExcluded(relativePath, source)) {
    summaries.policyExcluded += 1;
    continue;
  }

  for (const strict of variants(data)) {
    summaries.variants += 1;
    const variantData = es5VariantMetadata(data, relativePath, strict);
    if (variantData !== data || hasES5SourceAdjustment(relativePath)) {
      summaries.es5Adjusted += 1;
    }
    const normalizedTestSource = normalizePositiveSyntax(source, variantData, relativePath);
    const runnableSource = buildSource(normalizedTestSource, variantData, strict);
    const sableResult = evaluate(executeSable, runnableSource, variantData, relativePath);
    if (sableResult.pass) {
      if (sableResult.negative) summaries.negativePassed += 1;
      else summaries.passed += 1;
      continue;
    }

    const nativeResult = evaluate(executeNative, runnableSource, variantData, relativePath);
    let allowedHostFailure = false;
    if (!nativeResult.pass) {
      summaries.hostFailures += 1;
      allowedHostFailure = isAllowedHostFailure(relativePath, strict, sableResult, nativeResult);
      if (allowedHostFailure) summaries.allowedHostFailures += 1;
      else {
        summaries.hostFailurePolicyDrift += 1;
        summaries.failed += 1;
      }
    } else {
      summaries.failed += 1;
    }
    recordFailure(relativePath, strict, sableResult, nativeResult, allowedHostFailure);
  }

  if (quiet && summaries.files % 100 === 0) {
    console.log(
      `[ES5 PROGRESS] files=${summaries.files}, variants=${summaries.variants}, ` +
        `passed=${summaries.passed + summaries.negativePassed}, failed=${summaries.failed}, ` +
        `host=${summaries.hostFailures}, policy=${summaries.policyExcluded}`
    );
  }
  if (summaries.files % 50 === 0 && typeof global.gc === "function") global.gc();
}

// A full run also fails when an allowlisted host failure disappears. That
// forces the policy file to remain an exact, reviewed baseline rather than a
// growing wildcard suppression list. Partial developer runs skip this stale
// entry check because they intentionally do not visit the whole corpus.
if (!matchPath && !limit && startIndex === 0) {
  for (const [key, entry] of hostFailurePolicyByVariant) {
    if (observedHostFailureVariants.has(key)) continue;
    summaries.hostFailurePolicyDrift += 1;
    summaries.failed += 1;
    failures.push({
      path: entry.path,
      mode: entry.mode,
      reason: "allowlisted host failure was not observed; remove or refresh the policy entry",
      native: entry.nativeReason,
      allowedHostFailure: false,
    });
  }
}

const report = {
  revision,
  optimization,
  elapsedMs: Date.now() - startedAt,
  ...summaries,
  codegen: codegenTotals,
  failures: failures.slice(0, maxFailureDetails),
};
console.log(JSON.stringify(report, null, 2));
if (summaries.failed && !allowFailures) process.exitCode = 1;
