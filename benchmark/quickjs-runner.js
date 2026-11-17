"use strict";

const { getQuickJS } = require("quickjs-emscripten");

// Shared QuickJS-WASM evaluation context for the comparison backends. The
// print callback mirrors the sablejs capability surface so both backends
// observe the same harness output.
async function createQuickJSRunner(emit) {
  const QuickJS = await getQuickJS();
  const context = QuickJS.newContext();
  const print = context.newFunction("print", (value) => {
    emit(String(context.dump(value)));
  });
  const gc = context.newFunction("gc", () => {});
  context.setProp(context.global, "print", print);
  context.setProp(context.global, "gc", gc);
  print.dispose();
  gc.dispose();
  let preparedId = 0;
  return {
    setGlobal(name, value) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`Invalid QuickJS global name ${name}`);
      let handle;
      if (value === null) handle = context.null;
      else if (value === undefined) handle = context.undefined;
      else if (typeof value === "string") handle = context.newString(value);
      else if (typeof value === "number") handle = context.newNumber(value);
      else if (typeof value === "boolean") handle = value ? context.true : context.false;
      else
        throw new Error(`QuickJS globals support only primitive values, received ${typeof value}`);
      context.setProp(context.global, name, handle);
      if (typeof value === "string" || typeof value === "number") handle.dispose();
    },
    evaluate(source, filename = "benchmark.js") {
      const result = context.evalCode(source, filename);
      if (result.error) {
        const error = context.dump(result.error);
        result.error.dispose();
        throw new Error(`QuickJS evaluation failed: ${JSON.stringify(error)}`);
      }
      // Dump (copy out of the WASM heap) before disposing the handle; the
      // caller gets the completion value, not a discarded handle.
      const value = context.dump(result.value);
      result.value.dispose();
      return value;
    },
    prepare(source, filename = "benchmark.js") {
      const name = `__sablePrepared${preparedId++}`;
      const result = context.evalCode(
        `globalThis.${name} = function () {\n${source}\n};`,
        filename
      );
      if (result.error) {
        const error = context.dump(result.error);
        result.error.dispose();
        throw new Error(`QuickJS preparation failed: ${JSON.stringify(error)}`);
      }
      result.value.dispose();
      return () => {
        // Only the prepared function invocation is evaluated in the timed
        // phase; the workload source itself was parsed and compiled above.
        return this.evaluate(`${name}();`, `${filename}#run`);
      };
    },
    dispose() {
      context.dispose();
    },
  };
}

module.exports = { createQuickJSRunner };
