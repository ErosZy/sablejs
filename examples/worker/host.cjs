"use strict";

// Host side of the worker isolation example. The guest program runs in a
// dedicated worker_threads Worker, so the host can enforce a wall-clock
// timeout and terminate the execution agent — the only reliable way to stop
// an infinite guest loop.
//
//   node examples/precompile/build.cjs   (first, once)
//   node examples/worker/host.cjs
//
// Node's worker_threads.Worker is an EventEmitter (no addEventListener), so
// it needs a small adapter; a browser `new Worker(url)` satisfies the client
// contract directly.

const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { compile } = require("sablejs");
const { createSandboxClient } = require("sablejs/worker");

// Adapter: worker_threads.Worker → the addEventListener/postMessage/terminate
// shape the client speaks. Two differences from a browser Worker:
// - events deliver the value directly, not a MessageEvent with `.data`;
// - it is an EventEmitter, so "on" substitutes for "addEventListener".
function toSandboxWorker(worker) {
  return {
    addEventListener(type, listener) {
      if (type === "message") {
        worker.on("message", (value) => listener({ data: value }));
      } else {
        worker.on("error", (error) => listener(error));
      }
    },
    postMessage(message) {
      worker.postMessage(message);
    },
    terminate() {
      worker.terminate();
    },
  };
}

async function main() {
  const worker = new Worker(path.join(__dirname, "sandbox.worker.cjs"));
  const sandbox = createSandboxClient(toSandboxWorker(worker), { timeoutMs: 5000 });

  // run(): the bound artifact (precompiled) with copied input data.
  const receipt = await sandbox.run({
    vip: true,
    items: [
      { price: 10, count: 2 },
      { price: 5, count: 4 },
    ],
  });
  console.log("run()      :", receipt); // { line: 32, ship: 10 }

  // evaluate(): load a *different* artifact on the same worker. The artifact
  // code comes from compile() — never pass un-compiled user source here.
  const other = compile("({ reversed: input.text.split('').reverse().join('') });", {
    optimization: "Os",
  });
  console.log("evaluate() :", await sandbox.evaluate(other.code, { text: "sablejs" }));

  // A guest infinite loop: the wall-clock timeout terminates the worker.
  const looping = compile("while (true) {}");
  try {
    await sandbox.evaluate(looping.code, {}, { timeoutMs: 300 });
    console.log("timeout    : UNREACHABLE");
  } catch (error) {
    console.log("timeout    :", error.message.slice(0, 60) + "…");
    // "sandbox execution timed out after 300 ms; the worker was terminated"
  }

  sandbox.terminate();
  console.log("done");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
