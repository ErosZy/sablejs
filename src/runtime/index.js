"use strict";

const {
  captureArgumentsObject: CAPTURE_ARGUMENTS_OBJECT,
  writePropertyValue: HOST_WRITE_SLOPPY_PROPERTY_VALUE,
} = require("./sloppy");
const {
  SandboxBoundary,
  brandRuntimeCallable,
  capability,
  sanitizeHostError,
  unwrapCapabilities,
} = require("./security");

const ABI_VERSION = "2.0.0-aot.5";
const EMPTY = Symbol("sable.empty");
// Brand for REFVAR/PUTVAR reference tokens; a with/catch object can never
// hold this module-private symbol, so token identity is unambiguous.
const REF_TOKEN = Symbol("sable.reference");
const ARRAY_PUSH = Array.prototype.push;
const ARRAY_POP = Array.prototype.pop;
const ARRAY_SPLICE = Array.prototype.splice;
const ARRAY_SLICE = Array.prototype.slice;
const ARRAY_FROM = Array.from;
const ARRAY_IS_ARRAY = Array.isArray;
// Item 15: raw prototype functions exported so generated code can compare a
// member-call callee against them by identity. These must be the unbound
// prototype functions — the guest-visible resolved method of `o.join()` is
// exactly Array.prototype.join, so only the raw object matches.
const arrayPrototypeJoin = Array.prototype.join;
const arrayPrototypePush = Array.prototype.push;
const arrayPrototypeSort = Array.prototype.sort;
const arrayPrototypeSlice = Array.prototype.slice;
const arrayPrototypeIndexOf = Array.prototype.indexOf;
const stringPrototypeCharAt = String.prototype.charAt;
const stringPrototypeIndexOf = String.prototype.indexOf;
const stringPrototypeSlice = String.prototype.slice;
const stringPrototypeReplace = String.prototype.replace;
const regexpPrototypeTest = RegExp.prototype.test;
// Item 15: direct-call arms of the inlined host intrinsics (items 14/15).
// They run the checked callee with the given receiver and fixed arguments
// (V8's call-apply elimination folds FUNCTION_CALL.call into a direct call)
// and sanitize any thrown error exactly like the boundary's applyHost, so a
// throwing intrinsic is observationally identical to the mediated path —
// the guest sees the same error class, message, and (absent) stack instead
// of a raw host error that would leak host frames.
function hostCallIntrinsic0(target, thisValue) {
  try {
    return FUNCTION_CALL.call(target, thisValue);
  } catch (error) {
    throw sanitizeHostError(error);
  }
}
function hostCallIntrinsic1(target, thisValue, a) {
  try {
    return FUNCTION_CALL.call(target, thisValue, a);
  } catch (error) {
    throw sanitizeHostError(error);
  }
}
function hostCallIntrinsic2(target, thisValue, a, b) {
  try {
    return FUNCTION_CALL.call(target, thisValue, a, b);
  } catch (error) {
    throw sanitizeHostError(error);
  }
}
function hostCallIntrinsic3(target, thisValue, a, b, c) {
  try {
    return FUNCTION_CALL.call(target, thisValue, a, b, c);
  } catch (error) {
    throw sanitizeHostError(error);
  }
}
function hostCallIntrinsic4(target, thisValue, a, b, c, d) {
  try {
    return FUNCTION_CALL.call(target, thisValue, a, b, c, d);
  } catch (error) {
    throw sanitizeHostError(error);
  }
}
function hostCallIntrinsic5(target, thisValue, a, b, c, d, e) {
  try {
    return FUNCTION_CALL.call(target, thisValue, a, b, c, d, e);
  } catch (error) {
    throw sanitizeHostError(error);
  }
}
const ARRAY_FOR_EACH = Function.call.bind(Array.prototype.forEach);
const ARRAY_INDEX_OF = Function.call.bind(Array.prototype.indexOf);
const ARRAY_LAST_INDEX_OF = Function.call.bind(Array.prototype.lastIndexOf);
const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_DEFINE_PROPERTIES = Object.defineProperties;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_KEYS = Object.keys;
const OBJECT_SET_PROTOTYPE_OF = Object.setPrototypeOf;
const HAS_OWN_PROPERTY = Function.call.bind(Object.prototype.hasOwnProperty);
const REFLECT_APPLY = Reflect.apply;
const REFLECT_CONSTRUCT = Reflect.construct;
const FUNCTION_CALL = Function.prototype.call;
const REFLECT_DEFINE_PROPERTY = Reflect.defineProperty;
const REFLECT_DELETE_PROPERTY = Reflect.deleteProperty;
const REFLECT_GET = Reflect.get;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const REFLECT_SET = Reflect.set;
const ARRAY_PROTOTYPE = Array.prototype;
const OBJECT_PROTOTYPE = Object.prototype;
const OBJECT_DEFINE_GETTER = Object.prototype.__defineGetter__;
const OBJECT_DEFINE_SETTER = Object.prototype.__defineSetter__;
const REFLECT_SET_PROTOTYPE_OF = Reflect.setPrototypeOf;
let indexedPrototypeUnsafe = false;
// Object-literal initialization must create own data properties without
// consulting inherited properties (ES5.1 11.1.5 -> CreateDataProperty). Once
// an accessor or non-writable data property is installed on
// Array.prototype/Object.prototype, any chain swap of the two is performed,
// or any key of a literal is __proto__, the fast assignment path would
// observe the prototype. It therefore falls back to defineData for the rest
// of the process. Unsafe descriptors cannot be installed by sandboxed
// programs (the intrinsic graph is protected), so sandbox runs stay fast.
let prototypeSetterUnsafe = false;

// The two built-in prototypes are captured at module load; a host that
// installed unsafe properties on them before loading the runtime must disable
// the fast path too. Object.prototype's own __proto__ accessor is excluded —
// the initProperty key check already routes __proto__ keys to defineData,
// and the accessor at that key affects only __proto__ writes.
(function scanUnsafePrototypeProperties() {
  for (const proto of [OBJECT_PROTOTYPE, ARRAY_PROTOTYPE]) {
    const keys = REFLECT_OWN_KEYS(proto);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      // ES5.1 literal keys are strings; host symbol properties cannot be
      // addressed by INITPROP and must not disable its fast path.
      if (typeof key !== "string" || key === "__proto__") continue;
      const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(proto, key);
      if (isLiteralAssignmentUnsafeDescriptor(descriptor)) {
        prototypeSetterUnsafe = true;
        return;
      }
    }
  }
})();

function dataDescriptor(value, writable, enumerable, configurable) {
  const descriptor = OBJECT_CREATE(null);
  descriptor.value = value;
  descriptor.writable = writable;
  descriptor.enumerable = enumerable;
  descriptor.configurable = configurable;
  return descriptor;
}

function accessorDescriptor(getter, setter, enumerable, configurable) {
  const descriptor = OBJECT_CREATE(null);
  descriptor.get = getter;
  descriptor.set = setter;
  descriptor.enumerable = enumerable;
  descriptor.configurable = configurable;
  return descriptor;
}

function safePropertyDescriptor(descriptor) {
  const safe = OBJECT_CREATE(null);
  ARRAY_FOR_EACH(["value", "writable", "get", "set", "enumerable", "configurable"], (key) => {
    if (HAS_OWN_PROPERTY(descriptor, key)) safe[key] = descriptor[key];
  });
  return safe;
}

function defineData(object, key, value, writable, enumerable, configurable) {
  return OBJECT_DEFINE_PROPERTY(
    object,
    key,
    dataDescriptor(value, writable, enumerable, configurable)
  );
}

function defineAccessor(object, key, getter, setter, enumerable, configurable) {
  return OBJECT_DEFINE_PROPERTY(
    object,
    key,
    accessorDescriptor(getter, setter, enumerable, configurable)
  );
}

// The internal-array chain is null-based: guest code can never install
// index accessors on it, so runtime-owned writes through the chain are
// immune to Array.prototype/Object.prototype pollution. slice is needed by
// the boundary's argument securing paths, which receive internal arrays as
// call args (call()/construct() collect them there rather than on a plain
// Array whose prototype a guest may have polluted).
const INTERNAL_ARRAY_PROTO = OBJECT_CREATE(null);
defineData(INTERNAL_ARRAY_PROTO, "push", ARRAY_PUSH, false, false, false);
defineData(INTERNAL_ARRAY_PROTO, "pop", ARRAY_POP, false, false, false);
defineData(INTERNAL_ARRAY_PROTO, "splice", ARRAY_SPLICE, false, false, false);
defineData(INTERNAL_ARRAY_PROTO, "slice", ARRAY_SLICE, false, false, false);

function createIsolatedArray(length = 0) {
  const array = new Array(length);
  OBJECT_SET_PROTOTYPE_OF(array, INTERNAL_ARRAY_PROTO);
  return array;
}

function createFastArray(length = 0) {
  return indexedPrototypeUnsafe ? createIsolatedArray(length) : new Array(length);
}

function isIndexedPrototype(object) {
  return object === ARRAY_PROTOTYPE || object === OBJECT_PROTOTYPE;
}

function affectsInternalArraySlots(key) {
  if (typeof key === "symbol") return false;
  const text = String(key);
  if (text === "push" || text === "pop" || text === "splice") return true;
  const index = Number(text);
  return Number.isInteger(index) && index >= 0 && index < 0xffffffff && String(index) === text;
}

// Any accessor descriptor — an own "get" key, an own "set" key (even set
// to undefined), or both — makes plain assignment observe the prototype:
// [[Put]] through an inherited accessor with no setter throws in strict
// mode and silently fails in sloppy mode, so literal init must not assign.
function isAccessorDescriptor(descriptor) {
  return descriptor && (HAS_OWN_PROPERTY(descriptor, "get") || HAS_OWN_PROPERTY(descriptor, "set"));
}

// A fresh literal assignment can be intercepted by an accessor or rejected
// by an inherited non-writable data property. Mutation observation runs
// before defineProperty, so descriptors that do not explicitly opt into a
// writable data property are treated conservatively: on a new property the
// omitted writable field defaults to false, while a false positive only
// disables the fast path.
function isLiteralAssignmentUnsafeDescriptor(descriptor) {
  return isAccessorDescriptor(descriptor) || !descriptor || descriptor.writable !== true;
}

function observePrototypeMutation(callable, thisValue, args) {
  if (
    (callable === OBJECT_DEFINE_PROPERTY || callable === REFLECT_DEFINE_PROPERTY) &&
    isIndexedPrototype(args[0])
  ) {
    if (affectsInternalArraySlots(args[1])) indexedPrototypeUnsafe = true;
    if (isLiteralAssignmentUnsafeDescriptor(args[2])) prototypeSetterUnsafe = true;
  } else if (callable === OBJECT_DEFINE_PROPERTIES && isIndexedPrototype(args[0]) && args[1]) {
    ARRAY_FOR_EACH(REFLECT_OWN_KEYS(args[1]), (key) => {
      const descriptor = args[1][key];
      if (affectsInternalArraySlots(key)) indexedPrototypeUnsafe = true;
      if (isLiteralAssignmentUnsafeDescriptor(descriptor)) prototypeSetterUnsafe = true;
    });
  } else if (
    (callable === OBJECT_SET_PROTOTYPE_OF || callable === REFLECT_SET_PROTOTYPE_OF) &&
    isIndexedPrototype(args[0])
  ) {
    indexedPrototypeUnsafe = true;
    prototypeSetterUnsafe = true;
  } else if (
    (callable === OBJECT_DEFINE_GETTER || callable === OBJECT_DEFINE_SETTER) &&
    isIndexedPrototype(thisValue)
  ) {
    if (affectsInternalArraySlots(args[0])) indexedPrototypeUnsafe = true;
    // __defineGetter__ installs a getter-only accessor; assignment through
    // it has no setter to call, so literal init must not assign either.
    prototypeSetterUnsafe = true;
  } else if (
    callable === REFLECT_SET &&
    (isIndexedPrototype(args[0]) || isIndexedPrototype(args[3]))
  ) {
    // Reflect.set writes through its receiver (defaults to the target); a
    // __proto__ write invokes the host accessor and swaps the chain.
    if (args[1] === "__proto__") prototypeSetterUnsafe = true;
    else if (affectsInternalArraySlots(args[1])) indexedPrototypeUnsafe = true;
  }
}

// Fast locals stay on V8's ordinary packed-elements path. Array.from creates
// own data properties (rather than assigning through Array.prototype), so an
// ES5 program cannot intercept local initialization or later writes by
// installing an inherited numeric setter.
function createFastLocals(length) {
  // Small compiled frames dominate normal programs. Array literals are both
  // cheaper than Array.from per call and keep PACKED_ELEMENTS on V8.
  switch (length) {
    case 0:
      return [];
    case 1:
      return [void 0];
    case 2:
      return [void 0, void 0];
    case 3:
      return [void 0, void 0, void 0];
    case 4:
      return [void 0, void 0, void 0, void 0];
    case 5:
      return [void 0, void 0, void 0, void 0, void 0];
    case 6:
      return [void 0, void 0, void 0, void 0, void 0, void 0];
    case 7:
      return [void 0, void 0, void 0, void 0, void 0, void 0, void 0];
    case 8:
      return [void 0, void 0, void 0, void 0, void 0, void 0, void 0, void 0];
    default:
      break;
  }
  const source = OBJECT_CREATE(null);
  defineData(source, "length", length, false, false, false);
  return REFLECT_APPLY(ARRAY_FROM, undefined, [source]);
}

function createInternalArray(length = 0, hooks = null) {
  const array = createIsolatedArray(length);
  if (!hooks) return array;
  const push = function pushInternal(...values) {
    const result = REFLECT_APPLY(ARRAY_PUSH, array, values);
    if (hooks.onPush) hooks.onPush(values.length);
    return result;
  };
  const pop = function popInternal() {
    const hadValue = array.length > 0;
    const result = REFLECT_APPLY(ARRAY_POP, array, []);
    if (hadValue && hooks.onPop) hooks.onPop();
    return result;
  };
  const splice = function spliceInternal(...args) {
    const result = REFLECT_APPLY(ARRAY_SPLICE, array, args);
    if (hooks.onSplice) hooks.onSplice(args);
    return result;
  };
  defineData(array, "push", push, false, false, false);
  defineData(array, "pop", pop, false, false, false);
  defineData(array, "splice", splice, false, false, false);
  return array;
}

const STANDARD_GLOBALS = {
  Object,
  Function,
  Array,
  String,
  Boolean,
  Number,
  Math,
  Date,
  RegExp,
  Error,
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError,
  JSON,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  decodeURI,
  decodeURIComponent,
  encodeURI,
  encodeURIComponent,
  escape,
  unescape,
};

// Feature availability follows the host. Trusted programs receive these
// references directly; sandbox programs receive the mediated boundary view.
const OPTIONAL_STANDARD_GLOBAL_NAMES = [
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Symbol",
  "BigInt",
  "Reflect",
  "Proxy",
  "Atomics",
  "WeakRef",
  "FinalizationRegistry",
  "Intl",
];

function standardIntrinsicRoots() {
  const roots = OBJECT_KEYS(STANDARD_GLOBALS).map((name) => STANDARD_GLOBALS[name]);
  ARRAY_FOR_EACH(OPTIONAL_STANDARD_GLOBAL_NAMES, (name) => {
    if (typeof globalThis[name] !== "undefined") roots.push(globalThis[name]);
  });
  return roots;
}

function createGlobal(injected, boundary = null) {
  const globalObject = boundary ? OBJECT_CREATE(null) : {};
  ARRAY_FOR_EACH(OBJECT_KEYS(STANDARD_GLOBALS), (name) => {
    const value = boundary
      ? boundary.exposeIntrinsic(STANDARD_GLOBALS[name])
      : STANDARD_GLOBALS[name];
    defineData(globalObject, name, value, true, false, true);
  });
  ARRAY_FOR_EACH(OPTIONAL_STANDARD_GLOBAL_NAMES, (name) => {
    if (typeof globalThis[name] !== "undefined") {
      const value = boundary ? boundary.exposeIntrinsic(globalThis[name]) : globalThis[name];
      defineData(globalObject, name, value, true, false, true);
    }
  });
  defineData(globalObject, "NaN", NaN, false, false, false);
  defineData(globalObject, "Infinity", Infinity, false, false, false);
  defineData(globalObject, "undefined", undefined, false, false, false);
  const imported = boundary ? boundary.importGlobals(injected) : unwrapCapabilities(injected);
  if (imported != null) {
    ARRAY_FOR_EACH(REFLECT_OWN_KEYS(imported), (key) => {
      OBJECT_DEFINE_PROPERTY(
        globalObject,
        key,
        safePropertyDescriptor(OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(imported, key))
      );
    });
  }
  return globalObject;
}

// Keep observable property-write semantics behind a small lexical function.
// Optimized generated modules import this directly, which gives V8 a stable,
// monomorphic call target instead of a RuntimeInstance property lookup for
// every local/global store.
function writePropertyValue(frame, object, key, value) {
  return frame.metadata.strict
    ? writeStrictPropertyValue(object, key, value)
    : HOST_WRITE_SLOPPY_PROPERTY_VALUE(object, key, value);
}

function writeStrictPropertyValue(object, key, value, runtime, frame) {
  if (isIndexedPrototype(object)) {
    if (affectsInternalArraySlots(key)) {
      indexedPrototypeUnsafe = true;
      if (runtime && frame) runtime.hardenFastFrameChain(frame);
    }
    // Writing __proto__ on either prototype invokes Object.prototype's own
    // accessor and swaps the chain that literal init consults.
    if (key === "__proto__") prototypeSetterUnsafe = true;
  }
  object[key] = value;
  return value;
}

// Sloppy writes must keep silent-failure semantics, so they stay a call
// into the deliberately non-strict writer; the __proto__ swap check rides
// on the same call (V8 inlines this thin wrapper).
function writeSloppyPropertyValue(object, key, value) {
  if (isIndexedPrototype(object) && key === "__proto__") prototypeSetterUnsafe = true;
  return HOST_WRITE_SLOPPY_PROPERTY_VALUE(object, key, value);
}

function findBindingValue(runtime, frame, name) {
  for (let environment = frame.environment; environment; environment = environment.outer) {
    if (environment.kind === "object") {
      if (runtime.hasPropertyValue(environment.object, name)) {
        return { kind: "object", object: environment.object, name, withBase: true };
      }
    } else if (environment.kind === "catch") {
      if (runtime.hasPropertyValue(environment.object, name)) {
        return { kind: "object", object: environment.object, name };
      }
    } else if (environment.kind === "frame") {
      const owner = environment.frame;
      if (HAS_OWN_PROPERTY(owner.dynamicBindings, name)) {
        return { kind: "object", object: owner.dynamicBindings, name };
      }
      const localIndex = ARRAY_LAST_INDEX_OF(owner.metadata.variables, name);
      if (localIndex >= 0 && !owner.metadata.script) {
        return { kind: "local", frame: owner, index: localIndex + 1 };
      }
    }
  }
  if (runtime.hasPropertyValue(runtime.global, name)) {
    return { kind: "object", object: runtime.global, name };
  }
  return null;
}

function readBindingValue(runtime, binding) {
  return binding.kind === "local"
    ? binding.frame.locals[binding.index]
    : runtime.getPropertyValue(binding.object, binding.name);
}

function readVariableValue(runtime, frame, name, required) {
  const binding = findBindingValue(runtime, frame, name);
  if (!binding) {
    if (required) throw new ReferenceError(`${name} is not defined`);
    return undefined;
  }
  return readBindingValue(runtime, binding);
}

function readGlobalVariableValue(global, name, required) {
  if (name in global) return global[name];
  if (required) throw new ReferenceError(`${name} is not defined`);
  return undefined;
}

function writeGlobalVariableValue(frame, global, name, value) {
  if (!(name in global) && frame.metadata.strict) {
    throw new ReferenceError(`${name} is not defined`);
  }
  writePropertyValue(frame, global, name, value);
  return value;
}

function writeVariableValue(runtime, frame, name, value) {
  const binding = findBindingValue(runtime, frame, name);
  if (!binding) {
    if (frame.metadata.strict) throw new ReferenceError(`${name} is not defined`);
    runtime.writeProperty(frame, runtime.global, name, value);
  } else if (binding.kind === "local") {
    binding.frame.locals[binding.index] = value;
  } else {
    runtime.writeProperty(frame, binding.object, binding.name, value);
  }
  return value;
}

function deleteVariableValue(runtime, frame, name) {
  const binding = findBindingValue(runtime, frame, name);
  if (!binding || binding.kind === "local") return !binding;
  if (runtime.boundary) runtime.boundary.assertMutable(binding.object, "delete from");
  const target = runtime.boundary
    ? runtime.boundary.propertyTarget(binding.object)
    : binding.object;
  return REFLECT_DELETE_PROPERTY(target, binding.name);
}

function deleteGlobalVariableValue(global, name) {
  return REFLECT_DELETE_PROPERTY(global, name);
}

function getArgumentsValue(runtime, frame) {
  if (!frame.argumentsInitialized) {
    frame.argumentsObject = runtime.createArgumentsObject(frame, frame.callArgs);
    frame.argumentsInitialized = true;
  }
  return frame.argumentsObject;
}

function setArgumentsValue(frame, value) {
  frame.argumentsObject = value;
  frame.argumentsInitialized = true;
  return value;
}

function applyValue(runtime, frame, callable, thisValue, args) {
  if (typeof callable !== "function") throw new TypeError(`${String(callable)} is not a function`);
  observePrototypeMutation(callable, thisValue, args);
  if (indexedPrototypeUnsafe) runtime.hardenFastFrameChain(frame);
  return REFLECT_APPLY(callable, thisValue, args);
}

function constructValue(constructor, args) {
  if (typeof constructor !== "function")
    throw new TypeError(`${String(constructor)} is not a constructor`);
  return REFLECT_CONSTRUCT(constructor, args);
}

function getSandboxPropertyValue(runtime, object, key) {
  return runtime.boundary.get(object, key);
}

function instanceOfTarget(runtime, value) {
  return runtime.boundary.propertyTarget(value);
}

function setSandboxPropertyValue(runtime, writer, object, key, value) {
  const boundary = runtime.boundary;
  const target = boundary.writeTarget(object, "modify");
  const stored = typeof value === "function" ? boundary.secureValue(value) : value;
  writer(target, key, stored);
  return value;
}

// Slim sandbox write path for provably guest-created objects (literals,
// closures, and provenance-marked locals). writeTarget would be a no-op for
// them — they are never wrappers, capability tokens, or protected
// intrinsics — so this keeps only the value securing and the strict/sloppy
// writer dispatch of setSandboxPropertyValue.
function setGuestPropertyValue(runtime, frame, object, key, value) {
  const stored = typeof value === "function" ? runtime.boundary.secureValue(value) : value;
  return writePropertyValue(frame, object, key, stored);
}

// Sandbox call dispatch. The codegen calls the arity-specialized variant
// matching the call site's static argument count, so a guest call never
// builds an args array: the captured Function.prototype.call forwards the
// fixed arguments without materializing a list (V8 lowers `.call` on a
// plain callee to a direct call). A call-heavy tuning workload showed that
// per-site membership memoization can regress throughput substantially, so
// keep the generic direct check.
// (V8's native WeakSet.has beats a manual array memo — 8.4 ns vs 15.7 ns
// per hit), while the WeakSet probe itself is the cheap half of dispatch;
// the win came from collapsing the guest fast path into the dispatch
// function and dropping the per-call array allocation. Non-guest callables
// fall back to boundary.call with a lazily built array; that path also
// serves arities above the specialized range.
function applySandboxValue0(runtime, callable, thisValue) {
  const boundary = runtime.boundary;
  if (boundary.guestFunctions.has(callable)) {
    boundary.count("calls");
    boundary.count("guestCalls");
    const previousEntries = boundary.pendingGuestEntries;
    boundary.pendingGuestEntries += 1;
    try {
      return FUNCTION_CALL.call(callable, thisValue);
    } finally {
      boundary.pendingGuestEntries = previousEntries;
    }
  }
  if (typeof callable !== "function") {
    throw new TypeError(`${String(callable)} is not a function`);
  }
  return boundary.call(callable, thisValue, []);
}

function applySandboxValue1(runtime, callable, thisValue, a0) {
  const boundary = runtime.boundary;
  if (boundary.guestFunctions.has(callable)) {
    boundary.count("calls");
    boundary.count("guestCalls");
    const previousEntries = boundary.pendingGuestEntries;
    boundary.pendingGuestEntries += 1;
    try {
      return FUNCTION_CALL.call(callable, thisValue, a0);
    } finally {
      boundary.pendingGuestEntries = previousEntries;
    }
  }
  if (typeof callable !== "function") {
    throw new TypeError(`${String(callable)} is not a function`);
  }
  return boundary.call(callable, thisValue, [a0]);
}

function applySandboxValue2(runtime, callable, thisValue, a0, a1) {
  const boundary = runtime.boundary;
  if (boundary.guestFunctions.has(callable)) {
    boundary.count("calls");
    boundary.count("guestCalls");
    const previousEntries = boundary.pendingGuestEntries;
    boundary.pendingGuestEntries += 1;
    try {
      return FUNCTION_CALL.call(callable, thisValue, a0, a1);
    } finally {
      boundary.pendingGuestEntries = previousEntries;
    }
  }
  if (typeof callable !== "function") {
    throw new TypeError(`${String(callable)} is not a function`);
  }
  return boundary.call(callable, thisValue, [a0, a1]);
}

function applySandboxValue3(runtime, callable, thisValue, a0, a1, a2) {
  const boundary = runtime.boundary;
  if (boundary.guestFunctions.has(callable)) {
    boundary.count("calls");
    boundary.count("guestCalls");
    const previousEntries = boundary.pendingGuestEntries;
    boundary.pendingGuestEntries += 1;
    try {
      return FUNCTION_CALL.call(callable, thisValue, a0, a1, a2);
    } finally {
      boundary.pendingGuestEntries = previousEntries;
    }
  }
  if (typeof callable !== "function") {
    throw new TypeError(`${String(callable)} is not a function`);
  }
  return boundary.call(callable, thisValue, [a0, a1, a2]);
}

function applySandboxValue4(runtime, callable, thisValue, a0, a1, a2, a3) {
  const boundary = runtime.boundary;
  if (boundary.guestFunctions.has(callable)) {
    boundary.count("calls");
    boundary.count("guestCalls");
    const previousEntries = boundary.pendingGuestEntries;
    boundary.pendingGuestEntries += 1;
    try {
      return FUNCTION_CALL.call(callable, thisValue, a0, a1, a2, a3);
    } finally {
      boundary.pendingGuestEntries = previousEntries;
    }
  }
  if (typeof callable !== "function") {
    throw new TypeError(`${String(callable)} is not a function`);
  }
  return boundary.call(callable, thisValue, [a0, a1, a2, a3]);
}

function applySandboxValue5(runtime, callable, thisValue, a0, a1, a2, a3, a4) {
  const boundary = runtime.boundary;
  if (boundary.guestFunctions.has(callable)) {
    boundary.count("calls");
    boundary.count("guestCalls");
    const previousEntries = boundary.pendingGuestEntries;
    boundary.pendingGuestEntries += 1;
    try {
      return FUNCTION_CALL.call(callable, thisValue, a0, a1, a2, a3, a4);
    } finally {
      boundary.pendingGuestEntries = previousEntries;
    }
  }
  if (typeof callable !== "function") {
    throw new TypeError(`${String(callable)} is not a function`);
  }
  return boundary.call(callable, thisValue, [a0, a1, a2, a3, a4]);
}

// Generic array form: arities above 5, and the pre-arity-specialized entry
// point retained for callers outside the codegen hot path.
function applySandboxValue(runtime, callable, thisValue, args) {
  const boundary = runtime.boundary;
  if (boundary.guestFunctions.has(callable)) {
    boundary.count("calls");
    boundary.count("guestCalls");
    const previousEntries = boundary.pendingGuestEntries;
    boundary.pendingGuestEntries += 1;
    try {
      return REFLECT_APPLY(callable, thisValue, args);
    } finally {
      boundary.pendingGuestEntries = previousEntries;
    }
  }
  if (typeof callable !== "function") {
    throw new TypeError(`${String(callable)} is not a function`);
  }
  return boundary.call(callable, thisValue, args);
}

function constructSandboxValue(runtime, constructor, args) {
  if (typeof constructor !== "function") {
    throw new TypeError(`${String(constructor)} is not a constructor`);
  }
  return runtime.boundary.construct(constructor, args);
}

// Arity-specialized sandbox construct dispatch, the `new` analog of
// applySandboxValueN: the callee-side variant matches the static argument
// count, so guest constructions never allocate an args array — `new`
// forwards the fixed arguments directly, and the pendingGuestEntries
// counter keeps the compiled closure's prologue from re-securing values
// already inside guest space. `new` on a guest closure is exactly
// Reflect.construct (both set new.target, build the fresh `this` with
// `constructor.prototype`, and run the closure's construct-as-call return
// rule), so the fast path is behavior-preserving. Non-guest constructors
// (wrappers, protected intrinsics, host functions) fall back to the generic
// boundary path with a lazily built array; that path also serves arities
// above the specialized range.
function constructSandboxValue0(runtime, constructor) {
  const boundary = runtime.boundary;
  if (boundary.guestFunctions.has(constructor)) {
    boundary.count("constructs");
    boundary.count("guestConstructs");
    const previousEntries = boundary.pendingGuestEntries;
    boundary.pendingGuestEntries += 1;
    try {
      return new constructor();
    } finally {
      boundary.pendingGuestEntries = previousEntries;
    }
  }
  return constructSandboxValue(runtime, constructor, []);
}

function constructSandboxValue1(runtime, constructor, a0) {
  const boundary = runtime.boundary;
  if (boundary.guestFunctions.has(constructor)) {
    boundary.count("constructs");
    boundary.count("guestConstructs");
    const previousEntries = boundary.pendingGuestEntries;
    boundary.pendingGuestEntries += 1;
    try {
      return new constructor(a0);
    } finally {
      boundary.pendingGuestEntries = previousEntries;
    }
  }
  return constructSandboxValue(runtime, constructor, [a0]);
}

function constructSandboxValue2(runtime, constructor, a0, a1) {
  const boundary = runtime.boundary;
  if (boundary.guestFunctions.has(constructor)) {
    boundary.count("constructs");
    boundary.count("guestConstructs");
    const previousEntries = boundary.pendingGuestEntries;
    boundary.pendingGuestEntries += 1;
    try {
      return new constructor(a0, a1);
    } finally {
      boundary.pendingGuestEntries = previousEntries;
    }
  }
  return constructSandboxValue(runtime, constructor, [a0, a1]);
}

function constructSandboxValue3(runtime, constructor, a0, a1, a2) {
  const boundary = runtime.boundary;
  if (boundary.guestFunctions.has(constructor)) {
    boundary.count("constructs");
    boundary.count("guestConstructs");
    const previousEntries = boundary.pendingGuestEntries;
    boundary.pendingGuestEntries += 1;
    try {
      return new constructor(a0, a1, a2);
    } finally {
      boundary.pendingGuestEntries = previousEntries;
    }
  }
  return constructSandboxValue(runtime, constructor, [a0, a1, a2]);
}

function constructSandboxValue4(runtime, constructor, a0, a1, a2, a3) {
  const boundary = runtime.boundary;
  if (boundary.guestFunctions.has(constructor)) {
    boundary.count("constructs");
    boundary.count("guestConstructs");
    const previousEntries = boundary.pendingGuestEntries;
    boundary.pendingGuestEntries += 1;
    try {
      return new constructor(a0, a1, a2, a3);
    } finally {
      boundary.pendingGuestEntries = previousEntries;
    }
  }
  return constructSandboxValue(runtime, constructor, [a0, a1, a2, a3]);
}

function constructSandboxValue5(runtime, constructor, a0, a1, a2, a3, a4) {
  const boundary = runtime.boundary;
  if (boundary.guestFunctions.has(constructor)) {
    boundary.count("constructs");
    boundary.count("guestConstructs");
    const previousEntries = boundary.pendingGuestEntries;
    boundary.pendingGuestEntries += 1;
    try {
      return new constructor(a0, a1, a2, a3, a4);
    } finally {
      boundary.pendingGuestEntries = previousEntries;
    }
  }
  return constructSandboxValue(runtime, constructor, [a0, a1, a2, a3, a4]);
}

function invokeCompiledFunction(
  runtime,
  execute,
  metadata,
  environment,
  compiled,
  receiver,
  constructing,
  args
) {
  if (runtime.boundary && !runtime.boundary.consumeInternalGuestEntry()) {
    receiver = runtime.boundary.secureValue(receiver);
    args = runtime.boundary.secureArguments(args);
    // Host-initiated entries (no program execution active) copy plain-data
    // values like globals do; nested host callbacks during execution keep
    // guest reference semantics.
    if (!runtime.boundary.guestExecutionActive) {
      receiver = runtime.boundary.secureHostEntryValue(receiver);
      args = runtime.boundary.secureHostEntryArguments(args);
    }
  }
  let thisValue = receiver;
  if (!metadata.strict) {
    if (thisValue === undefined || thisValue === null) thisValue = runtime.global;
    else if (typeof thisValue !== "object" && typeof thisValue !== "function")
      thisValue = Object(thisValue);
  }
  const child = runtime.createFrame(metadata, thisValue, args, compiled, environment);
  child.callerFrame = runtime.currentFrame;
  runtime.currentFrame = child;
  let result;
  try {
    result = execute(runtime, child);
  } finally {
    runtime.currentFrame = child.callerFrame;
  }
  if (
    constructing &&
    (result === null || (typeof result !== "object" && typeof result !== "function"))
  ) {
    return thisValue;
  }
  return result;
}

const RESTRICTED_ACCESSOR = () => {
  throw new TypeError("Restricted function property access");
};

function createSloppyAccessors(runtime) {
  const findActiveFrame = (compiled) => {
    let active = runtime.currentFrame;
    while (active !== null) {
      if (active.currentFunction === compiled) return active;
      active = active.callerFrame;
    }
    return null;
  };
  return {
    // Shared across closures: the accessor runs with `this` set to the
    // compiled function it was read from, so `compiled` comes from `this`.
    caller() {
      const active = findActiveFrame(this);
      if (active === null || active.callerFrame === null) return null;
      const caller = active.callerFrame;
      if (caller.metadata.strict) throw new TypeError("Strict function caller is restricted");
      return caller.currentFunction;
    },
    arguments() {
      const active = findActiveFrame(this);
      if (active === null) return null;
      return getArgumentsValue(runtime, active);
    },
  };
}

function initializeCompiledFunction(runtime, compiled, metadata) {
  // Brand unconditionally (also in trusted mode, which never registers guest
  // functions): a guest closure must be recognizable as runtime-owned when a
  // different instance re-injects it via globals.
  brandRuntimeCallable(compiled);
  if (metadata.name) {
    // Descriptors must be null-prototype: a plain literal inherits
    // Object.prototype, so guest-visible pollution (e.g. a "value" property)
    // would make the host see an invalid mixed descriptor and throw.
    OBJECT_DEFINE_PROPERTY(compiled, "name", dataDescriptor(metadata.name, false, false, true));
  }
  // ES5.1 13.2 step 15: a compiled function's length is not writable,
  // enumerable, or configurable. Native host functions use newer descriptor
  // rules, but compiled functions retain the target language semantics.
  OBJECT_DEFINE_PROPERTY(
    compiled,
    "length",
    dataDescriptor(metadata.parameterCount, false, false, false)
  );
  if (metadata.strict) {
    OBJECT_DEFINE_PROPERTY(
      compiled,
      "caller",
      accessorDescriptor(RESTRICTED_ACCESSOR, RESTRICTED_ACCESSOR, false, false)
    );
    OBJECT_DEFINE_PROPERTY(
      compiled,
      "arguments",
      accessorDescriptor(RESTRICTED_ACCESSOR, RESTRICTED_ACCESSOR, false, false)
    );
  } else {
    const accessors =
      runtime.sloppyAccessors || (runtime.sloppyAccessors = createSloppyAccessors(runtime));
    OBJECT_DEFINE_PROPERTY(
      compiled,
      "caller",
      accessorDescriptor(accessors.caller, undefined, false, false)
    );
    OBJECT_DEFINE_PROPERTY(
      compiled,
      "arguments",
      accessorDescriptor(accessors.arguments, undefined, false, false)
    );
  }
  if (runtime.boundary) runtime.boundary.registerGuestFunction(compiled);
  return compiled;
}

class RuntimeInstance {
  constructor(execute, metadata, scopeTable, options = {}, programOptions = {}) {
    this.execute = execute;
    this.metadata = metadata;
    this.scopeTable = scopeTable;
    this.security = programOptions.security || "trusted";
    if (options.security !== undefined && options.security !== this.security) {
      throw new Error(`sablejs security mode is compiled as ${this.security}`);
    }
    this.disposed = false;
    this.profileBoundary = options.profileBoundary === true;
    this.boundary =
      this.security === "sandbox"
        ? new SandboxBoundary(standardIntrinsicRoots(), () => this.disposed, this.profileBoundary)
        : null;
    this.global = createGlobal(options.globals, this.boundary);
    this.currentFrame = null;
    this.hasRun = false;
  }

  createFrame(metadata, thisValue, args, currentFunction, outerEnvironment, frameOptions = {}) {
    if (metadata.leafFrame) {
      const frame = {
        metadata,
        locals: createFastLocals(metadata.variables.length + 1),
        thisValue,
        currentFunction,
        callerFrame: null,
        callArgs: args,
      };
      for (let index = 0; index < metadata.parameterCount; index += 1) {
        frame.locals[index + 1] = args[index];
      }
      // Receiver-write classification stamp: computed once on the secured,
      // boxed receiver (thisValue arrived post-secure and post-box), so
      // sandbox writes to `this` skip per-write writeTarget resolution. The
      // underlying WeakMaps are monotone with respect to the receiver, so
      // the stamp cannot go stale mid-call.
      if (metadata.usesThisWrites && this.boundary) {
        frame.thisIsGuest = this.boundary.isUnmediatedWriteTarget(thisValue);
      }
      return frame;
    }
    const references = metadata.fastFrame ? createFastArray() : createInternalArray();
    // The receiver-marks mirror only matters when a with-environment can be
    // reached (the sole writers are getLocal/getVar on withBase bindings, and
    // the sole reader is the this-restore in call()). Scopes with no with in
    // their static ancestor chain can never see an object environment, so
    // their stacks stay plain and every push/pop is a native array op.
    const stack = metadata.fastFrame
      ? createFastArray()
      : createInternalArray(
          0,
          metadata.withMarks
            ? {
                onPush(count) {
                  for (let index = 0; index < count; index += 1) references.push(null);
                },
                onPop() {
                  references.pop();
                },
                onSplice(spliceArgs) {
                  const start = spliceArgs[0];
                  const deleteCount =
                    spliceArgs.length > 1 ? spliceArgs[1] : references.length - start;
                  references.splice(start, deleteCount);
                  for (let index = 2; index < spliceArgs.length; index += 1) {
                    references.splice(start + index - 2, 0, null);
                  }
                },
              }
            : null
        );
    const frame = {
      metadata,
      stack,
      references,
      locals: metadata.fastFrame
        ? createFastLocals(metadata.variables.length + 1)
        : createInternalArray(metadata.variables.length + 1),
      thisValue,
      currentFunction,
      environment: null,
      dynamicBindings: OBJECT_CREATE(null),
      evalFrame: !!frameOptions.evalFrame,
      evalTarget: frameOptions.evalTarget || null,
      callerFrame: null,
      callArgs: args,
      argumentsObject: null,
      argumentsInitialized: false,
      line: 0,
      column: 0,
    };
    frame.environment = { kind: "frame", frame, outer: outerEnvironment || null };
    for (let index = 0; index < metadata.parameterCount; index += 1) {
      frame.locals[index + 1] = args[index];
    }
    if (metadata.script && !frame.evalFrame) {
      ARRAY_FOR_EACH(metadata.variables, (name) => {
        if (!HAS_OWN_PROPERTY(this.global, name)) {
          defineData(this.global, name, undefined, true, true, false);
        }
      });
    }
    if (
      metadata.usesArguments &&
      !metadata.fastFrame &&
      !metadata.script &&
      ARRAY_INDEX_OF(metadata.variables, "arguments") === -1
    ) {
      const argumentsObject = this.createArgumentsObject(frame, args);
      frame.argumentsObject = argumentsObject;
      frame.argumentsInitialized = true;
      defineData(frame.dynamicBindings, "arguments", argumentsObject, true, true, false);
    }
    // Receiver-write classification stamp (see the leafFrame branch above).
    if (metadata.usesThisWrites && this.boundary) {
      frame.thisIsGuest = this.boundary.isUnmediatedWriteTarget(thisValue);
    }
    return frame;
  }

  createFastArray(length = 0) {
    return createFastArray(length);
  }

  hardenFastFrameChain(frame) {
    for (let current = frame; current; current = current.callerFrame) {
      if (!current.metadata.fastFrame) continue;
      if (current.stack && OBJECT_GET_PROTOTYPE_OF(current.stack) === ARRAY_PROTOTYPE) {
        OBJECT_SET_PROTOTYPE_OF(current.stack, INTERNAL_ARRAY_PROTO);
      }
      if (current.references && OBJECT_GET_PROTOTYPE_OF(current.references) === ARRAY_PROTOTYPE) {
        OBJECT_SET_PROTOTYPE_OF(current.references, INTERNAL_ARRAY_PROTO);
      }
    }
  }

  createArgumentsObject(frame, args) {
    // Start with the host Realm's actual Arguments exotic object so identity
    // checks such as Object.prototype.toString observe the browser model. The
    // ES5 mapped-parameter behavior is then expressed with own accessors.
    const object = REFLECT_APPLY(CAPTURE_ARGUMENTS_OBJECT, undefined, args);
    // Bundlers hoist "use strict" over the whole bundle, which turns the
    // capture helper strict: its Arguments object then carries PoisonPill
    // callee/caller accessors (non-configurable), and the defines below would
    // throw "Cannot redefine property: callee". Detect that capture and, for
    // sloppy frames, route the exposed object through the same proxy the
    // mapped-parameter path uses, with callee backed in a closure cell so
    // ES5 sloppy semantics hold even though the host exotic object is strict.
    const capturedCallee = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(object, "callee");
    const capturedStrictly = !capturedCallee || !capturedCallee.configurable;
    const mappedNames = new Set();
    const parameterMap = OBJECT_CREATE(null);
    let hasMappedParameters = false;
    for (let index = args.length - 1; index >= 0; index -= 1) {
      const name = frame.metadata.parameters[index];
      const localIndex = ARRAY_LAST_INDEX_OF(frame.metadata.variables, name) + 1;
      if (
        !frame.metadata.strict &&
        name !== undefined &&
        !mappedNames.has(name) &&
        localIndex > 0
      ) {
        mappedNames.add(name);
        parameterMap[index] = localIndex;
        hasMappedParameters = true;
      }
    }
    if (!capturedStrictly) {
      if (frame.metadata.strict) {
        const restricted = () => {
          throw new TypeError("Restricted arguments property access");
        };
        defineAccessor(object, "callee", restricted, restricted, false, false);
        defineAccessor(object, "caller", restricted, restricted, false, false);
      } else {
        defineData(object, "callee", frame.currentFunction, true, false, true);
      }
      if (!hasMappedParameters) return object;
    } else if (frame.metadata.strict) {
      // The host PoisonPill accessors already restrict callee/caller.
      if (!hasMappedParameters) return object;
    }
    return this.createArgumentsProxy(
      object,
      parameterMap,
      frame,
      capturedStrictly ? frame.currentFunction : undefined
    );
  }

  // A Proxy lets the exposed object retain native Arguments identity while
  // the compiled frame owns its lexical parameter slots. The traps implement
  // ES5's invisible [[ParameterMap]] without exposing accessor descriptors.
  // `sloppyCallee` is set when the host capture was strict but the frame is
  // sloppy: callee (and the legacy caller) then live in closure cells because
  // the strict exotic object's PoisonPill accessors cannot be redefined.
  createArgumentsProxy(object, parameterMap, frame, sloppyCallee) {
    let callee = sloppyCallee;
    let calleeAlive = typeof sloppyCallee !== "undefined";
    return new Proxy(object, {
      get(target, key, receiver) {
        if (key === Symbol.toStringTag) return "Arguments";
        if (calleeAlive && key === "callee") return callee;
        if (calleeAlive && key === "caller") return undefined;
        if (HAS_OWN_PROPERTY(parameterMap, key)) return frame.locals[parameterMap[key]];
        return REFLECT_GET(target, key, receiver);
      },
      set(target, key, value, receiver) {
        if (calleeAlive && key === "callee") {
          callee = value;
          return true;
        }
        if (calleeAlive && key === "caller") return true;
        if (HAS_OWN_PROPERTY(parameterMap, key)) {
          const updated = REFLECT_SET(target, key, value, target);
          if (updated) frame.locals[parameterMap[key]] = value;
          return updated;
        }
        return REFLECT_SET(target, key, value, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        if (calleeAlive && key === "callee") {
          return { value: callee, writable: true, enumerable: false, configurable: true };
        }
        if (calleeAlive && key === "caller") return undefined;
        const current = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(target, key);
        if (!current || !HAS_OWN_PROPERTY(parameterMap, key)) return current;
        const descriptor = safePropertyDescriptor(current);
        descriptor.value = frame.locals[parameterMap[key]];
        return descriptor;
      },
      defineProperty(target, key, descriptor) {
        if (calleeAlive && key === "callee") {
          if (HAS_OWN_PROPERTY(descriptor, "value")) callee = descriptor.value;
          return true;
        }
        const mapped = HAS_OWN_PROPERTY(parameterMap, key);
        const localIndex = mapped ? parameterMap[key] : 0;
        const updated = REFLECT_DEFINE_PROPERTY(target, key, safePropertyDescriptor(descriptor));
        if (!updated || !mapped) return updated;
        if (HAS_OWN_PROPERTY(descriptor, "value")) frame.locals[localIndex] = descriptor.value;
        if (
          HAS_OWN_PROPERTY(descriptor, "get") ||
          HAS_OWN_PROPERTY(descriptor, "set") ||
          (HAS_OWN_PROPERTY(descriptor, "writable") && descriptor.writable === false)
        ) {
          REFLECT_DELETE_PROPERTY(parameterMap, key);
        }
        return true;
      },
      deleteProperty(target, key) {
        if (calleeAlive && key === "callee") {
          calleeAlive = false;
          return true;
        }
        const deleted = REFLECT_DELETE_PROPERTY(target, key);
        if (deleted) REFLECT_DELETE_PROPERTY(parameterMap, key);
        return deleted;
      },
    });
  }

  run() {
    if (this.disposed) throw new Error("Cannot run a disposed sablejs instance");
    if (this.hasRun) throw new Error("A sablejs program instance can only run once");
    this.hasRun = true;
    const frame = this.createFrame(this.metadata, this.global, [], null, null);
    if (this.boundary) this.boundary.guestExecutionActive = true;
    try {
      return this.execute(this, frame);
    } finally {
      if (this.boundary) this.boundary.guestExecutionActive = false;
    }
  }

  dispose() {
    this.disposed = true;
    this.execute = null;
    this.metadata = null;
    this.currentFrame = null;
  }

  boundaryStats() {
    return this.boundary && this.boundary.stats;
  }

  pop(frame) {
    frame.stack.pop();
  }
  dup(frame) {
    const reference = frame.references[frame.references.length - 1];
    frame.stack.push(frame.stack[frame.stack.length - 1]);
    frame.references[frame.references.length - 1] = reference;
  }
  dup2(frame) {
    const firstReference = frame.references[frame.references.length - 2];
    const secondReference = frame.references[frame.references.length - 1];
    frame.stack.push(frame.stack[frame.stack.length - 2], frame.stack[frame.stack.length - 1]);
    frame.references[frame.references.length - 2] = firstReference;
    frame.references[frame.references.length - 1] = secondReference;
  }
  rot2(frame) {
    const stack = frame.stack;
    const references = frame.references;
    const value = stack[stack.length - 2];
    stack[stack.length - 2] = stack[stack.length - 1];
    stack[stack.length - 1] = value;
    const reference = references[references.length - 2];
    references[references.length - 2] = references[references.length - 1];
    references[references.length - 1] = reference;
  }
  rot3(frame) {
    const stack = frame.stack;
    const rotate = (values) => {
      const length = values.length;
      const last = values[length - 1];
      values[length - 1] = values[length - 2];
      values[length - 2] = values[length - 3];
      values[length - 3] = last;
    };
    rotate(stack);
    rotate(frame.references);
  }
  rot4(frame) {
    const stack = frame.stack;
    const rotate = (values) => {
      const length = values.length;
      const last = values[length - 1];
      values[length - 1] = values[length - 2];
      values[length - 2] = values[length - 3];
      values[length - 3] = values[length - 4];
      values[length - 4] = last;
    };
    rotate(stack);
    rotate(frame.references);
  }

  pushLiteral(frame, value) {
    frame.stack.push(value);
  }
  pushEmpty(frame) {
    frame.stack.push(EMPTY);
  }
  pushUndefined(frame) {
    frame.stack.push(undefined);
  }
  pushNull(frame) {
    frame.stack.push(null);
  }
  pushTrue(frame) {
    frame.stack.push(true);
  }
  pushFalse(frame) {
    frame.stack.push(false);
  }
  pushThis(frame) {
    frame.stack.push(frame.thisValue);
  }
  pushCurrent(frame) {
    frame.stack.push(frame.currentFunction);
  }
  newArray(frame) {
    frame.stack.push([]);
  }
  newObject(frame) {
    frame.stack.push({});
  }
  newRegExp(frame, pattern, flags) {
    frame.stack.push(new RegExp(pattern, flags));
  }

  getLocal(frame, index) {
    const name = frame.metadata.variables[index - 1];
    if (frame.evalFrame) {
      const target = frame.metadata.strict ? frame : frame.evalTarget;
      if (target.metadata.script && !target.evalFrame) frame.stack.push(this.global[name]);
      else {
        const targetIndex = ARRAY_LAST_INDEX_OF(target.metadata.variables, name);
        frame.stack.push(
          targetIndex >= 0 ? target.locals[targetIndex + 1] : target.dynamicBindings[name]
        );
      }
    } else if (!frame.metadata.lightweight) {
      const binding = this.findBinding(frame, name);
      frame.stack.push(binding ? this.readBinding(binding) : undefined);
      if (binding && binding.withBase) {
        frame.references[frame.references.length - 1] = binding.object;
      }
    } else if (frame.metadata.script) {
      frame.stack.push(this.global[name]);
    } else {
      frame.stack.push(frame.locals[index]);
    }
  }

  setLocal(frame, index) {
    this.writeLocalValue(frame, index, frame.stack[frame.stack.length - 1]);
  }

  // Value-oriented entry point used by the optimizing backend. Keeping the
  // binding semantics here lets generated code keep operands in JavaScript
  // locals without materializing them on frame.stack merely to perform a
  // local store.
  writeLocalValue(frame, index, value) {
    const name = frame.metadata.variables[index - 1];
    if (frame.evalFrame) {
      const target = frame.metadata.strict ? frame : frame.evalTarget;
      if (target.metadata.script && !target.evalFrame)
        this.writeProperty(frame, this.global, name, value);
      else {
        const targetIndex = ARRAY_LAST_INDEX_OF(target.metadata.variables, name);
        if (targetIndex >= 0) target.locals[targetIndex + 1] = value;
        else target.dynamicBindings[name] = value;
      }
    } else if (!frame.metadata.lightweight) {
      const binding = this.findBinding(frame, name);
      if (binding && binding.kind === "local") binding.frame.locals[binding.index] = value;
      else if (binding) this.writeProperty(frame, binding.object, binding.name, value);
      else if (frame.metadata.script) this.writeProperty(frame, this.global, name, value);
      else frame.locals[index] = value;
    } else if (frame.metadata.script) {
      this.writeProperty(frame, this.global, name, value);
    } else {
      frame.locals[index] = value;
    }
    return value;
  }

  deleteLocal(frame, index) {
    const name = frame.metadata.variables[index - 1];
    if (frame.evalFrame) {
      frame.stack.push(false);
    } else if (!frame.metadata.lightweight) {
      const binding = this.findBinding(frame, name);
      if (binding && binding.kind === "object" && binding.object !== this.global) {
        if (this.boundary) this.boundary.assertMutable(binding.object, "delete from");
        const target = this.boundary
          ? this.boundary.propertyTarget(binding.object)
          : binding.object;
        frame.stack.push(REFLECT_DELETE_PROPERTY(target, binding.name));
      } else {
        frame.stack.push(false);
      }
    } else if (frame.metadata.script) {
      frame.stack.push(delete this.global[name]);
    } else {
      frame.stack.push(false);
    }
  }

  findBinding(frame, name) {
    return findBindingValue(this, frame, name);
  }

  readBinding(binding) {
    return readBindingValue(this, binding);
  }

  hasVar(frame, name) {
    const binding = this.findBinding(frame, name);
    frame.stack.push(binding ? this.readBinding(binding) : undefined);
  }

  getVar(frame, name) {
    const binding = this.findBinding(frame, name);
    if (!binding) throw new ReferenceError(`${name} is not defined`);
    frame.stack.push(this.readBinding(binding));
    if (binding.withBase) frame.references[frame.references.length - 1] = binding.object;
  }

  setVar(frame, name) {
    const value = frame.stack[frame.stack.length - 1];
    const binding = this.findBinding(frame, name);
    if (!binding) {
      if (frame.metadata.strict) throw new ReferenceError(`${name} is not defined`);
      this.writeProperty(frame, this.global, name, value);
    } else if (binding.kind === "local") {
      binding.frame.locals[binding.index] = value;
    } else {
      this.writeProperty(frame, binding.object, binding.name, value);
    }
  }

  // Captures the identifier reference base before an assignment's rval
  // evaluates. ES5 8.7.2 creates the Reference when the left-hand side
  // evaluates and PutValue uses it even if the binding disappears in between
  // (e.g. `with (o) { x = (delete o.x, 2) }` must store into o).
  refVar(frame, name) {
    const binding = this.findBinding(frame, name);
    if (binding && binding.kind === "local") {
      frame.stack.push({ [REF_TOKEN]: true, frame: binding.frame, index: binding.index });
    } else {
      frame.stack.push(binding ? binding.object : null);
    }
  }

  putVar(frame, name) {
    const value = frame.stack.pop();
    const token = frame.stack.pop();
    if (token === null) {
      if (frame.metadata.strict) throw new ReferenceError(`${name} is not defined`);
      this.writeProperty(frame, this.global, name, value);
    } else if (token[REF_TOKEN]) {
      token.frame.locals[token.index] = value;
    } else {
      this.writeProperty(frame, token, name, value);
    }
    // The assignment expression's value is the expression result.
    frame.stack.push(value);
  }

  deleteVar(frame, name) {
    const binding = this.findBinding(frame, name);
    if (!binding || binding.kind === "local") frame.stack.push(!binding);
    else {
      if (this.boundary) this.boundary.assertMutable(binding.object, "delete from");
      const target = this.boundary ? this.boundary.propertyTarget(binding.object) : binding.object;
      frame.stack.push(REFLECT_DELETE_PROPERTY(target, binding.name));
    }
  }

  inOperator(frame) {
    const right = frame.stack.pop();
    const left = frame.stack.pop();
    frame.stack.push(this.hasPropertyValue(right, left));
  }

  initProperty(frame) {
    let value = frame.stack.pop();
    const key = frame.stack.pop();
    const object = frame.stack[frame.stack.length - 1];
    if (this.boundary) this.boundary.assertMutable(object, "initialize a property on");
    if (this.boundary && typeof value === "function") value = this.boundary.secureValue(value);
    if (value === EMPTY && ARRAY_IS_ARRAY(object)) {
      const index = Number(key);
      if (Number.isInteger(index) && index >= object.length) object.length = index + 1;
    } else if (value !== EMPTY) {
      // The literal object is fresh (no own accessors, extensible, chained
      // only to Array.prototype/Object.prototype), so a plain assignment
      // creates the same own data property as defineData — except when an
      // inherited accessor/non-writable property exists
      // (prototypeSetterUnsafe) or the key is
      // __proto__ (host Object.prototype's own accessor). Object-literal
      // semantics must bypass both, so those stay on defineData.
      if (key !== "__proto__" && !prototypeSetterUnsafe) {
        object[key] = value;
      } else {
        defineData(object, key, value, true, true, true);
      }
    }
  }

  initGetter(frame) {
    const getter = frame.stack.pop();
    const key = frame.stack.pop();
    const object = frame.stack[frame.stack.length - 1];
    if (this.boundary) this.boundary.assertMutable(object, "initialize an accessor on");
    const previous = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(object, key);
    defineAccessor(object, key, getter, previous && previous.set, true, true);
  }

  initSetter(frame) {
    const setter = frame.stack.pop();
    const key = frame.stack.pop();
    const object = frame.stack[frame.stack.length - 1];
    if (this.boundary) this.boundary.assertMutable(object, "initialize an accessor on");
    const previous = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(object, key);
    defineAccessor(object, key, previous && previous.get, setter, true, true);
  }

  getProperty(frame) {
    const key = frame.stack.pop();
    const object = frame.stack.pop();
    frame.stack.push(this.getPropertyValue(object, key));
  }
  getPropertyStatic(frame, key) {
    const object = frame.stack.pop();
    frame.stack.push(this.getPropertyValue(object, key));
  }
  getPropertyValue(object, key) {
    return this.boundary ? this.boundary.get(object, key) : object[key];
  }
  hasPropertyValue(object, key) {
    const target = this.boundary ? this.boundary.propertyTarget(object) : object;
    return key in target;
  }
  writeProperty(frame, object, key, value) {
    if (!this.boundary) {
      writePropertyValue(frame, object, key, value);
      return value;
    }
    const target = this.boundary.writeTarget(object, "modify");
    const stored = typeof value === "function" ? this.boundary.secureValue(value) : value;
    writePropertyValue(frame, target, key, stored);
    return value;
  }
  setProperty(frame) {
    const value = frame.stack.pop();
    const key = frame.stack.pop();
    const object = frame.stack.pop();
    this.writeProperty(frame, object, key, value);
    frame.stack.push(value);
  }
  setPropertyStatic(frame, key) {
    const value = frame.stack.pop();
    const object = frame.stack.pop();
    this.writeProperty(frame, object, key, value);
    frame.stack.push(value);
  }
  deleteProperty(frame) {
    const key = frame.stack.pop();
    const object = frame.stack.pop();
    if (this.boundary) this.boundary.assertMutable(object, "delete from");
    const target = this.boundary ? this.boundary.propertyTarget(Object(object)) : Object(object);
    const result = REFLECT_DELETE_PROPERTY(target, key);
    if (!result && frame.metadata.strict)
      throw new TypeError(`Cannot delete property ${String(key)}`);
    frame.stack.push(result);
  }
  deletePropertyStatic(frame, key) {
    const object = frame.stack.pop();
    if (this.boundary) this.boundary.assertMutable(object, "delete from");
    const target = this.boundary ? this.boundary.propertyTarget(Object(object)) : Object(object);
    const result = REFLECT_DELETE_PROPERTY(target, key);
    if (!result && frame.metadata.strict)
      throw new TypeError(`Cannot delete property ${String(key)}`);
    frame.stack.push(result);
  }

  iterator(frame) {
    const value = Object(frame.stack.pop());
    const object = this.boundary ? this.boundary.propertyTarget(value) : value;
    const keys = createInternalArray();
    for (const key in object) keys.push(key);
    frame.stack.push({ object, keys, index: 0 });
  }
  nextIterator(frame) {
    const iterator = frame.stack[frame.stack.length - 1];
    while (iterator.index < iterator.keys.length) {
      const key = iterator.keys[iterator.index++];
      // ES5 permits deletion during enumeration. A key captured by the host
      // enumerator is skipped if it no longer exists when its turn arrives.
      if (key in iterator.object) {
        frame.stack.push(key, true);
        return;
      }
    }
    frame.stack.pop();
    frame.stack.push(false);
  }

  makeClosure(execute, metadata, environment) {
    const runtime = this;
    let compiled;
    compiled = function sableCompiledFunction(...args) {
      const constructing = new.target !== undefined;
      let thisValue = this;
      if (runtime.boundary && !runtime.boundary.consumeInternalGuestEntry()) {
        thisValue = runtime.boundary.secureValue(thisValue);
        args = runtime.boundary.secureArguments(args);
        if (!runtime.boundary.guestExecutionActive) {
          thisValue = runtime.boundary.secureHostEntryValue(thisValue);
          args = runtime.boundary.secureHostEntryArguments(args);
        }
      }
      if (!metadata.strict) {
        if (thisValue === undefined || thisValue === null) thisValue = runtime.global;
        else if (typeof thisValue !== "object" && typeof thisValue !== "function")
          thisValue = Object(thisValue);
      }
      const child = runtime.createFrame(metadata, thisValue, args, compiled, environment);
      child.callerFrame = runtime.currentFrame;
      runtime.currentFrame = child;
      let result;
      try {
        result = execute(runtime, child);
      } finally {
        runtime.currentFrame = child.callerFrame;
      }
      if (
        constructing &&
        (result === null || (typeof result !== "object" && typeof result !== "function"))
      ) {
        return thisValue;
      }
      return result;
    };
    return initializeCompiledFunction(runtime, compiled, metadata);
  }

  closureFactory(frame, factory) {
    frame.stack.push(factory(this, frame.environment));
  }

  closure(frame, execute, metadata) {
    frame.stack.push(this.makeClosure(execute, metadata, frame.environment));
  }

  evalStatic(frame, execute, metadata) {
    frame.stack.pop();
    const target = frame.evalTarget || frame;
    const evalFrame = this.createFrame(
      metadata,
      frame.thisValue,
      [],
      frame.currentFunction,
      frame.environment,
      { evalFrame: true, evalTarget: target }
    );
    if (!metadata.strict) {
      ARRAY_FOR_EACH(metadata.variables, (name) => {
        if (target.metadata.script && !target.evalFrame) {
          if (!(name in this.global)) {
            defineData(this.global, name, undefined, true, true, true);
          }
        } else if (
          ARRAY_LAST_INDEX_OF(target.metadata.variables, name) < 0 &&
          !HAS_OWN_PROPERTY(target.dynamicBindings, name)
        ) {
          target.dynamicBindings[name] = undefined;
        }
      });
    }
    frame.stack.push(execute(this, evalFrame));
  }

  rejectDynamicEval() {
    throw new SyntaxError("Dynamic eval source is not supported; use a compile-time literal");
  }

  dynamicFunction(frame, index) {
    const scopeId = frame.metadata.dynamicFunctions[index];
    if (scopeId === -1 || scopeId === undefined) {
      throw new SyntaxError("Dynamic Function source is not supported; use compile-time literals");
    }
    const descriptor = this.scopeTable[scopeId];
    return descriptor.factory
      ? descriptor.factory(this, null)
      : this.makeClosure(descriptor.execute, descriptor.metadata, null);
  }

  call(frame, count) {
    const stack = frame.stack;
    const references = frame.references;
    const length = stack.length;
    const callableIndex = length - count - 2;
    const referenceThis = references[callableIndex];
    const argsStart = length - count;
    // Args are collected on the isolated internal-array chain: index writes
    // must not walk a guest-polluted Array.prototype (a getter-only or
    // read-only accessor on an index would throw where splice used to define).
    const args = createInternalArray(count);
    for (let index = 0; index < count; index += 1) args[index] = stack[argsStart + index];
    let thisValue = stack[argsStart - 1];
    const callable = stack[callableIndex];
    // Consume the args + receiver + callee slots by trimming instead of
    // splicing: no element shifts, no hooked splice. references keeps the
    // same parallel trim, and later pushes overwrite the stale slots.
    stack.length = callableIndex;
    references.length = callableIndex;
    if (thisValue === undefined && referenceThis !== null && referenceThis !== undefined) {
      thisValue = referenceThis;
    }
    if (typeof callable !== "function")
      throw new TypeError(`${String(callable)} is not a function`);
    observePrototypeMutation(callable, thisValue, args);
    if (indexedPrototypeUnsafe) this.hardenFastFrameChain(frame);
    if (
      (callable === Function || (this.boundary && this.boundary.isFunctionConstructor(callable))) &&
      count === 1 &&
      frame.metadata.dynamicFunctions.length
    ) {
      frame.stack.push(this.dynamicFunction(frame, Number(args[0])));
    } else if (this.boundary) {
      frame.stack.push(this.boundary.call(callable, thisValue, args));
    } else {
      frame.stack.push(REFLECT_APPLY(callable, thisValue, args));
    }
  }
  construct(frame, count) {
    const stack = frame.stack;
    const references = frame.references;
    const length = stack.length;
    const argsStart = length - count;
    const constructorIndex = length - count - 1;
    // Args are collected on the isolated internal-array chain: index writes
    // must not walk a guest-polluted Array.prototype (a getter-only or
    // read-only accessor on an index would throw where splice used to define).
    const args = createInternalArray(count);
    for (let index = 0; index < count; index += 1) args[index] = stack[argsStart + index];
    const constructor = stack[constructorIndex];
    stack.length = constructorIndex;
    references.length = constructorIndex;
    if (typeof constructor !== "function")
      throw new TypeError(`${String(constructor)} is not a constructor`);
    if (
      (constructor === Function ||
        (this.boundary && this.boundary.isFunctionConstructor(constructor))) &&
      count === 1 &&
      frame.metadata.dynamicFunctions.length
    ) {
      frame.stack.push(this.dynamicFunction(frame, Number(args[0])));
    } else if (this.boundary) {
      frame.stack.push(this.boundary.construct(constructor, args));
    } else {
      frame.stack.push(REFLECT_CONSTRUCT(constructor, args));
    }
  }

  unary(frame, operation) {
    frame.stack.push(operation(frame.stack.pop()));
  }
  binary(frame, operation) {
    const right = frame.stack.pop();
    const left = frame.stack.pop();
    frame.stack.push(operation(left, right));
  }
  typeOf(frame) {
    this.unary(frame, (value) => typeof value);
  }
  positive(frame) {
    this.unary(frame, (value) => +value);
  }
  negative(frame) {
    this.unary(frame, (value) => -value);
  }
  bitNot(frame) {
    this.unary(frame, (value) => ~value);
  }
  logicalNot(frame) {
    this.unary(frame, (value) => !value);
  }
  increment(frame) {
    this.unary(frame, (value) => +value + 1);
  }
  decrement(frame) {
    this.unary(frame, (value) => +value - 1);
  }
  postIncrement(frame) {
    const value = +frame.stack.pop();
    frame.stack.push(value + 1, value);
  }
  postDecrement(frame) {
    const value = +frame.stack.pop();
    frame.stack.push(value - 1, value);
  }
  multiply(frame) {
    this.binary(frame, (left, right) => left * right);
  }
  divide(frame) {
    this.binary(frame, (left, right) => left / right);
  }
  modulo(frame) {
    this.binary(frame, (left, right) => left % right);
  }
  add(frame) {
    this.binary(frame, (left, right) => left + right);
  }
  subtract(frame) {
    this.binary(frame, (left, right) => left - right);
  }
  shiftLeft(frame) {
    this.binary(frame, (left, right) => left << right);
  }
  shiftRight(frame) {
    this.binary(frame, (left, right) => left >> right);
  }
  shiftRightUnsigned(frame) {
    this.binary(frame, (left, right) => left >>> right);
  }
  lessThan(frame) {
    this.binary(frame, (left, right) => left < right);
  }
  greaterThan(frame) {
    this.binary(frame, (left, right) => left > right);
  }
  lessThanOrEqual(frame) {
    this.binary(frame, (left, right) => left <= right);
  }
  greaterThanOrEqual(frame) {
    this.binary(frame, (left, right) => left >= right);
  }
  equal(frame) {
    this.binary(frame, (left, right) => left == right);
  }
  notEqual(frame) {
    this.binary(frame, (left, right) => left != right);
  }
  strictEqual(frame) {
    this.binary(frame, (left, right) => left === right);
  }
  strictNotEqual(frame) {
    this.binary(frame, (left, right) => left !== right);
  }
  bitAnd(frame) {
    this.binary(frame, (left, right) => left & right);
  }
  bitXor(frame) {
    this.binary(frame, (left, right) => left ^ right);
  }
  bitOr(frame) {
    this.binary(frame, (left, right) => left | right);
  }
  instanceOf(frame) {
    this.binary(
      frame,
      (left, right) => left instanceof (this.boundary ? this.boundary.propertyTarget(right) : right)
    );
  }

  caseJump(frame) {
    const candidate = frame.stack.pop();
    if (frame.stack[frame.stack.length - 1] === candidate) {
      frame.stack.pop();
      return true;
    }
    return false;
  }
  branch(frame) {
    return !!frame.stack.pop();
  }
  throwValue(frame) {
    throw frame.stack.pop();
  }
  tryCheckpoint(frame) {
    return { stackDepth: frame.stack.length, environment: frame.environment };
  }
  catchException(frame, checkpoint, error) {
    frame.stack.length = checkpoint.stackDepth;
    frame.references.length = checkpoint.stackDepth;
    frame.environment = checkpoint.environment;
    frame.stack.push(error);
  }
  beginCatch(frame, name) {
    const binding = OBJECT_CREATE(null);
    defineData(binding, name, frame.stack.pop(), true, true, false);
    frame.environment = { kind: "catch", object: binding, outer: frame.environment };
  }
  endCatch(frame) {
    frame.environment = frame.environment.outer;
  }
  beginWith(frame) {
    const value = frame.stack.pop();
    if (value === null || value === undefined)
      throw new TypeError("Cannot convert undefined or null to object");
    frame.environment = { kind: "object", object: Object(value), outer: frame.environment };
  }
  endWith(frame) {
    frame.environment = frame.environment.outer;
  }
  debuggerStatement() {}
  location(frame, line, column) {
    frame.line = line;
    frame.column = column;
  }
  result(frame) {
    return frame.stack.pop();
  }
}

function createProgram(
  execute,
  metadata,
  compilerAbi = ABI_VERSION,
  scopeTable = {},
  programOptions = {}
) {
  if (compilerAbi !== ABI_VERSION) {
    throw new Error(`sablejs AOT ABI mismatch: compiler=${compilerAbi}, runtime=${ABI_VERSION}`);
  }
  return Object.freeze({
    abiVersion: ABI_VERSION,
    security: programOptions.security || "trusted",
    createInstance(options) {
      return new RuntimeInstance(execute, metadata, scopeTable, options, programOptions);
    },
  });
}

module.exports = {
  ABI_VERSION,
  RuntimeInstance,
  capability,
  arrayPrototypeIndexOf,
  arrayPrototypeJoin,
  arrayPrototypePush,
  arrayPrototypeSlice,
  arrayPrototypeSort,
  applySandboxValue,
  applySandboxValue0,
  applySandboxValue1,
  applySandboxValue2,
  applySandboxValue3,
  applySandboxValue4,
  applySandboxValue5,
  applyValue,
  constructSandboxValue,
  constructSandboxValue0,
  constructSandboxValue1,
  constructSandboxValue2,
  constructSandboxValue3,
  constructSandboxValue4,
  constructSandboxValue5,
  constructValue,
  createProgram,
  deleteGlobalVariableValue,
  deleteVariableValue,
  getArgumentsValue,
  getSandboxPropertyValue,
  hostCallIntrinsic0,
  hostCallIntrinsic1,
  hostCallIntrinsic2,
  hostCallIntrinsic3,
  hostCallIntrinsic4,
  hostCallIntrinsic5,
  initializeCompiledFunction,
  isPrototypeSetterUnsafe,
  instanceOfTarget,
  invokeCompiledFunction,
  readGlobalVariableValue,
  readVariableValue,
  regexpPrototypeTest,
  setArgumentsValue,
  setGuestPropertyValue,
  setSandboxPropertyValue,
  stringPrototypeCharAt,
  stringPrototypeIndexOf,
  stringPrototypeReplace,
  stringPrototypeSlice,
  writeGlobalVariableValue,
  writeVariableValue,
  writePropertyValue,
  writeSloppyPropertyValue,
  writeStrictPropertyValue,
};

// Item 13: generated code calls this once per inlined literal init; it reads
// the live monotone flag (a plain data property on exports would go stale
// when the flag flips mid-run, and the generated code's $r is the runtime
// instance, not this module).
function isPrototypeSetterUnsafe() {
  return prototypeSetterUnsafe;
}
