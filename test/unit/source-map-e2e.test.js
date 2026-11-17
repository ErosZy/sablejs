"use strict";

// Node end-to-end evidence for external source maps (design doc
// docs/source-maps.md, Slice 2): compile a guest program with an external
// map, write the artifact + map + driver into a temp directory, and run the
// driver under `node --enable-source-maps`. Node's engine-side source-map
// support must resolve the uncaught `$exec*` frames back to the guest
// filename and statement line — exactly what a consumer of the artifact
// experiences — without sablejs installing any stack hook.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { describe, it } = require("node:test");
const { compile } = require("../../src/compiler");

const runtimeModule = path.resolve(__dirname, "../../src/runtime");

// Guest program whose throw statement is line 7 and whose root call is line
// 11. The E2E assertions pin both generated locations against the map.
const E2E_SOURCE = [
  "function add(a, b) {",
  "  return a + b;",
  "}",
  "function fail() {",
  "  var x = add(1, 2);",
  "  if (x > 0) {",
  '    throw new Error("guest boom");',
  "  }",
  "  return x;",
  "}",
  "fail();",
].join("\n");

function runMapped(security, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sablejs-map-e2e-"));
  try {
    const result = compile(E2E_SOURCE, {
      optimization: "O2",
      security,
      runtimeModule,
      sourceMap: {
        sourceFile: "guest/input.js",
        generatedFile: "program.cjs",
        sourceMapURL: "program.cjs.map",
        sourcesContent: true,
      },
      ...options,
    });
    fs.writeFileSync(path.join(directory, "program.cjs"), result.code);
    fs.writeFileSync(path.join(directory, "program.cjs.map"), result.map);
    fs.writeFileSync(
      path.join(directory, "driver.cjs"),
      'const program = require("./program.cjs");\nprogram.createInstance({}).run();\n'
    );
    return spawnSync(process.execPath, ["--enable-source-maps", "driver.cjs"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 30_000,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("external source maps under Node's engine support", function () {
  it("resolves the uncaught guest error to the guest filename and statement line", function () {
    for (const security of ["sandbox", "trusted"]) {
      const output = runMapped(security);
      assert.notStrictEqual(output.status, 0, `${security} driver must fail`);
      // The uncaught-error header points at the guest file and the throw
      // statement (line 7), and the source line is available because
      // sourcesContent was embedded.
      assert.ok(
        /guest[\\/]input\.js:7/.test(output.stderr),
        `${security} error header not mapped: ${output.stderr}`
      );
      assert.ok(
        output.stderr.includes('throw new Error("guest boom")'),
        `${security} mapped header lacks the guest source line`
      );
      // The throw statement's $exec frame resolves to statement start
      // (line 7, column 5); the root $exec frame resolves to the `fail();`
      // call statement (line 11, column 1).
      assert.ok(
        /at \$\w+ \([^)]*guest[\\/]input\.js:7:5\)/.test(output.stderr),
        `${security} throw frame not mapped to 7:5: ${output.stderr}`
      );
      assert.ok(
        /guest[\\/]input\.js:11:1/.test(output.stderr),
        `${security} root call frame not mapped to 11:1: ${output.stderr}`
      );
      // No raw generated location leaks into the remapped trace: the
      // artifact's own filename must not appear in any frame or header.
      assert.ok(
        !output.stderr.includes("program.cjs:"),
        `${security} raw generated location leaked: ${output.stderr}`
      );
    }
  });

  it("leaves the raw generated trace unmapped without the flag (control)", function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sablejs-map-e2e-"));
    try {
      const result = compile(E2E_SOURCE, {
        optimization: "O2",
        security: "trusted",
        runtimeModule,
        sourceMap: {
          sourceFile: "guest/input.js",
          generatedFile: "program.cjs",
          sourceMapURL: "program.cjs.map",
        },
      });
      fs.writeFileSync(path.join(directory, "program.cjs"), result.code);
      fs.writeFileSync(path.join(directory, "program.cjs.map"), result.map);
      fs.writeFileSync(
        path.join(directory, "driver.cjs"),
        'const program = require("./program.cjs");\nprogram.createInstance({}).run();\n'
      );
      // Without --enable-source-maps the trace shows the generated file and
      // never the guest positions: the mapped output above is therefore the
      // engine's doing, not an artifact-side hack.
      const output = spawnSync(process.execPath, ["driver.cjs"], {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.notStrictEqual(output.status, 0, "driver must fail");
      assert.ok(output.stderr.includes("program.cjs"), "raw trace lost the generated file");
      assert.ok(
        !/guest[\\/]input\.js:7:5/.test(output.stderr),
        "control run must not show the mapped position"
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports the guest location through Node stacks in both security modes", function () {
    // Same evidence as the first test but through Node's stack API rather
    // than the uncaught-error printer: the host can capture the error and
    // read the mapped frames, which is the sandbox-boundary-safe consumer
    // path (host side observes a sanitized error with engine-remapped
    // frames; the error object itself carries no host paths).
    for (const security of ["sandbox", "trusted"]) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sablejs-map-e2e-"));
      try {
        const result = compile(E2E_SOURCE, {
          optimization: "O2",
          security,
          runtimeModule,
          sourceMap: {
            sourceFile: "guest/input.js",
            generatedFile: "program.cjs",
            sourceMapURL: "program.cjs.map",
          },
        });
        fs.writeFileSync(path.join(directory, "program.cjs"), result.code);
        fs.writeFileSync(path.join(directory, "program.cjs.map"), result.map);
        fs.writeFileSync(
          path.join(directory, "driver.cjs"),
          'const program = require("./program.cjs");\n' +
            "try {\n  program.createInstance({}).run();\n} catch (error) {\n" +
            '  console.log("CAUGHT:" + (error.stack || "").split("\\n").join("|"));\n}\n'
        );
        const output = spawnSync(process.execPath, ["--enable-source-maps", "driver.cjs"], {
          cwd: directory,
          encoding: "utf8",
          timeout: 30_000,
        });
        assert.strictEqual(output.status, 0, `${security} driver must catch cleanly`);
        assert.ok(
          output.stdout.includes("CAUGHT:") && /guest[\\/]input\.js:7:5/.test(output.stdout),
          `${security} caught stack not remapped: ${output.stdout}`
        );
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  });
});
