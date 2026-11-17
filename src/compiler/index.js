"use strict";

const FrontendCompiler = require("../frontend/compiler");
const decodeProgram = require("../ir/decode");
const { verifyProgram } = require("../ir/verify");
const { buildSemanticCFG, verifyCFG } = require("../ir/cfg");
const { lowerToMIR: lowerProgramToMIR, verifyMIR } = require("../ir/mir");
const {
  OPTIMIZER_PIPELINE_VERSION,
  optimizeProgram,
  normalizeLevel,
} = require("../backend/optimizer");
const { generate, normalizeIdentifierProtection } = require("../codegen");
const { finalizeSourceMap, sourceMapURLComment, stripMarkers } = require("../codegen/source-map");
const { printProgram, printMIR, printCFG } = require("../ir/print");
const { ABI_VERSION } = require("../runtime");
const { base64EncodeUtf8, utf8ByteLength } = require("../platform");

// Inspection-mode file adapter. compile() writes the HIR/MIR/code dumps
// through this three-method surface, so the browser bundle never executes
// Node built-ins at module scope: pass your own implementation (e.g. memfs)
// as options.fs, or leave the default — which lazily requires Node's fs/path
// only when a dump is actually written.
function defaultInspectionFs() {
  const fs = require("fs");
  const path = require("path");
  return {
    mkdirSync: (directory, options) => fs.mkdirSync(directory, options),
    writeFileSync: (file, text) => fs.writeFileSync(file, text),
    join: (...parts) => path.join(...parts),
  };
}

function normalizeSecurity(value) {
  if (value === undefined || value === "sandbox") return "sandbox";
  if (value === "trusted") return "trusted";
  throw new Error(`Unknown sablejs security mode ${value}`);
}

// Normalizes the sourceMap compile option into the internal settings object
// consumed by codegen and the map finalizer. Returns null when disabled.
// Validation failures (unknown modes, empty filenames, non-boolean
// sourcesContent, newline-containing URLs) surface here, before any code is
// generated. Logical filenames are never inferred from the caller's cwd.
function normalizeSourceMapOptions(value) {
  if (value === undefined || value === false || value === null) return null;
  if (value === true || value === "external") {
    return {
      mode: "external",
      sourceFile: "<sablejs-input>",
      generatedFile: "generated.cjs",
      sourceMapURL: undefined,
      sourcesContent: false,
    };
  }
  if (value === "inline") {
    return {
      mode: "inline",
      sourceFile: "<sablejs-input>",
      generatedFile: "generated.cjs",
      sourceMapURL: undefined,
      sourcesContent: false,
    };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      'Invalid sourceMap option: expected an object, "external", "inline", or a boolean'
    );
  }
  const mode = value.mode == null ? "external" : value.mode;
  if (mode !== "external" && mode !== "inline") {
    throw new Error(
      `Invalid sourceMap mode ${JSON.stringify(mode)}: expected "external" or "inline"`
    );
  }
  const sourceFile = value.sourceFile == null ? "<sablejs-input>" : value.sourceFile;
  if (typeof sourceFile !== "string" || sourceFile.length === 0) {
    throw new Error("Invalid sourceMap sourceFile: expected a non-empty string");
  }
  const generatedFile = value.generatedFile == null ? "generated.cjs" : value.generatedFile;
  if (typeof generatedFile !== "string" || generatedFile.length === 0) {
    throw new Error("Invalid sourceMap generatedFile: expected a non-empty string");
  }
  const sourceMapURL = value.sourceMapURL;
  if (
    sourceMapURL != null &&
    (typeof sourceMapURL !== "string" || sourceMapURL.length === 0 || /[\r\n]/.test(sourceMapURL))
  ) {
    throw new Error("Invalid sourceMap sourceMapURL: expected a non-empty string without newlines");
  }
  if (value.sourcesContent != null && typeof value.sourcesContent !== "boolean") {
    throw new Error("Invalid sourceMap sourcesContent: expected a boolean");
  }
  return {
    mode,
    sourceFile,
    generatedFile,
    sourceMapURL,
    sourcesContent: value.sourcesContent === true,
  };
}

// Walks the optimized HIR in deterministic scope order and collects the
// synthetic eval/Function scopes that carry a frontend source descriptor.
// Each entry maps to a virtual source named `<sourceFile>#eval-N` /
// `#dynamic-N`; markers reference entries by registry position + 1 (identity
// 0 is the root source). Scopes without a descriptor (runtime-dynamic eval
// values cannot be statically known) are skipped and stay unmapped.
function buildSyntheticSources(program, sourceFile) {
  const sources = [];
  const seen = new Set();
  let evalCount = 0;
  let dynamicCount = 0;
  program.scopes.forEach((scope) => {
    scope.instructions.forEach((instruction) => {
      if (
        instruction.op === "EVAL" &&
        instruction.args[0] &&
        instruction.args[0] !== -1 &&
        instruction.args[0].syntheticSource
      ) {
        const nested = instruction.args[0];
        if (seen.has(nested.id)) return;
        seen.add(nested.id);
        evalCount += 1;
        const descriptor = nested.syntheticSource;
        sources.push({
          scopeId: nested.id,
          name: `${sourceFile}#eval-${evalCount}`,
          text: descriptor.text,
          lines: descriptor.lines,
          columns: descriptor.columns,
        });
      }
    });
    scope.dynamicFunctions.forEach((dynamicScope) => {
      if (dynamicScope !== -1 && dynamicScope.syntheticSource) {
        if (seen.has(dynamicScope.id)) return;
        seen.add(dynamicScope.id);
        dynamicCount += 1;
        const descriptor = dynamicScope.syntheticSource;
        sources.push({
          scopeId: dynamicScope.id,
          name: `${sourceFile}#dynamic-${dynamicCount}`,
          text: descriptor.text,
          lines: descriptor.lines,
          columns: descriptor.columns,
        });
      }
    });
  });
  return sources;
}

class AOTCompiler {
  lowerToHIR(source, options = {}) {
    const frontendScope = new FrontendCompiler({
      structuredMetadata: true,
    }).compile(source, !!options.strict);
    const hir = decodeProgram(frontendScope);
    verifyProgram(hir);
    return hir;
  }

  compile(source, options = {}) {
    const optimization = normalizeLevel(
      options.optimization == null ? options.optimize : options.optimization
    );
    const security = normalizeSecurity(options.security);
    const identifierProtection = normalizeIdentifierProtection(options.identifierProtection);
    const sourceMapSettings = normalizeSourceMapOptions(options.sourceMap);
    // Source maps consume LOC positions at compile time, so the optimizer
    // retains them exactly like preserveSourceLocations; codegen also gates
    // small-function inlining off while either is active.
    const retainSourceLocations = !!sourceMapSettings || options.preserveSourceLocations === true;
    const hir = this.lowerToHIR(source, options);
    // Synthetic eval/Function scopes carry a frontend descriptor
    // ({ text, lines, columns }) that gives them a virtual source identity.
    // The registry is built once from the optimized HIR and shared by
    // codegen (marker emission) and the finalizer (sources/sourcesContent),
    // so source indices are identical across Os candidates by construction.
    const syntheticSources = sourceMapSettings
      ? buildSyntheticSources(hir, sourceMapSettings.sourceFile)
      : null;
    const stats = optimizeProgram(hir, optimization, { ...options, retainSourceLocations });
    verifyProgram(hir);
    let mir;
    if (options.includeMIR || options.dumpIR === "mir" || options.dumpIR === "all") {
      mir = lowerProgramToMIR(hir);
      verifyMIR(mir, hir);
    }
    let semanticCFG;
    if (
      options.includeCFG ||
      options.dumpIR === "cfg" ||
      options.dumpIR === "all" ||
      options.dumpDir
    ) {
      semanticCFG = {
        kind: "ProgramCFG",
        edgeModel: "semantic",
        entry: hir.entry,
        scopes: hir.scopes.map((scope) => {
          const scopeCFG = buildSemanticCFG(scope);
          verifyCFG(scopeCFG, scope);
          return scopeCFG;
        }),
      };
    }
    const createCodegenStats = () => ({
      straightScopes: 0,
      structuredScopes: 0,
      fallbackScopes: 0,
      fastFrameScopes: 0,
      leafFrameScopes: 0,
      framePooledScopes: 0,
      inlineLeafFrameScopes: 0,
      inlineFastFrameScopes: 0,
      inlining: null,
      sizeOptimization: null,
      identifierProtection: null,
      stackToLocal: {
        enabled: (optimization === "O2" || optimization === "Os") && options.stackToLocal !== false,
        instructions: 0,
        helpersAvoided: 0,
        stackLoads: 0,
        stackStores: 0,
        sizeTemporaryAssignments: 0,
        sizeTemporaryReuses: 0,
        promotedLoads: 0,
        promotedStores: 0,
        denseSwitches: 0,
        denseSwitchCases: 0,
      },
      localPromotion: null,
    });
    const requestedFactories = options.perScopeFactories;
    const factoryCandidates =
      optimization === "Os" && requestedFactories === undefined
        ? [false, true]
        : [requestedFactories === undefined ? optimization !== "Os" : requestedFactories];
    const candidates = factoryCandidates.map((perScopeFactories) => {
      const codegenStats = createCodegenStats();
      const code = generate(hir, {
        ...options,
        optimization,
        security,
        perScopeFactories,
        codegenStats,
        retainSourceLocations,
        mapSettings: sourceMapSettings,
        syntheticSources,
      });
      return {
        code,
        codegenStats,
        perScopeFactories,
        // Location markers and map comments must not participate in the
        // candidate size model: measure the marker-free bytes exactly as the
        // map-off build would.
        bytes: utf8ByteLength(sourceMapSettings ? stripMarkers(code) : code),
      };
    });
    candidates.sort(
      (left, right) =>
        left.bytes - right.bytes || Number(left.perScopeFactories) - Number(right.perScopeFactories)
    );
    const selected = candidates[0];
    const { code: selectedCode, codegenStats, perScopeFactories } = selected;
    codegenStats.sizeOptimization.costModel = {
      objective: "raw-bytes",
      selected: perScopeFactories ? "per-scope-factories" : "shared-factory",
      candidates: candidates.map((candidate) => ({
        strategy: candidate.perScopeFactories ? "per-scope-factories" : "shared-factory",
        bytes: candidate.bytes,
      })),
      zeroGrowthInlining: optimization === "Os",
      temporaryReuse: optimization === "Os",
      helperImportPruning: true,
    };
    stats.codegen = codegenStats;
    // Finalize the map only for the selected candidate: markers are stripped
    // and the v3 map is built against the cleaned output, then the
    // destination comment (inline data URL, or the caller's external URL) is
    // appended after the final mapping positions are known.
    let code = selectedCode;
    let map;
    let cleanCode = selectedCode;
    if (sourceMapSettings) {
      ({ code: cleanCode, map } = finalizeSourceMap(
        selectedCode,
        sourceMapSettings,
        source,
        syntheticSources
      ));
      code = cleanCode;
      if (sourceMapSettings.mode === "inline") {
        code = `${cleanCode}\n${sourceMapURLComment(
          `data:application/json;charset=utf-8;base64,${base64EncodeUtf8(map)}`
        )}`;
      } else if (sourceMapSettings.sourceMapURL) {
        code = `${cleanCode}\n${sourceMapURLComment(sourceMapSettings.sourceMapURL)}`;
      }
    }
    stats.codegen.sizeOptimization.outputBytes = utf8ByteLength(code);
    if (options.dumpDir) {
      // Inspection mode: write optimized HIR, completion-aware semantic CFG,
      // the MIR the backend passes reason about, and generated code. Independent of
      // dumpIR/includeHIR, which attach the graph objects to the result — the
      // returned object is unchanged by dumpDir. File access goes through the
      // options.fs adapter so browser bundles can supply an in-memory
      // implementation (the Node default is lazily required, see above).
      const dumpFs = options.fs || defaultInspectionFs();
      const dumpMIR = mir || lowerProgramToMIR(hir);
      verifyMIR(dumpMIR, hir);
      dumpFs.mkdirSync(options.dumpDir, { recursive: true });
      dumpFs.writeFileSync(dumpFs.join(options.dumpDir, "hir.txt"), printProgram(hir));
      dumpFs.writeFileSync(dumpFs.join(options.dumpDir, "cfg.txt"), printCFG(semanticCFG));
      dumpFs.writeFileSync(dumpFs.join(options.dumpDir, "mir.txt"), printMIR(dumpMIR));
      // The dumped code.js uses code.js.map as its URL rather than leaking
      // the absolute dumpDir; the returned artifact continues to use the
      // caller-provided logical names (inline maps keep their data URL).
      const dumpCode =
        map && sourceMapSettings.mode === "external"
          ? `${cleanCode}\n${sourceMapURLComment("code.js.map")}`
          : code;
      dumpFs.writeFileSync(dumpFs.join(options.dumpDir, "code.js"), dumpCode);
      if (map) {
        // The dumped artifact is named code.js, so the copied map's `file`
        // field must match it rather than the caller's generatedFile (which
        // describes the returned artifact's eventual output path).
        const dumpMap =
          sourceMapSettings.mode === "external"
            ? JSON.stringify({ ...JSON.parse(map), file: "code.js" })
            : map;
        dumpFs.writeFileSync(dumpFs.join(options.dumpDir, "code.js.map"), dumpMap);
      }
    }
    return {
      code,
      format: options.format || "cjs",
      optimization,
      stats,
      hir:
        options.dumpIR === "hir" || options.dumpIR === "all" || options.includeHIR
          ? hir
          : undefined,
      cfg:
        options.includeCFG || options.dumpIR === "cfg" || options.dumpIR === "all"
          ? semanticCFG
          : undefined,
      mir,
      map,
      metadata: {
        abiVersion: ABI_VERSION,
        format: options.format || "cjs",
        inputLanguage: "es5.1",
        identifierProtection,
        optimize: optimization,
        optimizerPipelineVersion: OPTIMIZER_PIPELINE_VERSION,
        optimizerPasses: stats.passes.map((pass) => pass.name),
        optimizerDisabledPasses: stats.disabledPasses.slice(),
        optimizerAnalysisGeneration: stats.analysis ? stats.analysis.generation : 0,
        optimizerAnalysisRebuilds: stats.analysis ? stats.analysis.rebuilds.slice() : [],
        optimizerBailouts: stats.analysis ? stats.analysis.bailouts.slice() : [],
        perScopeFactories,
        security,
        // The key exists only when a map was requested, matching the
        // declarations (map-off metadata is otherwise byte-identical to the
        // pre-map build).
        ...(sourceMapSettings ? { sourceMap: sourceMapSettings } : {}),
      },
    };
  }

  lowerToMIR(source, options = {}) {
    const hir = this.lowerToHIR(source, options);
    const mir = lowerProgramToMIR(hir);
    verifyMIR(mir, hir);
    return mir;
  }
}

function compile(source, options) {
  return new AOTCompiler().compile(source, options);
}

function lowerToHIR(source, options) {
  return new AOTCompiler().lowerToHIR(source, options);
}

function lowerToMIR(source, options) {
  return new AOTCompiler().lowerToMIR(source, options);
}

module.exports = {
  AOTCompiler,
  compile,
  lowerToHIR,
  lowerToMIR,
  normalizeSecurity,
  normalizeSourceMapOptions,
};
