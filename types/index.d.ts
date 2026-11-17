/**
 * sablejs — ES5.1 ahead-of-time compiler and runtime (`sablejs`).
 *
 * Compile a guest ES5.1 program (a script with no imports that returns its
 * result as the final expression) into a dependency-free CommonJS artifact,
 * then run it against the sablejs runtime:
 *
 * ```ts
 * import { compile } from "sablejs";
 * const { code } = compile("({ total: input.price * 1.2 });", {
 *   optimization: "O1",
 *   security: "sandbox",
 * });
 * // write code to disk, then:
 * //   const program = require("./program.cjs");
 * //   const instance = program.createInstance({ globals: { input } });
 * //   instance.run(); // { total: 120 }
 * ```
 *
 * The compiler and the runtime are separate modules (`sablejs/runtime` is the
 * only runtime dependency of generated code; `sablejs/worker` packages Worker
 * isolation). Both are re-exported here.
 */

import type {
  CapabilityOptions,
  CapabilityToken,
  CompiledProgram,
  RuntimeInstance,
  RuntimeInstanceOptions,
  SecurityMode,
} from "./runtime";

export type {
  CapabilityOptions,
  CapabilityToken,
  CompiledProgram,
  RuntimeInstance,
  RuntimeInstanceOptions,
  SecurityMode,
};

export { capability } from "./runtime";

/** The `sablejs/runtime` module, as a namespace. */
export const runtime: typeof import("./runtime");
/** The `sablejs/worker` module, as a namespace. */
export const worker: typeof import("./worker");

/** Optimization levels. Os is the size-optimizing pass set. */
export type OptimizationLevel = "O0" | "O1" | "O2" | "Os";

/**
 * Anything `compile()` accepts for `optimization`/`optimize`: the canonical
 * levels plus the accepted aliases (`"0"`, `"1"`, `"2"`, `"s"`, `"S"`,
 * lowercase `"o0"`–`"os"`, and any of these with a leading `-`, e.g. `"-O2"`).
 */
export type OptimizationLevelLike =
  | OptimizationLevel
  | "0"
  | "1"
  | "2"
  | "s"
  | "S"
  | Lowercase<OptimizationLevel>
  | `-${OptimizationLevel}`
  | `-${Lowercase<OptimizationLevel>}`
  | "-0"
  | "-1"
  | "-2"
  | "-s"
  | "-S";

/**
 * Identifier protection for the generated code. `"alias"` (the default)
 * aliases guest identifiers to collision-resistant generated names;
 * `"preserve"` keeps guest identifier names in the generated code.
 */
export type IdentifierProtection = boolean | "alias" | "preserve";

/** Source Map v3 settings for {@link CompileOptions.sourceMap}. */
export interface SourceMapSettings {
  /** `"external"` (default) writes a URL comment; `"inline"` embeds a base64 data URL. */
  mode?: "external" | "inline";
  /** Logical source path (`file` identity in the map); never inferred from cwd. */
  sourceFile?: string;
  /** Logical generated artifact name (`file` field in the v3 map). */
  generatedFile?: string;
  /** External URL comment; appended only in external mode. */
  sourceMapURL?: string;
  /** Embed the guest source in `sourcesContent` (default false). */
  sourcesContent?: boolean;
}

/** Anything `compile()` accepts for `sourceMap`. */
export type SourceMapOption = boolean | "external" | "inline" | SourceMapSettings;

/** The normalized settings object, as reflected in `result.metadata.sourceMap`. */
export interface NormalizedSourceMapSettings {
  mode: "external" | "inline";
  sourceFile: string;
  generatedFile: string;
  sourceMapURL?: string;
  sourcesContent: boolean;
}

/**
 * Inspection-mode file adapter for `dumpDir`. Defaults to Node's `fs`/`path`,
 * lazily required; browser bundles pass an in-memory implementation.
 */
export interface InspectionFs {
  mkdirSync(directory: string, options: { recursive: boolean }): unknown;
  writeFileSync(file: string, text: string): unknown;
  join(...parts: string[]): string;
}

/** Compiler options for `compile()` / `AOTCompiler.compile()`. */
export interface CompileOptions {
  /**
   * Optimization level. Accepts `"O0"`–`"Os"` and the aliases listed on
   * {@link OptimizationLevelLike}. Default `"O1"`. O2/Os are experimental
   * while the completion-aware CFG hardening gate remains open.
   */
  optimization?: OptimizationLevelLike;
  /** Alias for {@link optimization}, honored when `optimization` is unset. */
  optimize?: OptimizationLevelLike;
  /**
   * `"sandbox"` (default) deep-copies `globals`, mediates host-function
   * capabilities, and deletes stacks on boundary errors; `"trusted"` passes
   * `globals` by reference with lowest overhead.
   */
  security?: SecurityMode;
  /** Identifier protection for generated code. Default `"alias"`. */
  identifierProtection?: IdentifierProtection;
  /**
   * Emit a Source Map v3 for the generated code. Statement-level mappings at
   * every optimization level; static eval/Function bodies map to virtual
   * sources. Maps never change the default build.
   */
  sourceMap?: SourceMapOption;
  /**
   * Keep `LOC` operations in generated code so `frame.line`/`frame.column`
   * track the guest position at runtime. Independent of `sourceMap`, which
   * consumes locations at compile time.
   */
  preserveSourceLocations?: boolean;
  /** Parse the guest source in strict mode (ES5.1 `"use strict"` semantics). */
  strict?: boolean;
  /** Force Os candidate selection (per-scope vs shared closure factories). */
  perScopeFactories?: boolean;
  /**
   * Path override for the runtime module when bundling for the browser (the
   * runtime must be bundled into the artifact's module graph).
   */
  runtimeModule?: string;
  /**
   * Disable the stack-to-local lowering (O2/Os move operand stack into
   * locals; the fallback path keeps an explicit stack).
   */
  stackToLocal?: boolean;
  /** Diagnostic A/B switch: disable MIR sparse conditional constant propagation. */
  sparseConditionalConstantPropagation?: boolean;
  /** Diagnostic A/B switch: disable MIR literal copy propagation. */
  copyPropagation?: boolean;
  /** Diagnostic A/B switch: disable MIR dead-code elimination. */
  deadCodeElimination?: boolean;
  /** Diagnostic A/B switch: disable O2 loop-invariant code motion. */
  loopInvariantCodeMotion?: boolean;
  /** Diagnostic A/B switch: disable O2 global value numbering. */
  globalValueNumbering?: boolean;
  /** Diagnostic A/B switch: disable O2/Os dead-store elimination. */
  deadStoreElimination?: boolean;
  /** Attach the optimized HIR graph object to the result. */
  includeHIR?: boolean;
  /** Attach the SSA MIR graph object to the result. */
  includeMIR?: boolean;
  /** Attach the completion-aware semantic CFG graph object to the result. */
  includeCFG?: boolean;
  /** Attach the named graph object(s) to the result. */
  dumpIR?: "hir" | "mir" | "cfg" | "all";
  /** Write `hir.txt` / `cfg.txt` / `mir.txt` / `code.js` (+ map) into a directory. */
  dumpDir?: string;
  /** File adapter used by `dumpDir`; defaults to Node's fs/path. */
  fs?: InspectionFs;
}

/** One optimizer pass run, as recorded in `OptimizerStats.passes`. */
export interface OptimizerPassRecord {
  name: string;
  generation: number;
  preserves: string[];
  invalidates: string[];
  durationMs: number;
  nodesBefore: number;
  nodesAfter: number;
  nodesChanged: number;
}

/** Statistics recorded by the optimizer. */
export interface OptimizerStats {
  level: OptimizationLevel;
  /** Version of the optimizer pass/annotation contract used for this build. */
  pipelineVersion: number;
  passes: OptimizerPassRecord[];
  /** Passes retained in the pipeline contract but disabled for an A/B build. */
  disabledPasses: string[];
  constantsFolded: number;
  constantBranchesFolded: number;
  deadOperationsRemoved: number;
  unreachableBlocksRemoved: number;
  cfg: { blocks: number; edges: number; loops: number };
  mir: { builds: number };
  analysis?: {
    generation: number;
    rebuilds: Array<{ name: string; generation: number; reason: string }>;
    rollbacks: number;
    bailouts: Array<{
      pass: string;
      reason: string;
      scopeId?: number;
      diagnosticCode?: string;
    }>;
  };
  sourceLocationsRemoved: number;
  nodesBefore: number;
  nodesAfter?: number;
}

/** Statistics recorded by code generation. */
export interface CodegenStats {
  straightScopes: number;
  structuredScopes: number;
  fallbackScopes: number;
  fastFrameScopes: number;
  leafFrameScopes: number;
  framePooledScopes: number;
  inlineLeafFrameScopes: number;
  inlineFastFrameScopes: number;
  inlining: {
    enabled: boolean;
    budget: number;
    candidates: number;
    callSites: number;
    guardedCallSites: number;
    instructionsInlined: number;
    hostIntrinsicCallSites: number;
    memberIntrinsicCallSites: number;
  };
  /**
   * Os size-model and candidate selection. Always present; `costModel` is
   * attached by the pipeline after candidate selection (objective
   * `"raw-bytes"`, `selected`/`candidates` describe the closure-factory
   * strategies measured).
   */
  sizeOptimization: {
    enabled: boolean;
    temporarySlots: number;
    helperImports: number;
    outputBytes: number;
    decisions: {
      perScopeFactories: boolean;
      smallFunctionInlining: boolean;
      globalValueNumbering: boolean;
      loopInvariantCodeMotion: boolean;
    };
    costModel: {
      objective: "raw-bytes";
      selected: "per-scope-factories" | "shared-factory";
      candidates: Array<{
        strategy: "per-scope-factories" | "shared-factory";
        bytes: number;
      }>;
      zeroGrowthInlining: boolean;
      temporaryReuse: boolean;
      helperImportPruning: boolean;
    };
  };
  identifierProtection: {
    mode: "alias" | "preserve";
    aliasedScopes: number;
    aliasedBindings: number;
    uniqueAliases: number;
    reusedAliases: number;
  };
  stackToLocal: {
    enabled: boolean;
    instructions: number;
    helpersAvoided: number;
    stackLoads: number;
    stackStores: number;
    sizeTemporaryAssignments: number;
    sizeTemporaryReuses: number;
    promotedLoads: number;
    promotedStores: number;
    denseSwitches: number;
    denseSwitchCases: number;
  };
  localPromotion: { eligibleScopes: number; promotedSlots: number };
  /**
   * O2 frame-scope write-classification stamps. Always present; inactive
   * modes report three zeros (no plans were tracked).
   */
  slotProvenance: {
    trackedScopes: number;
    trackedSlots: number;
    droppedSlots: number;
  };
}

/** Full compile statistics (`result.stats`). */
export interface CompileStats extends OptimizerStats {
  codegen: CodegenStats;
}

/** Compile metadata (`result.metadata`). */
export interface CompileMetadata {
  /** AOT ABI version shared with the runtime. */
  abiVersion: string;
  /** Generated module format (always `"cjs"` today). */
  format: "cjs";
  inputLanguage: "es5.1";
  identifierProtection: "alias" | "preserve";
  optimize: OptimizationLevel;
  /** Version of the optimizer pass/annotation contract. */
  optimizerPipelineVersion: number;
  /** Exact ordered pass list that ran for this artifact. */
  optimizerPasses: string[];
  /** Pipeline passes explicitly disabled by diagnostic A/B options. */
  optimizerDisabledPasses: string[];
  /** Final optimized-HIR generation after the recorded pass list. */
  optimizerAnalysisGeneration: number;
  /** Fresh analysis publications used to avoid consuming stale graphs. */
  optimizerAnalysisRebuilds: Array<{ name: string; generation: number; reason: string }>;
  /** Optional optimizer candidates that were rejected and rolled back. */
  optimizerBailouts: Array<{
    pass: string;
    reason: string;
    scopeId?: number;
    diagnosticCode?: string;
  }>;
  perScopeFactories: boolean;
  security: SecurityMode;
  /** Normalized source-map settings; present only when a map was requested. */
  sourceMap?: NormalizedSourceMapSettings;
}

/** Result of `compile()`. */
export interface CompileResult {
  /**
   * The generated CommonJS artifact. Its only runtime dependency is the
   * sablejs runtime module; inline source maps append a data-URL comment.
   */
  code: string;
  format: "cjs";
  optimization: OptimizationLevel;
  stats: CompileStats;
  /**
   * The optimized HIR graph object (debugging; present with
   * `includeHIR` / `dumpIR`).
   */
  hir?: any;
  /** Completion-aware semantic CFG (debugging; present with `includeCFG` / `dumpIR`). */
  cfg?: any;
  /** The SSA MIR graph object (debugging; present with `includeMIR` / `dumpIR`). */
  mir?: any;
  /** Serialized Source Map v3 JSON; undefined when source maps are disabled. */
  map?: string;
  metadata: CompileMetadata;
}

/**
 * Compiles an ES5.1 guest program into a CommonJS artifact.
 *
 * Validation failures (unknown modes, malformed options) throw `Error` with
 * descriptive messages before any code is generated. Guest errors are not
 * produced here — they surface at `instance.run()`.
 */
export function compile(source: string, options?: CompileOptions): CompileResult;

/**
 * AOT compiler class. `compile()` is a convenience wrapper around a fresh
 * instance; `lowerToHIR` / `lowerToMIR` expose the intermediate forms.
 */
export class AOTCompiler {
  compile(source: string, options?: CompileOptions): CompileResult;
  /** Parses the source and lowers it to optimized HIR (debugging surface). */
  lowerToHIR(source: string, options?: { strict?: boolean }): any;
  /** Lowers the source to SSA MIR (debugging surface). */
  lowerToMIR(source: string, options?: CompileOptions): any;
}

/** Parses and lowers a guest program to its HIR (debugging surface). */
export function lowerToHIR(source: string, options?: { strict?: boolean }): any;
/** Lowers a guest program to its SSA MIR (debugging surface). */
export function lowerToMIR(source: string, options?: CompileOptions): any;

/**
 * Normalizes a security mode, throwing on unknown values. Exported for host
 * reuse (e.g. validating CLI options).
 */
export function normalizeSecurity(value?: SecurityMode): SecurityMode;

/**
 * Normalizes a sourceMap option into the internal settings shape, returning
 * null when disabled. Validation failures throw before code generation.
 */
export function normalizeSourceMapOptions(
  value?: SourceMapOption
): NormalizedSourceMapSettings | null;
