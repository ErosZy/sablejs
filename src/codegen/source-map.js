"use strict";

// Source Map v3 generation for the CommonJS artifact returned by compile().
//
// The code generator keeps its internal string return type: in source-map
// mode it lowers every LOC operation to a private marker line, and this
// module scans the completely assembled module once, removes the markers, and
// builds the map against the cleaned output. Scanning at the end naturally
// observes the real generated positions after codegen's final string
// insertions and removals (temporary declarations, stackless frames).
//
// Markers are collision-resistant because they contain raw control
// characters: every guest-derived string in generated code passes through
// jsLiteral/JSON.stringify, which escapes control characters as \uXXXX, and
// every other emitted character is compiler-controlled. The finalizer asserts
// that none remain in returned code.

const { GenMapping, addSegment, toEncodedMap } = require("@jridgewell/gen-mapping");

const MARKER_START = "sable:";
const MARKER_END = "";
const RESET_PAYLOAD = "reset";
const LOC_PREFIX = "loc:";

// A location marker carries (source identity, line, column). Identity 0 is
// the caller's logical sourceFile; identities 1..N index the synthetic
// eval/dynamic-function sources of the map. Line is one-based, column
// zero-based, matching the Acorn LOC contract; the finalizer converts the
// line when it adds segments.
function locMarker(source, line, column) {
  return `${MARKER_START}${LOC_PREFIX}${source}:${line}:${column}${MARKER_END}`;
}

// Maps a position inside parsed synthetic text to the guest-recognizable
// virtual source described by a frontend descriptor:
//   { text, lines, columns }
// where `lines`/`columns` are the prefix geometry injected around the
// guest text before parsing (the strict-mode `'use strict';` prefix for
// eval, the `function _dynamic_N(params){ ` wrapper for Function): how
// many parsed lines the wrapper occupies and how long its last line is.
// A newline-free prefix (single-line params) has `lines: 0`, so only the
// first parsed body line carries a column shift; a multi-line parameter
// list contributes its newlines to `lines`, and later body lines are
// relative to the body text itself.
// Returns null when the position falls inside the injected prefix — such
// locations cannot map to guest text and must stay unmapped.
function translateSynthetic(line, column, descriptor) {
  const virtualLine = line - descriptor.lines;
  if (virtualLine < 1) return null;
  const virtualColumn = line === descriptor.lines + 1 ? column - descriptor.columns : column;
  if (virtualColumn < 0) return null;
  return { line: virtualLine, column: virtualColumn };
}

// A reset marker ends the active source location: subsequent generated lines
// are unmapped until the next location marker. Emitted at the start and end
// of every generated `$exec*` scope so module metadata, factories, and the
// next scope's prologue never inherit the last statement's location.
function resetMarker() {
  return `${MARKER_START}${RESET_PAYLOAD}${MARKER_END}`;
}

// Returns { kind: "reset" } | { kind: "loc", source, line, column } | null.
function parseMarkerLine(text) {
  const line = text.trim();
  if (!line.startsWith(MARKER_START) || !line.endsWith(MARKER_END)) return null;
  const payload = line.slice(MARKER_START.length, line.length - MARKER_END.length);
  if (payload === RESET_PAYLOAD) return { kind: "reset" };
  if (payload.startsWith(LOC_PREFIX)) {
    const parts = payload.slice(LOC_PREFIX.length).split(":");
    if (parts.length === 3) {
      const [source, lineValue, column] = parts.map(Number);
      if (Number.isInteger(source) && Number.isInteger(lineValue) && Number.isInteger(column)) {
        return { kind: "loc", source, line: lineValue, column };
      }
    }
  }
  return null;
}

// Removes marker lines without building a map. Used to measure candidate
// bytes with the Os factory selection cost model: location markers and map
// comments must not participate in the size comparison.
function stripMarkers(code) {
  return code
    .split("\n")
    .filter((line) => parseMarkerLine(line) === null)
    .join("\n");
}

// Removes markers and builds the Source Map v3 JSON for the cleaned output.
// `settings` is the normalized sourceMap option object:
//   { mode, sourceFile, generatedFile, sourceMapURL, sourcesContent }
// `syntheticSources` is the ordered registry of virtual eval/dynamic sources
// compiled from the program (see src/compiler/index.js), each
//   { scopeId, name, text, lines, columns }
// with source identity 1..N in marker order matching registry position.
// Returns { code, map } where code is marker-free and map is the serialized
// v3 JSON. The comment line (inline data URL or external sourceMapURL) is
// appended by the caller, which knows the eventual output destination.
function finalizeSourceMap(codeWithMarkers, settings, sourceText, syntheticSources = []) {
  const map = new GenMapping({ file: settings.generatedFile });
  let active = null;
  let cleanLine = 0;
  const cleaned = [];
  const lines = codeWithMarkers.split("\n");
  for (const line of lines) {
    const marker = parseMarkerLine(line);
    if (marker) {
      // Marker lines vanish from the output and produce no segment; a reset
      // also ends the active source location.
      active = marker.kind === "reset" ? null : marker;
      continue;
    }
    if (active && line.trim().length) {
      // Statement-level mapping: every non-empty generated line under an
      // active location receives a segment at its first non-whitespace
      // column. Acorn LOC lines are one-based; the map generator indexes
      // source lines from zero. Columns stay zero-based.
      const source =
        active.source === 0 ? settings.sourceFile : syntheticSources[active.source - 1].name;
      addSegment(map, cleanLine, line.search(/\S/), source, active.line - 1, active.column);
    }
    cleaned.push(line);
    cleanLine += 1;
  }
  const code = cleaned.join("\n");
  if (code.includes(MARKER_START) || code.includes(MARKER_END)) {
    throw new Error("Source map finalizer left a private location marker in generated code");
  }
  const encoded = toEncodedMap(map);
  // GenMapping assigns source indices by first-segment order, which is not
  // guaranteed to match the registry order encoded in the markers (a nested
  // eval's factory can emit before the root eval's). The map's `sources`
  // must therefore be GenMapping's own array — the array the segment indices
  // point into — and `sourcesContent` aligns by name, not by position.
  const sourceNames = encoded.sources;
  const contentBySource = new Map();
  contentBySource.set(settings.sourceFile, sourceText);
  for (const source of syntheticSources) contentBySource.set(source.name, source.text);
  const mapJson = JSON.stringify({
    version: 3,
    file: settings.generatedFile,
    sources: sourceNames,
    ...(settings.sourcesContent
      ? { sourcesContent: sourceNames.map((name) => contentBySource.get(name) ?? null) }
      : {}),
    names: [],
    mappings: encoded.mappings,
  });
  return { code, map: mapJson };
}

function sourceMapURLComment(url) {
  return `//# sourceMappingURL=${url}`;
}

module.exports = {
  MARKER_END,
  MARKER_START,
  finalizeSourceMap,
  locMarker,
  parseMarkerLine,
  resetMarker,
  sourceMapURLComment,
  stripMarkers,
  translateSynthetic,
};
