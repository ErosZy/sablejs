"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const bundlePath = path.resolve(__dirname, "../../.cache/e2e/program.js");
const bundle = fs.readFileSync(bundlePath, "utf8");
const compilerBundlePath = path.resolve(__dirname, "../../.cache/e2e/compiler-browser.js");
const compilerBundle = fs.readFileSync(compilerBundlePath, "utf8");
const mapInlineBundlePath = path.resolve(__dirname, "../../.cache/e2e/map-inline.js");
const mapInlineBundle = fs.readFileSync(mapInlineBundlePath, "utf8");
const expected = { total: 76, finalValue: 13, label: "portable", argsProbe: "2:9:true" };
const { TraceMap, originalPositionFor } = require("@jridgewell/trace-mapping");

test("runs the compiled program on the browser main thread", async ({ page }) => {
  await page.addScriptTag({ content: bundle });
  await expect.poll(() => page.evaluate(() => globalThis.__sablejs_e2e_result__)).toEqual(expected);
});

test("runs the compiled program inside a Web Worker", async ({ page }) => {
  const result = await page.evaluate(
    (source) =>
      new Promise((resolve, reject) => {
        const workerSource = `${source}\npostMessage(globalThis.__sablejs_e2e_result__);`;
        const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
        const worker = new Worker(url);
        worker.onmessage = (event) => {
          worker.terminate();
          URL.revokeObjectURL(url);
          resolve(event.data);
        };
        worker.onerror = (event) => {
          worker.terminate();
          URL.revokeObjectURL(url);
          reject(new Error(event.message));
        };
      }),
    bundle
  );

  expect(result).toEqual(expected);
});

test("compiles ES5.1 in a browser without Node polyfills", async ({ page }) => {
  await page.addScriptTag({ content: compilerBundle });
  const result = await page.evaluate(() => globalThis.__sablejs_compiler_e2e_result__);
  expect(result).toEqual({
    format: "cjs",
    inputLanguage: "es5.1",
    security: "sandbox",
    hasCreateProgram: true,
    outputBytes: expect.any(Number),
  });
  expect(result.outputBytes).toBeGreaterThan(0);
});

test("emits and consumes an inline source map in a browser without Node polyfills", async ({
  page,
}) => {
  await page.addScriptTag({ content: mapInlineBundle });
  const result = await page.evaluate(() => globalThis.__sablejs_map_inline_e2e_result__);
  // The inline-mapped artifact executed in-page and surfaced the guest error
  // through the browser runtime — the data-URL comment breaks nothing.
  expect(result.outcome).toEqual({ name: "Error", message: "guest boom" });
  expect(result.code).toContain("//# sourceMappingURL=data:application/json;charset=utf-8;base64,");
  // The browser-produced data URL (TextEncoder + btoa path, no Buffer)
  // round-trips to exactly the returned map.
  const base64 = result.code.split("data:application/json;charset=utf-8;base64,")[1];
  expect(JSON.parse(Buffer.from(base64, "base64").toString("utf8"))).toEqual(
    JSON.parse(result.map)
  );
  // The statement-level mapping survives: the generated throw statement
  // resolves to the guest's line 2 (`throw new Error(...)`).
  const decoded = new TraceMap(result.map);
  const mapped = result.code.split("\n").some((line, index) => {
    if (!line.trim()) return false;
    const position = originalPositionFor(decoded, { line: index + 1, column: line.search(/\S/) });
    return position.source === "<sablejs-input>" && position.line === 2;
  });
  expect(mapped).toBe(true);
});
