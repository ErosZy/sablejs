"use strict";

const OpSpec = require("../ir/op-spec");
const { ABI_VERSION } = require("../runtime");
const { locMarker, resetMarker, translateSynthetic } = require("./source-map");

// These operations lower to JavaScript control flow rather than to a Runtime
// helper call. Every other OpSpec entry must name one concrete helper. This is
// deliberately exhaustive so adding an opcode without an AOT lowering fails at
// compiler startup instead of silently falling back to interpretation.
const STATIC_CONTROL_OPS = new Set([
  "JUMP", "JTRUE", "JFALSE", "JCASE", "RETURN", "THROW", "TRY", "ENDTRY",
]);

// Operations that cannot be guarded safely while operands stay in generated
// locals continue through RuntimeInstance. Hot property/call paths use the
// smaller sandbox helpers below instead of materializing the operand stack.
const SANDBOX_MEDIATED_OPS = new Set([
  "DELPROP", "DELPROP_S", "IN", "INSTANCEOF", "INITPROP", "INITGETTER", "INITSETTER",
  "ITERATOR", "NEXTITER",
]);
const SANDBOX_SENSITIVE_PROPERTY_NAMES = [
  "constructor", "prototype", "__proto__", "caller", "callee", "arguments",
];

function sandboxPropertyRead(object, key, staticName = null) {
  const mediated = `$getSandbox($r, ${object}, ${key})`;
  if (staticName !== null && SANDBOX_SENSITIVE_PROPERTY_NAMES.includes(staticName)) return mediated;
  if (staticName !== null) return `${object}[${key}]`;
  const sensitive = staticName === null
    ? SANDBOX_SENSITIVE_PROPERTY_NAMES.map((name) => `${key} === ${jsLiteral(name)}`).join(" || ")
    : "false";
  return `((${sensitive}) ? ${mediated} : ${object}[${key}])`;
}

function validateLoweringCoverage() {
  const missing = OpSpec.byCode.filter((spec) =>
    !STATIC_CONTROL_OPS.has(spec.name) && !spec.helper
  );
  if (missing.length) {
    throw new Error(`Missing AOT lowering for: ${missing.map((spec) => spec.name).join(", ")}`);
  }
  return Object.freeze({
    total: OpSpec.count,
    directHelpers: OpSpec.byCode.filter((spec) => !STATIC_CONTROL_OPS.has(spec.name)).length,
    staticControl: STATIC_CONTROL_OPS.size,
  });
}

const LOWERING_COVERAGE = validateLoweringCoverage();

function jsLiteral(value) {
  if (value === undefined) return "void 0";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    if (Object.is(value, -0)) return "-0";
  }
  return JSON.stringify(value);
}

// TRUE/FALSE/NULL/UNDEF carry no operand — the value lives in the op name —
// while INTEGER/NUMBER/STRING carry it in args[0]. Constant-folded ops
// (e.g. NEG 0 → -0 at O1+) carry the folded value in optimized.literal.
function literalOperand(instruction) {
  if (instruction.optimized && instruction.optimized.kind === "literal") {
    return jsLiteral(instruction.optimized.value);
  }
  switch (instruction.op) {
    case "TRUE": return "true";
    case "FALSE": return "false";
    case "NULL": return "null";
    case "UNDEF": return "void 0";
    default: return jsLiteral(instruction.args[0]);
  }
}

// Hoisted LICM loads read the slot exactly like the inline GETLOCAL form:
// frame locals via `$l[index]`, or the promoted variable when local
// promotion claims the slot. The optimizer only hoists reads in scopes
// with a static frame layout (no with/eval/catch chain), so `$l` is always
// declared here; a hoist without frame layout would silently miscompile, so
// fail loudly instead of emitting a broken read.
function hoistedLocalLoad(context, load) {
  if (context.localKind !== "frame") {
    throw new Error(`LICM hoist without frame layout in scope ${context.scope.id}`);
  }
  if (context.promotedLocals && context.promotedLocals.has(load.localIndex)) {
    return promotedLocalName(context, load.localIndex);
  }
  return `$l[${load.localIndex}]`;
}

// A promoted local is a true `$exec` variable declared in the function
// prologue (`let $p<scope>_<index>;`) instead of a slot in the frame's
// `locals` array. The slot keeps its dead `void 0` placeholder so every
// frame constructor, the `$getArguments` parameter mapping, and the
// metadata layout stay untouched; only GETLOCAL/SETLOCAL (and LICM hoists)
// divert to the variable.
function promotedLocalName(context, index) {
  return `$p${context.scope.id}_${index}`;
}

// Item 9: per-slot provenance stamps. Each tracked frame local gets a $q flag
// that records whether writeTarget resolution for the value it currently
// holds is a provable no-op (see the SETPROP guest-slot branch). The flag is
// classified once per store instead of per property write; $q is free of the
// codegen's $p/$v/$t/$gv/$h/$l/$s/$g identifier families.
function provenanceFlag(context, index) {
  return `$q${context.scope.id}_${index}`;
}

// Item 10: inline the guest-write path. A guest-classified receiver (the
// $q-stamp true branch, the thisIsGuest true branch, or a directly marked
// guest object) makes writeTarget a provable no-op, and $setGuest's remaining
// per-write work is (a) the typeof-function check and (b) the strict/sloppy
// writer dispatch — both below. The inline form emits that work directly at
// the write site: for a strict scope a native `$o[$k] = v` (writeStrictPropertyValue
// minus its isIndexedPrototype guard, which is dead on this path: the guard
// fires only for the host Array/Object prototypes, which are protected
// intrinsics — isUnmediatedWriteTarget classifies them false, so a
// guest-classified receiver provably never triggers it), for a sloppy scope a
// single call to the captured non-strict writer `$writeSloppy`
// (silent-failure semantics — a native set in the strict generated code would
// throw where sloppy must no-op). The value-side securing is preserved
// verbatim (`typeof === "function" ? secureValue : value`), and values whose
// static op proves primitive (arithmetic/comparison results, literals) skip
// even that check. Emitted only where context.slotProvenance holds (O2 sandbox
// frame scopes — the item-9 footprint), so Os/O0/O1/trusted stay byte-identical.
// Kill switch: `inlineGuestWrites: false` / `--no-inline-guest-writes`.
const PRIMITIVE_RESULT_OPS = new Set([
  // Ops whose result is never a function and never an object (mirrors
  // valueTypeForOperation's primitive outputs, plus ADD — `a + b` is always
  // string-or-number).
  "UNDEF", "NULL", "TRUE", "FALSE", "INTEGER", "NUMBER", "STRING",
  "POS", "NEG", "BITNOT", "INC", "DEC", "POSTINC", "POSTDEC",
  "MUL", "DIV", "MOD", "SUB", "SHL", "SHR", "USHR", "BITAND", "BITXOR", "BITOR", "ADD",
  "LT", "GT", "LE", "GE", "EQ", "NE", "STRICTEQ", "STRICTNE", "LOGNOT", "TYPEOF",
  "DELLOCAL", "DELLOCAL2", "DELVAR", "DELPROP", "DELPROP_S", "IN", "INSTANCEOF",
]);

// jsLiteral renders: numbers (JSON or NaN/Infinity/-0 forms), double-quoted
// strings, true/false/null/void 0.
function isLiteralRender(render) {
  return /^(NaN|-?Infinity|-0|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|void 0|"(?:[^"\\]|\\.)*")$/.test(render);
}

// A render is pure when reading it twice (the typeof probe and the branch)
// is side-effect-free and order-independent: named temps (recorded via
// temporary()), promoted locals and hoisted LICM loads (const, pure), and
// literals. Stack pops and inline expressions are not — those keep $setGuest.
function isPureWriteValue(context, render) {
  if (context.temporaryInstructions.has(render)) return true;
  if (/^\$(?:p|h)\d+_\d+$/.test(render)) return true;
  return isLiteralRender(render);
}

// The value's static op proves it can never be a function (so secureValue's
// function branch is unreachable) and never an ambient object (the write path
// only secures functions — secureValue's ambient branch is unreached from
// $setGuest/$setSandbox, which gate on typeof === "function" only).
function isProvablyPrimitiveValue(context, render) {
  const instruction = context.temporaryInstructions.get(render);
  if (instruction && PRIMITIVE_RESULT_OPS.has(instruction.op)) return true;
  if (instruction && instruction.optimized && instruction.optimized.kind === "literal") {
    const folded = instruction.optimized.value;
    return typeof folded !== "object" && typeof folded !== "function";
  }
  return isLiteralRender(render);
}

// Record a temp's producing instruction for the write-path purity check.
// Deliberately NOT routed through temporary(): the record is consulted only
// by isPureWriteValue/isProvablyPrimitiveValue (inline guest writes), while
// instructionTemporaries ("reuse" optimization) is left untouched so
// enabling inline writes never changes reuse behavior.
function recordWriteTemp(context, name, instruction) {
  context.temporaryInstructions.set(name, instruction);
  return name;
}

// Returns the guest-branch write expression, or null when the site must keep
// the $setGuest call (non-O2 context, or a value render that is not pure).
function guestWriteExpression(context, object, key, value) {
  if (!context.slotProvenance || !context.inlineGuestWrites || !isPureWriteValue(context, value)) return null;
  const secured = isProvablyPrimitiveValue(context, value)
    ? value
    : `(typeof ${value} === "function" ? $r.boundary.secureValue(${value}) : ${value})`;
  return context.scope.strict
    ? `${object}[${key}] = ${secured}`
    : `$writeSloppy(${object}, ${key}, ${secured})`;
}

// Item 9: the SETPROP/SETPROP_S branch for a receiver that is a frame local.
// The $q flag carries the store-time classification; the lazy `=== undefined`
// fallback covers slots whose first store predated discovery (no
// classification line was emitted for it). Sloppy parameter slots are
// readable by the mapped arguments proxy — a direct frame.locals write — so
// once arguments are materialized the stamp may be stale and the write takes
// the full sandbox path. Dropped slots (mixed-path setLocal conflicts) take
// the full path too. Returns true when the branch was taken.
function emitProvenanceWriteSite(lines, indent, context, origin, object, key, value) {
  const plan = context.provenanceSlots;
  if (!plan) return false;
  if (plan.dropped.has(origin.index)) {
    lines.push(`${indent}$setSandbox($r, ${context.writeProperty}, ${object}, ${key}, ${value});`);
    return true;
  }
  plan.tracked.add(origin.index);
  const scope = context.scope;
  const guard = !scope.strict &&
    scope.parameters.includes(scope.variables[origin.index - 1])
    ? "!$f.argumentsInitialized && "
    : "";
  const flag = provenanceFlag(context, origin.index);
  const guest = guestWriteExpression(context, object, key, value) ||
    `$setGuest($r, $f, ${object}, ${key}, ${value})`;
  lines.push(`${indent}(${guard}(${flag} === undefined ? ${flag} = $r.boundary.isUnmediatedWriteTarget(${object}) : ${flag})) ? ${guest} : $setSandbox($r, ${context.writeProperty}, ${object}, ${key}, ${value});`);
  return true;
}

// Item 14: identifier calls of these five host intrinsics inline into a
// direct call (see case "CALL"). They are pure intrinsics whose results are
// always primitives, so the direct call is observationally identical to the
// boundary dispatch as long as no argument is an ambient host object.
const HOST_INTRINSIC_NAMES = new Set(["isNaN", "parseFloat", "parseInt", "Number", "String"]);

// Item 15: member calls of these host prototype functions inline into a
// direct `callee.call(receiver, ...)` (see case "CALL"). The set covers the
// workload-hot members {join, push, charAt, indexOf, slice, sort, replace,
// test}; the resolved callee is compared by identity against the raw
// prototype functions imported from the runtime module, so a guest own
// property, prototype redefinition, or wrapper always routes to the fallback.
const MEMBER_INTRINSIC_NAMES = new Set(["join", "push", "charAt", "indexOf", "slice", "sort", "replace", "test"]);
// The boundary's MUTATES_RECEIVER set contains exactly these two members;
// their inline must route protected receivers (intrinsic graph objects) to
// the fallback, where assertMutable throws the same boundary error.
const MUTATING_MEMBER_INTRINSICS = new Set(["push", "sort"]);
// Identity anchors per member. slice and indexOf exist on both
// Array.prototype and String.prototype, so their guards must match either.
const MEMBER_INTRINSIC_GUARDS = {
  join: ["$hostJoin"],
  push: ["$hostPush"],
  sort: ["$hostSort"],
  charAt: ["$hostCharAt"],
  replace: ["$hostReplace"],
  test: ["$hostTest"],
  slice: ["$hostSliceArray", "$hostSliceString"],
  indexOf: ["$hostIndexOfArray", "$hostIndexOfString"],
};

// Item 15b: runtime-stack operand counts for the fallback dispatch. The O2
// emitter flushes the entire codegen stack onto $s before every dispatch and
// the runtime helper pops its operands from there, so a member call whose
// operands were flushed at a region boundary (a control-flow value between
// the operand pushes and the CALL — e.g. a ternary inside an object literal
// argument) can be recovered from the codegen's $s mirror and still inlined.
// The counts mirror the runtime helpers exactly (verified against
// src/runtime/index.js); ops with conditional or unknown stack shapes taint
// the mirror instead, which conservatively disables recovery until the next
// flush. Net deltas come from OpSpec.
const DISPATCH_STACK_POPS = {
  GETPROP: 2, GETPROP_S: 1, SETPROP: 3, SETPROP_S: 2, DELPROP: 2, DELPROP_S: 1,
  INITPROP: 2, INITGETTER: 2, INITSETTER: 2, IN: 2, INSTANCEOF: 2,
  ITERATOR: 1, EVAL: 1, WITH: 1, CATCH: 1, THROW: 1, RETURN: 1, PUTVAR: 1,
  TYPEOF: 1, POS: 1, NEG: 1, BITNOT: 1, LOGNOT: 1, INC: 1, DEC: 1,
  POSTINC: 1, POSTDEC: 1,
  MUL: 2, DIV: 2, MOD: 2, ADD: 2, SUB: 2, SHL: 2, SHR: 2, USHR: 2,
  LT: 2, GT: 2, LE: 2, GE: 2, EQ: 2, NE: 2, STRICTEQ: 2, STRICTNE: 2,
  BITAND: 2, BITXOR: 2, BITOR: 2,
  CLOSURE: 0, REFVAR: 0, DUP: 0, POP: 1,
  // Literal pushes via $r.pushLiteral (the optimized-literal path).
  INTEGER: 0, NUMBER: 0, STRING: 0,
};

// Item 13: inline the INITPROP fast path for literal initialization on a
// provably fresh guest object. The runtime helper's remaining per-init work
// for a fresh literal is: the assertMutable call (a no-op — protected objects
// are realm intrinsics; a literal temp created mid-run can never be in
// protectedValues/propertyTarget), the EMPTY-hole length branch (unreachable —
// EMPTY is pushed via $r.pushEmpty, which flushes the model stack, so a hole
// init never has all three operands pending), the __proto__ key check (the
// key is a static literal — excluded below when it spells __proto__), the
// inherited-property safety flag check (kept live through the historical
// $prototypesHaveSetters module import — the generated $r is the runtime
// instance, not the module),
// and the function-value securing (preserved via the typeof probe, skipped
// when the value's static op proves primitive). The fallback branch
// re-materializes the full unpopped operand stack so $r.initProperty($f)
// sees exactly what the runtime path would.
function emitInlineInitProperty(lines, indent, context, stack) {
  if (!context.inlineGuestInit) return false;
  if (stack.length < 3) return false;
  const value = stack[stack.length - 1];
  const key = stack[stack.length - 2];
  const object = stack[stack.length - 3];
  const origin = context.temporaryOrigins.get(object);
  if (!origin || origin.kind !== "guest-object") return false;
  // Static literal keys only, and never __proto__ (assignment through the
  // host accessor swaps the chain where defineData must create an own prop).
  const keyInstruction = context.temporaryInstructions.get(key);
  const safeKey = keyInstruction && (
    keyInstruction.op === "INTEGER" || keyInstruction.op === "NUMBER" ||
    (keyInstruction.op === "STRING" && keyInstruction.args[0] !== "__proto__")
  );
  if (!safeKey) return false;
  // Model-stack entries are write-once temps, so reading the value twice
  // (probe + assignment) is pure; only the probe eligibility needs the
  // static op classification.
  const secured = context.security === "sandbox" &&
      !isProvablyPrimitiveValue(context, value)
    ? `(typeof ${value} === "function" ? $r.boundary.secureValue(${value}) : ${value})`
    : value;
  stack.pop();
  stack.pop();
  stack.pop();
  lines.push(`${indent}if ($prototypesHaveSetters()) {`);
  lines.push(`${indent}  $s.push(${object}, ${key}, ${value});`);
  lines.push(`${indent}  $r.initProperty($f);`);
  // The runtime initProperty pops value + key and keeps the object on $s;
  // mirror that (the object stays available for a following call).
  if (context.runtimeStack) {
    context.runtimeStack.push(object, key, value);
    context.runtimeStack.length -= 2;
  }
  lines.push(`${indent}} else {`);
  lines.push(`${indent}  ${object}[${key}] = ${secured};`);
  lines.push(`${indent}}`);
  stack.push(object);
  return true;
}

const OBJECT_LITERAL_VALUE_OPS = new Set(["INTEGER", "NUMBER", "STRING", "TRUE", "FALSE", "NULL", "UNDEF"]);

// A property value is foldable when it is a plain literal or a
// constant-folded op (NEG/arithmetic folded to a literal by the optimizer).
function isFoldableLiteralValue(instruction) {
  if (instruction.elided) return false;
  if (instruction.optimized && instruction.optimized.kind === "literal") return true;
  return OBJECT_LITERAL_VALUE_OPS.has(instruction.op);
}

function metadata(scope, fastFrame = false, aliases = null, leafFrame = false, usesThisWrites = false, withMarks = false) {
  const alias = (name) => aliases && aliases.has(name) ? aliases.get(name) : name;
  return {
    id: scope.id,
    name: alias(scope.name),
    script: scope.script,
    strict: scope.strict,
    lightweight: scope.lightweight,
    usesArguments: scope.usesArguments,
    usesThisWrites,
    parameterCount: scope.parameterCount,
    parameters: scope.parameters.map(alias),
    variables: scope.variables.map(alias),
    dynamicFunctions: scope.dynamicFunctions.map((dynamicScope) => dynamicScope === -1 ? -1 : dynamicScope.id),
    fastFrame,
    leafFrame,
    // Only scopes with a with (or eval) in their static ancestor chain can
    // ever resolve a withBase binding at runtime; the runtime keeps the
    // receiver-marks stack sync only for those (see createFrame).
    withMarks,
  };
}

// Lifts a LOC position into a private marker for source-map mode. Root
// scopes map directly to identity 0; synthetic eval/Function scopes with a
// frontend descriptor translate through their virtual source; synthetic
// scopes without one (runtime-dynamic eval values) lower to a reset so
// their bodies stay unmapped.
function markerForLocation(locationContext, line, column) {
  if (locationContext.syntheticSource) {
    const translated = translateSynthetic(line, column, locationContext.syntheticSource);
    if (translated) {
      return locMarker(locationContext.syntheticSource.index, translated.line, translated.column);
    }
    return resetMarker();
  }
  return locationContext.syntheticScope ? resetMarker() : locMarker(0, line, column);
}

// Returns the nearest synthetic-scope state for a scope, walking the parent
// chain: { kind: "source", entry } when the scope or an ancestor is a static
// eval / dynamic-Function scope with a frontend source descriptor;
// { kind: "reset" } when the nearest synthetic ancestor is a runtime-dynamic
// eval (its body is unknowable, so descendants stay unmapped too); and
// { kind: "root" } when no synthetic ancestor exists. Lexical descendants of
// a static eval (a function declared inside the eval body) keep LOC offsets
// relative to the same parsed text, so the descriptor's translation applies
// unchanged.
function inheritSynthetic(scope, options) {
  for (let current = scope; current;) {
    if (options.syntheticSources) {
      const entry = options.syntheticSources.get(current.id);
      if (entry) return { kind: "source", entry };
    }
    if ((options.evalScopeIds && options.evalScopeIds.has(current.id)) ||
        (options.dynamicFunctionScopeIds && options.dynamicFunctionScopeIds.has(current.id))) {
      return { kind: "reset" };
    }
    current = current.parentId == null ? null : options.scopesById.get(current.parentId);
  }
  return { kind: "root" };
}

// Maps a scope's factory header line (`function $execN(...) {`) to the
// scope's first LOC, so a devtools breakpoint on a guest function
// declaration lands on the generated factory line instead of falling through
// to the first body statement's mapping. Falls back to a reset when the
// scope has no LOC (fully optimized empty bodies); the module-level $make
// wrappers stay unmapped.
function entryMarkerForScope(scope, context) {
  if (!context || !context.sourceMap) return "";
  let loc = null;
  for (const instruction of scope.instructions) {
    if (instruction.op === "LOC" && (loc === null || instruction.offset < loc.offset)) loc = instruction;
  }
  return loc ? markerForLocation(context, loc.args[0], loc.args[1]) : resetMarker();
}

function factoryLines(scope, context) {
  const entry = entryMarkerForScope(scope, context);
  return entry ? [entry, `function $exec${scope.id}($r, $f) {`] : [`function $exec${scope.id}($r, $f) {`];
}

function callForInstruction(instruction, context = null) {
  if (instruction.optimized && instruction.optimized.kind === "duplicate") {
    return "$r.dup($f);";
  }
  if (instruction.optimized && instruction.optimized.kind === "drop-inputs") {
    return Array.from({ length: instruction.optimized.count }, () => "$r.pop($f);").join(" ");
  }
  if (instruction.op === "LOC") {
    // The fallback path lowers LOC to $r.location($f, line, column) for
    // runtime frame-location tracking. Source-map mode consumes the position
    // at compile time instead: lower to a private marker (virtual-source for
    // synthetic eval/Function bodies, reset otherwise). When both modes are
    // requested the runtime write is emitted alongside the marker, matching
    // the direct lowering path; without context.sourceMap this falls through
    // to the generic helper below, so the O0/O1 runtime contract is
    // byte-for-byte unchanged.
    if (context && context.sourceMap) {
      const marker = markerForLocation(context, instruction.args[0], instruction.args[1]);
      if (context.preserveSourceLocations) {
        return `${marker}\n$f.line = ${jsLiteral(instruction.args[0])}; $f.column = ${jsLiteral(instruction.args[1])};`;
      }
      return marker;
    }
  }
  if (instruction.optimized && instruction.optimized.kind === "literal") {
    return `$r.pushLiteral($f, ${jsLiteral(instruction.optimized.value)});`;
  }
  const spec = OpSpec.byName[instruction.op];
  if (!spec.helper) throw new Error(`No runtime helper for ${instruction.op}`);
  if (["beginTry", "endTry"].includes(spec.helper)) {
    throw new Error(`${instruction.op} has not been lowered by the structured-control-flow backend yet`);
  }
  if (instruction.op === "CLOSURE") {
    const nested = instruction.args[0];
    return context && context.perScopeFactories === false
      ? `$r.closure($f, $exec${nested.id}, $meta${nested.id});`
      : `$r.closureFactory($f, $make${nested.id});`;
  }
  if (instruction.op === "EVAL") {
    const nested = instruction.args[0];
    return nested === -1
      ? "$r.rejectDynamicEval($f);"
      : `$r.evalStatic($f, $exec${nested.id}, $meta${nested.id});`;
  }
  const args = instruction.args.map((value, index) => {
    if (index === 0 && ["HASVAR", "GETVAR", "SETVAR", "DELVAR", "REFVAR", "PUTVAR"].includes(instruction.op) &&
        context && context.bindingName) {
      return jsLiteral(context.bindingName(value));
    }
    return jsLiteral(value);
  });
  return `$r.${spec.helper}($f${args.length ? `, ${args.join(", ")}` : ""});`;
}

const NATIVE_BINARY_OPERATORS = Object.freeze({
  inOperator: "in",
  multiply: "*",
  divide: "/",
  modulo: "%",
  add: "+",
  subtract: "-",
  shiftLeft: "<<",
  shiftRight: ">>",
  shiftRightUnsigned: ">>>",
  lessThan: "<",
  greaterThan: ">",
  lessThanOrEqual: "<=",
  greaterThanOrEqual: ">=",
  equal: "==",
  notEqual: "!=",
  strictEqual: "===",
  strictNotEqual: "!==",
  bitAnd: "&",
  bitXor: "^",
  bitOr: "|",
  instanceOf: "instanceof",
});

const NATIVE_UNARY_EXPRESSIONS = Object.freeze({
  typeOf: (value) => `(typeof ${value})`,
  positive: (value) => `(+${value})`,
  negative: (value) => `(-${value})`,
  bitNot: (value) => `(~${value})`,
  logicalNot: (value) => `(!${value})`,
  increment: (value) => `(+${value} + 1)`,
  decrement: (value) => `(+${value} - 1)`,
});

const DYNAMIC_LOCAL_OPERATIONS = new Set([
  "WITH", "ENDWITH", "EVAL", "CATCH", "ENDCATCH",
]);

const IDENTIFIER_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function identifierAlias(index) {
  let value = index;
  let suffix = "";
  do {
    suffix = IDENTIFIER_ALPHABET[value % IDENTIFIER_ALPHABET.length] + suffix;
    value = Math.floor(value / IDENTIFIER_ALPHABET.length) - 1;
  } while (value >= 0);
  return `$${suffix}`;
}

function normalizeIdentifierProtection(value) {
  if (value === undefined || value === true || value === "alias") return "alias";
  if (value === false || value === "preserve") return "preserve";
  throw new Error(`Unknown identifier protection mode ${value}`);
}

function createIdentifierAliases(program, scopesById, protection, codegenStats) {
  const aliases = new Map(program.scopes.map((scope) => [scope.id, new Map()]));
  codegenStats.identifierProtection = {
    mode: protection,
    aliasedScopes: 0,
    aliasedBindings: 0,
    uniqueAliases: 0,
    reusedAliases: 0,
  };
  if (protection === "preserve") return aliases;

  // A with/catch/eval environment performs name lookup at runtime. Its own
  // scope, its lexical ancestors, and its lexical descendants therefore keep
  // source spelling. Independent sibling subtrees remain safe to rename.
  const dynamicAncestors = new Set();
  program.scopes.forEach((scope) => {
    if (!scope.instructions.some((instruction) => DYNAMIC_LOCAL_OPERATIONS.has(instruction.op))) return;
    for (let current = scope; current; current = current.parentId == null
      ? null
      : scopesById.get(current.parentId)) {
      dynamicAncestors.add(current.id);
    }
  });
  const dynamicChain = new Map();
  const hasDynamicAncestor = (scope) => {
    if (dynamicChain.has(scope.id)) return dynamicChain.get(scope.id);
    const dynamic = scope.instructions.some((instruction) =>
      DYNAMIC_LOCAL_OPERATIONS.has(instruction.op)
    ) || (scope.parentId != null && hasDynamicAncestor(scopesById.get(scope.parentId)));
    dynamicChain.set(scope.id, dynamic);
    return dynamic;
  };

  const forbidden = new Set(["arguments"]);
  program.scopes.forEach((scope) => {
    if (scope.name) forbidden.add(scope.name);
    scope.parameters.forEach((name) => forbidden.add(name));
    scope.variables.forEach((name) => forbidden.add(name));
  });
  const children = new Map();
  program.scopes.forEach((scope) => {
    const parentId = scope.parentId == null ? null : scope.parentId;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(scope);
  });
  const activeAliases = new Set();
  const usedAliases = new Set();
  const visited = new Set();

  function protectScope(scope) {
    if (visited.has(scope.id)) return;
    visited.add(scope.id);
    const scopeAliases = aliases.get(scope.id);
    const eligible = !scope.script && !dynamicAncestors.has(scope.id) && !hasDynamicAncestor(scope);
    if (eligible) {
      let nextAlias = 0;
      const allocate = () => {
        let alias;
        do alias = identifierAlias(nextAlias++); while (
          forbidden.has(alias) || activeAliases.has(alias)
        );
        activeAliases.add(alias);
        usedAliases.add(alias);
        return alias;
      };
      scope.variables.forEach((name) => {
        if (name !== "arguments" && name && !scopeAliases.has(name)) {
          scopeAliases.set(name, allocate());
        }
      });
      // Defensive coverage for malformed HIR where a parameter or
      // named-function binding is absent from variables.
      scope.parameters.concat(scope.name || []).forEach((name) => {
        if (name !== "arguments" && name && !scopeAliases.has(name)) {
          scopeAliases.set(name, allocate());
        }
      });
    }
    if (scopeAliases.size) {
      codegenStats.identifierProtection.aliasedScopes += 1;
      codegenStats.identifierProtection.aliasedBindings += scopeAliases.size;
    }
    (children.get(scope.id) || []).forEach(protectScope);
    scopeAliases.forEach((alias) => activeAliases.delete(alias));
  }

  (children.get(null) || []).forEach(protectScope);
  program.scopes.forEach(protectScope);
  codegenStats.identifierProtection.uniqueAliases = usedAliases.size;
  codegenStats.identifierProtection.reusedAliases =
    codegenStats.identifierProtection.aliasedBindings - usedAliases.size;
  return aliases;
}

function createInlineExpressionPlan(scope, budget) {
  if (!scope.lightweight || scope.script || scope.usesArguments ||
      scope.dynamicFunctions.length || scope.controlRegions.length) return null;
  let instructions = scope.instructions.filter((instruction) =>
    !instruction.elided && !instruction.unreachable && instruction.op !== "LOC"
  );

  if (instructions.length >= 3 && instructions[0].op === "CURRENT" &&
      ["SETLOCAL", "SETLOCAL2"].includes(instructions[1].op) &&
      instructions[2].op === "POP") {
    const selfIndex = instructions[1].args[0];
    const selfRead = instructions.slice(3).some((instruction) =>
      ["GETLOCAL", "GETLOCAL2"].includes(instruction.op) && instruction.args[0] === selfIndex
    );
    if (selfRead) return null;
    instructions = instructions.slice(3);
  } else if (instructions.length >= 2 && instructions[0].op === "CURRENT" &&
      instructions[1].op === "POP" &&
      scope.instructions.some((instruction) => instruction.elided &&
        (instruction.op === "SETLOCAL" || instruction.op === "SETLOCAL2") &&
        instruction.offset > instructions[0].offset && instruction.offset < instructions[1].offset)) {
    // Prologue self-binding store was DSE-elided (dead-store elimination):
    // the body never reads its own name — a real read would have kept the
    // store live — so there is no self-binding to guard and the CURRENT/POP
    // pair is the whole prologue.
    instructions = instructions.slice(2);
  }

  const firstReturn = instructions.findIndex((instruction) => instruction.op === "RETURN");
  if (firstReturn < 0 || firstReturn + 3 < instructions.length) return null;
  const tail = instructions.slice(firstReturn + 1);
  if (tail.length && !(tail.length === 2 && tail[0].op === "UNDEF" && tail[1].op === "RETURN")) {
    return null;
  }
  instructions = instructions.slice(0, firstReturn + 1);
  if (instructions.length - 1 > budget) return null;

  const stack = [];
  let requiresNumbers = false;
  for (const instruction of instructions) {
    if (instruction.optimized && instruction.optimized.kind === "literal") {
      stack.push(() => jsLiteral(instruction.optimized.value));
      continue;
    }
    switch (instruction.op) {
      case "INTEGER":
      case "NUMBER":
      case "STRING":
        stack.push(() => jsLiteral(instruction.args[0]));
        continue;
      case "UNDEF": stack.push(() => "void 0"); continue;
      case "NULL": stack.push(() => "null"); continue;
      case "TRUE": stack.push(() => "true"); continue;
      case "FALSE": stack.push(() => "false"); continue;
      case "GETLOCAL":
      case "GETLOCAL2": {
        const parameter = instruction.args[0] - 1;
        if (parameter < 0 || parameter >= scope.parameterCount) return null;
        stack.push((args) => args[parameter] || "void 0");
        continue;
      }
      case "RETURN":
        if (stack.length !== 1) return null;
        return {
          instructionCount: instructions.length - 1,
          parameterCount: scope.parameterCount,
          requiresNumbers,
          render(args) { return stack[0](args); },
          scopeId: scope.id,
        };
      default:
        break;
    }

    const spec = OpSpec.byName[instruction.op];
    const unary = spec && NATIVE_UNARY_EXPRESSIONS[spec.helper];
    if (unary) {
      if (stack.length < 1) return null;
      const input = stack.pop();
      requiresNumbers = true;
      stack.push((args) => unary(input(args)));
      continue;
    }
    const operator = spec && NATIVE_BINARY_OPERATORS[spec.helper];
    if (operator) {
      if (stack.length < 2) return null;
      const right = stack.pop();
      const left = stack.pop();
      if (!["===", "!=="].includes(operator)) requiresNumbers = true;
      stack.push((args) => `(${left(args)} ${operator} ${right(args)})`);
      continue;
    }
    return null;
  }
  return null;
}

function createInlinePlans(program, options, codegenStats) {
  const enabled = options.inlineSmallFunctions !== false && options.optimization === "O2" &&
    options.retainSourceLocations !== true;
  const rawBudget = options.inlineBudget == null ? 12 : Number(options.inlineBudget);
  if (!Number.isInteger(rawBudget) || rawBudget < 0) {
    throw new Error(`Invalid inline budget ${options.inlineBudget}`);
  }
  const plans = new Map();
  if (enabled && rawBudget > 0) {
    program.scopes.forEach((scope) => {
      const plan = createInlineExpressionPlan(scope, rawBudget);
      if (plan) plans.set(scope.id, plan);
    });
  }
  codegenStats.inlining = {
    enabled,
    budget: rawBudget,
    candidates: plans.size,
    callSites: 0,
    guardedCallSites: 0,
    instructionsInlined: 0,
    hostIntrinsicCallSites: 0,
    memberIntrinsicCallSites: 0,
  };
  return plans;
}

function createCodegenContext(scope, options, codegenStats) {
  const synthetic = inheritSynthetic(scope, options);
  const enabled = options.stackToLocal !== false &&
    (options.optimization === "O2" || options.optimization === "Os");
  const denseSwitch = options.denseSwitch !== false;
  const arityConstruct = options.arityConstruct !== false;
  let localKind = null;
  if (enabled && !scope.script && options.directVariableScopeIds.has(scope.id)) {
    localKind = "frame";
  } else if (enabled && scope.script && !options.evalScopeIds.has(scope.id) && !scope.instructions.some((instruction) =>
    DYNAMIC_LOCAL_OPERATIONS.has(instruction.op)
  )) {
    localKind = "global";
  }
  // Item 9: slot-provenance stamps ($q flags) are emitted for O2 frame
  // scopes only. Soundness shape matches local promotion: lightweight scopes
  // have no CLOSURE ops (so no descendant can write a slot through a
  // captured-locals render), no with/eval/catch (direct variable resolution),
  // and no sloppy arguments use in the scope itself; the mapped-arguments
  // proxy writes parameter slots directly, which the $f.argumentsInitialized
  // guard at write sites covers. Os stays untouched — the flags would cost
  // minified bytes against the size optimizer's purpose.
  const slotProvenance = options.slotProvenance !== false &&
    options.optimization === "O2" && localKind === "frame" && scope.lightweight;
  let provenanceSlots = null;
  if (slotProvenance) {
    provenanceSlots = options.provenanceSlotPlans && options.provenanceSlotPlans.get(scope.id);
    if (!provenanceSlots && options.provenanceSlotPlans) {
      // The plan is shared across regeneration attempts: tracked slots get
      // the flag; dropped slots were found to be written through the
      // mixed-path runtime helpers and are excluded permanently.
      provenanceSlots = { tracked: new Set(), dropped: new Set() };
      options.provenanceSlotPlans.set(scope.id, provenanceSlots);
    }
  }
  const variableKind = (name) => {
    if (name === "arguments" && scope.usesArguments) {
      return { kind: "arguments", ownerId: scope.id };
    }
    let depth = 1;
    for (let parentId = scope.parentId; parentId != null;) {
      const parent = options.scopesById.get(parentId);
      if (!parent) break;
      if (name === "arguments" && parent.usesArguments) {
        return { kind: "captured-arguments", depth, ownerId: parent.id };
      }
      const index = parent.variables.lastIndexOf(name);
      if (!parent.script && index >= 0) {
        return { kind: "captured", depth, index: index + 1, ownerId: parent.id };
      }
      if (!parent.script) depth += 1;
      parentId = parent.parentId;
    }
    return { kind: options.globalNames.has(name) ? "declared-global" : "global" };
  };
  const globalValueProducerOffsets = new Set(scope.instructions.flatMap((instruction) =>
    !instruction.elided && !instruction.unreachable &&
    instruction.optimized && instruction.optimized.kind === "reuse"
      ? [instruction.optimized.sourceOffset]
      : []
  ));
  return {
    enabled,
    directVariables: enabled && options.directVariableScopeIds.has(scope.id),
    bindingName(name) {
      let ownerId = null;
      if (!scope.script && scope.variables.lastIndexOf(name) >= 0) ownerId = scope.id;
      for (let parentId = scope.parentId; ownerId == null && parentId != null;) {
        const parent = options.scopesById.get(parentId);
        if (!parent) break;
        if (!parent.script && parent.variables.lastIndexOf(name) >= 0) ownerId = parent.id;
        parentId = parent.parentId;
      }
      const aliases = options.identifierAliases.get(ownerId);
      return aliases && aliases.has(name) ? aliases.get(name) : name;
    },
    perScopeFactories: options.perScopeFactories !== false,
    security: options.security || "sandbox",
    sourceMap: !!options.mapSettings,
    preserveSourceLocations: options.preserveSourceLocations === true,
    // Synthetic-source scopes (static eval bodies, dynamic Function
    // factories) carry LOC ops against their own text, not the root file.
    // Lexical descendants inherit the nearest synthetic ancestor's state via
    // inheritSynthetic: in source-map mode their LOC ops lower to a
    // virtual-source marker when a source descriptor exists, or to a reset
    // marker when the source is unknowable (runtime-dynamic eval) — never to
    // a plausible but incorrect root location. Their invocation sites remain
    // mapped to the caller's scope.
    syntheticScope: synthetic.kind === "reset",
    syntheticSource: synthetic.kind === "source" ? synthetic.entry : null,
    variableKind,
    writeProperty: scope.strict ? "$writeStrict" : "$writeSloppy",
    localKind,
    promotedLocals: options.promotedLocalPlans && options.promotedLocalPlans.get(scope.id) || null,
    usesThisWrites: false,
    slotProvenance,
    provenanceSlots,
    inlineGuestWrites: options.inlineGuestWrites !== false,
    inlineGuestInit: options.optimization === "O2" && options.inlineGuestInit !== false,
    inlineHostIntrinsics: options.optimization === "O2" && options.inlineHostIntrinsics !== false,
    inlineMemberIntrinsics: options.optimization === "O2" && options.inlineMemberIntrinsics !== false,
    foldLiteralChains: options.optimization === "O2" && options.foldLiteralChains !== false,
    deferBranchTest: options.deferBranchTest !== false,
    denseSwitch,
    arityConstruct,
    scope,
    stats: codegenStats.stackToLocal,
    instructionTemporaries: new Map(),
    // Item 15: GETPROP_S temps whose static key is a member intrinsic, mapped
    // to { name, receiver }. Keyed by temp name rather than attached to the
    // temp's origin so chained reads off the callee keep their mediated
    // semantics. A stale record is harmless — the CALL guard compares the
    // live callee value by identity.
    memberIntrinsicCallees: new Map(),
    // Item 15b: mirror of the runtime stack $s for flushed-operand recovery.
    // Entries are temp names from flush() or null for anonymous dispatch
    // results and exclusive branch values; the recovery only ever inspects
    // the tail, so placeholders and taints (null) both conservatively
    // disable it. O2 only — the recovery is O2-gated by inlineMemberIntrinsics.
    runtimeStack: options.optimization === "O2" ? [] : null,
    // Set while emitting if/else consequent/alternate blocks: the branch's
    // flushed values are exclusive (only the taken branch exists at
    // runtime), so flush() mirrors them as count-only placeholders and the
    // join correction drops the dead branch's share.
    branchExclusive: false,
    // Item 18: branch-test stack round-trip elimination. Branch emitters set
    // expectBranchTest to the END OFFSET of a test range; only the final
    // batch of that range (whose end matches the offset) may record the test
    // in pendingBranchTest instead of pushing it to $s — a nested region's
    // boundary ends a batch early, and matching by offset keeps those
    // sub-batch flushes honest (they push normally). The branch tests the
    // pending temp directly. Single-consumption by construction (the branch
    // pops the test), height-neutral (push+pop both skipped, mirror
    // untouched), gated on !chunkOpen for temp scope.
    expectBranchTest: false,
    pendingBranchTest: null,
    globalValueProducerOffsets,
    temporaryOrigins: new Map(),
    temporaryInstructions: new Map(),
    knownFunctionBindings: new Map(),
    inlining: codegenStats.inlining,
    inlinePlans: options.inlinePlans,
    sizeOptimized: options.optimization === "Os",
    sizeTemporarySlots: new Set(),
    temporary: 0,
    // Structured regions nest generated code in blocks; a temporary is only
    // lexically visible where it was emitted. The active region stack plus
    // the current chunk id is recorded per temporary so cross-block "reuse"
    // and inline-guard references can be rejected instead of emitting a
    // reference to an out-of-scope const.
    regionStack: [],
    temporaryRegions: new Map(),
    chunkId: 0,
    temporaryScope() {
      return this.regionStack.join("/") + "/c" + this.chunkId;
    },
    // A recorded scope is visible at the use site when it is a prefix of the
    // current stack: outer regions' consts remain in scope inside nested
    // blocks, but siblings and inner regions are not.
    temporaryVisible(recorded) {
      const recordedParts = recorded.split("/");
      const currentParts = this.temporaryScope().split("/");
      if (recordedParts.length > currentParts.length) return false;
      for (let index = 0; index < recordedParts.length; index += 1) {
        if (recordedParts[index] !== currentParts[index]) return false;
      }
      return true;
    },
  };
}

function emitScopePrologue(lines, context) {
  if (!context.enabled) return;
  lines.push("  const $s = $f.stack;");
  if (context.localKind === "frame") lines.push("  const $l = $f.locals;");
  if (context.promotedLocals && context.promotedLocals.size) {
    // Phase 2 promotes strict parameter slots: their initial values still
    // come from the call arguments, so promoted params are initialized from
    // $f.callArgs in the declaration — $exec only receives ($r, $f), while
    // $args lives in the enclosing factory closures. (The frame literal
    // keeps the slot for constructors and the arguments mapping, but nothing
    // reads it.)
    const declarations = Array.from(context.promotedLocals, (index) =>
      index <= context.scope.parameterCount
        ? `${promotedLocalName(context, index)} = $f.callArgs[${index - 1}]`
        : promotedLocalName(context, index)
    );
    lines.push(`  let ${declarations.join(", ")};`);
  }
  if (context.localKind === "global" || context.directVariables) lines.push("  const $g = $r.global;");
  if (!context.sizeOptimized && context.globalValueProducerOffsets.size) {
    lines.push(`  let ${Array.from(context.globalValueProducerOffsets, (offset) =>
      `$gv${context.scope.id}_${offset}`
    ).join(", ")};`);
  }
}

// Item 15b: apply a fallback dispatch's runtime-stack effect to the $s
// mirror. The runtime helper pops its operands from $s and pushes its result
// (the codegen later pops that via load()); the mirror does the same with
// temp names as flush entries and null as anonymous results. Ops whose pop
// shape is conditional (JCASE, NEXTITER) or unmodeled taint the mirror —
// recovery then stays disabled until the next flush re-arms it.
function applyDispatchedStackEffect(context, instruction) {
  const model = context.runtimeStack;
  if (!model) return;
  let pops;
  let net;
  if (instruction.optimized && instruction.optimized.kind === "drop-inputs") {
    // The optimized form REPLACES the dispatch with N bare pops.
    pops = instruction.optimized.count;
    net = -pops;
  } else {
    switch (instruction.op) {
      case "CALL": pops = instruction.args[0] + 2; net = -(instruction.args[0] + 1); break;
      case "NEW": pops = instruction.args[0] + 1; net = -instruction.args[0]; break;
      case "JCASE":
      case "NEXTITER":
        context.runtimeStack = null;
        return;
      default: {
        pops = DISPATCH_STACK_POPS[instruction.op];
        if (pops === undefined) {
          context.runtimeStack = null;
          return;
        }
        const spec = OpSpec.byName[instruction.op];
        net = spec && typeof spec.stack === "number" ? spec.stack : 0;
      }
    }
  }
  if (pops > model.length) {
    // The dispatch popped below the last flush (or the mirror under-counted);
    // the tail is no longer recoverable. Taint conservatively.
    context.runtimeStack = null;
    return;
  }
  model.length -= pops;
  for (let index = 0; index < pops + net; index += 1) model.push(null);
}

function emitStackToLocalRange(lines, scope, instructions, indent, context) {
  const stack = [];
  let reusableTemporary = 0;
  // Giant straight-line ranges (huge array literals) emit hundreds of
  // thousands of function-scope consts, which overflows V8's single-function
  // scope handling. Group them into transparent blocks, cut at flush points
  // where every pending temporary reference has been emitted.
  const CHUNK_CONSTS = 200;
  let chunkConsts = 0;
  let chunkOpen = false;

  // Collapse NEWARRAY + (literal-index, literal-value, INITPROP) chains and
  // NEWOBJECT + (STRING key, literal value, INITPROP) chains into native
  // array/object literals. Item 17 extends the fold recursively: a value may
  // be a fresh nested object/array temp whose own chain folds inline, so
  // data literals with object-valued properties emit as one native literal
  // instead of one guarded keyed store per property (giant data literals
  // otherwise emit one helper round-trip per element: hundreds of KB of
  // source become tens of MB of generated code that overflows V8's default
  // stack when first compiled, and each round-trip pays a
  // $prototypesHaveSetters() guard call + typeof probe + keyed store).
  //
  // Safety: a native literal defines own data properties (DefineOwnProperty
  // semantics), so inherited accessors or non-writable data properties cannot
  // affect it — the fold
  // is strictly more correct than the guard path, which is why no guard is
  // emitted for folded properties. The folded values are fresh unobserved
  // temps (write-once model-stack discipline), so the sandbox loses only
  // mediation that was a no-op, and `__proto__` keys never fold: native
  // literal syntax gives it Annex-B prototype-setting meaning while ES5.1
  // treats it as a plain property. Duplicate keys keep the last-wins
  // semantics of both the literal and the INITPROP sequence. A nested temp
  // folds only when its def chain is contiguous within the current fold and
  // its def offset is not a reuse/licm source or global value producer —
  // those instructions' consumers would still reference the temp name whose
  // const declaration the fold elides.
  const arrayLiteralRanges = new Map();
  const objectLiteralRanges = new Map();
  // Kill switch --no-fold-literal-chains: reproduce the exact pre-item-17
  // shape — the shallow fold (literal-valued props only) with every
  // remaining INITPROP on the guard+store path. Note the kill switch must
  // NOT disable the shallow fold: an entirely unfolded giant data literal
  // emits a $exec0 with tens of thousands of statements whose Turbofan
  // optimization explodes memory (the item-17 A/B lesson).
  if (!context.foldLiteralChains) {
    const literalOps = new Set(["INTEGER", "NUMBER", "STRING"]);
    for (let start = 0; start < instructions.length; start += 1) {
      const instruction = instructions[start];
      if (instruction.op !== "NEWARRAY" || instruction.elided || instruction.unreachable) continue;
      const elements = [];
      let cursor = start + 1;
      let matched = 0;
      while (true) {
        const key = instructions[cursor];
        if (!key || !["INTEGER", "NUMBER"].includes(key.op) || Number(key.args[0]) !== matched) break;
        const value = instructions[cursor + 1];
        if (!value || !literalOps.has(value.op)) break;
        const init = instructions[cursor + 2];
        if (!init || init.op !== "INITPROP") break;
        elements.push(jsLiteral(value.args[0]));
        cursor += 3;
        matched += 1;
      }
      if (matched > 0) {
        arrayLiteralRanges.set(instruction.offset, { source: `[${elements.join(", ")}]`, endIndex: cursor });
        start = cursor - 1;
      }
    }
    for (let start = 0; start < instructions.length; start += 1) {
      const instruction = instructions[start];
      if (instruction.op !== "NEWOBJECT" || instruction.elided || instruction.unreachable) continue;
      const entries = [];
      let cursor = start + 1;
      let matched = 0;
      while (true) {
        const key = instructions[cursor];
        if (!key || key.op !== "STRING") break;
        if (key.args[0] === "__proto__") break;
        const value = instructions[cursor + 1];
        if (!value || !isFoldableLiteralValue(value)) break;
        const init = instructions[cursor + 2];
        if (!init || init.op !== "INITPROP") break;
        entries.push(`${jsLiteral(key.args[0])}: ${literalOperand(value)}`);
        cursor += 3;
        matched += 1;
      }
      if (matched > 0) {
        objectLiteralRanges.set(instruction.offset, { source: `{ ${entries.join(", ")} }`, endIndex: cursor });
        start = cursor - 1;
      }
    }
  } else {
    const foldExcluded = new Set();
    for (const instruction of instructions) {
      if (instruction.optimized &&
          (instruction.optimized.kind === "reuse" || instruction.optimized.kind === "licm")) {
        foldExcluded.add(instruction.optimized.sourceOffset);
      }
    }

    // Resolves the literal chain starting at `offset`: a foldable literal op
    // (rendered directly), or a NEWOBJECT/NEWARRAY whose INITPROP chain folds
    // recursively. Returns { source, endCursor } where endCursor is the index
    // of the last consumed instruction, or null when the chain does not fold
    // (the caller keeps the runtime/guard path for the unmatched tail).
    function resolveLiteralChain(instructions, offset, depth) {
      const instruction = instructions[offset];
      if (!instruction || instruction.elided || instruction.unreachable) return null;
      // Proof sources must execute as named producers. Folding a currently
      // literal-valued source into an enclosing aggregate would leave its
      // later GVN/LICM consumer without the required temporary.
      if (foldExcluded.has(instruction.offset) ||
          context.globalValueProducerOffsets.has(instruction.offset)) return null;
      if (isFoldableLiteralValue(instruction)) {
        return { source: literalOperand(instruction), endCursor: offset };
      }
      if (depth >= 8 || (instruction.op !== "NEWOBJECT" && instruction.op !== "NEWARRAY")) return null;
      const cursor = offset + 1;
      if (instruction.op === "NEWARRAY") {
        const elements = [];
        let matched = 0;
        let position = cursor;
        while (true) {
          const key = instructions[position];
          if (!key || !["INTEGER", "NUMBER"].includes(key.op) || Number(key.args[0]) !== matched) break;
          const resolved = resolveLiteralChain(instructions, position + 1, depth + 1);
          if (!resolved) break;
          const init = instructions[resolved.endCursor + 1];
          if (!init || init.op !== "INITPROP") break;
          elements.push(resolved.source);
          position = resolved.endCursor + 2;
          matched += 1;
        }
        if (matched === 0) return null;
        return { source: `[${elements.join(", ")}]`, endCursor: position - 1 };
      }
      const entries = [];
      let matched = 0;
      let position = cursor;
      while (true) {
        const key = instructions[position];
        if (!key || key.op !== "STRING") break;
        if (key.args[0] === "__proto__") break;
        const resolved = resolveLiteralChain(instructions, position + 1, depth + 1);
        if (!resolved) break;
        const init = instructions[resolved.endCursor + 1];
        if (!init || init.op !== "INITPROP") break;
        entries.push(`${jsLiteral(key.args[0])}: ${resolved.source}`);
        position = resolved.endCursor + 2;
        matched += 1;
      }
      if (matched === 0) return null;
      return { source: `{ ${entries.join(", ")} }`, endCursor: position - 1 };
    }

    for (let start = 0; start < instructions.length; start += 1) {
      const instruction = instructions[start];
      if (instruction.elided || instruction.unreachable) continue;
      if (instruction.op === "NEWARRAY") {
        const resolved = resolveLiteralChain(instructions, start, 0);
        if (resolved && resolved.endCursor > start) {
          arrayLiteralRanges.set(instruction.offset, { source: resolved.source, endIndex: resolved.endCursor + 1 });
          start = resolved.endCursor;
        }
      } else if (instruction.op === "NEWOBJECT") {
        const resolved = resolveLiteralChain(instructions, start, 0);
        if (resolved && resolved.endCursor > start) {
          objectLiteralRanges.set(instruction.offset, { source: resolved.source, endIndex: resolved.endCursor + 1 });
          start = resolved.endCursor;
        }
      }
    }
  }

  function capturedLocal(variable) {
    return `${capturedFrame(variable)}.locals[${variable.index}]`;
  }

  function capturedFrame(variable) {
    return `$f.environment${".outer".repeat(variable.depth)}.frame`;
  }

  function temporary(expression, instruction = null, origin = null) {
    const globalValueProducer = instruction && !context.sizeOptimized &&
      context.globalValueProducerOffsets.has(instruction.offset);
    const name = globalValueProducer
      ? `$gv${scope.id}_${instruction.offset}`
      : context.sizeOptimized
        ? `$t${reusableTemporary++}`
        : `$v${scope.id}_${context.temporary++}`;
    if (context.sizeOptimized) {
      const reused = context.sizeTemporarySlots.has(name);
      context.sizeTemporarySlots.add(name);
      context.stats.sizeTemporaryAssignments += 1;
      if (reused) context.stats.sizeTemporaryReuses += 1;
      lines.push(`${indent}${name} = ${expression};`);
    } else if (globalValueProducer) {
      lines.push(`${indent}${name} = ${expression};`);
    } else {
      lines.push(`${indent}const ${name} = ${expression};`);
      chunkConsts += 1;
    }
    if (instruction && !context.instructionTemporaries.has(instruction.offset)) {
      context.instructionTemporaries.set(instruction.offset, name);
    }
    if (instruction) {
      context.temporaryRegions.set(name, context.temporaryScope());
      context.temporaryInstructions.set(name, instruction);
    }
    if (origin) context.temporaryOrigins.set(name, origin);
    return name;
  }

  function load() {
    if (stack.length) return stack.pop();
    context.stats.stackLoads += 1;
    // The popped value is a dispatch result sitting on $s; mirror the pop.
    if (context.runtimeStack) context.runtimeStack.pop();
    return temporary("$s.pop()");
  }

  function flush(deferBranchTest = false) {
    if (!stack.length) return;
    if (deferBranchTest && context.deferBranchTest && !context.sizeOptimized && !chunkOpen && stack.length === 1) {
      // Item 18: the branch test already sits in a single in-scope temp —
      // test it directly instead of the $s.push/$s.pop round-trip. Height-
      // neutral (both sides skipped, mirror untouched), single-consumption
      // (the branch is the only reader of a test value), and gated on
      // !chunkOpen so the temp's const stays in scope at the branch site.
      context.pendingBranchTest = stack[0];
      stack.length = 0;
      return;
    }
    lines.push(`${indent}$s.push(${stack.join(", ")});`);
    context.stats.stackStores += stack.length;
    // Mirror the flush. A tainted mirror (null) re-arms here: the flushed
    // entries sit on top of whatever unknown state preceded, and the recovery
    // only ever inspects the tail above it.
    const model = context.runtimeStack;
    if (model) {
      if (context.branchExclusive) {
        // Exclusive branch exit: the flushed values exist only if this
        // branch is taken, so the mirror records the count with
        // placeholders; the join correction pops the dead branch's share.
        for (let index = 0; index < stack.length; index += 1) model.push(null);
      } else {
        model.push(...stack);
      }
    } else {
      context.runtimeStack = stack.slice();
    }
    stack.length = 0;
    if (context.sizeOptimized) reusableTemporary = 0;
    if (chunkConsts >= CHUNK_CONSTS) {
      chunkConsts = 0;
      context.chunkId += 1;
      if (chunkOpen) lines.push(`${indent}}`);
      lines.push(`${indent}{`);
      chunkOpen = true;
    }
  }

  function direct(instruction) {
    if (context.security === "sandbox" && SANDBOX_MEDIATED_OPS.has(instruction.op)) {
      return false;
    }
    context.stats.instructions += 1;
    context.stats.helpersAvoided += 1;

    if (instruction.optimized && instruction.optimized.kind === "reuse") {
      const source = context.instructionTemporaries.get(instruction.optimized.sourceOffset);
      if (!source) {
        throw new Error(
          `Invalid reuse source ${instruction.optimized.sourceOffset} at ${instruction.offset} in scope ${scope.id}`
        );
      }
      // Reuse pairs are dominance-guaranteed by the optimizer, so the
      // producing temporary is always lexically visible; only the inline
      // guard below needs the cross-block visibility check.
      stack.push(source);
      return true;
    }
    if (instruction.optimized && instruction.optimized.kind === "licm") {
      stack.push(`$h${scope.id}_${instruction.optimized.sourceOffset}`);
      return true;
    }

    if (instruction.optimized && instruction.optimized.kind === "literal") {
      stack.push(temporary(jsLiteral(instruction.optimized.value), instruction));
      return true;
    }
    if (instruction.optimized && instruction.optimized.kind === "duplicate") {
      if (!stack.length) return false;
      stack.push(stack[stack.length - 1]);
      return true;
    }
    if (instruction.optimized && instruction.optimized.kind === "drop-inputs") {
      for (let index = 0; index < instruction.optimized.count; index += 1) load();
      return true;
    }

    switch (instruction.op) {
      case "INTEGER":
      case "NUMBER":
      case "STRING":
        stack.push(recordWriteTemp(context, temporary(jsLiteral(instruction.args[0])), instruction));
        return true;
      case "UNDEF":
        stack.push(recordWriteTemp(context, temporary("void 0"), instruction));
        return true;
      case "NULL":
        stack.push(recordWriteTemp(context, temporary("null"), instruction));
        return true;
      case "TRUE":
        stack.push(recordWriteTemp(context, temporary("true"), instruction));
        return true;
      case "FALSE":
        stack.push(recordWriteTemp(context, temporary("false"), instruction));
        return true;
      case "THIS":
        // The sandbox write path can skip writeTarget resolution for writes
        // to the call receiver when the frame-stamped thisIsGuest flag says
        // writeTarget(this) is a provable no-op (see SETPROP below).
        stack.push(temporary("$f.thisValue", instruction, { kind: "this-value" }));
        return true;
      case "CURRENT":
        stack.push(temporary("$f.currentFunction"));
        return true;
      case "CLOSURE": {
        if (!context.perScopeFactories) return false;
        const nested = instruction.args[0];
        stack.push(temporary(
          `$make${nested.id}($r, $f.environment)`,
          instruction,
          { kind: "closure", identity: null, scopeId: nested.id }
        ));
        context.temporaryOrigins.get(stack[stack.length - 1]).identity = stack[stack.length - 1];
        return true;
      }
      case "NEWARRAY":
        stack.push(temporary("[]", instruction, { kind: "guest-object" }));
        return true;
      case "NEWOBJECT":
        stack.push(temporary("{}", instruction, { kind: "guest-object" }));
        return true;
      case "NEWREGEXP":
        stack.push(temporary(`new RegExp(${jsLiteral(instruction.args[0])}, ${jsLiteral(instruction.args[1])})`, instruction, { kind: "guest-object" }));
        return true;
      case "LOC": {
        // Source-map mode lowers LOC to a private marker; the position is
        // consumed by the finalizer at compile time, so no runtime write is
        // emitted unless preserveSourceLocations was also requested.
        const [sourceLine, sourceColumn] = instruction.args;
        if (context.sourceMap) {
          lines.push(markerForLocation(context, sourceLine, sourceColumn));
        }
        if (context.preserveSourceLocations) {
          lines.push(`${indent}$f.line = ${jsLiteral(sourceLine)}; $f.column = ${jsLiteral(sourceColumn)};`);
        }
        return true;
      }
      case "DEBUGGER":
        lines.push(`${indent}debugger;`);
        return true;
      case "POP":
        load();
        return true;
      case "DUP":
        if (!stack.length) return false;
        stack.push(stack[stack.length - 1]);
        return true;
      case "DUP2":
        if (stack.length < 2) return false;
        stack.push(stack[stack.length - 2], stack[stack.length - 1]);
        return true;
      case "ROT2":
      case "ROT3":
      case "ROT4": {
        const count = Number(instruction.op.slice(3));
        if (stack.length < count) return false;
        const values = stack.splice(stack.length - count, count);
        values.unshift(values.pop());
        stack.push(...values);
        return true;
      }
      case "GETLOCAL":
      case "GETLOCAL2": {
        if (!context.localKind) return false;
        const index = instruction.args[0];
        const promoted = context.promotedLocals && context.promotedLocals.has(index);
        if (promoted) context.stats.promotedLoads += 1;
        const expression = promoted
          ? promotedLocalName(context, index)
          : context.localKind === "frame"
            ? `$l[${index}]`
            : `$g[${jsLiteral(scope.variables[index - 1])}]`;
        const knownFunction = context.knownFunctionBindings.get(index);
        // The guest-object provenance pass marks GETLOCAL loads that provably
        // hold guest-created objects; sandbox property writes to them can
        // skip writeTarget resolution. Otherwise, in a provenance-eligible
        // scope the load records the slot itself: write sites keyed to a
        // tracked slot consult its $q flag instead of resolving writeTarget
        // per write (the flag is classified at stores — see SETLOCAL).
        const origin = knownFunction
          ? { kind: "known-function", identity: knownFunction.identity, scopeId: knownFunction.scopeId }
          : instruction.guestObjectOutput
            ? { kind: "guest-object" }
            : context.slotProvenance
              ? { kind: "guest-slot", index }
              : null;
        stack.push(temporary(expression, instruction, origin));
        return true;
      }
      case "SETLOCAL":
      case "SETLOCAL2": {
        if (!context.localKind || !stack.length) return false;
        const index = instruction.args[0];
        const value = stack[stack.length - 1];
        if (context.localKind === "frame") {
          if (context.promotedLocals && context.promotedLocals.has(index)) {
            context.stats.promotedStores += 1;
            lines.push(`${indent}${promotedLocalName(context, index)} = ${value};`);
          } else {
            lines.push(`${indent}$l[${index}] = ${value};`);
          }
        } else {
          lines.push(`${indent}${context.writeProperty}($g, ${jsLiteral(scope.variables[index - 1])}, ${value});`);
        }
        const origin = context.temporaryOrigins.get(value);
        if (origin && origin.kind === "closure") {
          context.knownFunctionBindings.set(index, origin);
        } else {
          context.knownFunctionBindings.delete(index);
        }
        // Item 9: a store to a tracked slot reclassifies its $q flag. Values
        // with static guest provenance (created by guest code, never wrappers
        // or protected intrinsics) classify to the constant true; everything
        // else resolves at runtime, exactly as writeTarget would.
        if (context.provenanceSlots && context.provenanceSlots.tracked.has(index)) {
          const unmediated = origin && (origin.kind === "guest-object" ||
            origin.kind === "closure" || origin.kind === "known-function");
          lines.push(`${indent}${provenanceFlag(context, index)} = ${unmediated
            ? "true"
            : `$r.boundary.isUnmediatedWriteTarget(${value})`};`);
        }
        return true;
      }
      case "HASVAR":
        if (!context.directVariables) return false;
        {
          const variable = context.variableKind(instruction.args[0]);
          if (variable.kind === "arguments") {
            stack.push(temporary("$getArguments($r, $f)"));
          } else if (variable.kind === "captured-arguments") {
            stack.push(temporary(`$getArguments($r, ${capturedFrame(variable)})`));
          } else if (variable.kind === "captured") {
            stack.push(temporary(capturedLocal(variable)));
          } else if (variable.kind === "declared-global") {
            stack.push(temporary(`$g[${jsLiteral(instruction.args[0])}]`));
          } else {
            stack.push(temporary(`$readGlobal($g, ${jsLiteral(instruction.args[0])}, false)`));
          }
        }
        return true;
      case "GETVAR":
        if (!context.directVariables) return false;
        {
          const variable = context.variableKind(instruction.args[0]);
          if (variable.kind === "arguments") {
            stack.push(temporary("$getArguments($r, $f)"));
          } else if (variable.kind === "captured-arguments") {
            stack.push(temporary(`$getArguments($r, ${capturedFrame(variable)})`));
          } else if (variable.kind === "captured") {
            stack.push(temporary(capturedLocal(variable)));
          } else if (variable.kind === "declared-global") {
            stack.push(temporary(`$g[${jsLiteral(instruction.args[0])}]`, null,
              HOST_INTRINSIC_NAMES.has(instruction.args[0])
                ? { kind: "host-intrinsic", name: instruction.args[0] }
                : null));
          } else {
            stack.push(temporary(`$readGlobal($g, ${jsLiteral(instruction.args[0])}, true)`, null,
              HOST_INTRINSIC_NAMES.has(instruction.args[0])
                ? { kind: "host-intrinsic", name: instruction.args[0] }
                : null));
          }
        }
        return true;
      case "SETVAR":
        if (!context.directVariables || !stack.length) return false;
        {
          const variable = context.variableKind(instruction.args[0]);
          if (variable.kind === "arguments") {
            lines.push(`${indent}$setArguments($f, ${stack[stack.length - 1]});`);
          } else if (variable.kind === "captured-arguments") {
            lines.push(`${indent}$setArguments(${capturedFrame(variable)}, ${stack[stack.length - 1]});`);
          } else if (variable.kind === "captured") {
            lines.push(`${indent}${capturedLocal(variable)} = ${stack[stack.length - 1]};`);
          } else if (variable.kind === "declared-global") {
            lines.push(`${indent}${context.writeProperty}($g, ${jsLiteral(instruction.args[0])}, ${stack[stack.length - 1]});`);
          } else {
            lines.push(`${indent}$writeGlobal($f, $g, ${jsLiteral(instruction.args[0])}, ${stack[stack.length - 1]});`);
          }
        }
        return true;
      case "DELVAR":
        if (!context.directVariables) return false;
        {
          const variable = context.variableKind(instruction.args[0]);
          stack.push(temporary(["arguments", "captured-arguments", "captured"].includes(variable.kind)
            ? "false"
            : `$deleteGlobal($g, ${jsLiteral(instruction.args[0])})`));
        }
        return true;
      case "GETPROP": {
        const key = load();
        const object = load();
        // Mediated results carry wrappers whose surface differs from the raw
        // target; reads chained off them must stay mediated. Non-direct
        // scopes resolve bindings through boundary.get, so every read there
        // stays mediated too (O0-equivalent semantics).
        const mediated = context.security === "sandbox" && (
          !context.directVariables ||
          (context.temporaryOrigins.get(object) || {}).kind === "mediated"
        );
        const expression = context.security === "sandbox"
          ? (mediated ? `$getSandbox($r, ${object}, ${key})` : sandboxPropertyRead(object, key))
          : `${object}[${key}]`;
        stack.push(temporary(
          expression,
          instruction,
          context.security === "sandbox" ? { kind: "mediated" } : null
        ));
        return true;
      }
      case "GETPROP_S": {
        const object = load();
        const staticName = instruction.args[0];
        const baseMediated = context.security === "sandbox" && (
          !context.directVariables ||
          (context.temporaryOrigins.get(object) || {}).kind === "mediated"
        );
        const mediated = baseMediated ||
          (context.security === "sandbox" && SANDBOX_SENSITIVE_PROPERTY_NAMES.includes(staticName));
        const expression = context.security === "sandbox"
          ? (mediated ? `$getSandbox($r, ${object}, ${jsLiteral(staticName)})` : `${object}[${jsLiteral(staticName)}]`)
          : `${object}[${jsLiteral(staticName)}]`;
        const temp = temporary(
          expression,
          instruction,
          context.security === "sandbox" && mediated ? { kind: "mediated" } : null
        );
        // Item 15: record raw (unmediated) reads of the member intrinsics so
        // the CALL case can identity-guard them. Mediated reads are excluded
        // — their callee may be a wrapper, which can never match the raw
        // prototype identity anyway.
        if (context.inlineMemberIntrinsics && context.security === "sandbox" &&
            !mediated && MEMBER_INTRINSIC_NAMES.has(staticName)) {
          context.memberIntrinsicCallees.set(temp, { name: staticName, receiver: object });
        }
        stack.push(temp);
        return true;
      }
      case "SETPROP": {
        const value = load();
        const key = load();
        const object = load();
        if (context.security === "sandbox") {
          // Guest-created objects (literals, closures, and provenance-marked
          // locals) are never wrappers or protected intrinsics, so writeTarget
          // resolution is a provable no-op; the slim helper keeps value
          // securing and the strict/sloppy writer semantics.
          const origin = context.temporaryOrigins.get(object);
          const guestObject = origin && (origin.kind === "guest-object" ||
            origin.kind === "closure" || origin.kind === "known-function");
          // A write to the call receiver is classified once per call: the
          // frame stamp records whether writeTarget($this) is a no-op, so the
          // per-write resolution can be skipped whenever it is. The stamp is
          // computed on the same secured, boxed receiver the write path sees,
          // and the underlying WeakMaps are monotone with respect to it, so
          // the ternary is exact — never a stale fast guess.
          if (origin && origin.kind === "guest-slot") {
            emitProvenanceWriteSite(lines, indent, context, origin, object, key, value);
          } else if (origin && origin.kind === "this-value") {
            context.usesThisWrites = true;
            const guest = guestWriteExpression(context, object, key, value) ||
              `$setGuest($r, $f, ${object}, ${key}, ${value})`;
            lines.push(`${indent}($f.thisIsGuest ? ${guest} : $setSandbox($r, ${context.writeProperty}, ${object}, ${key}, ${value}));`);
          } else {
            // Only provably-guest receivers may inline the write: the
            // guest-slot and this-value branches above are classification-
            // gated, and here guestObject marks guest-created objects. Any
            // other receiver (globals, mediated reads, protected intrinsics)
            // keeps the full $setSandbox path — writeTarget resolution is
            // exactly what blocks `Math.polluted = 1`-shaped attacks.
            lines.push(guestObject
              ? `${indent}${guestWriteExpression(context, object, key, value) || `$setGuest($r, $f, ${object}, ${key}, ${value})`};`
              : `${indent}$setSandbox($r, ${context.writeProperty}, ${object}, ${key}, ${value});`);
          }
        } else {
          lines.push(`${indent}${context.writeProperty}(${object}, ${key}, ${value});`);
        }
        stack.push(value);
        return true;
      }
      case "SETPROP_S": {
        const value = load();
        const object = load();
        if (context.security === "sandbox") {
          const origin = context.temporaryOrigins.get(object);
          const guestObject = origin && (origin.kind === "guest-object" ||
            origin.kind === "closure" || origin.kind === "known-function");
          const key = jsLiteral(instruction.args[0]);
          if (origin && origin.kind === "guest-slot") {
            emitProvenanceWriteSite(lines, indent, context, origin, object, key, value);
          } else if (origin && origin.kind === "this-value") {
            context.usesThisWrites = true;
            const guest = guestWriteExpression(context, object, key, value) ||
              `$setGuest($r, $f, ${object}, ${key}, ${value})`;
            lines.push(`${indent}($f.thisIsGuest ? ${guest} : $setSandbox($r, ${context.writeProperty}, ${object}, ${key}, ${value}));`);
          } else {
            // Only provably-guest receivers may inline the write: the
            // guest-slot and this-value branches above are classification-
            // gated, and here guestObject marks guest-created objects. Any
            // other receiver (globals, mediated reads, protected intrinsics)
            // keeps the full $setSandbox path — writeTarget resolution is
            // exactly what blocks `Math.polluted = 1`-shaped attacks.
            lines.push(guestObject
              ? `${indent}${guestWriteExpression(context, object, key, value) || `$setGuest($r, $f, ${object}, ${key}, ${value})`};`
              : `${indent}$setSandbox($r, ${context.writeProperty}, ${object}, ${key}, ${value});`);
          }
        } else {
          lines.push(`${indent}${context.writeProperty}(${object}, ${jsLiteral(instruction.args[0])}, ${value});`);
        }
        stack.push(value);
        return true;
      }
      case "CALL": {
        const count = instruction.args[0];
        if (scope.dynamicFunctions.length || stack.length < count + 2) {
          // Item 15b: a control-flow region between the operand pushes and
          // the CALL (e.g. a ternary inside an object-literal argument)
          // flushed the operands onto $s as materialized consts. The $s
          // mirror tracks that tail; when it is exactly this call's operands,
          // emit the same inline the stack path would and trim $s in place
          // of the dispatch.
          if (!scope.dynamicFunctions.length &&
              recoverFlushedIntrinsicCall(instruction, count)) return true;
          return false;
        }
        const args = stack.splice(stack.length - count, count);
        const thisValue = stack.pop();
        const callable = stack.pop();
        if (emitIntrinsicCallInline(callable, thisValue, args)) return true;
        if (context.security === "sandbox") {
          // Arity-specialized dispatch: the callee-side variant matches the
          // static argument count, so guest calls never allocate an args
          // array (the fast path forwards fixed arguments via the captured
          // Function.prototype.call). Arities above the specialized range
          // fall back to the generic array form.
          const callHelper = args.length <= 5
            ? `$applySandbox${args.length}`
            : "$applySandbox";
          const callArgs = args.length <= 5
            ? (args.length ? `, ${args.join(", ")}` : "")
            : `, [${args.join(", ")}]`;
          stack.push(temporary(`${callHelper}($r, ${callable}, ${thisValue}${callArgs})`));
          return true;
        }
        const origin = context.temporaryOrigins.get(callable);
        const inlinePlan = origin && context.inlinePlans.get(origin.scopeId);
        // The identity guard references the closure temporary by name; when
        // that temporary was emitted in an enclosing region's block it is
        // out of scope here, so fall back to the runtime call.
        const identityVisible = inlinePlan && origin &&
          context.temporaryVisible(context.temporaryRegions.get(origin.identity));
        if (inlinePlan && identityVisible) {
          const checks = [`${callable} === ${origin.identity}`];
          if (inlinePlan.requiresNumbers) {
            for (let index = 0; index < inlinePlan.parameterCount; index += 1) {
              const argument = args[index];
              checks.push(argument ? `typeof ${argument} === "number"` : "false");
            }
          }
          const fallback = `$apply($r, $f, ${callable}, ${thisValue}, [${args.join(", ")}])`;
          const expression = `(${checks.join(" && ")} ? ${inlinePlan.render(args)} : ${fallback})`;
          stack.push(temporary(expression));
          context.inlining.callSites += 1;
          context.inlining.guardedCallSites += 1;
          context.inlining.instructionsInlined += inlinePlan.instructionCount;
        } else {
          stack.push(temporary(`$apply($r, $f, ${callable}, ${thisValue}, [${args.join(", ")}])`));
        }
        return true;
      }
      case "NEW": {
        const count = instruction.args[0];
        if (scope.dynamicFunctions.length || stack.length < count + 1) return false;
        const args = stack.splice(stack.length - count, count);
        const constructor = stack.pop();
        // The provenance pass marks NEWs whose constructor is pinned to a
        // return-safe guest closure: the result is always a fresh guest
        // object, so property writes to it can skip writeTarget resolution.
        let expression;
        if (context.security === "sandbox") {
          if (context.arityConstruct) {
            // Arity-specialized dispatch, the `new` analog of the CALL fast
            // path: the callee-side variant matches the static argument
            // count, so guest constructions never allocate an args array
            // (the fast path invokes the compiled closure through host `new`
            // with fixed arguments). Arities above the specialized range
            // fall back to the generic array form.
            const constructHelper = args.length <= 5
              ? `$constructSandbox${args.length}`
              : "$constructSandbox";
            const constructArgs = args.length <= 5
              ? (args.length ? `, ${args.join(", ")}` : "")
              : `, [${args.join(", ")}]`;
            expression = `${constructHelper}($r, ${constructor}${constructArgs})`;
          } else {
            expression = `$constructSandbox($r, ${constructor}, [${args.join(", ")}])`;
          }
        } else if (context.arityConstruct && /^[$A-Za-z_][\w$]*(\.[$A-Za-z_][\w$]*|\[\d+\])*$/.test(constructor)) {
          // Trusted mode has no boundary: host `new` on the constructor
          // expression is exactly Reflect.construct(constructor, args) (same
          // [[Construct]], newTarget = constructor, same TypeError for
          // non-constructors), so the helper call and the args array are
          // both unnecessary. Only simple identifier / member / index
          // callees inline; anything else keeps the runtime path.
          expression = `new ${constructor}(${args.join(", ")})`;
        } else {
          expression = `$construct(${constructor}, [${args.join(", ")}])`;
        }
        stack.push(temporary(
          expression,
          instruction,
          context.security === "sandbox" && instruction.guestObjectOutput
            ? { kind: "guest-object" }
            : null
        ));
        return true;
      }
      case "POSTINC":
      case "POSTDEC": {
        const value = load();
        const numeric = temporary(`+${value}`);
        const updated = temporary(`${numeric} ${instruction.op === "POSTINC" ? "+" : "-"} 1`);
        stack.push(updated, numeric);
        return true;
      }
      default:
        break;
    }

    const spec = OpSpec.byName[instruction.op];
    // instanceof resolves wrappers through the boundary so the prototype walk
    // sees the raw target, matching O0's RuntimeInstance.instanceOf.
    if (context.security === "sandbox" && spec && spec.helper === "instanceOf") {
      const right = load();
      const left = load();
      stack.push(temporary(`(${left} instanceof $instanceOfTarget($r, ${right}))`));
      return true;
    }
    const unary = NATIVE_UNARY_EXPRESSIONS[spec.helper];
    if (unary) {
      stack.push(recordWriteTemp(context, temporary(unary(load())), instruction));
      return true;
    }
    const operator = NATIVE_BINARY_OPERATORS[spec.helper];
    if (operator) {
      const right = load();
      const left = load();
      stack.push(recordWriteTemp(context, temporary(`(${left} ${operator} ${right})`), instruction));
      return true;
    }
    return false;
  }

  // Item 14/15 shared inline emission, used by both the stack path (operands
  // popped off the codegen stack) and the item-15b recovery path (operands
  // recovered by name from the $s mirror). Returns true when the call was
  // inlined; the caller then treats the call as fully emitted.
  function emitIntrinsicCallInline(callable, thisValue, args) {
    // Item 14 (sandbox): identifier calls of the five host intrinsics
    // inline into a direct call. The callee is the live GETVAR read, so
    // guest redefinitions of the global binding are honored exactly like
    // the fallback — no capture, no shadow flag. All five are pure and
    // return primitives, so the direct call is observationally identical
    // to the boundary dispatch; the one divergence is an ambient host
    // object reaching the intrinsic through an argument, which the
    // sandbox probe routes to the fallback (the boundary would reject it
    // the same way).
    // Sandbox-only (measured 2026-08-24): the trusted $apply chain is
    // already fully optimized by V8 (inlined applyValue → escaped args
    // array → direct call), so the inline's per-site win there is tiny
    // and the shape change perturbs the enclosing functions' V8
    // optimization — trusted Typescript measured −6..−7% across three
    // interleaved runs (11 rounds) while all four of its site shapes won
    // +15..27% in isolation; sandbox is the mirror image (boundary.call →
    // callHost → secureArguments → applyHost is genuinely expensive;
    // sandbox Typescript measured +22.8% median), so the inline fires in
    // sandbox only and trusted keeps $apply.
    const calleeOrigin = context.temporaryOrigins.get(callable);
    const thisValueInstruction = context.temporaryInstructions.get(thisValue);
    if (context.inlineHostIntrinsics && context.security === "sandbox" &&
        calleeOrigin &&
        calleeOrigin.kind === "host-intrinsic" &&
        HOST_INTRINSIC_NAMES.has(calleeOrigin.name) &&
        thisValueInstruction && thisValueInstruction.op === "UNDEF") {
      const callHelper = args.length <= 5 ? `$applySandbox${args.length}` : "$applySandbox";
      const callArgs = args.length <= 5
        ? (args.length ? `, ${args.join(", ")}` : "")
        : `, [${args.join(", ")}]`;
      const fallback = `${callHelper}($r, ${callable}, ${thisValue}${callArgs})`;
      if (args.length) {
        if (args.length > 5) {
          // No sanitizing helper above arity 5; these sites are cold, so
          // keep the boundary dispatch.
          stack.push(temporary(fallback));
        } else {
          const probes = args.map((argument) =>
            `typeof ${argument} === "object" && ${argument} !== null && ` +
            `$r.boundary.ambientValues.has(${argument})`);
          // The direct arm runs the checked callee through the
          // sanitizing $hostCallN helper: String/Number arguments with
          // throwing ToPrimitive methods would otherwise surface a raw
          // host error (different class, host stack) where the boundary
          // throws a sanitized one. The helper is a module const binding
          // that V8 inlines into the site, and its inner
          // Function.prototype.call folds into a direct call, so the
          // per-site cost is the same as the bare variable call.
          stack.push(temporary(`(${probes.join(" || ")} ? ${fallback} : $hostCall${args.length}(${callable}, ${thisValue}${args.length ? `, ${args.join(", ")}` : ""}))`));
        }
      } else {
        // Zero-argument forms (isNaN(), String(), ...) cannot throw —
        // no ToPrimitive coercion on a missing first argument — so the
        // bare variable call stays. A variable callee passes undefined
        // this, and the variable call keeps normal call feedback (3.4%
        // better than the (0, f)() sequence-expression shape on the
        // first Typescript pass).
        stack.push(temporary(`${callable}()`));
      }
      context.inlining.hostIntrinsicCallSites += 1;
      return true;
    }
    // Item 15 (sandbox): member calls of the hot host prototype functions
    // inline into a direct Function.prototype.call. GETPROP_S recorded
    // the callee temp in memberIntrinsicCallees with its receiver temp;
    // requiring thisValue to be that exact temp pins the member-call
    // shape (the frontend reuses the receiver temp as the member-call
    // this). The guard compares the live-resolved callee by identity
    // against the imported raw prototype functions, so a guest own
    // property, prototype redefinition, or wrapper routes to the
    // fallback; the direct arm never re-reads the member, so accessor
    // side effects run exactly once like the boundary read. The direct
    // arm is the sanitizing $hostCallN helper with the checked callee
    // and the recorded receiver as this — the receiver is the exact
    // object the member call would run against, and the helper's
    // Function.prototype.call folds into a direct call under V8's
    // call-apply elimination.
    // The probes mirror the boundary's dispatch exactly: the pure
    // members (join, charAt, indexOf, slice, replace, test) get no
    // receiver inspection from callHost, so only ambient arguments route
    // to the fallback (an ambient function argument — replace's callback
    // — would run unmediated in the direct arm, where the boundary would
    // wrap it); the mutating members (push, sort) additionally route
    // protected receivers to the fallback, where assertMutable throws —
    // the read-only members skip the protected probe because the
    // boundary classifies them pure and lets them run on protected
    // receivers (test mutates lastIndex and still passes). No ambient
    // receiver probe: the boundary has none.
    const memberCallee = context.inlineMemberIntrinsics &&
      context.memberIntrinsicCallees.get(callable);
    if (context.security === "sandbox" && memberCallee &&
        thisValue === memberCallee.receiver && args.length <= 5) {
      const probes = [`(${MEMBER_INTRINSIC_GUARDS[memberCallee.name].map((anchor) => `${callable} !== ${anchor}`).join(" && ")})`];
      for (const argument of args) {
        probes.push(`typeof ${argument} === "object" && ${argument} !== null && ` +
          `$r.boundary.ambientValues.has(${argument})`);
      }
      if (MUTATING_MEMBER_INTRINSICS.has(memberCallee.name)) {
        probes.push(`$r.boundary.protectedValues.has(${thisValue})`);
      }
      const callHelper = args.length <= 5 ? `$applySandbox${args.length}` : "$applySandbox";
      const callArgs = args.length <= 5
        ? (args.length ? `, ${args.join(", ")}` : "")
        : `, [${args.join(", ")}]`;
      const fallback = `${callHelper}($r, ${callable}, ${thisValue}${callArgs})`;
      // Direct arm through the sanitizing $hostCallN helper: a throwing
      // intrinsic (test on a non-regexp receiver, a throwing sort
      // comparator) must surface the same sanitized error the boundary
      // throws, not a raw host error with its stack.
      const direct = `$hostCall${args.length}(${callable}, ${thisValue}${args.length ? `, ${args.join(", ")}` : ""})`;
      stack.push(temporary(`(${probes.join(" || ")} ? ${fallback} : ${direct})`));
      context.inlining.memberIntrinsicCallSites += 1;
      return true;
    }
    return false;
  }

  // Item 15b: a control region between the operand pushes and the CALL
  // flushed the operands onto $s as materialized consts, so the stack path
  // above never sees them. The $s mirror knows them by name. The runtime
  // indexes the call's operands from the END of $s (callableIndex =
  // length - count - 2), so the mirror tail is checked the same way — a
  // stale prefix is expected (e.g. an initProperty keeping the target
  // object on $s for a following member call) and stays below the trim.
  // Conservative by construction: the recorded member callee must sit at
  // the exact runtime index and the receiver must match its record, so a
  // drifted mirror (a mis-table'd dispatch pop) can only cause a miss,
  // never a false recovery. When it fires, emit the same inline and trim $s
  // in place of the dispatch. The inline evaluates the temps by name, so
  // the trim may follow the const emission; the $s.length assignment keeps
  // the frame's references hooks in lockstep exactly like the runtime's own
  // call trim.
  function recoverFlushedIntrinsicCall(instruction, count) {
    const model = context.runtimeStack;
    if (!model) return false;
    const callableIndex = model.length - count - 2;
    if (callableIndex < 0) return false;
    const callable = model[callableIndex];
    const thisValue = model[callableIndex + 1];
    if (typeof callable !== "string" || typeof thisValue !== "string") return false;
    for (let index = callableIndex + 2; index < model.length; index += 1) {
      if (typeof model[index] !== "string") return false;
    }
    if (!emitIntrinsicCallInline(callable, thisValue, model.slice(callableIndex + 2))) return false;
    lines.push(`${indent}$s.length -= ${count + 2};`);
    model.length = callableIndex;
    return true;
  }

  for (let loopIndex = 0; loopIndex < instructions.length; loopIndex += 1) {
    const instruction = instructions[loopIndex];
    const arrayLiteral = arrayLiteralRanges.get(instruction.offset);
    if (arrayLiteral) {
      stack.push(temporary(arrayLiteral.source, instruction, { kind: "guest-object" }));
      loopIndex = arrayLiteral.endIndex - 1;
      continue;
    }
    const objectLiteral = objectLiteralRanges.get(instruction.offset);
    if (objectLiteral) {
      stack.push(temporary(objectLiteral.source, instruction, { kind: "guest-object" }));
      loopIndex = objectLiteral.endIndex - 1;
      continue;
    }
    if (instruction.op === "RETURN") {
      const value = load();
      lines.push(`${indent}return ${value};`);
      continue;
    }
    if (instruction.op === "THROW") {
      const value = load();
      lines.push(`${indent}throw ${value};`);
      continue;
    }
    if (instruction.op === "INITPROP" && emitInlineInitProperty(lines, indent, context, stack)) {
      context.stats.instructions += 1;
      context.stats.helpersAvoided += 1;
      continue;
    }
    const instructionCount = context.stats.instructions;
    const helperCount = context.stats.helpersAvoided;
    if (direct(instruction)) {
      if (context.sizeOptimized && stack.length === 0) reusableTemporary = 0;
      continue;
    }
    context.stats.instructions = instructionCount;
    context.stats.helpersAvoided = helperCount;
    flush();
    lines.push(`${indent}${callForInstruction(instruction, context)}`);
    applyDispatchedStackEffect(context, instruction);
    if (!context.sizeOptimized && context.globalValueProducerOffsets.has(instruction.offset)) {
      if (context.runtimeStack) context.runtimeStack.pop();
      stack.push(temporary("$s.pop()", instruction));
    }
  }
  // Item 18: the final batch of an armed test range may defer the branch
  // test (a single in-scope temp) instead of pushing it to $s; the caller's
  // branchValue consumes the pending value. The flag is matched to this
  // batch's end offset (the last instruction's end — HIR offsets are
  // contiguous, so this equals the batch end unless trailing instructions
  // were elided, which falls back conservatively) so sub-batch flushes
  // inside nested regions push normally; the flag is cleared whenever the
  // armed range ends, whether or not the deferral fired.
  const rangeEnd = instructions.length ? instructions[instructions.length - 1].end : -1;
  if (context.expectBranchTest === rangeEnd) {
    flush(true);
    context.expectBranchTest = false;
  } else {
    flush();
  }
  if (chunkOpen) lines.push(`${indent}}`);
}

const BRANCH_OPS = new Set(["JUMP", "JTRUE", "JFALSE", "JCASE", "TRY", "ENDTRY"]);

function simpleStructuredRegion(scope) {
  if (!Array.isArray(scope.controlRegions) || scope.controlRegions.length !== 1) return null;
  const region = scope.controlRegions[0];
  if (!["If", "While", "DoWhile", "For", "ForIn"].includes(region.kind)) return null;
  const permittedControl = new Set([
    region.branch,
    region.backedge,
    region.alternateExit,
  ].filter(Number.isInteger));
  const unsupported = scope.instructions.some((instruction) =>
    !instruction.unreachable && BRANCH_OPS.has(instruction.op) && !permittedControl.has(instruction.offset)
  );
  if (unsupported) return null;
  const branch = Number.isInteger(region.branch)
    ? scope.instructions.find((instruction) => instruction.offset === region.branch)
    : null;
  const backedge = Number.isInteger(region.backedge)
    ? scope.instructions.find((instruction) => instruction.offset === region.backedge)
    : null;
  if (branch && !["JTRUE", "JFALSE"].includes(branch.op)) return null;
  if (region.kind === "If") {
    if (!branch) return null;
    if (Number.isInteger(region.alternateExit)) {
      const exit = scope.instructions.find((instruction) => instruction.offset === region.alternateExit);
      if (!exit || exit.op !== "JUMP" || exit.args[0] !== region.end) return null;
    }
    return region;
  }
  if (backedge && (backedge.op !== "JUMP" || backedge.args[0] !== region.testStart)) return null;
  return region;
}

function emitStraightRange(lines, scope, start, end, indent, context) {
  const instructions = scope.instructions.filter((instruction) =>
    instruction.offset >= start && instruction.offset < end &&
    !instruction.elided && !instruction.unreachable
  );
  if (context && context.enabled) {
    emitStackToLocalRange(lines, scope, instructions, indent, context);
    return;
  }
  instructions.forEach((instruction) => {
    switch (instruction.op) {
      case "RETURN":
        lines.push(`${indent}return $r.result($f);`);
        break;
      case "THROW":
        lines.push(`${indent}return $r.throwValue($f);`);
        break;
      default:
        if (STATIC_CONTROL_OPS.has(instruction.op)) {
          throw new Error(`Unexpected ${instruction.op} in structured straight-line range`);
        }
        lines.push(`${indent}${callForInstruction(instruction, context)}`);
    }
  });
}

function branchValue(context) {
  if (context && context.enabled) {
    if (context.pendingBranchTest) {
      // Item 18: the range's final flush deferred the test into a temp; the
      // branch tests it directly (nothing was pushed, so no mirror pop).
      const value = context.pendingBranchTest;
      context.pendingBranchTest = null;
      return value;
    }
    // The branch test was pushed by the range's final flush; mirror the pop.
    if (context.runtimeStack) context.runtimeStack.pop();
    return "$s.pop()";
  }
  return "$r.branch($f)";
}

function emitLoopCondition(lines, scope, region, indent, context) {
  if (!Number.isInteger(region.branch)) return;
  context.expectBranchTest = region.branch;
  emitStraightRange(lines, scope, region.testStart, region.branch, indent, context);
  const branch = scope.instructions.find((instruction) => instruction.offset === region.branch);
  const exitsWhenTrue = branch.op === "JTRUE";
  lines.push(`${indent}if (${exitsWhenTrue ? "" : "!"}${branchValue(context)}) break $loop${region.id};`);
}

function generateSimpleStructuredScope(scope, region, context) {
const lines = factoryLines(scope, context);
  emitScopePrologue(lines, context);
  emitStraightRange(lines, scope, 0, region.start, "  ", context);

  if (region.kind === "For") {
    emitStraightRange(lines, scope, region.initStart, region.initEnd, "  ", context);
  } else if (region.kind === "ForIn") {
    emitStraightRange(lines, scope, region.iteratorStart, region.iteratorEnd, "  ", context);
  }

  const loopHeaders = new Set([region.testStart, region.bodyStart, region.start]);
  (scope.loopInvariantLoads || []).filter((load) => loopHeaders.has(load.header)).forEach((load) => {
    lines.push(`  const $h${scope.id}_${load.sourceOffset} = ${hoistedLocalLoad(context, load)};`);
  });

  lines.push(`  $loop${region.id}: while (true) {`);
  if (region.kind === "DoWhile") {
    emitStraightRange(lines, scope, region.bodyStart, region.bodyEnd, "    ", context);
    context.expectBranchTest = region.branch;
    emitStraightRange(lines, scope, region.testStart, region.branch, "    ", context);
    const branch = scope.instructions.find((instruction) => instruction.offset === region.branch);
    lines.push(`    if (${branch.op === "JTRUE" ? "!" : ""}${branchValue(context)}) break $loop${region.id};`);
  } else if (region.kind === "ForIn") {
    context.expectBranchTest = region.branch;
    emitStraightRange(lines, scope, region.testStart, region.branch, "    ", context);
    const branch = scope.instructions.find((instruction) => instruction.offset === region.branch);
    lines.push(`    if (${branch.op === "JFALSE" ? "!" : ""}${branchValue(context)}) break $loop${region.id};`);
    emitStraightRange(lines, scope, region.bodyStart, region.bodyEnd, "    ", context);
  } else {
    emitLoopCondition(lines, scope, region, "    ", context);
    emitStraightRange(lines, scope, region.bodyStart, region.bodyEnd, "    ", context);
    if (region.kind === "For") {
      emitStraightRange(lines, scope, region.updateStart, region.updateEnd, "    ", context);
    }
  }
  lines.push("  }");
  emitStraightRange(lines, scope, region.end, scope.codeLength, "  ", context);
  lines.push("}");
  return lines.join("\n");
}

function generateSimpleStructuredIf(scope, region, context) {
const lines = factoryLines(scope, context);
  emitScopePrologue(lines, context);
  emitStraightRange(lines, scope, 0, region.testStart, "  ", context);
  context.expectBranchTest = region.branch;
  emitStraightRange(lines, scope, region.testStart, region.branch, "  ", context);
  const branch = scope.instructions.find((instruction) => instruction.offset === region.branch);
  const consequentWhenTrue = branch.op === "JTRUE" || region.alternateStart === null;
  // Item 15b: same exclusive-branch mirror correction as emitRegion's If
  // case — the branch blocks flush count-only placeholders and the join
  // pops the dead branch's share when both branches have the same net $s
  // delta (the base is measured after the branchValue pop).
  const previousExclusive = context.branchExclusive;
  context.branchExclusive = true;
  lines.push(`  if (${consequentWhenTrue ? "" : "!"}${branchValue(context)}) {`);
  const mirrorBase = context.runtimeStack ? context.runtimeStack.length : null;
  emitStraightRange(lines, scope, region.consequentStart, region.consequentEnd, "    ", context);
  const f1 = context.runtimeStack && mirrorBase !== null
    ? context.runtimeStack.length - mirrorBase
    : null;
  if (region.alternateStart !== null) {
    lines.push("  } else {");
    emitStraightRange(lines, scope, region.alternateStart, region.alternateEnd, "    ", context);
  }
  const f2 = context.runtimeStack && f1 !== null
    ? context.runtimeStack.length - mirrorBase - f1
    : null;
  context.branchExclusive = previousExclusive;
  lines.push("  }");
  const model = context.runtimeStack;
  if (model && f1 !== null && f1 === f2) {
    model.length -= f1;
  } else if (model) {
    context.runtimeStack = null;
  }
  emitStraightRange(lines, scope, region.end, scope.codeLength, "  ", context);
  lines.push("}");
  return lines.join("\n");
}

function structuredScopePlan(scope) {
  if (!Array.isArray(scope.controlRegions) || !scope.controlRegions.length) return null;
  if (scope.controlRegions.some((region) =>
    !["If", "Conditional", "Logical", "While", "DoWhile", "For", "ForIn", "Switch", "TryCatch", "TryFinally", "Label"].includes(region.kind)
  )) return null;

  const ownedControl = new Set();
  const ignoredOffsets = new Set();
  const exitsByOffset = new Map();
  const syntheticByStart = new Map((scope.syntheticRanges || []).map((range) => [range.start, range]));
  for (const range of scope.syntheticRanges || []) {
    scope.instructions.filter((instruction) =>
      instruction.offset >= range.start && instruction.offset < range.end && BRANCH_OPS.has(instruction.op)
    ).forEach((instruction) => ownedControl.add(instruction.offset));
  }
  for (const region of scope.controlRegions) {
    [region.branch, region.backedge, region.alternateExit].filter(Number.isInteger)
      .forEach((offset) => ownedControl.add(offset));
    if (region.kind === "Switch") {
      ownedControl.add(region.dispatchExit);
      (region.cases || []).filter((caseRegion) => !caseRegion.default)
        .forEach((caseRegion) => ownedControl.add(caseRegion.branch));
    }
    if (region.kind === "TryCatch") {
      [region.tryEnter, region.tryExit, region.catchExit].forEach((offset) => ownedControl.add(offset));
      scope.instructions.filter((instruction) =>
        instruction.offset >= region.start && instruction.offset < region.end && instruction.op === "ENDTRY"
      ).forEach((instruction) => ownedControl.add(instruction.offset));
      scope.instructions.filter((instruction) =>
        instruction.offset >= region.catchBodyStart && instruction.offset < region.catchBodyEnd &&
        instruction.op === "ENDCATCH"
      ).forEach((instruction) => ignoredOffsets.add(instruction.offset));
    }
    if (region.kind === "TryFinally") {
      [region.tryEnter, region.innerTryEnter, region.innerTryExit, region.catchExit, region.tryExit]
        .forEach((offset) => ownedControl.add(offset));
      scope.instructions.filter((instruction) =>
        instruction.offset >= region.start && instruction.offset < region.end && instruction.op === "ENDTRY"
      ).forEach((instruction) => ownedControl.add(instruction.offset));
      scope.instructions.filter((instruction) =>
        instruction.offset >= region.catchBodyStart && instruction.offset < region.catchBodyEnd &&
        instruction.op === "ENDCATCH"
      ).forEach((instruction) => ignoredOffsets.add(instruction.offset));
    }
    for (const exit of region.exits || []) {
      if (exitsByOffset.has(exit.offset) || !["break", "continue"].includes(exit.kind)) return null;
      ownedControl.add(exit.offset);
      exitsByOffset.set(exit.offset, { ...exit, region });
    }
    const branch = Number.isInteger(region.branch)
      ? scope.instructions.find((instruction) => instruction.offset === region.branch)
      : null;
    if (!["Switch", "TryCatch", "TryFinally", "Label"].includes(region.kind) &&
        (region.kind !== "For" || region.branch !== null)) {
      if (!branch || !["JTRUE", "JFALSE"].includes(branch.op)) return null;
    }
    if (Number.isInteger(region.backedge)) {
      const backedge = scope.instructions.find((instruction) => instruction.offset === region.backedge);
      if (!backedge || backedge.op !== "JUMP" || backedge.args[0] !== region.testStart) return null;
    }
    if (Number.isInteger(region.alternateExit)) {
      const exit = scope.instructions.find((instruction) => instruction.offset === region.alternateExit);
      if (!exit || exit.op !== "JUMP" || exit.args[0] !== region.end) return null;
    }
  }

  for (let leftIndex = 0; leftIndex < scope.controlRegions.length; leftIndex += 1) {
    const left = scope.controlRegions[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < scope.controlRegions.length; rightIndex += 1) {
      const right = scope.controlRegions[rightIndex];
      const disjoint = left.end <= right.start || right.end <= left.start;
      const nested = (left.start <= right.start && right.end <= left.end) ||
        (right.start <= left.start && left.end <= right.end);
      if (!disjoint && !nested) return null;
    }
  }

  const completionsByStart = new Map();
  const completionsByRegion = new Map();
  let nextCompletionId = 1;
  for (const range of scope.syntheticRanges || []) {
    const owner = scope.controlRegions.filter((region) =>
      region.kind === "TryFinally" && region.start <= range.start && range.end <= region.end
    ).sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
    if (!owner) return null;
    const abrupt = scope.instructions.find((instruction) =>
      instruction.offset >= range.end &&
      (instruction.op === "RETURN" ||
       (instruction.op === "JUMP" && exitsByOffset.has(instruction.offset)))
    );
    if (!abrupt || abrupt.offset >= owner.end) return null;
    const completion = {
      id: nextCompletionId++,
      owner,
      range,
      cleanupStart: range.end,
      abrupt,
      exit: abrupt.op === "JUMP" ? exitsByOffset.get(abrupt.offset) : null,
    };
    completionsByStart.set(range.start, completion);
    if (!completionsByRegion.has(owner.id)) completionsByRegion.set(owner.id, []);
    completionsByRegion.get(owner.id).push(completion);
  }

  if (scope.instructions.some((instruction) =>
    !instruction.unreachable && BRANCH_OPS.has(instruction.op) && !ownedControl.has(instruction.offset)
  )) return null;
  const regionsByStart = new Map();
  scope.controlRegions.forEach((region) => {
    if (!regionsByStart.has(region.start)) regionsByStart.set(region.start, []);
    regionsByStart.get(region.start).push(region);
  });
  regionsByStart.forEach((regions) => regions.sort((left, right) =>
    (right.end - right.start) - (left.end - left.start)
  ));
  return {
    regionsByStart,
    exitsByOffset,
    syntheticByStart,
    completionsByStart,
    completionsByRegion,
    ignoredOffsets,
  };
}

function generateStructuredScope(scope, plan, context) {
const lines = factoryLines(scope, context);
  emitScopePrologue(lines, context);
  const instructionsByOffset = new Map(scope.instructions.map((instruction) => [instruction.offset, instruction]));

  function emitRange(start, end, indent, activeRegion = null) {
    let offset = start;
    if (context.enabled) context.regionStack.push(activeRegion);
    try {
    while (offset < end) {
      const synthetic = plan.syntheticByStart.get(offset);
      if (synthetic && synthetic.end <= end) {
        const completion = plan.completionsByStart.get(offset);
        if (completion) {
          lines.push(`${indent}$completion${scope.id}_${completion.owner.id} = ${completion.id};`);
          lines.push(`${indent}break $completionRegion${scope.id}_${completion.owner.id};`);
          offset = completion.abrupt.end;
        } else {
          offset = synthetic.end;
        }
        continue;
      }
      const region = (plan.regionsByStart.get(offset) || []).find((candidate) =>
        candidate !== activeRegion && candidate.end <= end
      );
      if (region) {
        emitRegion(region, indent);
        offset = region.end;
        continue;
      }
      const instruction = instructionsByOffset.get(offset);
      if (!instruction) throw new Error(`Missing HIR instruction at structured offset ${offset}`);
      if (context.enabled) {
        let cursor = offset;
        let hasBatch = false;
        while (cursor < end) {
          if (cursor !== offset) {
            const nestedRegion = (plan.regionsByStart.get(cursor) || []).some((candidate) =>
              candidate !== activeRegion && candidate.end <= end
            );
            if (nestedRegion || plan.syntheticByStart.has(cursor)) break;
          }
          const candidate = instructionsByOffset.get(cursor);
          if (!candidate) break;
          if (!candidate.elided && !candidate.unreachable) {
            if (plan.ignoredOffsets.has(candidate.offset) || plan.exitsByOffset.has(candidate.offset)) break;
            if (STATIC_CONTROL_OPS.has(candidate.op) && !["RETURN", "THROW"].includes(candidate.op)) break;
          }
          hasBatch = true;
          cursor = candidate.end;
          if (["RETURN", "THROW"].includes(candidate.op)) break;
        }
        if (hasBatch) {
          emitStraightRange(lines, scope, offset, cursor, indent, context);
          offset = cursor;
          continue;
        }
      }
      offset = instruction.end;
      if (instruction.elided || instruction.unreachable) continue;
      if (plan.ignoredOffsets.has(instruction.offset)) continue;
      const controlExit = plan.exitsByOffset.get(instruction.offset);
      if (controlExit) {
        emitControlExit(controlExit, indent);
        continue;
      }
      switch (instruction.op) {
        case "RETURN":
          lines.push(`${indent}return $r.result($f);`);
          break;
        case "THROW":
          lines.push(`${indent}return $r.throwValue($f);`);
          break;
        case "ENDTRY":
          break;
        default:
          if (STATIC_CONTROL_OPS.has(instruction.op)) {
            throw new Error(`Unexpected ${instruction.op} in Structured Control LIR`);
          }
          lines.push(`${indent}${callForInstruction(instruction, context)}`);
      }
    }
    } finally {
      if (context.enabled) context.regionStack.pop();
    }
  }

  function branchCondition(region) {
    const branch = instructionsByOffset.get(region.branch);
    return branch.op === "JTRUE";
  }

  function emitControlExit(exit, indent) {
    const region = exit.region;
    if (exit.kind === "break") {
      const prefix = region.kind === "Switch" ? "switch" : region.kind === "Label" ? "label" : "loop";
      lines.push(`${indent}break $${prefix}${region.id};`);
      return;
    }
    if (region.kind === "For") {
      emitRange(region.updateStart, region.updateEnd, indent, region);
    } else if (region.kind === "DoWhile") {
      context.expectBranchTest = region.branch;
      emitRange(region.testStart, region.branch, indent, region);
      lines.push(`${indent}if (${branchCondition(region) ? "!" : ""}${branchValue(context)}) break $loop${region.id};`);
    }
    lines.push(`${indent}continue $loop${region.id};`);
  }

  function emitLoopInvariantLoads(region, indent) {
    const headers = new Set([region.testStart, region.bodyStart, region.start]);
    (scope.loopInvariantLoads || []).filter((load) => headers.has(load.header)).forEach((load) => {
      lines.push(
        `${indent}const $h${scope.id}_${load.sourceOffset} = ${hoistedLocalLoad(context, load)};`
      );
    });
  }

  function emitRegion(region, indent) {
    if (region.kind === "If" || region.kind === "Conditional") {
      context.expectBranchTest = region.branch;
      emitRange(region.testStart, region.branch, indent, region);
      const trueConsequent = branchCondition(region) || region.alternateStart === null;
      // Item 15b: exclusive branch blocks flush their pending values into
      // the $s mirror as count-only placeholders; at the join, pop the dead
      // branch's share when both branches have the same net $s delta, else
      // taint (the count is ambiguous when the taken branch's gain is
      // unknown). The base is measured after the branchValue pop so the
      // condition's pop is not charged to the consequent's delta.
      const previousExclusive = context.branchExclusive;
      context.branchExclusive = true;
      lines.push(`${indent}if (${trueConsequent ? "" : "!"}${branchValue(context)}) {`);
      const mirrorBase = context.runtimeStack ? context.runtimeStack.length : null;
      emitRange(region.consequentStart, region.consequentEnd, `${indent}  `, region);
      const f1 = context.runtimeStack && mirrorBase !== null
        ? context.runtimeStack.length - mirrorBase
        : null;
      if (region.alternateStart !== null) {
        lines.push(`${indent}} else {`);
        emitRange(region.alternateStart, region.alternateEnd, `${indent}  `, region);
      }
      const f2 = context.runtimeStack && f1 !== null
        ? context.runtimeStack.length - mirrorBase - f1
        : null;
      context.branchExclusive = previousExclusive;
      lines.push(`${indent}}`);
      const model = context.runtimeStack;
      if (model && f1 !== null && f1 === f2) {
        model.length -= f1;
      } else if (model) {
        context.runtimeStack = null;
      }
      return;
    }

    if (region.kind === "Logical") {
      context.expectBranchTest = region.branch;
      emitRange(region.leftStart, region.branch, indent, region);
      const branch = instructionsByOffset.get(region.branch);
      const evaluateRightWhenTrue = branch.op === "JFALSE";
      lines.push(`${indent}if (${evaluateRightWhenTrue ? "" : "!"}${branchValue(context)}) {`);
      emitRange(region.rightStart, region.rightEnd, `${indent}  `, region);
      lines.push(`${indent}}`);
      return;
    }

    if (region.kind === "Switch") {
      // Dense path (item 7b): every non-default case test is a single
      // compile-time constant (integer/number/string/boolean/null/undefined
      // or a constant-folded expression) with distinct SameValueZero values,
      // so the host switch compares the discriminant directly — no per-case
      // $r.caseJump calls, no selector variable, no guard chain. ES5 switch
      // semantics are strict equality (===) on the already-evaluated
      // discriminant, exactly what a native switch implements, and constant
      // tests have no side effects, so the generic path's short-circuit
      // guard is vacuous. Distinct SameValueZero labels can never both
      // ===-match the same input (NaN === x is always false; any other
      // ===-match fixes the input to the label), so first-match semantics
      // coincide. Duplicates are rejected for the host compiler (duplicate
      // case labels are a SyntaxError) and fall back to the generic chain.
      // The discriminant was materialized by the range's final flush, so
      // $s.pop() captures it; the guest stack ends up identical to the
      // generic path (discriminant consumed exactly once on every path).
      // Gated on the stack-to-local emitter: at O0/O1 there is no `$s`
      // alias and every op is a runtime call.
      const caseTests = region.cases.map((caseRegion) => {
        if (caseRegion.default) return { default: true };
        const branch = instructionsByOffset.get(caseRegion.branch);
        if (!branch || branch.unreachable) return { constant: false };
        const real = [];
        for (let offset = caseRegion.testStart; offset < caseRegion.branch; offset += 1) {
          const instruction = instructionsByOffset.get(offset);
          if (instruction && !instruction.elided) real.push(instruction);
        }
        if (real.length !== 1) return { constant: false };
        const instruction = real[0];
        if (context.globalValueProducerOffsets.has(instruction.offset)) return { constant: false };
        if (instruction.optimized && instruction.optimized.kind === "literal") {
          return { constant: true, value: instruction.optimized.value };
        }
        switch (instruction.op) {
          case "INTEGER":
          case "NUMBER":
          case "STRING":
            return { constant: true, value: instruction.args[0] };
          case "TRUE": return { constant: true, value: true };
          case "FALSE": return { constant: true, value: false };
          case "NULL": return { constant: true, value: null };
          case "UNDEF": return { constant: true, value: undefined };
          default: return { constant: false };
        }
      });
      const seen = new Set();
      const constantCaseCount = caseTests.filter((test) => !test.default).length;
      const dense = context.enabled && context.denseSwitch && constantCaseCount >= 2 &&
        caseTests.every((test) => test.default || (test.constant && (seen.has(test.value) ? false : (seen.add(test.value), true))));
      if (dense) {
        const discriminant = `$d${region.id}`;
        emitRange(region.discriminantStart, region.discriminantEnd, indent, region);
        lines.push(`${indent}const ${discriminant} = $s.pop();`);
        if (context.runtimeStack) context.runtimeStack.pop();
        lines.push(`${indent}$switch${region.id}: switch (${discriminant}) {`);
        region.cases.forEach((caseRegion, index) => {
          const test = caseTests[index];
          lines.push(`${indent}  ${test.default ? "default" : `case ${jsLiteral(test.value)}`}:`);
          emitRange(caseRegion.bodyStart, caseRegion.bodyEnd, `${indent}    `, region);
        });
        lines.push(`${indent}}`);
        if (context.runtimeStack) context.runtimeStack = null;
        context.stats.denseSwitches += 1;
        context.stats.denseSwitchCases += constantCaseCount;
        return;
      }
      const selector = `$case${region.id}`;
      lines.push(`${indent}let ${selector} = -1;`);
      emitRange(region.discriminantStart, region.discriminantEnd, indent, region);
      region.cases.filter((caseRegion) => {
        if (caseRegion.default) return false;
        const branch = instructionsByOffset.get(caseRegion.branch);
        return branch && !branch.unreachable;
      }).forEach((caseRegion) => {
        lines.push(`${indent}if (${selector} === -1) {`);
        emitRange(caseRegion.testStart, caseRegion.branch, `${indent}  `, region);
        lines.push(`${indent}  if ($r.caseJump($f)) ${selector} = ${caseRegion.index};`);
        lines.push(`${indent}}`);
      });
      const dispatchPop = instructionsByOffset.get(region.dispatchPop);
      const defaultCase = region.cases.find((caseRegion) => caseRegion.default);
      const needsDispatchPop = Boolean(dispatchPop && !dispatchPop.elided && !dispatchPop.unreachable);
      if (needsDispatchPop || defaultCase) {
        lines.push(`${indent}if (${selector} === -1) {`);
        if (needsDispatchPop) lines.push(`${indent}  $r.pop($f);`);
        if (defaultCase) lines.push(`${indent}  ${selector} = ${defaultCase.index};`);
        lines.push(`${indent}}`);
      }
      if (context.runtimeStack) context.runtimeStack = null;
      lines.push(`${indent}$switch${region.id}: switch (${selector}) {`);
      region.cases.forEach((caseRegion) => {
        lines.push(`${indent}  case ${caseRegion.index}:`);
        emitRange(caseRegion.bodyStart, caseRegion.bodyEnd, `${indent}    `, region);
      });
      lines.push(`${indent}}`);
      if (context.runtimeStack) context.runtimeStack = null;
      return;
    }

    if (region.kind === "TryCatch") {
      const suffix = `${scope.id}_${region.id}`;
      const catchInstruction = instructionsByOffset.get(region.catchStart);
      lines.push(`${indent}const $checkpoint${suffix} = $r.tryCheckpoint($f);`);
      lines.push(`${indent}try {`);
      emitRange(region.tryBodyStart, region.tryBodyEnd, `${indent}  `, region);
      lines.push(`${indent}} catch ($error${suffix}) {`);
      lines.push(`${indent}  $r.catchException($f, $checkpoint${suffix}, $error${suffix});`);
      lines.push(`${indent}  $r.beginCatch($f, ${jsLiteral(catchInstruction.args[0])});`);
      lines.push(`${indent}  try {`);
      emitRange(region.catchBodyStart, region.catchBodyEnd, `${indent}    `, region);
      lines.push(`${indent}  } finally {`);
      lines.push(`${indent}    $r.endCatch($f);`);
      lines.push(`${indent}  }`);
      lines.push(`${indent}}`);
      return;
    }

    if (region.kind === "TryFinally") {
      const suffix = `${scope.id}_${region.id}`;
      const completions = plan.completionsByRegion.get(region.id) || [];
      const completionIndent = completions.length ? `${indent}  ` : indent;
      if (completions.length) {
        lines.push(`${indent}let $completion${suffix} = 0;`);
        lines.push(`${indent}$completionRegion${suffix}: {`);
      }
      if (region.hasCatch) {
        const catchInstruction = instructionsByOffset.get(region.catchStart);
        lines.push(`${completionIndent}const $checkpoint${suffix} = $r.tryCheckpoint($f);`);
        lines.push(`${completionIndent}try {`);
        emitRange(region.tryBodyStart, region.tryBodyEnd, `${completionIndent}  `, region);
        lines.push(`${completionIndent}} catch ($error${suffix}) {`);
        lines.push(`${completionIndent}  $r.catchException($f, $checkpoint${suffix}, $error${suffix});`);
        lines.push(`${completionIndent}  $r.beginCatch($f, ${jsLiteral(catchInstruction.args[0])});`);
        lines.push(`${completionIndent}  try {`);
        emitRange(region.catchBodyStart, region.catchBodyEnd, `${completionIndent}    `, region);
        lines.push(`${completionIndent}  } finally {`);
        lines.push(`${completionIndent}    $r.endCatch($f);`);
        lines.push(`${completionIndent}  }`);
        lines.push(`${completionIndent}} finally {`);
      } else {
        lines.push(`${completionIndent}try {`);
        emitRange(region.tryBodyStart, region.tryBodyEnd, `${completionIndent}  `, region);
        lines.push(`${completionIndent}} finally {`);
      }
      emitRange(region.finalizerStart, region.finalizerEnd, `${completionIndent}  `, region);
      lines.push(`${completionIndent}}`);
      if (completions.length) {
        lines.push(`${indent}}`);
        completions.forEach((completion) => {
          lines.push(`${indent}if ($completion${suffix} === ${completion.id}) {`);
          emitRange(completion.cleanupStart, completion.abrupt.offset, `${indent}  `, region);
          if (completion.abrupt.op === "RETURN") {
            lines.push(`${indent}  return $r.result($f);`);
          } else {
            emitControlExit(completion.exit, `${indent}  `);
          }
          lines.push(`${indent}}`);
        });
      }
      return;
    }

    if (region.kind === "Label") {
      lines.push(`${indent}$label${region.id}: {`);
      emitRange(region.bodyStart, region.bodyEnd, `${indent}  `, region);
      lines.push(`${indent}}`);
      return;
    }

    if (region.kind === "For") {
      emitRange(region.initStart, region.initEnd, indent, region);
    } else if (region.kind === "ForIn") {
      emitRange(region.iteratorStart, region.iteratorEnd, indent, region);
    }
    emitLoopInvariantLoads(region, indent);
    lines.push(`${indent}$loop${region.id}: while (true) {`);
    const bodyIndent = `${indent}  `;
    if (region.kind === "DoWhile") {
      emitRange(region.bodyStart, region.bodyEnd, bodyIndent, region);
      context.expectBranchTest = region.branch;
      emitRange(region.testStart, region.branch, bodyIndent, region);
      lines.push(`${bodyIndent}if (${branchCondition(region) ? "!" : ""}${branchValue(context)}) break $loop${region.id};`);
    } else if (region.kind === "ForIn") {
      context.expectBranchTest = region.branch;
      emitRange(region.testStart, region.branch, bodyIndent, region);
      lines.push(`${bodyIndent}if (${branchCondition(region) ? "" : "!"}${branchValue(context)}) break $loop${region.id};`);
      emitRange(region.bodyStart, region.bodyEnd, bodyIndent, region);
    } else {
      if (Number.isInteger(region.branch)) {
        context.expectBranchTest = region.branch;
        emitRange(region.testStart, region.branch, bodyIndent, region);
        lines.push(`${bodyIndent}if (${branchCondition(region) ? "" : "!"}${branchValue(context)}) break $loop${region.id};`);
      }
      emitRange(region.bodyStart, region.bodyEnd, bodyIndent, region);
      if (region.kind === "For") {
        emitRange(region.updateStart, region.updateEnd, bodyIndent, region);
      }
    }
    lines.push(`${indent}}`);
  }

  emitRange(0, scope.codeLength, "  ");
  lines.push("}");
  return lines.join("\n");
}

function isStraightScope(scope) {
  return scope.instructions.every((instruction) =>
    instruction.unreachable || instruction.elided ||
    !STATIC_CONTROL_OPS.has(instruction.op) || ["RETURN", "THROW"].includes(instruction.op)
  );
}

function generateStraightScope(scope, context) {
const lines = factoryLines(scope, context);
  emitScopePrologue(lines, context);
  emitStraightRange(lines, scope, 0, scope.codeLength, "  ", context);
  lines.push("}");
  return lines.join("\n");
}

function generateScope(scope, options, codegenStats) {
  const context = createCodegenContext(scope, options, codegenStats);
  const plan = structuredScopePlan(scope);
  let code;
  if (plan) {
    codegenStats.structuredScopes += 1;
    code = generateStructuredScope(scope, plan, context);
  } else if (isStraightScope(scope)) {
    codegenStats.straightScopes += 1;
    code = generateStraightScope(scope, context);
  } else {
    const structuredRegion = simpleStructuredRegion(scope);
    if (!structuredRegion) {
      throw new Error(
        `Unable to lower control flow in scope ${scope.id} (${scope.name || "<anonymous>"}) ` +
        "to Structured Control LIR; interpreter/trampoline fallback is forbidden"
      );
    }
    codegenStats.structuredScopes += 1;
    code = structuredRegion.kind === "If"
      ? generateSimpleStructuredIf(scope, structuredRegion, context)
      : generateSimpleStructuredScope(scope, structuredRegion, context);
  }
  if (context.sizeOptimized && context.sizeTemporarySlots.size) {
    const declaration = `  let ${Array.from(context.sizeTemporarySlots).join(", ")};`;
    // Insert after the factory header's `{` — never after the first newline,
    // which is the entry location marker's line when source maps are on.
    code = code.replace("{\n", `{\n${declaration}\n`);
    codegenStats.sizeOptimization.temporarySlots += context.sizeTemporarySlots.size;
  }
  if (context.provenanceSlots && context.provenanceSlots.tracked.size) {
    // Item 9: declare every tracked slot's $q flag. The stamp is classified
    // lazily at the first write site (`$q === undefined ? classify : $q`) and
    // reclassified at every SETLOCAL; an unconditional prologue classification
    // of parameter slots is deliberately omitted — it would run once per call
    // even when the function's write sites never execute (early returns), and
    // the lazy fallback classifies the identical initial value at the first
    // write, so a prologue classification saves nothing (it measured −6.9%
    // on a constraint-solving workload and recovered on removal). The
    // mapped-arguments guard still
    // gates staleness for sloppy parameter slots either way.
    const declaration = `  let ${Array.from(context.provenanceSlots.tracked).map((index) => provenanceFlag(context, index)).join(", ")};`;
    code = code.replace("{\n", `{\n${declaration}\n`);
  }
  return { code, usesThisWrites: context.usesThisWrites };
}

// The pooled frame's locals array is only ever read by the $exec body it
// serves: leaf frames are lightweight and stackless, so no runtime helper
// observes them (getLocal/setLocal/findBinding walk environment chains the
// frame does not participate in), and arguments-materialized frames are
// retired, never pooled. Resetting only the slots the body can actually
// read keeps the reused array on V8's packed-elements fast path: storing
// `void 0` into a double-representation array transitions it to generic
// elements, after which every double-valued local is boxed into a
// HeapNumber on each acquire. Returns a Set of slot indices, or null to
// reset every slot when the body does something unusual (computed-index
// access, a bare reference to the array) that the scan cannot classify.
function computeLeafLocalsReads(execCode, localCount) {
  const body = execCode.replace(/const \$l = \$f\.locals;\n?/, "");
  if (/\$l\b(?!\[\d+\])|\$f\.locals(?!\[)/.test(body)) return null;
  const reads = new Set();
  for (const match of body.matchAll(/\$l\[(\d+)\]/g)) {
    const index = Number(match[1]);
    if (index >= localCount) return null;
    const tail = body.slice(match.index + match[0].length);
    if (!/^\s*=/.test(tail)) reads.add(index);
  }
  return reads;
}

function generateLeafFactory(scope, security, shape = {}) {
  const localCount = scope.variables.length + 1;
  const locals = localsLiteral(scope, localCount);
  // Retired frames are chained through a poolNext field on the frame object
  // itself, so the freelist needs no container and never touches
  // Array.prototype (which trusted-mode guest code could pollute). Frames
  // that ever materialized an arguments object are retired, never pooled:
  // the arguments proxy holds the frame and lazily maps its locals, so
  // reusing the frame would alias a different call's parameters.
  const pool = shape.framePooling !== false;
  const localsReads = pool ? shape.localsReads : null;
  const thisStamp = shape.usesThisWrites && security === "sandbox"
    ? ", thisIsGuest: $r.boundary.isUnmediatedWriteTarget($this)"
    : "";
  const lines = [
    `function $make${scope.id}($r, $environment) {`,
    `  const $execute = $exec${scope.id};`,
    `  const $metadata = $meta${scope.id};`,
    "  let $compiled;",
    ...(pool ? ["  let $poolHead = null;"] : []),
    "  $compiled = function(...$args) {",
    "    let $this = this;",
  ];
  if (security === "sandbox") {
    lines.push(
      "    if (!$r.boundary.consumeInternalGuestEntry()) {",
      "      $this = $r.boundary.secureValue($this);",
      "      $args = $r.boundary.secureArguments($args);",
      // Host-initiated entries (no program execution active) copy plain-data
      // values like globals do, so guest mutations cannot reach host objects
      // through a returned function's arguments or receiver.
      "      if (!$r.boundary.guestExecutionActive) {",
      "        $this = $r.boundary.secureHostEntryValue($this);",
      "        $args = $r.boundary.secureHostEntryArguments($args);",
      "      }",
      "    }"
    );
  }
  lines.push(
    "    if (!$metadata.strict) {",
    "      if ($this === void 0 || $this === null) $this = $r.global;",
    "      else if (typeof $this !== \"object\" && typeof $this !== \"function\") $this = Object($this);",
    "    }"
  );
  if (pool) {
    // Acquire: reuse the pooled frame (the slots the body reads are
    // rewritten in place with the initial values, so no per-call allocation
    // at all) or build a fresh one. Metadata and currentFunction are
    // constant per factory, so the reuse path omits them. thisIsGuest is
    // receiver-dependent and must be re-stamped for the new call. Slots the
    // body never reads keep whatever the previous call left (or the
    // literal's `void 0`): the frame is unreachable while pooled, so a
    // stale value is never observed — and skipping those stores keeps the
    // reused array on the packed-elements fast path (see
    // computeLeafLocalsReads). localsReads === null (unclassifiable body)
    // resets every slot, the safe superset.
    const slotResets = [];
    for (let index = 0; index < localCount; index += 1) {
      if (localsReads && !localsReads.has(index)) continue;
      const initial = index > 0 && index <= scope.parameterCount ? `$args[${index - 1}]` : "void 0";
      slotResets.push(`      $f.locals[${index}] = ${initial};`);
    }
    lines.push(
      "    let $f = $poolHead;",
      "    if ($f) {",
      "      $poolHead = $f.poolNext;",
      ...slotResets,
      "      $f.thisValue = $this;",
      "      $f.callerFrame = $r.currentFrame;",
      "      $f.callArgs = $args;",
      ...(shape.usesThisWrites && security === "sandbox"
        ? ["      $f.thisIsGuest = $r.boundary.isUnmediatedWriteTarget($this);"]
        : []),
      "    } else {",
      `      $f = { metadata: $metadata, locals: [${locals}], thisValue: $this, currentFunction: $compiled, callerFrame: $r.currentFrame, callArgs: $args${thisStamp} };`,
      "    }"
    );
  } else {
    lines.push(
      `    const $f = { metadata: $metadata, locals: [${locals}], thisValue: $this, currentFunction: $compiled, callerFrame: $r.currentFrame, callArgs: $args${thisStamp} };`
    );
  }
  lines.push(
    "    $r.currentFrame = $f;",
    "    try {",
    "      return $execute($r, $f);",
    "    } finally {",
    "      $r.currentFrame = $f.callerFrame;",
    ...(pool
      ? [
          "      if (!$f.argumentsInitialized) {",
          "        $f.poolNext = $poolHead;",
          "        $poolHead = $f;",
          "      }",
        ]
      : []),
    "    }",
    "  };",
    "  return $initializeCompiled($r, $compiled, $metadata);",
    "}"
  );
  return lines.join("\n");
}

function generateFactory(scope, leafFrame = false, security = "sandbox", fastFrame = false, shape = {}) {
  if (scope.script) return null;
  if (leafFrame) return generateLeafFactory(scope, security, shape);
  if (fastFrame) return generateFastFrameFactory(scope, security, shape);
  return [
    `function $make${scope.id}($r, $environment, $execute = $exec${scope.id}, $metadata = $meta${scope.id}) {`,
    "  let $compiled;",
    "  $compiled = function(...$args) {",
    "    return $invokeCompiled($r, $execute, $metadata, $environment, $compiled, this, new.target !== void 0, $args);",
    "  };",
    "  return $initializeCompiled($r, $compiled, $metadata);",
    "}",
  ].join("\n");
}

// Parameter slots are filled directly from $args inside the literal, so frame
// construction needs no parameter copy loop. A literal also stays on V8's
// packed-elements fast path for any size; the Array.from fallback in
// createFastLocals is only used by non-fast frames.
function localsLiteral(scope, localCount) {
  return Array.from({ length: localCount }, (_, index) =>
    index > 0 && index <= scope.parameterCount ? `$args[${index - 1}]` : "void 0"
  ).join(", ");
}

// Fast frames skip the dynamic-environment machinery, so their factory can
// build the frame inline instead of dispatching through
// invokeCompiledFunction + createFrame. The construction mirrors
// RuntimeInstance.createFrame's fastFrame branch exactly; fields the scope
// never reads are omitted from the literal.
function generateFastFrameFactory(scope, security, shape = {}) {
  const localCount = scope.variables.length + 1;
  const locals = localsLiteral(scope, localCount);
  const lines = [
    `function $make${scope.id}($r, $environment) {`,
    `  const $execute = $exec${scope.id};`,
    `  const $metadata = $meta${scope.id};`,
    "  let $compiled;",
    "  $compiled = function(...$args) {",
    "    const $constructing = new.target !== void 0;",
    "    let $this = this;",
  ];
  if (security === "sandbox") {
    lines.push(
      "    if (!$r.boundary.consumeInternalGuestEntry()) {",
      "      $this = $r.boundary.secureValue($this);",
      "      $args = $r.boundary.secureArguments($args);",
      // Host-initiated entries (no program execution active) copy plain-data
      // values like globals do, so guest mutations cannot reach host objects
      // through a returned function's arguments or receiver.
      "      if (!$r.boundary.guestExecutionActive) {",
      "        $this = $r.boundary.secureHostEntryValue($this);",
      "        $args = $r.boundary.secureHostEntryArguments($args);",
      "      }",
      "    }"
    );
  }
  lines.push(
    "    if (!$metadata.strict) {",
    "      if ($this === void 0 || $this === null) $this = $r.global;",
    "      else if (typeof $this !== \"object\" && typeof $this !== \"function\") $this = Object($this);",
    "    }"
  );
  // Sandbox mode can never pollute Array.prototype (attempts are observed and
  // blocked), and hardenFastFrameChain still swaps active stacks on observed
  // attempts, so literal arrays are safe there. Trusted mode keeps the
  // flag-aware allocation.
  const stackAlloc = security === "sandbox" ? "[]" : "$r.createFastArray()";
  const frameFields = [
    "metadata: $metadata",
    `stack: ${stackAlloc}`,
    `references: ${stackAlloc}`,
    `locals: [${locals}]`,
    "thisValue: $this",
    "currentFunction: $compiled",
    "callerFrame: $r.currentFrame",
    "callArgs: $args",
  ];
  if (shape.needsEnvironment) frameFields.push("environment: null");
  if (shape.needsDynamicBindings) frameFields.push("dynamicBindings: Object.create(null)");
  if (shape.hasLineRefs) frameFields.push("line: 0", "column: 0");
  // Receiver-write classification stamp: computed once on the secured, boxed
  // receiver so per-write writeTarget resolution can be skipped for it.
  if (shape.usesThisWrites && security === "sandbox") {
    frameFields.push("thisIsGuest: $r.boundary.isUnmediatedWriteTarget($this)");
  }
  lines.push(`    const $f = { ${frameFields.join(", ")} };`);
  if (shape.needsEnvironment) {
    lines.push(`    $f.environment = { kind: "frame", frame: $f, outer: $environment };`);
  }
  lines.push(
    "    $r.currentFrame = $f;",
    "    try {",
    "      const $result = $execute($r, $f);",
    "      if ($constructing && ($result === null || (typeof $result !== \"object\" && typeof $result !== \"function\"))) return $this;",
    "      return $result;",
    "    } finally {",
    "      $r.currentFrame = $f.callerFrame;",
    "    }",
    "  };",
    "  return $initializeCompiled($r, $compiled, $metadata);",
    "}"
  );
  return lines.join("\n");
}

const RUNTIME_IMPORTS = Object.freeze([
  ["applySandboxValue", "$applySandbox"],
  ["applySandboxValue0", "$applySandbox0"],
  ["applySandboxValue1", "$applySandbox1"],
  ["applySandboxValue2", "$applySandbox2"],
  ["applySandboxValue3", "$applySandbox3"],
  ["applySandboxValue4", "$applySandbox4"],
  ["applySandboxValue5", "$applySandbox5"],
  ["applyValue", "$apply"],
  ["constructSandboxValue", "$constructSandbox"],
  ["constructSandboxValue0", "$constructSandbox0"],
  ["constructSandboxValue1", "$constructSandbox1"],
  ["constructSandboxValue2", "$constructSandbox2"],
  ["constructSandboxValue3", "$constructSandbox3"],
  ["constructSandboxValue4", "$constructSandbox4"],
  ["constructSandboxValue5", "$constructSandbox5"],
  ["constructValue", "$construct"],
  ["createProgram", "$createProgram"],
  ["deleteGlobalVariableValue", "$deleteGlobal"],
  ["deleteVariableValue", "$deleteVar"],
  ["getArgumentsValue", "$getArguments"],
  ["getSandboxPropertyValue", "$getSandbox"],
  // Items 14/15: sanitizing direct-call arms for the inlined host
  // intrinsics — the runtime helper runs the checked callee and sanitizes
  // any thrown error like the boundary's applyHost.
  ["hostCallIntrinsic0", "$hostCall0"],
  ["hostCallIntrinsic1", "$hostCall1"],
  ["hostCallIntrinsic2", "$hostCall2"],
  ["hostCallIntrinsic3", "$hostCall3"],
  ["hostCallIntrinsic4", "$hostCall4"],
  ["hostCallIntrinsic5", "$hostCall5"],
  ["initializeCompiledFunction", "$initializeCompiled"],
  ["isPrototypeSetterUnsafe", "$prototypesHaveSetters"],
  ["instanceOfTarget", "$instanceOfTarget"],
  ["invokeCompiledFunction", "$invokeCompiled"],
  ["readGlobalVariableValue", "$readGlobal"],
  ["readVariableValue", "$readVar"],
  // Item 15: identity anchors for the member-call host-intrinsic inline. The
  // generated guard compares a resolved member callee against these raw
  // prototype functions; as immutable module const bindings, V8 constant-
  // folds the comparison to a plain reference compare.
  ["arrayPrototypeJoin", "$hostJoin"],
  ["arrayPrototypePush", "$hostPush"],
  ["arrayPrototypeSort", "$hostSort"],
  ["arrayPrototypeSlice", "$hostSliceArray"],
  ["arrayPrototypeIndexOf", "$hostIndexOfArray"],
  ["stringPrototypeCharAt", "$hostCharAt"],
  ["stringPrototypeIndexOf", "$hostIndexOfString"],
  ["stringPrototypeSlice", "$hostSliceString"],
  ["stringPrototypeReplace", "$hostReplace"],
  ["regexpPrototypeTest", "$hostTest"],
  ["setArgumentsValue", "$setArguments"],
  ["setGuestPropertyValue", "$setGuest"],
  ["setSandboxPropertyValue", "$setSandbox"],
  ["writeGlobalVariableValue", "$writeGlobal"],
  ["writeSloppyPropertyValue", "$writeSloppy"],
  ["writeStrictPropertyValue", "$writeStrict"],
  ["writeVariableValue", "$writeVar"],
]);

function generate(program, options = {}) {
  if (options.format && options.format !== "cjs") {
    throw new Error("The initial AOT backend currently emits CommonJS; ESM is scheduled for M5");
  }
  const runtimeModule = options.runtimeModule || "sablejs/runtime";
  const codegenStats = options.codegenStats || {
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
      enabled: (options.optimization === "O2" || options.optimization === "Os") &&
        options.stackToLocal !== false,
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
    slotProvenance: null,
  };
  codegenStats.sizeOptimization = {
    enabled: options.optimization === "Os",
    temporarySlots: 0,
    helperImports: 0,
    outputBytes: 0,
    decisions: {
      perScopeFactories: options.perScopeFactories !== false,
      // Mirrors the actual enablement in createInlinePlans: source maps (and
      // preserveSourceLocations) retain LOC, which disables expression
      // inlining — report the decision as made, not as configured.
      smallFunctionInlining: options.optimization === "O2" && options.inlineSmallFunctions !== false &&
        options.retainSourceLocations !== true,
      globalValueNumbering: options.optimization === "O2",
      loopInvariantCodeMotion: options.optimization === "O2",
    },
  };
  const evalScopeIds = new Set();
  program.scopes.forEach((scope) => scope.instructions.forEach((instruction) => {
    if (instruction.op === "EVAL" && instruction.args[0] && instruction.args[0] !== -1) {
      evalScopeIds.add(instruction.args[0].id);
    }
  }));
  // Dynamic Function("...") scopes parse synthetic text; their LOC ops refer
  // to that text, never the root file. The decoded scopes are members of the
  // host scope's dynamicFunctions table.
  const dynamicFunctionScopeIds = new Set();
  program.scopes.forEach((scope) => scope.dynamicFunctions.forEach((dynamicScope) => {
    if (dynamicScope !== -1) dynamicFunctionScopeIds.add(dynamicScope.id);
  }));
  const scopesById = new Map(program.scopes.map((scope) => [scope.id, scope]));
  const inlinePlans = createInlinePlans(program, options, codegenStats);
  const identifierProtection = normalizeIdentifierProtection(options.identifierProtection);
  const identifierAliases = createIdentifierAliases(
    program,
    scopesById,
    identifierProtection,
    codegenStats
  );
  const dynamicChain = new Map();
  const hasDynamicChain = (scope) => {
    if (dynamicChain.has(scope.id)) return dynamicChain.get(scope.id);
    const dynamic = scope.instructions.some((instruction) =>
      DYNAMIC_LOCAL_OPERATIONS.has(instruction.op)
    ) || (scope.parentId != null && hasDynamicChain(scopesById.get(scope.parentId)));
    dynamicChain.set(scope.id, dynamic);
    return dynamic;
  };
  // With/eval environments are pushed at runtime and shadow name resolution
  // for every function nested under them, not just siblings in the with block.
  // Fast frames omit the environment chain, so any scope that could resolve a
  // name through one must stay out of the fast path.
  const withEvalChain = new Map();
  const hasWithEvalAncestor = (scope) => {
    if (withEvalChain.has(scope.id)) return withEvalChain.get(scope.id);
    const dynamic = scope.instructions.some((instruction) =>
      instruction.op === "WITH" || instruction.op === "ENDWITH" || instruction.op === "EVAL"
    ) || (scope.parentId != null && hasWithEvalAncestor(scopesById.get(scope.parentId)));
    withEvalChain.set(scope.id, dynamic);
    return dynamic;
  };
  // A catch environment shadows exactly one name: its parameter. A nested
  // scope that resolves that name at runtime needs the environment chain;
  // scopes that resolve other names (or none) are unaffected by the catch
  // env and keep the fast path.
  const resolveNameOperations = new Set([
    "GETVAR", "SETVAR", "HASVAR", "DELVAR", "REFVAR", "PUTVAR",
  ]);
  const ancestorCatchNames = new Map();
  const collectAncestorCatchNames = (scope) => {
    if (ancestorCatchNames.has(scope.id)) return ancestorCatchNames.get(scope.id);
    const names = new Set();
    if (scope.parentId != null) {
      const parent = scopesById.get(scope.parentId);
      parent.instructions.forEach((instruction) => {
        if (instruction.op === "CATCH" && instruction.args[0] != null) {
          names.add(instruction.args[0]);
        }
      });
      collectAncestorCatchNames(parent).forEach((name) => names.add(name));
    }
    ancestorCatchNames.set(scope.id, names);
    return names;
  };
  const resolvesAncestorCatchName = (scope) => {
    const names = collectAncestorCatchNames(scope);
    if (names.size === 0) return false;
    return scope.instructions.some((instruction) =>
      resolveNameOperations.has(instruction.op) &&
      instruction.args[0] != null &&
      names.has(instruction.args[0])
    );
  };
  const directVariableScopeIds = new Set(program.scopes
    .filter((scope) => !hasDynamicChain(scope))
    .map((scope) => scope.id));
  // Item 6: local promotion (all securities since Phase 3). Slots in
  // "frame"-layout scopes (O2/Os, non-script, direct variable resolution)
  // are promoted from `$f.locals` elements to real `$exec` prologue
  // variables. Soundness: a scope with no CLOSURE op creates no nested
  // closure, so no other frame's environment chain can ever contain this
  // frame's environment node — the locals array is unreachable by the
  // runtime name-walk (findBinding/getVar/setVar/hasVar) and by captured
  // reads from any descendant (there are none). No with/eval/catch keeps
  // the scope's own code on the inline path and no dynamicFunctions keeps
  // it off the `$r.call` fallback; no GETLOCAL2/SETLOCAL2 keeps
  // capture-visible slots out. The promoted slot keeps its dead `void 0`
  // placeholder in the locals array, so every frame constructor, the
  // `$getArguments` parameter mapping, and the metadata layout stay
  // untouched — only GETLOCAL/SETLOCAL (and LICM hoists) divert to the
  // variable. Phase 2 ships strict parameters: strict scopes also promote
  // parameter slots, because `arguments` is unmapped there
  // (createArgumentsObject builds its `frame.locals`-reading mapped proxy
  // only for sloppy frames) and fn.arguments/fn.caller are PoisonPill
  // accessors — no runtime path reads a parameter back through the locals
  // array. Phase 3 (sandbox): the eligibility has no security term — a
  // boundary review found no sandbox path that observes frame.locals
  // (secureValue/writeTarget/isUnmediatedWriteTarget operate on values,
  // never frames; the getLocal/writeLocalValue evalFrame branches target
  // the eval caller, which carries the excluded EVAL op). Phase 1's
  // "trusted only" gate was a staging decision, not a soundness boundary.
  const promotedLocalPlans = new Map();
  // stackToLocal:false switches the emitter to the explicit-stack fallback
  // path; promotion plans must not be built for it (their $l locals do not
  // exist there, and the drift guard would fail the compile). The
  // provenance gate below mirrors this check.
  if ((options.optimization === "O2" || options.optimization === "Os") &&
      options.stackToLocal !== false) {
    program.scopes.forEach((scope) => {
      if (scope.script || !directVariableScopeIds.has(scope.id) ||
          scope.dynamicFunctions.length) return;
      if (scope.instructions.some((instruction) =>
        DYNAMIC_LOCAL_OPERATIONS.has(instruction.op) ||
        instruction.op === "CLOSURE" ||
        instruction.op === "GETLOCAL2" ||
        instruction.op === "SETLOCAL2"
      )) return;
      const indexes = new Set();
      // Phase 2: strict scopes start at slot 1 (parameters included), sloppy
      // scopes stay above the parameter range (the mapped arguments proxy
      // reads parameter slots through frame.locals).
      const firstIndex = scope.strict ? 1 : scope.parameterCount + 1;
      for (let index = firstIndex; index <= scope.variables.length; index += 1) {
        indexes.add(index);
      }
      if (indexes.size) promotedLocalPlans.set(scope.id, indexes);
    });
  }
  // Item 9: slot-provenance plans ($q flags). The plan maps scopeId to the
  // tracked/dropped slot sets; the context consults it lazily, so empty plans
  // only appear for scopes that actually discover write sites.
  const provenanceSlotPlans = new Map();
  const entryScope = scopesById.get(program.entry);
  const globalNames = new Set(entryScope && entryScope.script ? entryScope.variables : []);
  // The compile pipeline builds the ordered synthetic-source registry (see
  // buildSyntheticSources in src/compiler/index.js); markers reference it by
  // registry position + 1, so codegen looks entries up by scope id.
  const syntheticSources = new Map(
    (options.syntheticSources || []).map((entry, index) =>
      [entry.scopeId, { ...entry, index: index + 1 }]
    )
  );
  const codegenOptions = {
    ...options,
    evalScopeIds,
    dynamicFunctionScopeIds,
    syntheticSources,
    directVariableScopeIds,
    globalNames,
    identifierAliases,
    identifierProtection,
    inlinePlans,
    promotedLocalPlans,
    provenanceSlotPlans,
    scopesById,
  };
  const generatedScopes = program.scopes.map((scope) => {
    let scopeCode;
    let usesThisWrites;
    const promoted = promotedLocalPlans.get(scope.id);
    // Item 9: slot-provenance stamps are eligible under the same isolation
    // shape as promotion (direct variable resolution, no closures, no
    // dynamic ops — scope.lightweight implies all three). Mirror the
    // context's predicate exactly, including the stackToLocal gate.
    const provenanceEligible = options.slotProvenance !== false &&
      options.stackToLocal !== false && options.optimization === "O2" &&
      !scope.script && scope.lightweight && directVariableScopeIds.has(scope.id);
    if (promoted || provenanceEligible) {
      // Mixed-path fallback: a stack-height mismatch (e.g. a constant-folded
      // ternary merge) sends GETLOCAL/SETLOCAL/DELLOCAL through the runtime
      // helpers, which read and write the locals array — the dead `void 0`
      // placeholder for a promoted slot. Demote exactly the affected slots
      // (they stay on the live array) and regenerate. Emission is
      // deterministic, so one retry per demoted set converges; the guard
      // below is a backstop against an (unreachable) cycle. A provenance
      // tracked slot written through $r.setLocal would bypass its $q store
      // classification, so such slots are dropped from the tracking plan —
      // permanently, via the dropped set, which keeps regeneration from
      // re-adding them.
      const initialCount = promoted ? promoted.size : 0;
      let attempts = 0;
      for (;;) {
        const snapshot = { ...codegenStats.stackToLocal };
        ({ code: scopeCode, usesThisWrites } = generateScope(scope, codegenOptions, codegenStats));
        const conflicting = [];
        Array.from(scopeCode.matchAll(/\$r\.(?:getLocal|setLocal|deleteLocal)\(\$f, (\d+)\)/g),
          (match) => Number(match[1])).forEach((index) => {
          if (promoted && promoted.has(index) && !conflicting.includes(index)) conflicting.push(index);
        });
        // Belt-and-suspenders against optimizer/codegen predicate drift: a
        // hoisted load rendered `$l[index]` for a promoted slot would read
        // the dead placeholder, so such slots are demoted too.
        Array.from(scopeCode.matchAll(/const \$h\d+_\d+ = \$l\[(\d+)\];/g),
          (match) => Number(match[1])).forEach((index) => {
          if (promoted && promoted.has(index) && !conflicting.includes(index)) conflicting.push(index);
        });
        const plan = provenanceSlotPlans.get(scope.id);
        if (plan) {
          Array.from(scopeCode.matchAll(/\$r\.setLocal\(\$f, (\d+)\)/g),
            (match) => Number(match[1])).forEach((index) => {
            if (plan.tracked.has(index) && !conflicting.includes(index)) {
              plan.tracked.delete(index);
              plan.dropped.add(index);
              conflicting.push(index);
            }
          });
        }
        // A name-based runtime write ($r.setVar — a SETVAR whose operand was
        // flushed off the model stack) resolves through findBinding and writes
        // frame.locals directly, bypassing both the promoted variable and the
        // $q store classification. Demote/drop every slot it targets, exactly
        // like the indexed setLocal demotions above; the name in the output is
        // the identifier-protection alias, so map it back through the alias
        // table.
        {
          const aliases = identifierAliases.get(scope.id);
          const aliasOf = (index) => {
            const original = scope.variables[index - 1];
            return aliases && aliases.has(original) ? aliases.get(original) : original;
          };
          Array.from(scopeCode.matchAll(/\$r\.setVar\(\$f, ("(?:[^"\\]|\\.)*")\)/g),
            (match) => JSON.parse(match[1])).forEach((name) => {
            for (const index of promoted) {
              if (index >= 1 && index <= scope.variables.length &&
                  aliasOf(index) === name && !conflicting.includes(index)) conflicting.push(index);
            }
            if (plan) {
              for (const index of Array.from(plan.tracked)) {
                if (index >= 1 && index <= scope.variables.length && aliasOf(index) === name) {
                  plan.tracked.delete(index);
                  plan.dropped.add(index);
                  if (!conflicting.includes(index)) conflicting.push(index);
                }
              }
            }
          });
        }
        if (!conflicting.length) break;
        conflicting.forEach((index) => promoted && promoted.delete(index));
        Object.assign(codegenStats.stackToLocal, snapshot);
        attempts += 1;
        if (attempts > initialCount + scope.variables.length + 1) {
          throw new Error(`Local promotion demotion did not converge in scope ${scope.id}`);
        }
      }
    } else {
      ({ code: scopeCode, usesThisWrites } = generateScope(scope, codegenOptions, codegenStats));
    }
    // Local promotion must never coexist with runtime name-walk or
    // environment-chain helpers: the eligibility predicate derives frame
    // isolation from the absence of closures and dynamic operations, so any
    // of these means the predicate and the emitter have drifted — fail
    // loudly. ($r.call/$r.construct legitimately appear after a runtime-
    // stack op — e.g. INITPROP with a non-literal value — without touching
    // locals; $r.getLocal/setLocal/deleteLocal for promoted indexes and
    // name-based $r.setVar writes — a SETVAR whose operand was flushed —
    // are handled by the demotion loop above, which demotes every slot they
    // touch, so the remaining setVar sites only ever target live-array
    // slots.)
    if ((promoted && promoted.size) || provenanceEligible) {
      const leaked = scopeCode.match(/\$r\.(?:getVar|hasVar|delVar|beginWith|evalStatic|closure)|\$readVar|\$writeVar|\$deleteVar/);
      if (leaked) {
        throw new Error(`Local promotion compiled runtime helper ${leaked[0]} into scope ${scope.id}`);
      }
    }
    let code = scopeCode;
    // Non-lightweight scopes resolve bindings through findBinding at runtime,
    // which walks environment frames and reads dynamicBindings; their factory
    // frames must carry the full createFrame field set. Script frames always
    // come from createFrame, so scripts stay eligible regardless.
    const fastFrame = ["O2", "Os"].includes(codegenOptions.optimization) &&
      (scope.lightweight || scope.script) &&
      !scope.instructions.some((instruction) => DYNAMIC_LOCAL_OPERATIONS.has(instruction.op)) &&
      !hasWithEvalAncestor(scope) &&
      !resolvesAncestorCatchName(scope) &&
      !/\$r\.(?:call|construct|getLocal|getVar|hasVar|beginWith)|\$r\.evalStatic/.test(code);
    if (fastFrame) codegenStats.fastFrameScopes += 1;
    const stackReferences = code.match(/\$s\b/g) || [];
    const stackless = fastFrame && stackReferences.length === 1 &&
      code.includes("  const $s = $f.stack;\n");
    if (stackless) code = code.replace("  const $s = $f.stack;\n", "");
    const leafFrame = options.leafFrames !== false && stackless && scope.lightweight &&
      !code.includes("$f.environment") &&
      !/\$r\.[A-Za-z_$][\w$]*\(\$f/.test(code);
    if (leafFrame) codegenStats.leafFrameScopes += 1;
    return { scope, code, fastFrame, leafFrame, usesThisWrites };
  });
  // Demotion (mixed-path fallbacks) may have shrunk the plan; report the
  // final shape. Non-eligible modes leave the plan empty, so zeros here.
  codegenStats.localPromotion = {
    eligibleScopes: promotedLocalPlans.size,
    promotedSlots: Array.from(promotedLocalPlans.values())
      .reduce((sum, indexes) => sum + indexes.size, 0),
  };
  // Item 9: report the final tracking shape (demotion may have dropped
  // slots). Scopes whose plans shrank to nothing are not counted.
  codegenStats.slotProvenance = {
    trackedScopes: 0,
    trackedSlots: 0,
    droppedSlots: 0,
  };
  provenanceSlotPlans.forEach((plan) => {
    if (!plan.tracked.size) return;
    codegenStats.slotProvenance.trackedScopes += 1;
    codegenStats.slotProvenance.trackedSlots += plan.tracked.size;
    codegenStats.slotProvenance.droppedSlots += plan.dropped.size;
  });
  // Frames along the ancestor chain of a dynamic (with/eval/catch) scope are
  // walked by runtime binding lookups, so their environment nodes and
  // dynamicBindings objects must exist. Every other fast frame omits them.
  const dynamicChainAncestorIds = new Set();
  program.scopes.forEach((scope) => {
    if (!scope.instructions.some((instruction) => DYNAMIC_LOCAL_OPERATIONS.has(instruction.op))) return;
    for (let current = scope; current; current = current.parentId == null
      ? null
      : scopesById.get(current.parentId)) {
      dynamicChainAncestorIds.add(current.id);
    }
  });
  const generatedFactories = [];
  if (options.perScopeFactories !== false) {
    generatedScopes.forEach(({ scope, leafFrame, fastFrame, code, usesThisWrites }) => {
      const inlineLeafFrame = leafFrame && options.inlineLeafFrames !== false;
      const inlineFastFrame = fastFrame && !inlineLeafFrame && options.inlineFastFrames !== false;
      const needsEnvironment = inlineFastFrame && (
        code.includes("$f.environment") ||
        code.includes("$r.tryCheckpoint") ||
        dynamicChainAncestorIds.has(scope.id)
      );
      const factory = generateFactory(scope, inlineLeafFrame, codegenOptions.security, inlineFastFrame, {
        needsEnvironment,
        needsDynamicBindings: dynamicChainAncestorIds.has(scope.id),
        hasLineRefs: code.includes("$f.line"),
        usesThisWrites,
        framePooling: options.framePooling !== false,
        ...(inlineLeafFrame && options.framePooling !== false
          ? { localsReads: computeLeafLocalsReads(code, scope.variables.length + 1) }
          : {}),
      });
      if (factory && inlineLeafFrame) codegenStats.inlineLeafFrameScopes += 1;
      if (factory && inlineLeafFrame && options.framePooling !== false) codegenStats.framePooledScopes += 1;
      if (factory && inlineFastFrame) codegenStats.inlineFastFrameScopes += 1;
      if (factory) generatedFactories.push(factory);
    });
  }
  const helperBody = generatedScopes.map(({ code }) => code).concat(generatedFactories).join("\n");
  const imports = RUNTIME_IMPORTS.filter(([, local]) =>
    local === "$createProgram" || helperBody.includes(local)
  );
  codegenStats.sizeOptimization.helperImports = imports.length;
  const lines = [
    '"use strict";',
    `const { ${imports.map(([exported, local]) => `${exported}: ${local}`).join(", ")} } = require(${JSON.stringify(runtimeModule)});`,
  ];
  generatedScopes.forEach(({ scope, fastFrame, leafFrame, usesThisWrites }) =>
    lines.push(`const $meta${scope.id} = ${JSON.stringify(metadata(
      scope,
      fastFrame,
      identifierAliases.get(scope.id),
      leafFrame,
      usesThisWrites,
      hasWithEvalAncestor(scope)
    ))};`)
  );
  // Source-map mode wraps every $exec body in reset markers: they end the
  // previous scope's active location so its last statement never maps module
  // metadata, factories, or the next scope's prologue. The finalizer strips
  // them along with the LOC markers; with maps disabled they are never
  // emitted, so generated bytes stay byte-for-byte unchanged.
  const scopeReset = options.mapSettings ? resetMarker() : null;
  generatedScopes.forEach(({ code }) => {
    if (scopeReset) {
      lines.push(scopeReset);
      lines.push(code);
      lines.push(scopeReset);
    } else {
      lines.push(code);
    }
  });
  generatedFactories.forEach((code) => lines.push(code));
  lines.push(
    `const $scopeTable = { ${program.scopes.map((scope) => `${scope.id}: { execute: $exec${scope.id}, metadata: $meta${scope.id}${scope.script || options.perScopeFactories === false ? "" : `, factory: $make${scope.id}`} }`).join(", ")} };`
  );
  lines.push(
    `module.exports = $createProgram($exec${program.entry}, $meta${program.entry}, ${JSON.stringify(ABI_VERSION)}, $scopeTable, ${JSON.stringify({ security: options.security || "sandbox" })});`,
    ""
  );
  return lines.join("\n");
}

module.exports = {
  LOWERING_COVERAGE,
  STATIC_CONTROL_OPS,
  generate,
  jsLiteral,
  normalizeIdentifierProtection,
  validateLoweringCoverage,
};
