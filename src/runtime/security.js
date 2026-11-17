"use strict";

const CAPABILITY_RECORDS = new WeakMap();

// Every callable the sablejs runtime itself manufactures is branded here:
// capability wrappers, mediated host-function wrappers, guest closures
// (sandbox and trusted), the dynamic-constructor guard, and the redacted
// toString. Module-level rather than per-boundary, so a callable surfaced by
// instance A is recognized by instance B — auto-wrap must never wrap a
// runtime-owned callable, and such callables stay rejected when re-injected
// into a different instance (cross-instance smuggling).
const RUNTIME_CALLABLES = new WeakSet();
function brandRuntimeCallable(callable) {
  RUNTIME_CALLABLES.add(callable);
  return callable;
}
// Wrapper -> raw host target, stored in a WeakMap rather than as a
// symbol-keyed property. A property read on a guest-owned proxy invokes the
// guest's get trap with the key, so a symbol tag would be observable (and
// forgeable through trap return values); WeakMap identity lookups never
// invoke proxy traps. Every introspection entry point
// (Object.getOwnPropertySymbols and friends) is still redirected through
// propertyTarget, so wrappers surface the raw target's own keys rather than
// any wrapper-surface artifacts.
const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_PROTOTYPE = Object.prototype;
const OWN_KEYS = Reflect.ownKeys;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_CONSTRUCT = Reflect.construct;
const REFLECT_GET = Reflect.get;
const FUNCTION_APPLY = Function.prototype.apply;
const FUNCTION_BIND = Function.prototype.bind;
const FUNCTION_CALL = Function.prototype.call;

const CODE_CONSTRUCTORS = new Set([Function]);
try {
  CODE_CONSTRUCTORS.add(async function () {}.constructor);
} catch (_) {}
try {
  CODE_CONSTRUCTORS.add(function* () {}.constructor);
} catch (_) {}
try {
  CODE_CONSTRUCTORS.add(async function* () {}.constructor);
} catch (_) {}

const MUTATES_ARGUMENT_ZERO = new Set(
  [
    Object.assign,
    Object.defineProperty,
    Object.defineProperties,
    Object.freeze,
    Object.preventExtensions,
    Object.seal,
    Object.setPrototypeOf,
    typeof Proxy === "function" && Proxy,
    typeof Proxy === "function" && Proxy.revocable,
    typeof Reflect === "object" && Reflect.defineProperty,
    typeof Reflect === "object" && Reflect.deleteProperty,
    typeof Reflect === "object" && Reflect.preventExtensions,
    typeof Reflect === "object" && Reflect.set,
    typeof Reflect === "object" && Reflect.setPrototypeOf,
  ].filter(Boolean)
);

const INSPECTS_ARGUMENT_ZERO = new Set(
  [
    Object.getOwnPropertyDescriptor,
    Object.getOwnPropertyDescriptors,
    Object.getOwnPropertyNames,
    Object.getOwnPropertySymbols,
    Object.getPrototypeOf,
    Object.isExtensible,
    Object.isFrozen,
    Object.isSealed,
    Object.keys,
    Object.entries,
    Object.values,
    typeof Reflect === "object" && Reflect.getOwnPropertyDescriptor,
    typeof Reflect === "object" && Reflect.getPrototypeOf,
    typeof Reflect === "object" && Reflect.isExtensible,
    typeof Reflect === "object" && Reflect.ownKeys,
  ].filter(Boolean)
);

const CAPTURE_STACK_TRACE =
  typeof Error.captureStackTrace === "function" && Error.captureStackTrace;
const FUNCTION_TO_STRING = Function.prototype.toString;
// Canonical typed-array constructors, in instanceof-safe order. Clones of
// subclassed views are rebuilt with their base constructor so only standard
// view semantics cross the boundary (same policy as Buffer -> Uint8Array).
const VIEW_BASE_CONSTRUCTORS = [
  "Uint8ClampedArray",
  "Int8Array",
  "Uint8Array",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]
  .map((name) => globalThis[name])
  .filter(Boolean);

const MUTATES_RECEIVER = new Set();
function addMutators(prototype, names) {
  if (!prototype) return;
  for (const name of names) {
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(prototype, name);
    if (descriptor && typeof descriptor.value === "function") {
      MUTATES_RECEIVER.add(descriptor.value);
    }
  }
}
addMutators(Object.prototype, ["__defineGetter__", "__defineSetter__"]);
const OBJECT_PROTO_DESCRIPTOR = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(Object.prototype, "__proto__");
if (OBJECT_PROTO_DESCRIPTOR && typeof OBJECT_PROTO_DESCRIPTOR.set === "function") {
  MUTATES_RECEIVER.add(OBJECT_PROTO_DESCRIPTOR.set);
}
addMutators(Array.prototype, [
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]);
addMutators(
  Date.prototype,
  OWN_KEYS(Date.prototype).filter((key) => typeof key === "string" && key.startsWith("set"))
);
addMutators(typeof Map === "function" && Map.prototype, ["clear", "delete", "set"]);
addMutators(typeof Set === "function" && Set.prototype, ["add", "clear", "delete"]);
addMutators(typeof WeakMap === "function" && WeakMap.prototype, ["delete", "set"]);
addMutators(typeof WeakSet === "function" && WeakSet.prototype, ["add", "delete"]);
addMutators(typeof RegExp === "function" && RegExp.prototype, ["compile"]);
for (const name of [
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
]) {
  const constructor = globalThis[name];
  addMutators(constructor && constructor.prototype, [
    "copyWithin",
    "fill",
    "reverse",
    "set",
    "sort",
  ]);
}

// Boundary errors are identified by identity, not by message: the message
// test runs in catch paths that may themselves be on an exhausted stack
// (a guest recursion overflow inside a mediated call), where even a regex
// compile or string coercion can throw and corrupt the reported error.
const BOUNDARY_ERRORS = new WeakSet();

function boundaryError(message) {
  const error = new TypeError(`sablejs sandbox boundary: ${message}`);
  BOUNDARY_ERRORS.add(error);
  // Boundary violations propagate into guest catch blocks; strip the stack
  // so host file paths and frames never cross the boundary.
  try {
    delete error.stack;
  } catch (_) {}
  return error;
}

// Shared catch tail for mediated calls: boundary errors pass through
// untouched; other host errors are sanitized. If even sanitization cannot
// run (stack exhaustion), the original error propagates — guests must see
// the engine's own failure, not a corruption of it.
function sanitizeHostError(error) {
  if (error && BOUNDARY_ERRORS.has(error)) return error;
  try {
    return safeError(error);
  } catch (_) {
    return error;
  }
}

function capability(callable, options = {}) {
  if (typeof callable !== "function") throw new TypeError("sablejs capability requires a function");
  if (options == null || typeof options !== "object") {
    throw new TypeError("sablejs capability options must be an object");
  }
  const token = OBJECT_FREEZE(OBJECT_CREATE(null));
  CAPABILITY_RECORDS.set(token, {
    callable,
    name: typeof options.name === "string" ? options.name : callable.name || "capability",
    thisValue: options.thisValue,
  });
  return token;
}

// Auto-wrapped capability name derivation: the callable's own name wins,
// then the last path segment the clone reached it through (e.g. "save" for
// globals.input.save), then the generic fallback. The <key>/<value>
// placeholders cloneValue uses for Map and Set tasks never become names.
function capabilityName(callable, path) {
  if (typeof callable.name === "string" && callable.name !== "") return callable.name;
  const dot = path.lastIndexOf(".");
  const segment = dot === -1 ? path : path.slice(dot + 1);
  return segment !== "" && segment !== "<key>" && segment !== "<value>" ? segment : "capability";
}

function safeError(error) {
  let name = "Error";
  let message = "Host capability failed";
  try {
    if (error && typeof error.name === "string") name = error.name;
  } catch (_) {}
  try {
    if (error && typeof error.message === "string") message = error.message;
    else if (typeof error === "string") message = error;
  } catch (_) {}
  const sanitized = new Error(message);
  sanitized.name = name;
  try {
    delete sanitized.stack;
  } catch (_) {}
  return sanitized;
}

function isPlainObject(value) {
  const prototype = OBJECT_GET_PROTOTYPE_OF(value);
  return prototype === OBJECT_PROTOTYPE || prototype === null;
}

// Trusted mode: capability tokens in injected globals are replaced by their
// recorded callables so capability-style host code runs unchanged in trusted
// mode. The host's object graph is never mutated: only containers on token
// paths are rebuilt (shallow plain-object/array/Map/Set copies); every other
// subtree is shared by reference, preserving the trusted pass-through
// contract. Tokens nested inside class instances or accessor closures are
// not traversed and therefore not unwrapped.
const BOUND_CALLABLES = new WeakMap();

function resolveCapabilityToken(record) {
  // Without a thisValue the raw callable itself is returned, so trusted mode
  // keeps reference identity. With a thisValue, memoize one bound function
  // per token so every occurrence of the same token resolves to the same
  // callable — sandbox honors thisValue via REFLECT_APPLY, so trusted must
  // too, or method-style capabilities silently change behavior.
  if (record.thisValue === undefined) return record.callable;
  let bound = BOUND_CALLABLES.get(record);
  if (bound === undefined) {
    bound = FUNCTION_BIND.call(record.callable, record.thisValue);
    BOUND_CALLABLES.set(record, bound);
  }
  return bound;
}

function isContainer(value) {
  if (Array.isArray(value)) return true;
  if (isPlainObject(value)) return true;
  try {
    return value instanceof Map || value instanceof Set;
  } catch (_) {
    return false;
  }
}

function containerChildren(node) {
  if (Array.isArray(node)) return node;
  try {
    if (node instanceof Map) {
      const out = [];
      for (const entry of node) out.push(entry[0], entry[1]);
      return out;
    }
    if (node instanceof Set) {
      const out = [];
      for (const value of node) out.push(value);
      return out;
    }
  } catch (_) {
    return [];
  }
  const out = [];
  try {
    for (const key of OWN_KEYS(node)) {
      const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(node, key);
      if (!descriptor) continue;
      if ("value" in descriptor) {
        if (isObject(descriptor.value)) out.push(descriptor.value);
      } else {
        if (isObject(descriptor.get)) out.push(descriptor.get);
        if (isObject(descriptor.set)) out.push(descriptor.set);
      }
    }
  } catch (_) {}
  return out;
}

// Iterative token scan with an explicit stack. A node is marked on-stack
// before its children are pushed, so cycles terminate; when a token is found,
// every frame currently on the stack (the ancestor chain) is marked true
// immediately, so an ancestor can never miss a token that a cycle member hid
// behind a back-edge. Returns the WeakMap memo (node -> hasTokenBelow).
function scanHasToken(root) {
  const memo = new WeakMap();
  const complete = new WeakSet();
  const onStack = new WeakSet();
  const stack = [{ node: root }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const node = frame.node;
    // `complete` tracks children fully walked; `memo` may already be true
    // from propagation without the walk being done, so it cannot gate the
    // frame (skipping would leave sibling subtrees unscanned and the rebuild
    // would misplace them by reference).
    if (complete.has(node)) {
      stack.length -= 1;
      continue;
    }
    // Re-entry of a frame that already pushed children: resume the walk.
    if (frame.pushed) {
      let pending = null;
      for (const child of frame.children) {
        if (isObject(child) && !complete.has(child) && !onStack.has(child)) {
          pending = child;
          break;
        }
      }
      if (pending !== null) {
        stack.push({ node: pending });
        continue;
      }
      if (!memo.has(node)) {
        memo.set(
          node,
          frame.children.some((child) => memo.get(child) === true)
        );
      }
      complete.add(node);
      stack.length -= 1;
      continue;
    }
    if (CAPABILITY_RECORDS.has(node)) {
      memo.set(node, true);
      // A token anywhere below an open frame marks every frame on the stack
      // (its ancestor chain) true, so an ancestor can never miss a token a
      // cycle member hid behind a back-edge.
      for (const ancestor of stack) memo.set(ancestor.node, true);
      complete.add(node);
      stack.length -= 1;
      continue;
    }
    if (!isContainer(node)) {
      memo.set(node, false);
      complete.add(node);
      stack.length -= 1;
      continue;
    }
    if (onStack.has(node)) {
      stack.length -= 1;
      continue;
    }
    onStack.add(node);
    frame.children = containerChildren(node);
    frame.pushed = true;
  }
  return memo;
}

function defineSlot(shell, key, value, descriptor) {
  // Null-prototype descriptor: a plain literal would inherit
  // Object.prototype pollution and the host could reject it as mixed.
  const holder = OBJECT_CREATE(null);
  if ("get" in descriptor) {
    holder.get = descriptor.get;
    holder.set = descriptor.set;
  } else {
    holder.value = value;
    holder.writable = descriptor.writable;
  }
  holder.enumerable = descriptor.enumerable;
  holder.configurable = descriptor.configurable;
  OBJECT_DEFINE_PROPERTY(shell, key, holder);
}

function materializeShell(node) {
  if (Array.isArray(node)) return new Array(node.length);
  try {
    if (node instanceof Map) return new Map();
    if (node instanceof Set) return new Set();
  } catch (_) {}
  return OBJECT_CREATE(OBJECT_GET_PROTOTYPE_OF(node));
}

// Fills a shell: token-free children are copied by reference with their
// original descriptor attributes (accessors verbatim, array holes absent);
// only token-path children become tasks that replace the slot once rebuilt.
function fillShell(shell, node, stack, hasTokenBelow) {
  if (Array.isArray(node) || isPlainObject(node)) {
    let keys;
    try {
      keys = OWN_KEYS(node);
    } catch (_) {
      keys = [];
    }
    for (const key of keys) {
      if (Array.isArray(node) && key === "length") continue;
      let descriptor;
      try {
        descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(node, key);
      } catch (_) {
        descriptor = null;
      }
      if (!descriptor) continue;
      if ("value" in descriptor) {
        const value = descriptor.value;
        if (isObject(value) && hasTokenBelow.get(value)) {
          stack.push({
            node: value,
            place: (resolved) => defineSlot(shell, key, resolved, descriptor),
          });
        } else {
          defineSlot(shell, key, value, descriptor);
        }
      } else {
        defineSlot(shell, key, descriptor.get, descriptor);
      }
    }
    return;
  }
  try {
    if (node instanceof Map) {
      for (const [key, value] of node) {
        const keyNeeds = isObject(key) && hasTokenBelow.get(key);
        const valueNeeds = isObject(value) && hasTokenBelow.get(value);
        if (!keyNeeds && !valueNeeds) {
          shell.set(key, value);
        } else if (keyNeeds && valueNeeds) {
          stack.push({
            node: key,
            place: (resolvedKey) => {
              stack.push({
                node: value,
                place: (resolvedValue) => shell.set(resolvedKey, resolvedValue),
              });
            },
          });
        } else if (keyNeeds) {
          stack.push({ node: key, place: (resolvedKey) => shell.set(resolvedKey, value) });
        } else {
          stack.push({ node: value, place: (resolvedValue) => shell.set(key, resolvedValue) });
        }
      }
      return;
    }
    if (node instanceof Set) {
      for (const value of node) {
        if (isObject(value) && hasTokenBelow.get(value)) {
          stack.push({ node: value, place: (resolvedValue) => shell.add(resolvedValue) });
        } else {
          shell.add(value);
        }
      }
    }
  } catch (_) {}
}

function unwrapCapabilities(value) {
  if (value === null || typeof value !== "object") return value;
  const hasTokenBelow = scanHasToken(value);
  if (!hasTokenBelow.get(value)) return value;
  const seen = new WeakMap();
  let result;
  const stack = [
    {
      node: value,
      place: (resolved) => {
        result = resolved;
      },
    },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    stack.length -= 1;
    const node = frame.node;
    const record = CAPABILITY_RECORDS.get(node);
    if (record) {
      frame.place(resolveCapabilityToken(record));
      continue;
    }
    if (!isContainer(node) || !hasTokenBelow.get(node)) {
      frame.place(node);
      continue;
    }
    const existing = seen.get(node);
    if (existing !== undefined) {
      frame.place(existing);
      continue;
    }
    const shell = materializeShell(node);
    seen.set(node, shell);
    frame.place(shell);
    fillShell(shell, node, stack, hasTokenBelow);
  }
  return result;
}

function isObject(value) {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function collectIntrinsicGraph(roots) {
  const graph = new WeakSet();
  const pending = roots.filter(isObject);
  while (pending.length) {
    const value = pending.pop();
    if (graph.has(value)) continue;
    graph.add(value);
    let prototype;
    try {
      prototype = OBJECT_GET_PROTOTYPE_OF(value);
    } catch (_) {
      prototype = null;
    }
    if (isObject(prototype) && !graph.has(prototype)) pending.push(prototype);
    let keys;
    try {
      keys = OWN_KEYS(value);
    } catch (_) {
      keys = [];
    }
    for (const key of keys) {
      let descriptor;
      try {
        descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
      } catch (_) {
        descriptor = null;
      }
      if (!descriptor) continue;
      for (const candidate of [descriptor.value, descriptor.get, descriptor.set]) {
        if (isObject(candidate) && !graph.has(candidate)) pending.push(candidate);
      }
    }
  }
  return graph;
}

// The protected-intrinsic graph is host state captured once and shared by
// every sandbox instance: walking it per instance dominates short-program
// startup (~48% of createInstance). Contract: the host must not extend
// intrinsic prototypes after the first sandbox instance is created.
let sharedIntrinsicGraph = null;
function protectedIntrinsicGraph(roots) {
  if (sharedIntrinsicGraph === null) sharedIntrinsicGraph = collectIntrinsicGraph(roots);
  return sharedIntrinsicGraph;
}

class SandboxBoundary {
  constructor(intrinsics, isDisposed, profile = false) {
    this.isDisposed = isDisposed;
    this.profiling = profile;
    // Opt-in hot-path counters for sandbox-tax analysis. `profileBoundary`
    // must be enabled at createInstance; counting is skipped otherwise.
    this.stats = {
      calls: 0, // dispatch entries
      guestCalls: 0, // guest-function dispatch (counter + apply)
      hostCalls: 0, // callHost mediations
      constructs: 0, // boundary.construct entries
      guestConstructs: 0, // guest-function construct fast path (arity-specialized)
      writeTargets: 0, // property writes resolved through the boundary
      mediatedGets: 0, // boundary.get reads
      functionWrites: 0, // property writes whose value needed securing
      argumentCopies: 0, // secureArguments had to copy the args array
      wrapperCreations: 0, // wrapHostFunction calls
      blocked: 0, // boundary violations thrown
    };
    this.count = this.profiling
      ? (key) => {
          this.stats[key] += 1;
        }
      : () => {};
    this.ambientValues = new WeakSet();
    this.ambientValues.add(globalThis);
    if (typeof globalThis.process === "object" && globalThis.process !== null) {
      this.ambientValues.add(globalThis.process);
    }
    this.guestFunctions = new WeakSet();
    this.protectedValues = protectedIntrinsicGraph(intrinsics);
    // Target -> wrapper dedup cache (wrapHostFunction returns the same
    // wrapper for the same raw target) and wrapper -> target reverse
    // mapping. Both are WeakMaps: identity lookups never invoke proxy traps,
    // so a guest proxy can neither observe nor forge the mapping.
    this.hostFunctionWrappers = new WeakMap();
    this.wrapperTargets = new WeakMap();
    // Monomorphic identity cache for pure-intrinsic calls, and a lazily
    // computed pure-intrinsic classification per target: both serve the
    // intrinsic-call hot path without per-call guard-set lookups.
    this.pureIntrinsicCache = new WeakMap();
    this.cachedPureCallable = null;
    this.cachedPureTarget = null;
    this.pendingGuestEntries = 0;
    // True while run() executes the program. Host-initiated guest entries
    // (a returned function called from the host) are detected by this flag
    // being false; nested host-callback entries during execution keep guest
    // reference semantics.
    this.guestExecutionActive = false;
    const boundary = this;
    this.functionConstructor = function sableDynamicFunctionBoundary() {
      throw boundaryError("dynamic code constructors are disabled");
    };
    this.registerGuestFunction(this.functionConstructor);
    // Shared redaction installed as the wrappers' own toString so direct
    // reads disclose nothing about boundary internals.
    this.redactedToString = () => "function () { [sablejs sandbox boundary] }";
    this.registerGuestFunction(this.redactedToString);
  }

  registerGuestFunction(callable) {
    this.guestFunctions.add(callable);
    return brandRuntimeCallable(callable);
  }

  consumeInternalGuestEntry() {
    if (this.pendingGuestEntries === 0) return false;
    this.pendingGuestEntries -= 1;
    return true;
  }

  importGlobals(globals) {
    if (globals == null) return null;
    if (typeof globals !== "object") throw boundaryError("globals must be an object");
    return this.cloneValue(globals, "globals", "host-to-guest", new WeakMap(), {
      wrapFunctions: true,
    });
  }

  exposeIntrinsic(value) {
    return CODE_CONSTRUCTORS.has(value) ? this.functionConstructor : value;
  }

  isFunctionConstructor(value) {
    return value === this.functionConstructor;
  }

  propertyTarget(value) {
    if (value === this.functionConstructor) return Function;
    // WeakMap.get is trap-free: a guest proxy passed here never runs its get
    // trap, so the wrapper-target mapping stays unobservable and unforgeable.
    return this.wrapperTargets.get(value) || value;
  }

  isProtected(value) {
    const target = this.propertyTarget(value);
    return isObject(target) && this.protectedValues.has(target);
  }

  assertMutable(value, operation = "modify") {
    if (this.isProtected(value)) {
      throw boundaryError(`cannot ${operation} a shared intrinsic`);
    }
  }

  // Resolves the write target and asserts mutability in one pass for the hot
  // property-write path. Single-pass TOCTOU analysis: the WeakMap lookup and
  // the protected-set check are trap-free and synchronous — no guest code can
  // run between resolution and the caller's write, and the returned target is
  // the exact object the caller writes to. Guest proxies cannot steer the
  // resolution (their traps never fire here), so the checked object is always
  // the written object.
  // Complement of writeTarget's no-op condition, computed without the counter
  // and without throwing: true iff writeTarget(value) would return `value`
  // unchanged. Used to classify sandbox `this` receivers once per call so
  // per-write writeTarget resolution can be skipped on the hot path. The
  // pinning test asserts the two cannot drift: for any value,
  // isUnmediatedWriteTarget(v) === false whenever writeTarget(v) throws or
  // returns a target other than v.
  isUnmediatedWriteTarget(value) {
    if (value === this.functionConstructor) return false;
    if (this.wrapperTargets.get(value) !== undefined) return false;
    if (isObject(value) && this.protectedValues.has(value)) return false;
    return true;
  }

  writeTarget(value, operation = "modify") {
    this.count("writeTargets");
    if (value === this.functionConstructor) {
      throw boundaryError(`cannot ${operation} a shared intrinsic`);
    }
    const target = this.wrapperTargets.get(value) || value;
    if (isObject(target) && this.protectedValues.has(target)) {
      throw boundaryError(`cannot ${operation} a shared intrinsic`);
    }
    return target;
  }

  secureValue(value) {
    if (typeof value === "function") {
      if (this.guestFunctions.has(value)) return value;
      if (this.wrapperTargets.get(value)) return value;
      if (CODE_CONSTRUCTORS.has(value)) return this.functionConstructor;
      return this.wrapHostFunction(value);
    }
    if (typeof value === "object" && value !== null && this.ambientValues.has(value)) {
      throw boundaryError("an intrinsic exposed an ambient host object");
    }
    return value;
  }

  // Returns args unchanged when no element needs securing so the common
  // no-function-argument case avoids allocating a copy per call.
  secureArguments(args) {
    for (let index = 0; index < args.length; index += 1) {
      const value = args[index];
      if (typeof value !== "function") continue;
      const secured = this.secureValue(value);
      if (secured === value) continue;
      const copy = args.slice(0, index);
      this.count("argumentCopies");
      copy[index] = secured;
      for (let rest = index + 1; rest < args.length; rest += 1) {
        const candidate = args[rest];
        if (typeof candidate === "function") {
          const wrapped = this.secureValue(candidate);
          copy[rest] = wrapped === candidate ? candidate : wrapped;
        } else {
          copy[rest] = candidate;
        }
      }
      return copy;
    }
    return args;
  }

  // Host-initiated guest entries (calling a returned guest function, or
  // invoking it with .call/.apply) copy plain-data values the same way
  // globals are copied, so guest mutations cannot reach host objects through
  // the arguments or the receiver. Guest-internal entries never take this
  // path; they keep reference semantics between guest frames.
  secureHostEntryValue(value) {
    if (typeof value === "function") return this.secureValue(value);
    if (typeof value === "object" && value !== null) {
      return this.cloneValue(value, "arguments", "host-to-guest", new WeakMap());
    }
    return value;
  }

  secureHostEntryArguments(args) {
    for (let index = 0; index < args.length; index += 1) {
      const value = args[index];
      if (typeof value !== "object" || value === null) continue;
      const copy = args.slice(0, index);
      this.count("argumentCopies");
      copy[index] = this.secureHostEntryValue(value);
      for (let rest = index + 1; rest < args.length; rest += 1) {
        const candidate = args[rest];
        copy[rest] =
          typeof candidate === "object" && candidate !== null
            ? this.secureHostEntryValue(candidate)
            : candidate;
      }
      return copy;
    }
    return args;
  }

  wrapHostFunction(target) {
    this.count("wrapperCreations");
    const existing = this.hostFunctionWrappers.get(target);
    if (existing) return existing;
    const boundary = this;
    const wrapper = function sableIntrinsicBoundary(...args) {
      if (new.target !== undefined) return boundary.constructHost(target, args);
      return boundary.callHost(target, this, args);
    };
    // The wrapper -> target mapping lives in wrapperTargets (trap-free), not
    // on the wrapper, so guest proxy traps can never observe it.
    this.wrapperTargets.set(wrapper, target);
    // Redact the wrapper's own source so direct toString reads disclose
    // nothing about boundary internals. Null-prototype descriptor: a plain
    // literal would inherit guest-visible Object.prototype pollution and
    // the host could reject it as a mixed descriptor.
    const toStringDescriptor = OBJECT_CREATE(null);
    toStringDescriptor.value = this.redactedToString;
    toStringDescriptor.writable = false;
    toStringDescriptor.enumerable = false;
    toStringDescriptor.configurable = true;
    OBJECT_DEFINE_PROPERTY(wrapper, "toString", toStringDescriptor);
    this.hostFunctionWrappers.set(target, wrapper);
    return brandRuntimeCallable(wrapper);
  }

  call(callable, thisValue, args) {
    this.count("calls");
    // Identity cache for pure intrinsics: single-intrinsic loops skip
    // dispatch entirely. The cached callable can never be a guest function,
    // so the hit check is safe by identity.
    if (callable === this.cachedPureCallable) {
      return this.callHost(this.cachedPureTarget, thisValue, args);
    }
    if (this.guestFunctions.has(callable)) {
      this.count("guestCalls");
      const previousEntries = this.pendingGuestEntries;
      this.pendingGuestEntries += 1;
      try {
        return REFLECT_APPLY(callable, thisValue, args);
      } finally {
        this.pendingGuestEntries = previousEntries;
      }
    }
    if (this.isFunctionConstructor(callable) || CODE_CONSTRUCTORS.has(callable)) {
      throw boundaryError("dynamic code constructors are disabled");
    }
    const target = this.wrapperTargets.get(callable);
    if (target) {
      if (this.isPureIntrinsic(target)) {
        this.cachedPureCallable = callable;
        this.cachedPureTarget = target;
      }
      return this.callHost(target, thisValue, args);
    }
    if (this.protectedValues.has(callable)) {
      if (this.isPureIntrinsic(callable)) {
        this.cachedPureCallable = callable;
        this.cachedPureTarget = callable;
      }
      return this.callHost(callable, thisValue, args);
    }
    throw boundaryError("calling an unmediated host function is disabled");
  }

  construct(constructor, args) {
    this.count("constructs");
    if (this.isFunctionConstructor(constructor) || CODE_CONSTRUCTORS.has(constructor)) {
      throw boundaryError("dynamic code constructors are disabled");
    }
    const target = this.wrapperTargets.get(constructor);
    if (target) return this.constructHost(target, args);
    if (this.protectedValues.has(constructor)) return this.constructHost(constructor, args);
    if (!this.guestFunctions.has(constructor)) {
      throw boundaryError("constructing an unmediated host function is disabled");
    }
    return REFLECT_CONSTRUCT(constructor, args);
  }

  callHost(target, thisValue, args) {
    this.count("hostCalls");
    // Intrinsics that appear in no guard set skip the per-call argument and
    // receiver inspections below.
    if (this.isPureIntrinsic(target)) {
      return this.applyHost(target, thisValue, this.secureArguments(args));
    }
    // V8's captureStackTrace writes a host stack onto its receiver; even a
    // guest-owned receiver would disclose host file paths. It is not part of
    // ES5.1, so the sandbox refuses it outright.
    if (CAPTURE_STACK_TRACE && target === CAPTURE_STACK_TRACE) {
      throw boundaryError("Error.captureStackTrace is not available in the sandbox");
    }
    // Function.prototype.toString reads the receiver's literal source, so it
    // would disclose boundary internals through a wrapper; own redacted
    // toString properties only cover direct reads.
    if (
      target === FUNCTION_TO_STRING &&
      typeof thisValue === "function" &&
      this.wrapperTargets.get(thisValue)
    ) {
      throw boundaryError("reading the source of a mediated function is disabled");
    }
    if (MUTATES_ARGUMENT_ZERO.has(target) && args.length) {
      this.assertMutable(args[0], "modify");
    }
    if (typeof Reflect === "object" && target === Reflect.set && args.length > 3) {
      this.assertMutable(args[3], "modify through");
    }
    if (MUTATES_RECEIVER.has(target)) this.assertMutable(thisValue, "modify");
    let hostArgs = this.secureArguments(args);
    if (INSPECTS_ARGUMENT_ZERO.has(target) && hostArgs.length) {
      hostArgs = hostArgs.slice();
      hostArgs[0] = this.propertyTarget(hostArgs[0]);
    }
    let hostThis = thisValue;
    if (
      (target === FUNCTION_APPLY || target === FUNCTION_BIND || target === FUNCTION_CALL) &&
      typeof hostThis === "function"
    ) {
      hostThis = this.secureValue(hostThis);
    }
    if (
      (target === REFLECT_APPLY || target === REFLECT_CONSTRUCT) &&
      hostArgs.length &&
      typeof hostArgs[0] === "function"
    ) {
      hostArgs = hostArgs.slice();
      hostArgs[0] = this.secureValue(hostArgs[0]);
      if (
        target === REFLECT_CONSTRUCT &&
        hostArgs.length > 2 &&
        typeof hostArgs[2] === "function"
      ) {
        hostArgs[2] = this.secureValue(hostArgs[2]);
      }
    }
    return this.applyHost(target, hostThis, hostArgs);
  }

  // Shared invocation tail: run the target, sanitize its errors, and secure
  // the result. Boundary errors pass through untouched.
  applyHost(target, thisValue, args) {
    try {
      return this.secureValue(REFLECT_APPLY(target, thisValue, args));
    } catch (error) {
      throw sanitizeHostError(error);
    }
  }

  // Intrinsics that appear in no guard set: their calls need no argument or
  // receiver inspection beyond securing argument values. Classified lazily
  // per target and cached, so the hot call path is one WeakMap lookup.
  isPureIntrinsic(target) {
    let pure = this.pureIntrinsicCache.get(target);
    if (pure === undefined) {
      pure = !(
        MUTATES_ARGUMENT_ZERO.has(target) ||
        INSPECTS_ARGUMENT_ZERO.has(target) ||
        MUTATES_RECEIVER.has(target) ||
        (CAPTURE_STACK_TRACE && target === CAPTURE_STACK_TRACE) ||
        target === FUNCTION_TO_STRING ||
        target === FUNCTION_APPLY ||
        target === FUNCTION_BIND ||
        target === FUNCTION_CALL ||
        target === REFLECT_APPLY ||
        target === REFLECT_CONSTRUCT
      );
      this.pureIntrinsicCache.set(target, pure);
    }
    return pure;
  }

  constructHost(target, args) {
    if (CODE_CONSTRUCTORS.has(target)) {
      throw boundaryError("dynamic code constructors are disabled");
    }
    if (typeof Proxy === "function" && target === Proxy && args.length) {
      this.assertMutable(args[0], "wrap");
    }
    try {
      return this.secureValue(REFLECT_CONSTRUCT(target, args));
    } catch (error) {
      throw sanitizeHostError(error);
    }
  }

  get(value, key) {
    this.count("mediatedGets");
    if (value === null || value === undefined) {
      throw new TypeError(`Cannot read properties of ${value}`);
    }
    let target = value;
    if (typeof value !== "object" && typeof value !== "function") target = Object(value);
    if (typeof target === "function") target = this.propertyTarget(target);
    const result = REFLECT_GET(target, key, target);
    if (typeof result === "function") return this.secureValue(result);
    if (typeof result === "object" && result !== null && this.ambientValues.has(result)) {
      throw boundaryError("an intrinsic exposed an ambient host object");
    }
    return result;
  }

  cloneValue(value, path, direction, seen, options = null) {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return value;

    // Iterative clone: an explicit work stack bounds depth by memory instead
    // of the host call stack, so pathologically deep payloads clone instead
    // of overflowing the stack inside the boundary. Containers register in
    // `seen` at materialization, so shared references and cycles survive;
    // specials (Date/RegExp/buffers/views/errors) clone per occurrence.
    let result;
    const pending = [
      {
        value,
        path,
        place: (clone) => {
          result = clone;
        },
      },
    ];
    while (pending.length > 0) {
      const current = pending[pending.length - 1];
      pending.length -= 1;
      const { value: node, path: nodePath, place } = current;
      // Primitive short-circuit: entry checks above cover the root, but
      // nested values arrive as tasks, and isPlainObject would box them
      // (Object.getPrototypeOf(1) === Number.prototype).
      if ((typeof node !== "object" || node === null) && typeof node !== "function") {
        place(node);
        continue;
      }
      // The checks the entry path used to perform at every recursion level
      // run here, because nested values arrive as tasks: ambient objects,
      // capability records, and functions keep their specific messages.
      if (direction === "host-to-guest" && this.ambientValues.has(node)) {
        throw boundaryError(`${nodePath} contains an ambient host object`);
      }
      const record = direction === "host-to-guest" ? CAPABILITY_RECORDS.get(node) : null;
      if (record) {
        place(this.createCapability(record));
        continue;
      }
      if (typeof node === "function") {
        // Globals import may auto-wrap raw host functions as capabilities so
        // the same globals literal serves sandbox and trusted modes. The
        // ambient and CAPABILITY_RECORDS branches above still take
        // precedence; runtime-owned callables (another instance's wrappers or
        // guest closures) are never re-wrapped.
        if (
          direction === "host-to-guest" &&
          options &&
          options.wrapFunctions &&
          !RUNTIME_CALLABLES.has(node)
        ) {
          const existing = seen.get(node);
          if (existing !== undefined) {
            place(existing);
            continue;
          }
          const wrapper = this.createCapability({
            callable: node,
            name: capabilityName(node, nodePath),
            thisValue: undefined,
          });
          seen.set(node, wrapper);
          place(wrapper);
          continue;
        }
        if (direction === "host-to-guest" && options && options.wrapFunctions) {
          throw boundaryError(
            `${nodePath} contains a function owned by the sablejs runtime; only host functions or capability() tokens may cross`
          );
        }
        const kind =
          direction === "host-to-guest" ? "function; wrap it with capability()" : "guest function";
        throw boundaryError(`${nodePath} contains a ${kind}`);
      }
      if (seen.has(node)) {
        place(seen.get(node));
        continue;
      }

      // The branded paths below operate on the node's internal slots, which
      // a Proxy cannot carry: instanceof matches through the target, and
      // the branded method call then fails with a raw receiver TypeError
      // ("this is not a Date object", "incompatible receiver"). Proxies and
      // other exotic objects are not plain data, so the failure is turned
      // into the documented boundary error instead of leaking clone
      // internals. (Proxies over plain objects and arrays brand as plain
      // data and clone as the data they present, with per-node checks.)
      if (node instanceof Date) {
        try {
          place(new Date(node.getTime()));
        } catch (error) {
          throw boundaryError(
            `${nodePath} is a Proxy-wrapped Date; only plain data or explicit capabilities cross`
          );
        }
        continue;
      }
      if (node instanceof RegExp) {
        try {
          place(new RegExp(node.source, node.flags));
        } catch (error) {
          throw boundaryError(
            `${nodePath} is a Proxy-wrapped RegExp; only plain data or explicit capabilities cross`
          );
        }
        continue;
      }
      if (typeof ArrayBuffer !== "undefined" && node instanceof ArrayBuffer) {
        try {
          place(node.slice(0));
        } catch (error) {
          throw boundaryError(
            `${nodePath} is a Proxy-wrapped ArrayBuffer; only plain data or explicit capabilities cross`
          );
        }
        continue;
      }
      if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(node)) {
        // Buffer carries its own prototype with host-only methods; clone it
        // into a plain Uint8Array so only standard view semantics cross.
        try {
          if (typeof Buffer !== "undefined" && node instanceof Buffer) {
            place(new Uint8Array(node));
            continue;
          }
          if (typeof DataView !== "undefined" && node instanceof DataView) {
            const buffer = node.buffer.slice(node.byteOffset, node.byteOffset + node.byteLength);
            place(new DataView(buffer));
            continue;
          }
          // Strip subclass prototypes the same way: only standard view
          // semantics cross, never host-added subclass methods.
          const constructor =
            VIEW_BASE_CONSTRUCTORS.indexOf(node.constructor) !== -1
              ? node.constructor
              : VIEW_BASE_CONSTRUCTORS.find((Base) => node instanceof Base) || Uint8Array;
          place(new constructor(node));
          continue;
        } catch (error) {
          throw boundaryError(
            `${nodePath} is a Proxy-wrapped typed array; only plain data or explicit capabilities cross`
          );
        }
      }
      if (typeof Map !== "undefined" && node instanceof Map) {
        try {
          const clone = new Map();
          seen.set(node, clone);
          place(clone);
          const entries = [];
          for (const [key, entry] of node) {
            entries.push({ key, entry });
          }
          // Reversed so key/value pairs pop in iteration order.
          for (let index = entries.length - 1; index >= 0; index -= 1) {
            const { key, entry } = entries[index];
            const pair = {
              map: clone,
              key: undefined,
              value: undefined,
              keyDone: false,
              valueDone: false,
            };
            const maybeSet = () => {
              if (pair.keyDone && pair.valueDone) pair.map.set(pair.key, pair.value);
            };
            pending.push({
              value: key,
              path: `${nodePath}.<key>`,
              place: (clonedKey) => {
                pair.key = clonedKey;
                pair.keyDone = true;
                maybeSet();
              },
            });
            pending.push({
              value: entry,
              path: `${nodePath}.<value>`,
              place: (clonedEntry) => {
                pair.value = clonedEntry;
                pair.valueDone = true;
                maybeSet();
              },
            });
          }
          continue;
        } catch (error) {
          throw boundaryError(
            `${nodePath} is a Proxy-wrapped Map; only plain data or explicit capabilities cross`
          );
        }
      }
      if (typeof Set !== "undefined" && node instanceof Set) {
        try {
          const clone = new Set();
          seen.set(node, clone);
          place(clone);
          const entries = [];
          for (const entry of node) entries.push(entry);
          for (let index = entries.length - 1; index >= 0; index -= 1) {
            pending.push({
              value: entries[index],
              path: `${nodePath}.<value>`,
              place: (clonedEntry) => clone.add(clonedEntry),
            });
          }
          continue;
        } catch (error) {
          throw boundaryError(
            `${nodePath} is a Proxy-wrapped Set; only plain data or explicit capabilities cross`
          );
        }
      }
      if (node instanceof Error) {
        try {
          place(safeError(node));
          continue;
        } catch (error) {
          throw boundaryError(
            `${nodePath} is a Proxy-wrapped Error; only plain data or explicit capabilities cross`
          );
        }
      }
      if (!Array.isArray(node) && !isPlainObject(node)) {
        throw boundaryError(`${nodePath} must contain only plain data or explicit capabilities`);
      }

      const clone = Array.isArray(node) ? new Array(node.length) : {};
      seen.set(node, clone);
      place(clone);
      const keys = OWN_KEYS(node);
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        if (typeof key === "symbol") throw boundaryError(`${nodePath} contains a symbol property`);
        if (Array.isArray(node) && key === "length") continue;
        const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(node, key);
        if (!descriptor) continue;
        if (!("value" in descriptor)) throw boundaryError(`${nodePath}.${key} is an accessor`);
        // Null-prototype descriptor: a plain literal would inherit
        // guest-visible Object.prototype pollution and the host could
        // reject it as a mixed descriptor.
        const clonedDescriptor = OBJECT_CREATE(null);
        clonedDescriptor.writable = descriptor.writable;
        clonedDescriptor.enumerable = descriptor.enumerable;
        clonedDescriptor.configurable = descriptor.configurable;
        pending.push({
          value: descriptor.value,
          path: `${nodePath}.${key}`,
          place: (clonedValue) => {
            clonedDescriptor.value = clonedValue;
            OBJECT_DEFINE_PROPERTY(clone, key, clonedDescriptor);
          },
        });
      }
    }
    return result;
  }

  createCapability(record) {
    const boundary = this;
    const wrapper = function sableCapability(...guestArgs) {
      if (new.target !== undefined)
        throw boundaryError(`capability ${record.name} is not a constructor`);
      if (boundary.isDisposed()) throw boundaryError(`capability ${record.name} has been revoked`);
      const hostArgs = new Array(guestArgs.length);
      for (let index = 0; index < guestArgs.length; index += 1) {
        hostArgs[index] = boundary.cloneValue(
          guestArgs[index],
          `${record.name}.args[${index}]`,
          "guest-to-host",
          new WeakMap()
        );
      }
      let result;
      try {
        result = REFLECT_APPLY(record.callable, record.thisValue, hostArgs);
      } catch (error) {
        throw safeError(error);
      }
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return Promise.resolve(result).then(
          (value) =>
            boundary.cloneValue(value, `${record.name}.result`, "host-to-guest", new WeakMap()),
          (error) => {
            throw safeError(error);
          }
        );
      }
      return boundary.cloneValue(result, `${record.name}.result`, "host-to-guest", new WeakMap());
    };
    this.registerGuestFunction(wrapper);
    return wrapper;
  }
}

module.exports = {
  SandboxBoundary,
  boundaryError,
  brandRuntimeCallable,
  capability,
  sanitizeHostError,
  unwrapCapabilities,
};
