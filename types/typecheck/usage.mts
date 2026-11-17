/**
 * Type-level usage fixture for the sablejs declarations (ESM context:
 * nodenext resolution treats this .mts file as ES modules, mirroring
 * `import { compile } from "sablejs"` consumers).
 */
import { compile, capability, runtime, worker } from "sablejs";
import type { CompileResult, SourceMapSettings } from "sablejs";
import { createSandboxClient, WORKER_MODULE } from "sablejs/worker";
import { ABI_VERSION } from "sablejs/runtime";

const source = "({ answer: 42 });";

// ESM consumers get the same declaration surface as CJS consumers.
const result: CompileResult = compile(source, {
  optimization: "O2",
  security: "sandbox",
  sourceMap: {
    mode: "inline",
    sourcesContent: true,
  },
});
const code: string = result.code;
const abi: string = result.metadata.abiVersion;

// Source map settings and capability options type the same way.
const settings: SourceMapSettings = { mode: "external", sourceFile: "rules/input.js" };
const token = capability(async (record: unknown) => ({ saved: true }), { name: "save" });

// The worker module exports its constants directly in ESM too.
const workerModuleName: "sablejs/worker" = WORKER_MODULE;
const client = createSandboxClient(new Worker("./worker.js"), { timeoutMs: 1000 });
const runPromise: Promise<any> = client.run({ price: 100 });
const evalPromise: Promise<any> = client.evaluate(compile(source).code, {});

const runtimeAbi: string = ABI_VERSION;
const runtimeNs: typeof import("sablejs/runtime") = runtime;
const workerNs: typeof import("sablejs/worker") = worker;
const runtimeAbiViaRoot: string = runtimeNs.ABI_VERSION;
const workerModuleViaRoot: string = workerNs.WORKER_MODULE;

void [
  code,
  abi,
  settings,
  token,
  workerModuleName,
  runPromise,
  evalPromise,
  runtimeAbi,
  runtimeNs,
  workerNs,
  runtimeAbiViaRoot,
  workerModuleViaRoot,
];
