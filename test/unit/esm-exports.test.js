"use strict";

// Executable ESM surface: Node's ESM interop detects named exports of the
// CJS entry via cjs-module-lexer, which reads `module.exports.NAME = ...`
// assignments verbatim and does not see object-literal shorthand or spread.
// This test pins the full named-export list at runtime (the type gate only
// type-checks; it cannot catch a missing runtime export).

const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");

test("every declared root export is importable by name from ESM", () => {
  const script = `
    import { compile, AOTCompiler, lowerToHIR, lowerToMIR,
             normalizeSecurity, normalizeSourceMapOptions,
             normalizeTransformOptions, transformToES5,
             capability, runtime, worker } from "sablejs";
    import { createSandboxClient, WORKER_MODULE } from "sablejs/worker";
    import { ABI_VERSION } from "sablejs/runtime";

    const named = { compile, AOTCompiler, lowerToHIR, lowerToMIR,
                    normalizeSecurity, normalizeSourceMapOptions,
                    normalizeTransformOptions, transformToES5,
                    capability, runtime, worker };
    for (const [name, value] of Object.entries(named)) {
      if (value === undefined) throw new Error("named export not found: " + name);
    }
    if (typeof createSandboxClient !== "function") throw new Error("worker client missing");
    if (WORKER_MODULE !== "sablejs/worker") throw new Error("WORKER_MODULE mismatch");
    if (typeof ABI_VERSION !== "string") throw new Error("ABI_VERSION missing");

    // Full ESM round trip: compile → artifact → instance → run.
    const { code, metadata } = compile("function price(input) { return { total: input.price * 1.2 }; } price(input);", {
      optimization: "O2",
      security: "sandbox",
    });
    const { createProgram } = runtime;
    const module_ = { exports: {} };
    new Function("require", "module", "exports", code)(
      (specifier) => {
        if (specifier === "sablejs/runtime" || specifier === "sablejs") return runtime;
        throw new Error("unexpected module " + specifier);
      },
      module_, module_.exports
    );
    const instance = module_.exports.createInstance({ globals: { input: { price: 100 } } });
    const value = instance.run();
    instance.dispose();
    if (JSON.stringify(value) !== '{"total":120}') throw new Error("round trip mismatch: " + JSON.stringify(value));
    console.log("esm-surface-ok", metadata.security);
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.match(out, /esm-surface-ok sandbox/);
});
