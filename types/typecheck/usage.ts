/**
 * Type-level usage fixture for the sablejs declarations (CJS context:
 * nodenext resolution treats this .ts file as CommonJS, mirroring how
 * generated artifacts are consumed).
 *
 * Every exported symbol is exercised; @ts-expect-error lines pin the
 * negative contract (invalid inputs must fail to type-check).
 */
import {
  AOTCompiler,
  compile,
  lowerToHIR,
  lowerToMIR,
  normalizeSecurity,
  normalizeSourceMapOptions,
  normalizeTransformOptions,
  transformToES5,
  capability,
  runtime,
  worker,
} from "sablejs";
import type {
  CapabilityOptions,
  CapabilityToken,
  CodegenStats,
  CompiledProgram,
  CompileMetadata,
  CompileOptions,
  CompileResult,
  CompileStats,
  IdentifierProtection,
  InspectionFs,
  NormalizedSourceMapSettings,
  NormalizedTransformOptions,
  OptimizationLevel,
  OptimizationLevelLike,
  OptimizerPassRecord,
  RuntimeInstance,
  RuntimeInstanceOptions,
  SecurityMode,
  SourceMapOption,
  SourceMapSettings,
  TransformedES5Result,
  TransformOption,
} from "sablejs";
import { createSandboxClient } from "sablejs/worker";
import type { SandboxClient, SandboxClientOptions, SandboxWorker } from "sablejs/worker";
import {
  ABI_VERSION,
  RuntimeInstance as RuntimeInstanceClass,
  createProgram,
} from "sablejs/runtime";
import type { ProgramMetadata } from "sablejs/runtime";
import { Worker as NodeWorker } from "node:worker_threads";

// ---------------------------------------------------------------------------
// compile() with every documented option
// ---------------------------------------------------------------------------
const source = "function price(input) { return { total: input.price * 1.2 }; } price(input);";

const sourceMapSettings: SourceMapSettings = {
  mode: "external",
  sourceFile: "rules/input.js",
  generatedFile: "rules.cjs",
  sourceMapURL: "rules.cjs.map",
  sourcesContent: true,
};

const options: CompileOptions = {
  optimization: "O2",
  security: "sandbox",
  identifierProtection: "alias",
  sourceMap: sourceMapSettings,
  preserveSourceLocations: false,
  strict: false,
  perScopeFactories: false,
  stackToLocal: true,
  sparseConditionalConstantPropagation: true,
  copyPropagation: true,
  deadCodeElimination: true,
  loopInvariantCodeMotion: true,
  globalValueNumbering: true,
  deadStoreElimination: true,
  includeHIR: true,
  includeCFG: true,
  includeMIR: true,
  dumpIR: "all",
  dumpDir: "out",
};

const fsAdapter: InspectionFs = {
  mkdirSync: () => {},
  writeFileSync: () => {},
  join: (...parts) => parts.join("/"),
};

const compileOptions: CompileOptions = { ...options, fs: fsAdapter };

const result: CompileResult = compile(source, compileOptions);
const shorthand: CompileResult = compile(source);
const withAliases: CompileResult = compile(source, { optimize: "os", sourceMap: true });

// Result surface
const codeText: string = result.code;
const format: "cjs" = result.format;
const level: OptimizationLevel = result.optimization;
const map: string | undefined = result.map;
const hir: any = result.hir;
const mir: any = result.mir;

// Stats
const stats: CompileStats = result.stats;
const passes: OptimizerPassRecord[] = stats.passes;
const disabledPasses: string[] = stats.disabledPasses;
const passName: string = passes[0].name;
const passDelta: number = passes[0].nodesChanged;
const cfg: { blocks: number; edges: number; loops: number } = stats.cfg;
const codegen: CodegenStats = stats.codegen;
const stackToLocal: CodegenStats["stackToLocal"] = codegen.stackToLocal;
const enabled: boolean = stackToLocal.enabled;
const sizeOpt: CodegenStats["sizeOptimization"] = codegen.sizeOptimization;
const selected: "per-scope-factories" | "shared-factory" = sizeOpt.costModel.selected;
const strategy: "per-scope-factories" | "shared-factory" = sizeOpt.costModel.candidates[0].strategy;
const objective: "raw-bytes" = sizeOpt.costModel.objective;
const inliningStats: CodegenStats["inlining"] = codegen.inlining;
const inlined: number = inliningStats.instructionsInlined;
const reusedAliases: number = codegen.identifierProtection.reusedAliases;
// Always present (inactive modes report zeros) — no narrowing needed.
const provenance: CodegenStats["slotProvenance"] = codegen.slotProvenance;
const droppedSlots: number = provenance.droppedSlots;

// Metadata
const metadata: CompileMetadata = result.metadata;
const abiVersion: string = metadata.abiVersion;
const inputLanguage: "es5.1" | "esnext" = metadata.inputLanguage;
const wasTransformed: boolean = metadata.transformed;
const idProtection: "alias" | "preserve" = metadata.identifierProtection;
const optLevel: OptimizationLevel = metadata.optimize;
const securityMode: SecurityMode = metadata.security;
const normalizedMap: NormalizedSourceMapSettings | undefined = metadata.sourceMap;
const optimizerDisabledPasses: string[] = metadata.optimizerDisabledPasses;

// ---------------------------------------------------------------------------
// Source-map option variants
// ---------------------------------------------------------------------------
compile(source, { sourceMap: true });
compile(source, { sourceMap: "external" });
compile(source, { sourceMap: "inline" });
compile(source, { sourceMap: { mode: "inline", sourcesContent: true } });
const inlineMap: string | undefined = compile(source, { sourceMap: "inline" }).map;
// Level aliases: digits, lowercase, and leading-dash forms all compile.
compile(source, { optimization: "2" });
compile(source, { optimization: "os" });
compile(source, { optimization: "-O2" });
compile(source, { optimization: "-o2" });
compile(source, { optimization: "-2" });

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------
const trusted: SecurityMode = normalizeSecurity("trusted");
const normalized: NormalizedSourceMapSettings | null = normalizeSourceMapOptions({
  mode: "external",
});
const disabled: NormalizedSourceMapSettings | null = normalizeSourceMapOptions(false);
const normTransform: NormalizedTransformOptions = normalizeTransformOptions("auto");
const transformOpt: TransformOption = (src) => src;
const loweredES5: TransformedES5Result = transformToES5("const x = (a = 1) => a;");
const aliasMode: IdentifierProtection = true;
const anyMapOption: SourceMapOption = sourceMapSettings;

// ---------------------------------------------------------------------------
// AOTCompiler and intermediate forms
// ---------------------------------------------------------------------------
const compiler = new AOTCompiler();
const directResult: CompileResult = compiler.compile(source, { optimization: "O1" });
const hirGraph: any = compiler.lowerToHIR(source, { strict: true });
const mirGraph: any = compiler.lowerToMIR(source);
const loweredHir: any = lowerToHIR(source);
const loweredMir: any = lowerToMIR(source, { optimization: "Os" });

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------
const capOptions: CapabilityOptions = { name: "save", thisValue: { api: true } };
const token: CapabilityToken = capability(async function save(record: unknown) {
  return { saved: true };
}, capOptions);
const autoWrapped: CapabilityToken = capability((x: number) => x * 2);

// ---------------------------------------------------------------------------
// Compiled artifact lifecycle (the shape generated code exports)
// ---------------------------------------------------------------------------
const program: CompiledProgram = require("./fixture-artifact.cjs");
const instanceOptions: RuntimeInstanceOptions = {
  globals: { input: { price: 100 }, token },
  security: "sandbox",
  profileBoundary: true,
};
const instance: RuntimeInstance = program.createInstance(instanceOptions);
const runtimeResult: any = instance.run();
instance.dispose();
const isDisposed: boolean = instance.disposed;
const instSecurity: SecurityMode = instance.security;
const globalsObject: Record<string, any> = instance.global;
const boundaryStats: any = instance.boundaryStats();

// ---------------------------------------------------------------------------
// sablejs/runtime module (via the main entry's `runtime` namespace)
// ---------------------------------------------------------------------------
const abi: string = runtime.ABI_VERSION;
const rtInstance: RuntimeInstanceClass = new runtime.RuntimeInstance(
  () => null,
  { abiVersion: "2.0.0-aot.5", security: "trusted" },
  {},
  { globals: {} }
);
const metadataForProgram: ProgramMetadata = { abiVersion: "2.0.0-aot.5", security: "trusted" };
const programFromRuntime: CompiledProgram = createProgram(
  () => null,
  metadataForProgram,
  ABI_VERSION,
  {},
  { security: "trusted" }
);
const capFromRuntime: CapabilityToken = runtime.capability(() => 1);

// The `worker` namespace re-export resolves the same module as the subpath.
const workerNamespace: typeof import("sablejs/worker") = worker;
const workerModuleName: string = workerNamespace.WORKER_MODULE;

// ---------------------------------------------------------------------------
// Worker client
// ---------------------------------------------------------------------------
// Browser `Worker` satisfies SandboxWorker directly.
const fakeWorker: SandboxWorker = {
  addEventListener() {},
  postMessage() {},
  terminate() {},
};
const browserWorker: SandboxWorker = new Worker("./worker.js");
// Node's worker_threads.Worker is an EventEmitter without addEventListener,
// and its "message" events deliver the value directly — not a MessageEvent
// with `.data` — so the adapter must both re-bind "on" and normalize events.
function toSandboxWorker(worker: NodeWorker): SandboxWorker {
  return {
    addEventListener(type, listener) {
      if (type === "message") worker.on("message", (value) => listener({ data: value }));
      else worker.on("error", (error) => listener(error));
    },
    postMessage(message) {
      worker.postMessage(message);
    },
    terminate() {
      worker.terminate();
    },
  };
}
const nodeWorker: SandboxWorker = toSandboxWorker(new NodeWorker("./worker-script.cjs"));
const clientOptions: SandboxClientOptions = { timeoutMs: 5000 };
const client: SandboxClient = createSandboxClient(fakeWorker, clientOptions);
const runPromise: Promise<any> = client.run({ price: 100 });
const evalPromise: Promise<any> = client.evaluate(compile(source).code, { price: 100 });
const runWithTimeout: Promise<any> = client.run({ price: 100 }, { timeoutMs: 100 });
client.terminate();

// worker namespace via the main entry
const workerModule: typeof import("sablejs/worker") = worker;
const workerConst: "sablejs/worker" = workerModule.WORKER_MODULE;

// ---------------------------------------------------------------------------
// Negative contract: invalid inputs must not type-check
// ---------------------------------------------------------------------------
// @ts-expect-error compile expects a source string
compile(123);
// @ts-expect-error unknown optimization level
compile(source, { optimization: "O9" });
// @ts-expect-error sourceMap mode must be "external" | "inline"
compile(source, { sourceMap: { mode: "embed" } });
// @ts-expect-error sourcesContent must be a boolean
compile(source, { sourceMap: { sourcesContent: "yes" } });
// @ts-expect-error dumpIR is a fixed union
compile(source, { dumpIR: "bytecode" });
// @ts-expect-error capability requires a function
capability(null);
// @ts-expect-error a capability token is opaque — not a function
const notCallable: (...args: any[]) => any = token;
// @ts-expect-error instance state is read-only from the host side
instance.disposed = false;
// @ts-expect-error createSandboxClient requires a worker-shaped object
createSandboxClient({});
// @ts-expect-error a number is not an OptimizationLevelLike
const notLevel: OptimizationLevelLike = 2;

// Keep every imported value observably used (noUnusedLocals).
void [
  codeText,
  format,
  level,
  map,
  hir,
  mir,
  passes,
  disabledPasses,
  passName,
  passDelta,
  cfg,
  enabled,
  selected,
  strategy,
  objective,
  sizeOpt,
  inliningStats,
  inlined,
  reusedAliases,
  provenance,
  droppedSlots,
  abiVersion,
  inputLanguage,
  wasTransformed,
  idProtection,
  optLevel,
  securityMode,
  normalizedMap,
  optimizerDisabledPasses,
  trusted,
  normalized,
  disabled,
  normTransform,
  transformOpt,
  loweredES5,
  aliasMode,
  anyMapOption,
  shorthand,
  withAliases,
  directResult,
  hirGraph,
  mirGraph,
  loweredHir,
  loweredMir,
  runtimeResult,
  isDisposed,
  instSecurity,
  globalsObject,
  boundaryStats,
  abi,
  rtInstance,
  programFromRuntime,
  capFromRuntime,
  workerNamespace,
  workerModuleName,
  runPromise,
  evalPromise,
  runWithTimeout,
  workerConst,
  inlineMap,
  autoWrapped,
  nodeWorker,
  browserWorker,
  notCallable,
  notLevel,
];
