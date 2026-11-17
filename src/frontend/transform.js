"use strict";

const { parse } = require("acorn");

const ES5_RESERVED_WORDS = new Set([
  "break",
  "case",
  "catch",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "finally",
  "for",
  "function",
  "if",
  "in",
  "instanceof",
  "new",
  "return",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "class",
  "const",
  "enum",
  "export",
  "extends",
  "import",
  "super",
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
  "null",
  "true",
  "false",
]);

const HELPER_SOURCES = {
  _defineProperty: `function _defineProperty(obj, key, value) {
  key = _toPropertyKey(key);
  if (key in obj) {
    Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true });
  } else {
    obj[key] = value;
  }
  return obj;
}`,
  _toPropertyKey: `function _toPropertyKey(arg) {
  var key = _toPrimitive(arg, "string");
  return typeof key === "symbol" ? key : String(key);
}`,
  _toPrimitive: `function _toPrimitive(input, hint) {
  if (typeof input !== "object" || input === null) return input;
  var prim = typeof Symbol !== "undefined" && Symbol.toPrimitive ? input[Symbol.toPrimitive] : void 0;
  if (prim !== void 0) {
    var res = prim.call(input, hint || "default");
    if (typeof res !== "object" || res === null) return res;
    throw new TypeError("@@toPrimitive must return a primitive value.");
  }
  return (hint === "string" ? String : Number)(input);
}`,
  _objectSpread: `function _objectSpread(target) {
  for (var i = 1; i < arguments.length; i++) {
    var source = arguments[i] != null ? arguments[i] : {};
    var ownKeys = Object.keys(Object(source));
    if (typeof Object.getOwnPropertySymbols === "function") {
      ownKeys = ownKeys.concat(Object.getOwnPropertySymbols(Object(source)).filter(function (sym) {
        return Object.getOwnPropertyDescriptor(source, sym).enumerable;
      }));
    }
    for (var j = 0; j < ownKeys.length; j++) {
      _defineProperty(target, ownKeys[j], source[ownKeys[j]]);
    }
  }
  return target;
}`,
  _objectWithoutProperties: `function _objectWithoutProperties(source, excluded) {
  if (source == null) return {};
  var target = {};
  var sourceKeys = Object.keys(source);
  var i, key;
  for (i = 0; i < sourceKeys.length; i++) {
    key = sourceKeys[i];
    if (excluded.indexOf(key) >= 0) continue;
    target[key] = source[key];
  }
  if (Object.getOwnPropertySymbols) {
    var sourceSymbolKeys = Object.getOwnPropertySymbols(source);
    for (i = 0; i < sourceSymbolKeys.length; i++) {
      key = sourceSymbolKeys[i];
      if (excluded.indexOf(key) >= 0) continue;
      if (!Object.prototype.propertyIsEnumerable.call(source, key)) continue;
      target[key] = source[key];
    }
  }
  return target;
}`,
  _objectDestructuringEmpty: `function _objectDestructuringEmpty(obj) {
  if (obj == null) throw new TypeError("Cannot destructure " + obj);
}`,
  _slicedToArray: `function _slicedToArray(arr, i) {
  if (Array.isArray(arr)) return arr;
  if (arr != null && typeof Symbol !== "undefined" && Symbol.iterator in Object(arr)) {
    var _arr = [];
    var _n = true;
    var _d = false;
    var _s, _e;
    try {
      for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) {
        _arr.push(_s.value);
        if (i && _arr.length === i) break;
      }
    } catch (err) {
      _d = true;
      _e = err;
    } finally {
      try {
        if (!_n && _i["return"] != null) _i["return"]();
      } finally {
        if (_d) throw _e;
      }
    }
    return _arr;
  }
  throw new TypeError("Invalid attempt to destructure non-iterable instance.");
}`,
  _toArray: `function _toArray(arr) {
  if (Array.isArray(arr)) return _arrayLikeToArray(arr);
  if (arr != null && typeof Symbol !== "undefined" && Symbol.iterator in Object(arr)) {
    var _arr = [];
    var _i = arr[Symbol.iterator]();
    var _s;
    while (!(_s = _i.next()).done) _arr.push(_s.value);
    return _arr;
  }
  throw new TypeError("Invalid attempt to spread/destructure non-iterable instance.");
}`,
  _toConsumableArray: `function _toConsumableArray(arr) {
  if (Array.isArray(arr)) return _arrayLikeToArray(arr);
  if (typeof arr === "string" && typeof Symbol !== "undefined" && !Symbol.iterator) return arr.split("");
  if (arr != null && typeof Symbol !== "undefined" && Symbol.iterator in Object(arr)) {
    var _arr = [];
    var _i = arr[Symbol.iterator]();
    var _s;
    while (!(_s = _i.next()).done) _arr.push(_s.value);
    return _arr;
  }
  if (arr != null && typeof Array.from === "function" && typeof arr.length === "number") return Array.from(arr);
  throw new TypeError("Invalid attempt to spread non-iterable instance.");
}`,
  _arrayLikeToArray: `function _arrayLikeToArray(arr, len) {
  if (len == null || len > arr.length) len = arr.length;
  var arr2 = new Array(len);
  for (var i = 0; i < len; i++) arr2[i] = arr[i];
  return arr2;
}`,
  _createForOfIteratorHelper: `function _createForOfIteratorHelper(o) {
  if (typeof Symbol === "undefined" || o[Symbol.iterator] == null) {
    if (Array.isArray(o) || (o && typeof o.length === "number")) {
      var i = 0;
      var F = function () {};
      return {
        s: F,
        n: function () {
          if (i >= o.length) return { done: true };
          return { done: false, value: o[i++] };
        },
        e: function (e) { throw e; },
        f: F
      };
    }
    throw new TypeError("Invalid attempt to iterate non-iterable instance.");
  }
  var it = o[Symbol.iterator]();
  var normalCompletion = true;
  var didErr = false;
  var err;
  return {
    s: function () {},
    n: function () {
      var step = it.next();
      normalCompletion = step.done;
      return step;
    },
    e: function (e) {
      didErr = true;
      err = e;
    },
    f: function () {
      try {
        if (!normalCompletion && it["return"] != null) it["return"]();
      } finally {
        if (didErr) throw err;
      }
    }
  };
}`,
  _readOnlyError: `function _readOnlyError(name) {
  throw new TypeError('"' + name + '" is read-only');
}`,
  _taggedTemplateLiteral: `function _taggedTemplateLiteral(strings, raw) {
  if (!raw) raw = strings.slice(0);
  return Object.freeze(Object.defineProperties(strings, { raw: { value: Object.freeze(raw) } }));
}`,
  _classCallCheck: `function _classCallCheck(instance, Constructor) {
  if (!(instance instanceof Constructor)) {
    throw new TypeError("Cannot call a class as a function");
  }
}`,
  _defineProperties: `function _defineProperties(target, props) {
  for (var i = 0; i < props.length; i++) {
    var descriptor = props[i];
    descriptor.enumerable = descriptor.enumerable || false;
    descriptor.configurable = true;
    if ("value" in descriptor) descriptor.writable = true;
    Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor);
  }
}`,
  _createClass: `function _createClass(Constructor, protoProps, staticProps) {
  if (protoProps) _defineProperties(Constructor.prototype, protoProps);
  if (staticProps) _defineProperties(Constructor, staticProps);
  return Constructor;
}`,
  _inherits: `function _inherits(subClass, superClass) {
  if (typeof superClass !== "function" && superClass !== null) {
    throw new TypeError("Super expression must either be null or a function");
  }
  subClass.prototype = Object.create(superClass && superClass.prototype, {
    constructor: { value: subClass, writable: true, configurable: true }
  });
  if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : (subClass.__proto__ = superClass);
}`,
  _createSuper: `function _createSuper(Derived) {
  var hasNativeReflectConstruct = typeof Reflect !== "undefined" && Reflect.construct;
  return function _createSuperInternal() {
    var Super = Object.getPrototypeOf(Derived);
    var result;
    if (hasNativeReflectConstruct) {
      var NewTarget = this && this.constructor ? this.constructor : Derived;
      result = Reflect.construct(Super, arguments, NewTarget);
    } else {
      result = Super.apply(this, arguments);
    }
    return _possibleConstructorReturn(this, result);
  };
}`,
  _possibleConstructorReturn: `function _possibleConstructorReturn(self, call) {
  if (call && (typeof call === "object" || typeof call === "function")) {
    return call;
  } else if (call !== void 0) {
    throw new TypeError("Derived constructors may only return object or undefined");
  }
  return _assertThisInitialized(self);
}`,
  _assertThisInitialized: `function _assertThisInitialized(self) {
  if (self === void 0) {
    throw new ReferenceError("this hasn't been initialised - super() hasn't been called");
  }
  return self;
}`,
  _get: `function _get(target, property, receiver) {
  if (typeof Reflect !== "undefined" && Reflect.get) {
    return Reflect.get(target, property, receiver || target);
  }
  var base = target;
  while (base != null) {
    var desc = Object.getOwnPropertyDescriptor(base, property);
    if (desc) {
      if (desc.get) return desc.get.call(receiver || target);
      return desc.value;
    }
    base = Object.getPrototypeOf(base);
  }
}`,
  _set: `function _set(target, property, value, receiver, isStrict) {
  if (typeof Reflect !== "undefined" && Reflect.set) {
    var ok = Reflect.set(target, property, value, receiver);
    if (!ok && isStrict) throw new TypeError("Cannot set property " + String(property));
    return true;
  }
  var base = target;
  while (base != null) {
    var desc = Object.getOwnPropertyDescriptor(base, property);
    if (desc) {
      if (desc.set) { desc.set.call(receiver, value); return true; }
      if (!desc.writable) {
        if (isStrict) throw new TypeError("Cannot assign to read only property " + String(property));
        return false;
      }
      break;
    }
    base = Object.getPrototypeOf(base);
  }
  if (receiver && (typeof receiver === "object" || typeof receiver === "function")) {
    Object.defineProperty(receiver, property, { value: value, writable: true, enumerable: true, configurable: true });
    return true;
  }
  if (isStrict) throw new TypeError("Cannot create property " + String(property));
  return false;
}`,
  _classPrivateFieldInitSpec: `function _classPrivateFieldInitSpec(obj, privateMap, value) {
  if (privateMap.has(obj)) throw new TypeError("Cannot initialize the same private elements twice on an object");
  privateMap.set(obj, value);
}`,
  _classPrivateFieldGet: `function _classPrivateFieldGet(receiver, privateMap) {
  if (!privateMap.has(receiver)) throw new TypeError("attempted to get private field on non-instance");
  var descriptor = privateMap.get(receiver);
  if (descriptor.get) return descriptor.get.call(receiver);
  return descriptor.value;
}`,
  _classPrivateFieldSet: `function _classPrivateFieldSet(receiver, privateMap, value) {
  if (!privateMap.has(receiver)) throw new TypeError("attempted to set private field on non-instance");
  var descriptor = privateMap.get(receiver);
  if (descriptor.set) {
    descriptor.set.call(receiver, value);
  } else {
    if (!descriptor.writable) throw new TypeError("attempted to set read only private field");
    descriptor.value = value;
  }
  return value;
}`,
  _classPrivateMethodInitSpec: `function _classPrivateMethodInitSpec(obj, privateSet) {
  if (privateSet.has(obj)) throw new TypeError("Cannot initialize the same private elements twice on an object");
  privateSet.add(obj);
}`,
  _classPrivateMethodGet: `function _classPrivateMethodGet(receiver, privateSet, fn) {
  if (!privateSet.has(receiver)) throw new TypeError("attempted to get private field on non-instance");
  return fn;
}`,
  _classStaticPrivateFieldSpecGet: `function _classStaticPrivateFieldSpecGet(receiver, classConstructor, descriptor) {
  if (receiver !== classConstructor) throw new TypeError("Private static access of wrong provenance");
  if (descriptor.get) return descriptor.get.call(receiver);
  return descriptor.value;
}`,
  _classStaticPrivateFieldSpecSet: `function _classStaticPrivateFieldSpecSet(receiver, classConstructor, descriptor, value) {
  if (receiver !== classConstructor) throw new TypeError("Private static access of wrong provenance");
  if (descriptor.set) descriptor.set.call(receiver, value);
  else descriptor.value = value;
  return value;
}`,
  _classStaticPrivateMethodGet: `function _classStaticPrivateMethodGet(receiver, classConstructor, method) {
  if (receiver !== classConstructor) throw new TypeError("Private static access of wrong provenance");
  return method;
}`,
};

const HELPER_DEPS = {
  _defineProperty: ["_toPropertyKey"],
  _toPropertyKey: ["_toPrimitive"],
  _objectSpread: ["_defineProperty"],
  _toArray: ["_arrayLikeToArray"],
  _toConsumableArray: ["_arrayLikeToArray"],
  _createClass: ["_defineProperties"],
  _defineProperties: ["_toPropertyKey"],
  _createSuper: ["_possibleConstructorReturn"],
  _possibleConstructorReturn: ["_assertThisInitialized"],
};

const parsedHelperTemplates = new Map();

function stripLoc(node) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) stripLoc(node[i]);
    return node;
  }
  if ("loc" in node) node.loc = null;
  if ("start" in node) delete node.start;
  if ("end" in node) delete node.end;
  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i++) {
    stripLoc(node[keys[i]]);
  }
  return node;
}

function getHelperAST(helperName) {
  let cached = parsedHelperTemplates.get(helperName);
  if (!cached) {
    const src = HELPER_SOURCES[helperName];
    if (!src) throw new Error(`Unknown internal ES5 transform helper: ${helperName}`);
    const program = parse(src, { ecmaVersion: 5 });
    cached = stripLoc(program.body[0]);
    parsedHelperTemplates.set(helperName, cached);
  }
  return JSON.parse(JSON.stringify(cached));
}

function normalizeTransformOptions(value) {
  if (value === undefined || value === "auto") {
    return { mode: "auto", fn: null };
  }
  if (value === true || value === "es5" || value === "es5.1") {
    return { mode: "es5", fn: null };
  }
  if (value === false || value === "none") {
    return { mode: "none", fn: null };
  }
  if (typeof value === "function") {
    return { mode: "custom", fn: value };
  }
  throw new Error(
    `Invalid transform option ${JSON.stringify(
      value
    )}: expected "auto", "es5", "none", a boolean, or a function`
  );
}

// ---------------------------------------------------------------------------
// ESTree AST node builders (clean ES5.1 shapes)
// ---------------------------------------------------------------------------

function id(name, loc = null) {
  return { type: "Identifier", name, loc };
}

function lit(value, loc = null, extra = {}) {
  return {
    type: "Literal",
    value,
    raw: typeof value === "string" ? JSON.stringify(value) : String(value),
    ...extra,
    loc,
  };
}

function undefExpr(loc = null) {
  return { type: "UnaryExpression", operator: "void", prefix: true, argument: lit(0, loc), loc };
}

function exprStmt(expression, loc = null) {
  return { type: "ExpressionStatement", expression, loc };
}

function blockStmt(body, loc = null) {
  return { type: "BlockStatement", body, loc };
}

function varDecl(declarations, loc = null) {
  return { type: "VariableDeclaration", kind: "var", declarations, loc };
}

function varDecl1(nameId, init = null, loc = null) {
  return varDecl([{ type: "VariableDeclarator", id: nameId, init, loc }], loc);
}

function assign(left, right, operator = "=", loc = null) {
  return { type: "AssignmentExpression", operator, left, right, loc };
}

function member(object, property, computed = false, loc = null) {
  return { type: "MemberExpression", object, property, computed, optional: false, loc };
}

function call(callee, args = [], loc = null) {
  return { type: "CallExpression", callee, arguments: args, optional: false, loc };
}

function fnExpr(params, bodyStmts, fnId = null, loc = null) {
  return {
    type: "FunctionExpression",
    id: fnId,
    params,
    body: blockStmt(bodyStmts, loc),
    generator: false,
    async: false,
    expression: false,
    loc,
  };
}

function fnDecl(fnId, params, bodyStmts, loc = null) {
  return {
    type: "FunctionDeclaration",
    id: fnId,
    params,
    body: blockStmt(bodyStmts, loc),
    generator: false,
    async: false,
    expression: false,
    loc,
  };
}

function binExpr(operator, left, right, loc = null) {
  return { type: "BinaryExpression", operator, left, right, loc };
}

function logExpr(operator, left, right, loc = null) {
  return { type: "LogicalExpression", operator, left, right, loc };
}

function condExpr(test, consequent, alternate, loc = null) {
  return { type: "ConditionalExpression", test, consequent, alternate, loc };
}

function unaryExpr(operator, argument, loc = null) {
  return { type: "UnaryExpression", operator, prefix: true, argument, loc };
}

function seqExpr(expressions, loc = null) {
  // FrontendCompiler.SequenceExpression pops/skips when expressions.length === 1;
  // always unwrap single-element sequences!
  if (expressions.length === 0) return undefExpr(loc);
  if (expressions.length === 1) return expressions[0];
  return { type: "SequenceExpression", expressions, loc };
}

function propNode(key, value, kind = "init", computed = false, loc = null) {
  return { type: "Property", key, value, kind, method: false, shorthand: false, computed, loc };
}

function collectUsedNames(node, out = new Set()) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) collectUsedNames(node[i], out);
    return out;
  }
  if ((node.type === "Identifier" || node.type === "PrivateIdentifier") && node.name) {
    out.add(node.name);
  }
  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === "loc" || key === "start" || key === "end") continue;
    collectUsedNames(node[key], out);
  }
  return out;
}

function collectBoundNamesFromPattern(pattern, out = []) {
  if (!pattern) return out;
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties) {
        if (prop.type === "RestElement") collectBoundNamesFromPattern(prop.argument, out);
        else collectBoundNamesFromPattern(prop.value, out);
      }
      break;
    case "ArrayPattern":
      for (const elem of pattern.elements) {
        if (elem) collectBoundNamesFromPattern(elem, out);
      }
      break;
    case "RestElement":
      collectBoundNamesFromPattern(pattern.argument, out);
      break;
    case "AssignmentPattern":
      collectBoundNamesFromPattern(pattern.left, out);
      break;
  }
  return out;
}

function isDirectiveStatement(stmt) {
  return (
    stmt &&
    stmt.type === "ExpressionStatement" &&
    stmt.expression &&
    stmt.expression.type === "Literal" &&
    typeof stmt.expression.value === "string" &&
    typeof stmt.directive === "string"
  );
}

function isSimpleExpression(expr) {
  if (!expr) return false;
  return (
    expr.type === "Identifier" ||
    expr.type === "ThisExpression" ||
    (expr.type === "Literal" && !expr.regex && expr.bigint == null)
  );
}

function isFunctionLike(node) {
  return (
    node &&
    (node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression")
  );
}

function isLoopStatement(node) {
  return (
    node &&
    (node.type === "ForStatement" ||
      node.type === "ForInStatement" ||
      node.type === "ForOutStatement" ||
      node.type === "ForOfStatement" ||
      node.type === "WhileStatement" ||
      node.type === "DoWhileStatement")
  );
}

// Collect lexical (`let`, `const`, `class`, block `FunctionDeclaration`) bindings
// declared directly inside a statement list or single block (without crossing
// into functions/classes or nested blocks, except for directly nested
// declarations in SwitchStatement cases).
function collectBlockLexicalDecls(stmts) {
  const result = new Map(); // name -> { kind: "let" | "const" | "class" | "function" }
  const arr = Array.isArray(stmts) ? stmts : [stmts];
  for (const stmt of arr) {
    if (!stmt) continue;
    if (stmt.type === "VariableDeclaration" && (stmt.kind === "let" || stmt.kind === "const")) {
      for (const d of stmt.declarations) {
        for (const name of collectBoundNamesFromPattern(d.id)) {
          result.set(name, { kind: stmt.kind });
        }
      }
    } else if (stmt.type === "ClassDeclaration" && stmt.id) {
      result.set(stmt.id.name, { kind: "class" });
    } else if (stmt.type === "FunctionDeclaration" && stmt.id) {
      result.set(stmt.id.name, { kind: "function" });
    }
  }
  return result;
}

// Walk subtree inside the same non-arrow function (stopping at nested
// Function/Arrow/Class) to check if `this` / `arguments` or loop exits exist,
// OR to collect free identifier references inside nested functions/classes.
function collectCapturedRefsInSubtree(root, candidateNames) {
  const captured = new Set();
  if (!candidateNames || candidateNames.size === 0) return captured;

  function walkClosure(node, shadowed) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walkClosure(item, shadowed);
      return;
    }
    if (node.type === "Identifier") {
      if (candidateNames.has(node.name) && !shadowed.has(node.name)) {
        captured.add(node.name);
      }
      return;
    }
    if (isFunctionLike(node)) {
      const next = new Set(shadowed);
      for (const p of node.params || []) {
        for (const n of collectBoundNamesFromPattern(p)) next.add(n);
      }
      if (node.id) next.add(node.id.name);
      if (node.body && node.body.type === "BlockStatement") {
        // Also collect vars and block lexical decls inside direct body
        const lex = collectBlockLexicalDecls(node.body.body);
        for (const k of lex.keys()) next.add(k);
        for (const st of node.body.body) {
          if (st.type === "VariableDeclaration") {
            for (const d of st.declarations) {
              for (const n of collectBoundNamesFromPattern(d.id)) next.add(n);
            }
          }
        }
      }
      walkClosure(node.body, next);
      return;
    }
    if (node.type === "MemberExpression" && !node.computed) {
      walkClosure(node.object, shadowed);
      return;
    }
    if (node.type === "Property" && !node.computed && node.key && node.key.type === "Identifier") {
      if (node.shorthand && candidateNames.has(node.key.name) && !shadowed.has(node.key.name)) {
        captured.add(node.key.name);
      }
      walkClosure(node.value, shadowed);
      return;
    }
    if (node.type === "BlockStatement") {
      const next = new Set(shadowed);
      for (const k of collectBlockLexicalDecls(node.body).keys()) next.add(k);
      walkClosure(node.body, next);
      return;
    }
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k === "loc" || k === "start" || k === "end") continue;
      walkClosure(node[k], shadowed);
    }
  }

  function scanForClosures(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) scanForClosures(item);
      return;
    }
    if (isFunctionLike(node)) {
      walkClosure(node, new Set());
      return;
    }
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      walkClosure(node, new Set());
      return;
    }
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k === "loc" || k === "start" || k === "end") continue;
      scanForClosures(node[k]);
    }
  }

  scanForClosures(root);
  return captured;
}

class ES5Transformer {
  constructor(options = {}) {
    this.strict = options.strict === true;
    this.usedNames = new Set();
    this.uidCounter = 0;
    this.helpersUsed = new Set();
    this.helperRenames = new Map(); // canonicalHelperName -> concreteName in this program
    this.topLevelHoistedVars = []; // [Identifier, ...] emitted after directives
    this.currentFunction = null;
    this.currentArrowCtx = null;
    this.currentClassCtx = null;
    this.currentObjectSuperRef = null;
    this.scopeChain = []; // stack of lexical binding maps: name -> { outName, kind }
    this.activeLoops = []; // stack for break/continue/return rewriting inside captured _loop bodies
  }

  uid(hint = "tmp") {
    const clean = String(hint).replace(/[^A-Za-z0-9_$]/g, "_") || "tmp";
    let candidate;
    do {
      candidate = `$s_${clean}_${this.uidCounter++}`;
    } while (this.usedNames.has(candidate) || ES5_RESERVED_WORDS.has(candidate));
    this.usedNames.add(candidate);
    return candidate;
  }

  useHelper(canonicalName, loc = null) {
    let localName = this.helperRenames.get(canonicalName);
    if (!localName) {
      localName = this.usedNames.has(canonicalName)
        ? this.uid(canonicalName.slice(1))
        : canonicalName;
      this.usedNames.add(localName);
      this.helperRenames.set(canonicalName, localName);
      this.helpersUsed.add(canonicalName);
      for (const dep of HELPER_DEPS[canonicalName] || []) {
        this.useHelper(dep);
      }
    }
    return id(localName, loc);
  }

  hoistTopVar(hint = "t", loc = null) {
    const varId = id(this.uid(hint), loc);
    this.topLevelHoistedVars.push(varId);
    return varId;
  }

  allocateLocalVar(hint = "v", loc = null) {
    const varId = id(this.uid(hint), loc);
    if (this.currentFunction) {
      this.currentFunction.hoistedVars.push(varId);
    } else {
      this.topLevelHoistedVars.push(varId);
    }
    return varId;
  }

  // Ensures a single-evaluation reference to `expr` if `expr` isn't already pure
  bindOnce(expr, stmtsOrExprs, hint = "ref", loc = null) {
    if (isSimpleExpression(expr)) {
      return expr;
    }
    const tmp = this.allocateLocalVar(hint, loc || expr.loc);
    stmtsOrExprs.push(assign(id(tmp.name, loc), expr, "=", loc));
    return id(tmp.name, loc);
  }

  resolveBinding(name) {
    for (let i = this.scopeChain.length - 1; i >= 0; i--) {
      const entry = this.scopeChain[i].get(name);
      if (entry) return entry;
    }
    return null;
  }

  pushScope(bindingsMap) {
    this.scopeChain.push(bindingsMap);
  }

  popScope() {
    this.scopeChain.pop();
  }

  // Builds a scope map for a block/loop/switch/catch where names must be unique
  createLexicalScope(declsMap, forceRenameAll = true) {
    const map = new Map();
    for (const [name, info] of declsMap.entries()) {
      let outName = name;
      if (forceRenameAll || ES5_RESERVED_WORDS.has(name)) {
        outName = this.uid(name);
      } else {
        this.usedNames.add(name);
      }
      map.set(name, { outName, kind: info.kind });
    }
    return map;
  }

  transformProgram(program) {
    collectUsedNames(program, this.usedNames);

    // Detect top-level directive prologue
    let directiveCount = 0;
    let isProgramStrict = this.strict;
    while (
      directiveCount < program.body.length &&
      isDirectiveStatement(program.body[directiveCount])
    ) {
      if (program.body[directiveCount].expression.value === "use strict") {
        isProgramStrict = true;
      }
      directiveCount++;
    }

    // Track script top-level const/var/let/class bindings without renaming
    // top-level declarations (except ES5 strict future-word conflicts).
    const rootBindings = new Map();
    for (const stmt of program.body) {
      if (stmt.type === "VariableDeclaration") {
        for (const d of stmt.declarations) {
          for (const n of collectBoundNamesFromPattern(d.id)) {
            const safeName =
              (isProgramStrict && ES5_RESERVED_WORDS.has(n)) || n === "eval" || n === "arguments"
                ? this.uid(n)
                : n;
            rootBindings.set(n, { outName: safeName, kind: stmt.kind });
          }
        }
      } else if (
        (stmt.type === "ClassDeclaration" || stmt.type === "FunctionDeclaration") &&
        stmt.id
      ) {
        const n = stmt.id.name;
        const safeName = isProgramStrict && ES5_RESERVED_WORDS.has(n) ? this.uid(n) : n;
        rootBindings.set(n, {
          outName: safeName,
          kind: stmt.type === "ClassDeclaration" ? "class" : "var",
        });
      }
    }

    this.pushScope(rootBindings);
    const savedStrict = this.strict;
    this.strict = isProgramStrict;
    const body = this.transformStatementList(program.body, { isRoot: true });
    this.strict = savedStrict;
    this.popScope();

    // Insert hoisted top-level temp var declarations right after directive prologues
    const directives = body.slice(0, directiveCount);
    const rest = body.slice(directiveCount);
    const hoistedStmts = [];
    if (this.topLevelHoistedVars.length > 0) {
      hoistedStmts.push(
        varDecl(
          this.topLevelHoistedVars.map((v) => ({
            type: "VariableDeclarator",
            id: v,
            init: null,
            loc: null,
          })),
          null
        )
      );
    }

    // Emit used ES5 runtime helpers as FunctionDeclarations at the end of
    // Program.body so hoisting registers them before statement 0 AND trailing
    // expression completion values & ft[0] order remain completely undisturbed!
    const helperDecls = this.emitHelperDeclarations();
    return {
      type: "Program",
      sourceType: "script",
      body: [...directives, ...hoistedStmts, ...rest, ...helperDecls],
      loc: program.loc || null,
    };
  }

  emitHelperDeclarations() {
    if (this.helpersUsed.size === 0) return [];
    const decls = [];
    for (const canonicalName of HELPER_SOURCES ? Object.keys(HELPER_SOURCES) : []) {
      if (!this.helpersUsed.has(canonicalName)) continue;
      const fnNode = getHelperAST(canonicalName);
      const rewriteIdentifiers = (node) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
          for (const item of node) rewriteIdentifiers(item);
          return;
        }
        if (node.type === "Identifier" && this.helperRenames.has(node.name)) {
          node.name = this.helperRenames.get(node.name);
        }
        if (node.type === "MemberExpression" && !node.computed) {
          rewriteIdentifiers(node.object);
          return;
        }
        if (node.type === "Property" && !node.computed) {
          rewriteIdentifiers(node.value);
          return;
        }
        const keys = Object.keys(node);
        for (let i = 0; i < keys.length; i++) rewriteIdentifiers(node[keys[i]]);
      };
      rewriteIdentifiers(fnNode);
      decls.push(fnNode);
    }
    return decls;
  }

  transformStatementList(stmts, { isRoot = false } = {}) {
    const out = [];
    // Hoist any block-scoped FunctionDeclaration (`!isRoot`) to the top of its block
    if (!isRoot) {
      for (const stmt of stmts) {
        if (stmt && stmt.type === "FunctionDeclaration" && stmt.id) {
          const binding = this.resolveBinding(stmt.id.name);
          const targetId = id(binding ? binding.outName : stmt.id.name, stmt.loc);
          const fn = this.transformFunctionNode(
            {
              type: "FunctionExpression",
              id: id(stmt.id.name, stmt.id.loc),
              params: stmt.params,
              body: stmt.body,
              generator: stmt.generator,
              async: stmt.async,
              loc: stmt.loc,
            },
            { asExpression: true }
          );
          out.push(varDecl1(targetId, fn, stmt.loc));
        }
      }
    }
    for (const stmt of stmts) {
      if (!isRoot && stmt && stmt.type === "FunctionDeclaration") {
        // Already emitted & initialized above
        continue;
      }
      const lowered = this.transformStatement(stmt, { isRoot });
      if (Array.isArray(lowered)) out.push(...lowered);
      else if (lowered) out.push(lowered);
    }
    return out;
  }

  transformBlockStatement(node, { extraScopeMap = null, alreadyInScope = false } = {}) {
    if (alreadyInScope) {
      const body = this.transformStatementList(node.body);
      return blockStmt(body, node.loc);
    }
    const decls = collectBlockLexicalDecls(node.body);
    const scopeMap = this.createLexicalScope(decls, true);
    if (extraScopeMap) {
      for (const [k, v] of extraScopeMap.entries()) {
        if (!scopeMap.has(k)) scopeMap.set(k, v);
      }
    }
    this.pushScope(scopeMap);
    const body = this.transformStatementList(node.body);
    this.popScope();
    return blockStmt(body, node.loc);
  }

  transformStatement(stmt, { isRoot = false } = {}) {
    if (!stmt) return stmt;
    const loc = stmt.loc || null;
    switch (stmt.type) {
      case "EmptyStatement":
        return stmt;

      case "BlockStatement":
        return this.transformBlockStatement(stmt);

      case "VariableDeclaration":
        return this.transformVariableDeclaration(stmt);

      case "ExpressionStatement":
        if (isDirectiveStatement(stmt)) return stmt;
        return exprStmt(this.transformExpression(stmt.expression), loc);

      case "IfStatement": {
        const test = this.transformExpression(stmt.test);
        const consequent = this.transformLoopOrBranchBody(stmt.consequent);
        const alternate = stmt.alternate ? this.transformLoopOrBranchBody(stmt.alternate) : null;
        return { type: "IfStatement", test, consequent, alternate, loc };
      }

      case "SwitchStatement": {
        const discriminant = this.transformExpression(stmt.discriminant);
        const allDecls = new Map();
        for (const c of stmt.cases) {
          for (const [name, info] of collectBlockLexicalDecls(c.consequent).entries()) {
            allDecls.set(name, info);
          }
        }
        const scopeMap = this.createLexicalScope(allDecls, true);
        this.pushScope(scopeMap);
        const cases = stmt.cases.map((c) => {
          const test = c.test ? this.transformExpression(c.test) : null;
          const cons = this.transformStatementList(c.consequent);
          return { type: "SwitchCase", test, consequent: cons, loc: c.loc };
        });
        this.popScope();
        return { type: "SwitchStatement", discriminant, cases, loc };
      }

      case "LabeledStatement": {
        const labelName = stmt.label.name;
        if (isLoopStatement(stmt.body)) {
          return this.transformLoopStatement(stmt.body, labelName, stmt.label, loc);
        }
        return {
          type: "LabeledStatement",
          label: stmt.label,
          body: this.transformLoopOrBranchBody(stmt.body),
          loc,
        };
      }

      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
      case "WhileStatement":
      case "DoWhileStatement":
        return this.transformLoopStatement(stmt, null, null, loc);

      case "BreakStatement":
        return this.rewriteJumpInCapturedLoop(stmt, "break");

      case "ContinueStatement":
        return this.rewriteJumpInCapturedLoop(stmt, "continue");

      case "ReturnStatement": {
        const activeCap = this.currentActiveCapturedLoop();
        const arg = stmt.argument ? this.transformExpression(stmt.argument) : null;
        if (activeCap) {
          activeCap.hasReturn = true;
          return {
            type: "ReturnStatement",
            argument: {
              type: "ObjectExpression",
              properties: [propNode(id("v", loc), arg || undefExpr(loc), "init", false, loc)],
              loc,
            },
            loc,
          };
        }
        if (this.currentClassCtx && this.currentClassCtx.isDerivedConstructor) {
          // Return from derived constructor validates return value through _possibleConstructorReturn
          const helper = this.useHelper("_possibleConstructorReturn", loc);
          const selfId = id(this.currentClassCtx.thisVar, loc);
          return {
            type: "ReturnStatement",
            argument: call(helper, [selfId, arg || undefExpr(loc)], loc),
            loc,
          };
        }
        return { type: "ReturnStatement", argument: arg, loc };
      }

      case "ThrowStatement":
        return { type: "ThrowStatement", argument: this.transformExpression(stmt.argument), loc };

      case "WithStatement":
        return {
          type: "WithStatement",
          object: this.transformExpression(stmt.object),
          body: this.transformLoopOrBranchBody(stmt.body),
          loc,
        };

      case "TryStatement": {
        const block = this.transformBlockStatement(stmt.block);
        let handler = null;
        if (stmt.handler) {
          handler = this.transformCatchClause(stmt.handler);
        }
        const finalizer = stmt.finalizer ? this.transformBlockStatement(stmt.finalizer) : null;
        return { type: "TryStatement", block, handler, finalizer, loc };
      }

      case "FunctionDeclaration":
        return this.transformFunctionNode(stmt, { asExpression: false });

      case "ClassDeclaration":
        return this.transformClassDeclaration(stmt);

      case "DebuggerStatement":
        return stmt;

      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
      case "ExportAllDeclaration":
        throw new SyntaxError(
          "ES module import/export declarations are not supported in guest scripts"
        );

      default:
        throw new SyntaxError(`Unsupported statement syntax in guest program: ${stmt.type}`);
    }
  }

  transformLoopOrBranchBody(node) {
    if (!node) return node;
    if (node.type === "BlockStatement") return this.transformBlockStatement(node);
    const res = this.transformStatement(node);
    if (Array.isArray(res)) return blockStmt(res, node.loc);
    return res;
  }

  transformCatchClause(handler) {
    const loc = handler.loc;
    if (!handler.param) {
      // Optional catch binding `catch {}` -> `catch ($unused) {}`
      const paramId = id(this.uid("err"), loc);
      return {
        type: "CatchClause",
        param: paramId,
        body: this.transformBlockStatement(handler.body),
        loc,
      };
    }
    if (handler.param.type === "Identifier") {
      const name = handler.param.name;
      const bodyDecls = collectBlockLexicalDecls(handler.body.body);
      const scopeMap = this.createLexicalScope(bodyDecls, true);
      const paramOut = ES5_RESERVED_WORDS.has(name) ? this.uid(name) : name;
      scopeMap.set(name, { outName: paramOut, kind: "var" });
      this.pushScope(scopeMap);
      const body = this.transformBlockStatement(handler.body, { alreadyInScope: true });
      this.popScope();
      return { type: "CatchClause", param: id(paramOut, handler.param.loc), body, loc };
    }
    // Destructuring catch pattern: `catch ({ message }) { ... }`
    const tmpId = id(this.uid("err"), handler.param.loc);
    const patNames = collectBoundNamesFromPattern(handler.param);
    const bodyDecls = collectBlockLexicalDecls(handler.body.body);
    for (const n of patNames) bodyDecls.set(n, { kind: "let" });
    const scopeMap = this.createLexicalScope(bodyDecls, true);
    this.pushScope(scopeMap);
    const destructuringDecls = this.lowerPatternToVarDecls(
      handler.param,
      id(tmpId.name, loc),
      "let",
      loc
    );
    const body = this.transformBlockStatement(handler.body, { alreadyInScope: true });
    this.popScope();
    body.body.unshift(...destructuringDecls);
    return { type: "CatchClause", param: tmpId, body, loc };
  }

  transformVariableDeclaration(node, { initOnlyNoKeyword = false } = {}) {
    const loc = node.loc;
    const isLexical = node.kind === "let" || node.kind === "const";
    const decls = [];
    const inNestedBlock = this.scopeChain.length > 1;

    for (const d of node.declarations) {
      const initExpr = d.init ? this.transformExpression(d.init) : null;
      if (d.id.type === "Identifier") {
        const binding = this.resolveBinding(d.id.name);
        const outId = id(binding ? binding.outName : d.id.name, d.id.loc);
        // Reset uninitialized `let x;` inside nested blocks/loops to avoid retaining
        // values from earlier loop iterations!
        const finalInit =
          initExpr !== null ? initExpr : isLexical && inNestedBlock ? undefExpr(d.loc) : null;
        if (initOnlyNoKeyword) {
          decls.push(finalInit ? assign(outId, finalInit, "=", d.loc) : outId);
        } else {
          decls.push({ type: "VariableDeclarator", id: outId, init: finalInit, loc: d.loc });
        }
      } else {
        // Destructuring declaration: lower pattern into flat `var` declarations
        const rhs = initExpr || undefExpr(d.loc);
        const extraStmts = this.lowerPatternToVarDecls(d.id, rhs, node.kind, d.loc);
        for (const st of extraStmts) {
          for (const vd of st.declarations) decls.push(vd);
        }
      }
    }
    if (initOnlyNoKeyword) {
      return seqExpr(
        decls.filter((x) => x.type === "AssignmentExpression"),
        loc
      );
    }
    return varDecl(decls, loc);
  }

  // Emits an array of `varDecl` statements binding `pattern` from `rhsExpr`.
  lowerPatternToVarDecls(pattern, rhsExpr, kind = "var", loc = null) {
    const out = [];
    const rhsRef = this.bindForPattern(rhsExpr, out, "ref", loc);
    this._emitPatternBindings(pattern, rhsRef, out, /* asAssign */ false, loc);
    return out;
  }

  bindForPattern(rhsExpr, outDeclsOrExprs, hint, loc) {
    if (rhsExpr.type === "Identifier") return rhsExpr;
    const tmp = id(this.uid(hint), loc);
    if (
      this.scopeChain.length > 0 &&
      Array.isArray(outDeclsOrExprs) &&
      outDeclsOrExprs._exprMode !== true
    ) {
      outDeclsOrExprs.push(varDecl1(tmp, rhsExpr, loc));
    } else {
      const hoisted = this.allocateLocalVar(hint, loc);
      outDeclsOrExprs.push(assign(id(hoisted.name, loc), rhsExpr, "=", loc));
      return id(hoisted.name, loc);
    }
    return tmp;
  }

  // Assigns `pattern = rhsExpr` inside expression context, preserving original rhsExpr!
  lowerPatternAssignment(pattern, rhsExpr, loc = null) {
    const exprs = [];
    exprs._exprMode = true;
    const rhsTmp = this.allocateLocalVar("ref", loc);
    exprs.push(assign(id(rhsTmp.name, loc), rhsExpr, "=", loc));
    this._emitPatternBindings(pattern, id(rhsTmp.name, loc), exprs, /* asAssign */ true, loc);
    exprs.push(id(rhsTmp.name, loc));
    return seqExpr(exprs, loc);
  }

  _emitPatternBindings(pattern, valueExpr, out, asAssign, loc) {
    const pushAssignOrDecl = (targetExpr, initExpr, nodeLoc) => {
      if (asAssign || targetExpr.type !== "Identifier") {
        out.push(
          asAssign
            ? assign(targetExpr, initExpr, "=", nodeLoc)
            : exprStmt(assign(targetExpr, initExpr, "=", nodeLoc), nodeLoc)
        );
      } else {
        out.push(varDecl1(targetIdFrom(targetExpr), initExpr, nodeLoc));
      }
    };
    function targetIdFrom(node) {
      return { type: "Identifier", name: node.name, loc: node.loc };
    }

    switch (pattern.type) {
      case "Identifier": {
        const binding = this.resolveBinding(pattern.name);
        if (asAssign && binding && binding.kind === "const") {
          const ro = call(this.useHelper("_readOnlyError", loc), [lit(pattern.name, loc)], loc);
          out.push(seqExpr([valueExpr, ro], loc));
          return;
        }
        const target = id(binding ? binding.outName : pattern.name, pattern.loc);
        pushAssignOrDecl(target, valueExpr, loc);
        break;
      }

      case "MemberExpression": {
        // E.g. `[obj.a, obj.b] = [1, 2]`
        const target = this.transformExpression(pattern);
        if (asAssign) out.push(assign(target, valueExpr, "=", pattern.loc));
        else out.push(exprStmt(assign(target, valueExpr, "=", pattern.loc), pattern.loc));
        break;
      }

      case "AssignmentPattern": {
        const srcRef = this._ensureRef(valueExpr, out, asAssign, "def", loc);
        const resolved = condExpr(
          binExpr("===", srcRef, undefExpr(loc), loc),
          this.transformExpression(pattern.right),
          id(srcRef.name, loc),
          loc
        );
        this._emitPatternBindings(pattern.left, resolved, out, asAssign, loc);
        break;
      }

      case "ObjectPattern": {
        const objRef = this._ensureRef(valueExpr, out, asAssign, "obj", loc);
        if (pattern.properties.length === 0) {
          const check = call(this.useHelper("_objectDestructuringEmpty", loc), [objRef], loc);
          out.push(asAssign ? check : exprStmt(check, loc));
          return;
        }
        // Check null/undefined destructuring before accessing first property, or `_objectDestructuringEmpty`
        const hasRest = pattern.properties.some((p) => p.type === "RestElement");
        const excludedExprs = [];
        for (const prop of pattern.properties) {
          if (prop.type === "RestElement") {
            const restHelper = this.useHelper("_objectWithoutProperties", prop.loc);
            const restVal = call(
              restHelper,
              [objRef, { type: "ArrayExpression", elements: excludedExprs, loc: prop.loc }],
              prop.loc
            );
            this._emitPatternBindings(prop.argument, restVal, out, asAssign, prop.loc);
            continue;
          }
          let propAccess;
          if (!prop.computed && prop.key.type === "Identifier") {
            if (hasRest) excludedExprs.push(lit(prop.key.name, prop.key.loc));
            propAccess = member(objRef, id(prop.key.name, prop.key.loc), false, prop.loc);
          } else if (!prop.computed && prop.key.type === "Literal") {
            if (hasRest) excludedExprs.push(lit(String(prop.key.value), prop.key.loc));
            propAccess = member(objRef, this.transformLiteral(prop.key), true, prop.loc);
          } else {
            const keyExpr = this.transformExpression(prop.key);
            const keyRef = hasRest
              ? this._ensureRef(
                  call(this.useHelper("_toPropertyKey", prop.key.loc), [keyExpr], prop.key.loc),
                  out,
                  asAssign,
                  "key",
                  prop.key.loc
                )
              : keyExpr;
            if (hasRest) excludedExprs.push(id(keyRef.name, prop.key.loc));
            propAccess = member(objRef, keyRef, true, prop.loc);
          }
          this._emitPatternBindings(prop.value, propAccess, out, asAssign, prop.loc);
        }
        break;
      }

      case "ArrayPattern": {
        const elements = pattern.elements;
        const hasRest = elements.some((e) => e && e.type === "RestElement");
        const sliceCount = hasRest ? null : elements.length;
        const arrRef = hasRest
          ? this._ensureRef(
              call(this.useHelper("_toArray", loc), [valueExpr], loc),
              out,
              asAssign,
              "arr",
              loc
            )
          : this._ensureRef(
              call(this.useHelper("_slicedToArray", loc), [valueExpr, lit(sliceCount, loc)], loc),
              out,
              asAssign,
              "arr",
              loc
            );
        for (let i = 0; i < elements.length; i++) {
          const elem = elements[i];
          if (!elem) continue;
          if (elem.type === "RestElement") {
            const restSlice = call(
              member(arrRef, id("slice", elem.loc), false, elem.loc),
              [lit(i, elem.loc)],
              elem.loc
            );
            this._emitPatternBindings(elem.argument, restSlice, out, asAssign, elem.loc);
          } else {
            const elemExpr = member(arrRef, lit(i, elem.loc), true, elem.loc);
            this._emitPatternBindings(elem, elemExpr, out, asAssign, elem.loc);
          }
        }
        break;
      }

      default:
        throw new SyntaxError(`Unsupported destructuring pattern: ${pattern.type}`);
    }
  }

  _ensureRef(expr, out, asAssign, hint, loc) {
    if (expr.type === "Identifier") return expr;
    if (asAssign) {
      const tmp = this.allocateLocalVar(hint, loc);
      out.push(assign(id(tmp.name, loc), expr, "=", loc));
      return id(tmp.name, loc);
    }
    const tmp = id(this.uid(hint), loc);
    out.push(varDecl1(tmp, expr, loc));
    return id(tmp.name, loc);
  }

  // -------------------------------------------------------------------------
  // Loops (including for..of AND per-iteration let/const closure capture)
  // -------------------------------------------------------------------------

  currentActiveCapturedLoop() {
    if (this.activeLoops.length === 0) return null;
    const top = this.activeLoops[this.activeLoops.length - 1];
    return top && top.isCaptured ? top : null;
  }

  rewriteJumpInCapturedLoop(stmt, kind) {
    const label = stmt.label ? stmt.label.name : null;
    // Walk active loops from innermost outward
    for (let i = this.activeLoops.length - 1; i >= 0; i--) {
      const entry = this.activeLoops[i];
      const matches = label ? entry.label === label : entry.canTargetUnlabeled(kind);
      if (entry.isCaptured) {
        if (matches) {
          if (label) {
            return {
              type: "ReturnStatement",
              argument: lit(`${kind}|${label}`, stmt.loc),
              loc: stmt.loc,
            };
          }
          return {
            type: "ReturnStatement",
            argument: kind === "break" ? lit("break", stmt.loc) : null,
            loc: stmt.loc,
          };
        }
        // Jumping across a `_loop` boundary to an outer loop/label!
        if (label) {
          entry.forwardedLabels.add(`${kind}|${label}`);
          return {
            type: "ReturnStatement",
            argument: lit(`${kind}|${label}`, stmt.loc),
            loc: stmt.loc,
          };
        }
      } else if (matches) {
        return stmt;
      }
    }
    return stmt;
  }

  transformLoopStatement(stmt, labelName, labelNode, loc) {
    // 1. Collect header lexical bindings (let/const) and direct body lexical bindings
    const headerDecls = new Map();
    if (
      stmt.type === "ForStatement" &&
      stmt.init &&
      stmt.init.type === "VariableDeclaration" &&
      (stmt.init.kind === "let" || stmt.init.kind === "const")
    ) {
      for (const d of stmt.init.declarations) {
        for (const n of collectBoundNamesFromPattern(d.id)) {
          headerDecls.set(n, { kind: stmt.init.kind });
        }
      }
    } else if (
      (stmt.type === "ForInStatement" || stmt.type === "ForOfStatement") &&
      stmt.left &&
      stmt.left.type === "VariableDeclaration" &&
      (stmt.left.kind === "let" || stmt.left.kind === "const")
    ) {
      for (const d of stmt.left.declarations) {
        for (const n of collectBoundNamesFromPattern(d.id)) {
          headerDecls.set(n, { kind: stmt.left.kind });
        }
      }
    }

    const bodyDirectDecls =
      stmt.body && stmt.body.type === "BlockStatement"
        ? collectBlockLexicalDecls(stmt.body.body)
        : new Map();

    // Check if any closure inside loop body captures any header or body lexical binding
    const capturedHeaderNames = collectCapturedRefsInSubtree(stmt.body, headerDecls);
    const capturedBodyNames = collectCapturedRefsInSubtree(stmt.body, bodyDirectDecls);
    // Notice: if `for (let i...) { ... closure reading bodyVar ... }`, wrapping the
    // loop body in `_loop(headerCaptured...)` ALSO gives every iteration fresh
    // function-scoped body variables automatically!
    const needsLoopWrapper = capturedHeaderNames.size > 0 || capturedBodyNames.size > 0;

    // Rename header bindings + body lexical bindings cleanly
    const headerScope = this.createLexicalScope(headerDecls, true);
    this.pushScope(headerScope);

    let loweredBody;
    let preamble = [];
    let loopStmt;

    if (needsLoopWrapper) {
      const capturedHeaderList = [...headerDecls.keys()].filter((k) => capturedHeaderNames.has(k));
      const paramIds = [];
      const argIds = [];
      const innerHeaderMap = new Map();

      for (const origName of capturedHeaderList) {
        const outerName = headerScope.get(origName).outName;
        const paramName = this.uid(origName);
        paramIds.push(id(paramName, loc));
        argIds.push(id(outerName, loc));
        innerHeaderMap.set(origName, { outName: paramName, kind: headerDecls.get(origName).kind });
      }

      const loopFnId = id(this.uid("loop"), loc);
      const retTmp = id(this.uid("ret"), loc);
      const captureEntry = {
        label: labelName,
        isCaptured: true,
        hasReturn: false,
        forwardedLabels: new Set(),
        canTargetUnlabeled: () => true,
      };

      this.pushScope(innerHeaderMap);
      this.activeLoops.push(captureEntry);

      // Build body statements inside `_loop(...)`
      let loopInnerBody;
      const bodyScopeDecls = collectBlockLexicalDecls(
        stmt.body && stmt.body.type === "BlockStatement" ? stmt.body.body : []
      );
      const bodyScopeMap = this.createLexicalScope(bodyScopeDecls, true);
      this.pushScope(bodyScopeMap);
      if (stmt.body.type === "BlockStatement") {
        loopInnerBody = this.transformStatementList(stmt.body.body);
      } else {
        const s = this.transformStatement(stmt.body);
        loopInnerBody = Array.isArray(s) ? s : s ? [s] : [];
      }
      this.popScope();

      this.activeLoops.pop();
      this.popScope();

      // If any captured `let` loop-header variable was mutated inside the
      // iteration body, sync its final iteration value back out to the outer
      // loop variable via `try { ... } finally { outer = param; }`.
      const syncOutAssigns = [];
      for (const origName of capturedHeaderList) {
        if (headerDecls.get(origName).kind === "let") {
          const outerName = headerScope.get(origName).outName;
          const innerName = innerHeaderMap.get(origName).outName;
          if (this._subtreeMutatesBinding(loopInnerBody, innerName)) {
            syncOutAssigns.push(
              exprStmt(assign(id(outerName, loc), id(innerName, loc), "=", loc), loc)
            );
          }
        }
      }
      const wrappedLoopBody =
        syncOutAssigns.length > 0
          ? [
              {
                type: "TryStatement",
                block: blockStmt(loopInnerBody, loc),
                handler: null,
                finalizer: blockStmt(syncOutAssigns, loc),
                loc,
              },
            ]
          : loopInnerBody;

      const loopFn = fnExpr(paramIds, wrappedLoopBody, null, loc);
      preamble.push(varDecl1(loopFnId, loopFn, loc));

      const callLoopStmt = varDecl1(retTmp, call(id(loopFnId.name, loc), argIds, loc), loc);
      const dispatchStmts = [callLoopStmt];
      if (captureEntry.hasReturn) {
        dispatchStmts.push({
          type: "IfStatement",
          test: logExpr(
            "&&",
            id(retTmp.name, loc),
            binExpr("===", unaryExpr("typeof", id(retTmp.name, loc), loc), lit("object", loc), loc),
            loc
          ),
          consequent: {
            type: "ReturnStatement",
            argument: member(id(retTmp.name, loc), id("v", loc), false, loc),
            loc,
          },
          alternate: null,
          loc,
        });
      }
      for (const fwd of captureEntry.forwardedLabels) {
        const [jmpKind, jmpLabel] = fwd.split("|");
        const rawJump =
          jmpKind === "break"
            ? { type: "BreakStatement", label: id(jmpLabel, loc), loc }
            : { type: "ContinueStatement", label: id(jmpLabel, loc), loc };
        dispatchStmts.push({
          type: "IfStatement",
          test: binExpr("===", id(retTmp.name, loc), lit(fwd, loc), loc),
          consequent: this.rewriteJumpInCapturedLoop(rawJump, jmpKind),
          alternate: null,
          loc,
        });
      }
      if (labelName) {
        dispatchStmts.push({
          type: "IfStatement",
          test: binExpr("===", id(retTmp.name, loc), lit(`break|${labelName}`, loc), loc),
          consequent: { type: "BreakStatement", label: null, loc },
          alternate: null,
          loc,
        });
        dispatchStmts.push({
          type: "IfStatement",
          test: binExpr("===", id(retTmp.name, loc), lit(`continue|${labelName}`, loc), loc),
          consequent: { type: "ContinueStatement", label: null, loc },
          alternate: null,
          loc,
        });
      }
      dispatchStmts.push({
        type: "IfStatement",
        test: binExpr("===", id(retTmp.name, loc), lit("break", loc), loc),
        consequent: { type: "BreakStatement", label: null, loc },
        alternate: null,
        loc,
      });

      loweredBody = blockStmt(dispatchStmts, stmt.body.loc);
    } else {
      const normalEntry = {
        label: labelName,
        isCaptured: false,
        canTargetUnlabeled: () => true,
      };
      this.activeLoops.push(normalEntry);
      loweredBody = this.transformLoopOrBranchBody(stmt.body);
      this.activeLoops.pop();
    }

    if (stmt.type === "ForOfStatement") {
      const wrapped = this.buildForOfLoop(stmt, loweredBody, loc, labelNode);
      this.popScope();
      return preamble.length > 0 ? [...preamble, ...wrapped] : wrapped;
    }

    if (stmt.type === "ForStatement") {
      let init = null;
      if (stmt.init) {
        init =
          stmt.init.type === "VariableDeclaration"
            ? this.transformVariableDeclaration(stmt.init)
            : this.transformExpression(stmt.init);
      }
      const test = stmt.test ? this.transformExpression(stmt.test) : null;
      const update = stmt.update ? this.transformExpression(stmt.update) : null;
      loopStmt = { type: "ForStatement", init, test, update, body: loweredBody, loc };
    } else if (stmt.type === "ForInStatement") {
      loopStmt = this.buildForInLoop(stmt, loweredBody, loc);
    } else if (stmt.type === "WhileStatement") {
      loopStmt = {
        type: "WhileStatement",
        test: this.transformExpression(stmt.test),
        body: loweredBody,
        loc,
      };
    } else if (stmt.type === "DoWhileStatement") {
      loopStmt = {
        type: "DoWhileStatement",
        test: this.transformExpression(stmt.test),
        body: loweredBody,
        loc,
      };
    }

    this.popScope();
    if (labelName) loopStmt = { type: "LabeledStatement", label: labelNode, body: loopStmt, loc };
    return preamble.length > 0 ? [...preamble, loopStmt] : loopStmt;
  }

  _subtreeMutatesBinding(node, name) {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some((item) => this._subtreeMutatesBinding(item, name));
    if (isFunctionLike(node)) return false;
    if (
      node.type === "AssignmentExpression" &&
      node.left &&
      node.left.type === "Identifier" &&
      node.left.name === name
    ) {
      return true;
    }
    if (
      node.type === "UpdateExpression" &&
      node.argument &&
      node.argument.type === "Identifier" &&
      node.argument.name === name
    ) {
      return true;
    }
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k === "loc" || k === "start" || k === "end") continue;
      if (this._subtreeMutatesBinding(node[k], name)) return true;
    }
    return false;
  }

  buildForInLoop(stmt, bodyBlock, loc) {
    const right = this.transformExpression(stmt.right);
    const bodyStmts = bodyBlock.type === "BlockStatement" ? bodyBlock.body.slice() : [bodyBlock];
    let leftNode;

    if (stmt.left.type === "VariableDeclaration") {
      const d = stmt.left.declarations[0];
      if (d.id.type === "Identifier") {
        const binding = this.resolveBinding(d.id.name);
        leftNode = varDecl(
          [
            {
              type: "VariableDeclarator",
              id: id(binding ? binding.outName : d.id.name, d.id.loc),
              init: null,
              loc: d.loc,
            },
          ],
          stmt.left.loc
        );
      } else {
        const keyTmp = id(this.uid("key"), d.loc);
        leftNode = varDecl1(keyTmp, null, stmt.left.loc);
        const bindings = this.lowerPatternToVarDecls(
          d.id,
          id(keyTmp.name, d.loc),
          stmt.left.kind,
          d.loc
        );
        bodyStmts.unshift(...bindings);
      }
    } else if (stmt.left.type === "Identifier") {
      const binding = this.resolveBinding(stmt.left.name);
      if (binding && binding.kind === "const") {
        const keyTmp = id(this.uid("key"), stmt.left.loc);
        leftNode = varDecl1(keyTmp, null, stmt.left.loc);
        bodyStmts.unshift(
          exprStmt(
            call(this.useHelper("_readOnlyError", loc), [lit(stmt.left.name, loc)], loc),
            loc
          )
        );
      } else {
        leftNode = id(binding ? binding.outName : stmt.left.name, stmt.left.loc);
      }
    } else if (stmt.left.type === "MemberExpression") {
      leftNode = this.transformExpression(stmt.left);
    } else {
      const keyTmp = id(this.uid("key"), stmt.left.loc);
      leftNode = varDecl1(keyTmp, null, stmt.left.loc);
      bodyStmts.unshift(
        exprStmt(
          this.lowerPatternAssignment(stmt.left, id(keyTmp.name, stmt.left.loc), stmt.left.loc),
          stmt.left.loc
        )
      );
    }

    return {
      type: "ForInStatement",
      left: leftNode,
      right,
      body: blockStmt(bodyStmts, bodyBlock.loc),
      loc,
    };
  }

  buildForOfLoop(stmt, bodyBlock, loc, labelNode = null) {
    if (stmt.await) {
      throw new SyntaxError("for-await-of loops are not supported in synchronous guest scripts");
    }
    const helper = this.useHelper("_createForOfIteratorHelper", loc);
    const iterId = id(this.uid("iterator"), loc);
    const stepId = id(this.uid("step"), loc);
    const errId = id(this.uid("err"), loc);
    const iterableExpr = this.transformExpression(stmt.right);

    const innerBody = bodyBlock.type === "BlockStatement" ? bodyBlock.body.slice() : [bodyBlock];
    const stepValueExpr = member(id(stepId.name, loc), id("value", loc), false, loc);

    // Assign / declare `stmt.left` from `step.value`
    if (stmt.left.type === "VariableDeclaration") {
      const d = stmt.left.declarations[0];
      if (d.id.type === "Identifier") {
        const binding = this.resolveBinding(d.id.name);
        innerBody.unshift(
          varDecl1(id(binding ? binding.outName : d.id.name, d.id.loc), stepValueExpr, d.loc)
        );
      } else {
        const bindings = this.lowerPatternToVarDecls(d.id, stepValueExpr, stmt.left.kind, d.loc);
        innerBody.unshift(...bindings);
      }
    } else {
      innerBody.unshift(
        exprStmt(
          this.lowerPatternAssignment(stmt.left, stepValueExpr, stmt.left.loc),
          stmt.left.loc
        )
      );
    }

    const forStmt = {
      type: "ForStatement",
      init: call(member(id(iterId.name, loc), id("s", loc), false, loc), [], loc),
      test: {
        type: "UnaryExpression",
        operator: "!",
        prefix: true,
        argument: member(
          assign(
            id(stepId.name, loc),
            call(member(id(iterId.name, loc), id("n", loc), false, loc), [], loc),
            "=",
            loc
          ),
          id("done", loc),
          false,
          loc
        ),
        loc,
      },
      update: null,
      body: blockStmt(innerBody, loc),
      loc,
    };

    const loopNode = labelNode
      ? { type: "LabeledStatement", label: labelNode, body: forStmt, loc }
      : forStmt;

    const tryStmt = {
      type: "TryStatement",
      block: blockStmt([loopNode], loc),
      handler: {
        type: "CatchClause",
        param: errId,
        body: blockStmt(
          [
            exprStmt(
              call(
                member(id(iterId.name, loc), id("e", loc), false, loc),
                [id(errId.name, loc)],
                loc
              ),
              loc
            ),
          ],
          loc
        ),
        loc,
      },
      finalizer: blockStmt(
        [exprStmt(call(member(id(iterId.name, loc), id("f", loc), false, loc), [], loc), loc)],
        loc
      ),
      loc,
    };

    return [
      varDecl(
        [
          { type: "VariableDeclarator", id: iterId, init: call(helper, [iterableExpr], loc), loc },
          { type: "VariableDeclarator", id: stepId, init: null, loc },
        ],
        loc
      ),
      tryStmt,
    ];
  }

  // -------------------------------------------------------------------------
  // Functions & Arrows
  // -------------------------------------------------------------------------

  transformFunctionNode(node, { asExpression = true, objectSuperVar = null } = {}) {
    if (node.async) {
      throw new SyntaxError(
        "Async functions are not supported in guest scripts; expose an async host capability instead"
      );
    }
    if (node.generator) {
      throw new SyntaxError("Generator functions are not supported in guest scripts");
    }

    const loc = node.loc || null;
    const isArrow = node.type === "ArrowFunctionExpression";

    const fnCtx = isArrow
      ? this.currentFunction
      : {
          hoistedVars: [],
          thisAlias: null,
          argumentsAlias: null,
        };

    // Determine fn.length preserving ES6 behavior (stop before first default or rest parameter;
    // ObjectPattern/ArrayPattern before the first default/rest still count toward fn.length).
    const rawParams = node.params || [];
    const simpleParams = [];
    let seenDefaultOrRest = false;
    const paramDecls = [];
    const paramNamesMap = new Map();

    // Pre-collect body direct lexical decls so block scoping works identically to blocks
    const bodyStmtsRaw =
      node.body.type === "BlockStatement"
        ? node.body.body
        : [{ type: "ReturnStatement", argument: node.body, loc: node.body.loc }];

    const bodyLexDecls = collectBlockLexicalDecls(bodyStmtsRaw);
    // Notice `params` cannot conflict with ES5 strict reserved words; rename any
    // param whose name is in ES5_RESERVED_WORDS or shadowed by body lexical decls.
    const paramScopeMap = new Map();

    // First process parameter names cleanly
    for (let i = 0; i < rawParams.length; i++) {
      const p = rawParams[i];
      if (!seenDefaultOrRest && p.type === "Identifier") {
        const cleanName = ES5_RESERVED_WORDS.has(p.name) ? this.uid(p.name) : p.name;
        simpleParams.push(id(cleanName, p.loc));
        paramScopeMap.set(p.name, { outName: cleanName, kind: "var" });
        paramNamesMap.set(p.name, cleanName);
      } else if (!seenDefaultOrRest && (p.type === "ObjectPattern" || p.type === "ArrayPattern")) {
        const placeholder = id(this.uid("param"), p.loc);
        simpleParams.push(placeholder);
        for (const bn of collectBoundNamesFromPattern(p)) {
          paramScopeMap.set(bn, {
            outName: ES5_RESERVED_WORDS.has(bn) ? this.uid(bn) : bn,
            kind: "var",
          });
        }
        paramDecls.push({ kind: "pattern", index: i, placeholder, pattern: p, loc: p.loc });
      } else {
        seenDefaultOrRest = true;
        if (p.type === "RestElement") {
          // Rest parameter: `function fn(a, ...rest)` -> params stay `[a]` (rest not in fn.length!)
          for (const bn of collectBoundNamesFromPattern(p.argument)) {
            paramScopeMap.set(bn, {
              outName: ES5_RESERVED_WORDS.has(bn) ? this.uid(bn) : bn,
              kind: "var",
            });
          }
          const restLenExpr = binExpr(
            ">",
            member(id("arguments", p.loc), id("length", p.loc), false, p.loc),
            lit(i, p.loc),
            p.loc
          );
          const restLenIdent = id(this.uid("len"), p.loc);
          const restArrIdent = id(this.uid("rest"), p.loc);
          const restKeyIdent = id(this.uid("key"), p.loc);
          const copyLoop = {
            type: "ForStatement",
            init: varDecl(
              [
                {
                  type: "VariableDeclarator",
                  id: restLenIdent,
                  init: member(id("arguments", p.loc), id("length", p.loc), false, p.loc),
                  loc: p.loc,
                },
                {
                  type: "VariableDeclarator",
                  id: restArrIdent,
                  init: {
                    type: "NewExpression",
                    callee: id("Array", p.loc),
                    arguments: [
                      condExpr(
                        restLenExpr,
                        binExpr("-", id(restLenIdent.name, p.loc), lit(i, p.loc), p.loc),
                        lit(0, p.loc),
                        p.loc
                      ),
                    ],
                    loc: p.loc,
                  },
                  loc: p.loc,
                },
                { type: "VariableDeclarator", id: restKeyIdent, init: lit(i, p.loc), loc: p.loc },
              ],
              p.loc
            ),
            test: binExpr("<", id(restKeyIdent.name, p.loc), id(restLenIdent.name, p.loc), p.loc),
            update: {
              type: "UpdateExpression",
              operator: "++",
              argument: id(restKeyIdent.name, p.loc),
              prefix: false,
              loc: p.loc,
            },
            body: blockStmt(
              [
                exprStmt(
                  assign(
                    member(
                      id(restArrIdent.name, p.loc),
                      binExpr("-", id(restKeyIdent.name, p.loc), lit(i, p.loc), p.loc),
                      true,
                      p.loc
                    ),
                    member(id("arguments", p.loc), id(restKeyIdent.name, p.loc), true, p.loc),
                    "=",
                    p.loc
                  ),
                  p.loc
                ),
              ],
              p.loc
            ),
            loc: p.loc,
          };
          paramDecls.push({
            kind: "rest",
            loop: copyLoop,
            arrId: restArrIdent,
            pattern: p.argument,
            loc: p.loc,
          });
        } else {
          // Complex pattern (`AssignmentPattern` / `ObjectPattern` / `ArrayPattern`) OR parameter after a default param:
          // Use `arguments[i]` if nonSimple or after a default, OR keep named placeholder when after a default if Identifier!
          for (const bn of collectBoundNamesFromPattern(p)) {
            paramScopeMap.set(bn, {
              outName: ES5_RESERVED_WORDS.has(bn) ? this.uid(bn) : bn,
              kind: "var",
            });
          }
          paramDecls.push({ kind: "pattern", index: i, pattern: p, loc: p.loc });
        }
      }
    }

    // Add body top-level lexical names ONLY when they don't already shadow params
    for (const [n, info] of bodyLexDecls.entries()) {
      if (!paramScopeMap.has(n)) {
        const clean = ES5_RESERVED_WORDS.has(n) ? this.uid(n) : n;
        paramScopeMap.set(n, { outName: clean, kind: info.kind });
      }
    }

    // Directives inside body
    let bodyDirCount = 0;
    let bodyStrict = this.strict;
    while (bodyDirCount < bodyStmtsRaw.length && isDirectiveStatement(bodyStmtsRaw[bodyDirCount])) {
      if (bodyStmtsRaw[bodyDirCount].expression.value === "use strict") bodyStrict = true;
      bodyDirCount++;
    }

    const prevFunction = this.currentFunction;
    const prevArrowCtx = this.currentArrowCtx;
    const prevLoops = this.activeLoops;
    const prevStrict = this.strict;
    const prevObjSuper = this.currentObjectSuperRef;

    this.strict = bodyStrict;
    this.activeLoops = [];

    if (!isArrow) {
      this.currentFunction = fnCtx;
      this.currentArrowCtx = null;
      if (objectSuperVar) this.currentObjectSuperRef = objectSuperVar;
    } else {
      // Arrow captures lexical `this` / `arguments` from nearest enclosing non-arrow function (or root `_this`)
      if (!this.currentArrowCtx) {
        this.currentArrowCtx = {
          requestThis: () => {
            if (!fnCtx) {
              if (!this._scriptThisAlias) {
                this._scriptThisAlias = id(this.uid("this"), loc);
                this.topLevelHoistedVars.push(this._scriptThisAlias);
              }
              return id(this._scriptThisAlias.name, loc);
            }
            if (!fnCtx.thisAlias) fnCtx.thisAlias = id(this.uid("this"), loc);
            return id(fnCtx.thisAlias.name, loc);
          },
          requestArguments: () => {
            if (!fnCtx) return null;
            if (!fnCtx.argumentsAlias) fnCtx.argumentsAlias = id(this.uid("args"), loc);
            return id(fnCtx.argumentsAlias.name, loc);
          },
        };
      }
    }

    this.pushScope(paramScopeMap);

    // Emit parameter destructuring/default/rest prologues
    const paramInitStmts = [];
    for (const entry of paramDecls) {
      if (entry.kind === "rest") {
        paramInitStmts.push(entry.loop);
        if (entry.pattern.type === "Identifier") {
          const b = this.resolveBinding(entry.pattern.name);
          paramInitStmts.push(
            varDecl1(
              id(b ? b.outName : entry.pattern.name, entry.loc),
              id(entry.arrId.name, entry.loc),
              entry.loc
            )
          );
        } else {
          paramInitStmts.push(
            ...this.lowerPatternToVarDecls(
              entry.pattern,
              id(entry.arrId.name, entry.loc),
              "var",
              entry.loc
            )
          );
        }
      } else {
        const rawArg = member(
          id("arguments", entry.loc),
          lit(entry.index, entry.loc),
          true,
          entry.loc
        );
        if (entry.pattern.type === "AssignmentPattern") {
          const valExpr = condExpr(
            binExpr("!==", rawArg, undefExpr(entry.loc), entry.loc),
            member(id("arguments", entry.loc), lit(entry.index, entry.loc), true, entry.loc),
            this.transformExpression(entry.pattern.right),
            entry.loc
          );
          if (entry.pattern.left.type === "Identifier") {
            const b = this.resolveBinding(entry.pattern.left.name);
            paramInitStmts.push(
              varDecl1(
                id(b ? b.outName : entry.pattern.left.name, entry.pattern.left.loc),
                valExpr,
                entry.loc
              )
            );
          } else {
            paramInitStmts.push(
              ...this.lowerPatternToVarDecls(entry.pattern.left, valExpr, "var", entry.loc)
            );
          }
        } else if (entry.pattern.type === "Identifier") {
          const b = this.resolveBinding(entry.pattern.name);
          paramInitStmts.push(
            varDecl1(
              id(b ? b.outName : entry.pattern.name, entry.pattern.loc),
              member(id("arguments", entry.loc), lit(entry.index, entry.loc), true, entry.loc),
              entry.loc
            )
          );
        } else {
          const sourceExpr = entry.placeholder
            ? id(entry.placeholder.name, entry.loc)
            : member(id("arguments", entry.loc), lit(entry.index, entry.loc), true, entry.loc);
          paramInitStmts.push(
            ...this.lowerPatternToVarDecls(entry.pattern, sourceExpr, "var", entry.loc)
          );
        }
      }
    }

    const transformedBody = this.transformStatementList(bodyStmtsRaw);

    this.popScope();

    const directives = transformedBody.slice(0, bodyDirCount);
    const restBody = transformedBody.slice(bodyDirCount);
    const prologue = [];

    if (!isArrow) {
      if (fnCtx.thisAlias) {
        prologue.push(varDecl1(fnCtx.thisAlias, { type: "ThisExpression", loc }, loc));
      }
      if (fnCtx.argumentsAlias) {
        prologue.push(varDecl1(fnCtx.argumentsAlias, id("arguments", loc), loc));
      }
      if (fnCtx.hoistedVars.length > 0) {
        prologue.push(
          varDecl(
            fnCtx.hoistedVars.map((v) => ({
              type: "VariableDeclarator",
              id: v,
              init: null,
              loc: null,
            })),
            null
          )
        );
      }
    }

    this.currentFunction = prevFunction;
    this.currentArrowCtx = prevArrowCtx;
    this.activeLoops = prevLoops;
    this.strict = prevStrict;
    this.currentObjectSuperRef = prevObjSuper;

    const finalStmts = [...directives, ...prologue, ...paramInitStmts, ...restBody];
    const fnIdNode = node.id ? id(node.id.name, node.id.loc) : null;
    if (asExpression) {
      return fnExpr(simpleParams, finalStmts, fnIdNode, loc);
    }
    return fnDecl(fnIdNode, simpleParams, finalStmts, loc);
  }

  // -------------------------------------------------------------------------
  // Classes & Super & Private Elements (#x)
  // -------------------------------------------------------------------------

  transformClassDeclaration(stmt) {
    const loc = stmt.loc;
    const className = stmt.id.name;
    const binding = this.resolveBinding(className);
    const outId = id(binding ? binding.outName : className, stmt.id.loc);
    const classExprNode = { ...stmt, type: "ClassExpression" };
    // Always lower ClassDeclaration to VariableDeclaration (`var Foo = ...`) so
    // hoisting in `FrontendCompiler` registers Foo AND script completion stays intact!
    return varDecl1(outId, this.transformClassExpression(classExprNode), loc);
  }

  transformClassExpression(node) {
    const loc = node.loc || null;
    const className = node.id ? node.id.name : this.uid("Class");
    const classId = id(
      ES5_RESERVED_WORDS.has(className) ? this.uid(className) : className,
      node.id ? node.id.loc : loc
    );
    const hasSuper = node.superClass != null;

    const superParamId = hasSuper ? id(this.uid("Base"), node.superClass.loc) : null;
    const superVarId = hasSuper ? id(this.uid("super"), loc) : null;

    const iifeBody = [
      {
        type: "ExpressionStatement",
        expression: lit("use strict", loc),
        directive: "use strict",
        loc: null,
      },
    ];

    if (hasSuper) {
      iifeBody.push(
        exprStmt(
          call(
            this.useHelper("_inherits", loc),
            [id(classId.name, loc), id(superParamId.name, loc)],
            loc
          ),
          loc
        ),
        varDecl1(
          superVarId,
          call(this.useHelper("_createSuper", loc), [id(classId.name, loc)], loc),
          loc
        )
      );
    }

    // Collect private elements across class body
    const privateDecls = new Map(); // "#name" -> { kind: "field"|"method"|"accessor", static, storageId, fnId?, initExpr? }
    for (const el of node.body.body) {
      if (el.key && el.key.type === "PrivateIdentifier") {
        const keyName = el.key.name;
        const entry = privateDecls.get(keyName) || {
          name: keyName,
          static: !!el.static,
          kind:
            el.type === "MethodDefinition"
              ? el.kind === "get" || el.kind === "set"
                ? "accessor"
                : "method"
              : "field",
          storageId: id(this.uid(keyName), el.loc),
          fnId:
            el.type === "MethodDefinition" && el.kind === "method"
              ? id(this.uid(`${keyName}_fn`), el.loc)
              : null,
          getFnId: null,
          setFnId: null,
        };
        if (el.kind === "get") entry.getFnId = id(this.uid(`get_${keyName}`), el.loc);
        if (el.kind === "set") entry.setFnId = id(this.uid(`set_${keyName}`), el.loc);
        privateDecls.set(keyName, entry);
      }
    }

    // Declare WeakMap / WeakSet / static descriptor storages inside IIFE
    const instanceFieldInits = [];
    const instancePrivateMethodInits = [];
    const staticPostStatements = [];

    for (const entry of privateDecls.values()) {
      if (!entry.static) {
        const ctor = entry.kind === "method" ? "WeakSet" : "WeakMap";
        iifeBody.push(
          varDecl1(
            entry.storageId,
            { type: "NewExpression", callee: id(ctor, loc), arguments: [], loc },
            loc
          )
        );
        if (entry.kind === "method") {
          instancePrivateMethodInits.push(
            exprStmt(
              call(
                this.useHelper("_classPrivateMethodInitSpec", loc),
                [{ type: "ThisExpression", loc }, id(entry.storageId.name, loc)],
                loc
              ),
              loc
            )
          );
        } else if (entry.kind === "accessor") {
          const accProps = [];
          if (entry.getFnId)
            accProps.push(
              propNode(id("get", loc), id(entry.getFnId.name, loc), "init", false, loc)
            );
          if (entry.setFnId)
            accProps.push(
              propNode(id("set", loc), id(entry.setFnId.name, loc), "init", false, loc)
            );
          instancePrivateMethodInits.push(
            exprStmt(
              call(
                this.useHelper("_classPrivateFieldInitSpec", loc),
                [
                  { type: "ThisExpression", loc },
                  id(entry.storageId.name, loc),
                  { type: "ObjectExpression", properties: accProps, loc },
                ],
                loc
              ),
              loc
            )
          );
        }
      }
    }

    let constructorNode = null;
    const protoDescriptors = [];
    const staticDescriptors = [];

    // Push class context for constructor/methods/private expressions
    const prevClassCtx = this.currentClassCtx;
    const ctorThisId = id(this.uid("this"), loc);
    this.currentClassCtx = {
      classId,
      hasSuper,
      superVarId,
      privateDecls,
      thisVar: ctorThisId.name,
      isDerivedConstructor: false,
    };

    // Process class elements
    for (const el of node.body.body) {
      if (el.type === "MethodDefinition") {
        if (el.kind === "constructor") {
          constructorNode = el;
          continue;
        }
        if (el.key.type === "PrivateIdentifier") {
          const entry = privateDecls.get(el.key.name);
          const fn = this.transformFunctionNode(el.value, { asExpression: true });
          const targetFnId =
            el.kind === "get" ? entry.getFnId : el.kind === "set" ? entry.setFnId : entry.fnId;
          iifeBody.push({ ...fn, type: "FunctionDeclaration", id: targetFnId });
          if (entry.static && entry.kind === "method") {
            iifeBody.push(varDecl1(entry.storageId, id(targetFnId.name, el.loc), el.loc));
          } else if (entry.static && entry.kind === "accessor" && !entry.staticAccessorEmitted) {
            entry.staticAccessorEmitted = true;
            const accProps = [];
            if (entry.getFnId)
              accProps.push(
                propNode(id("get", el.loc), id(entry.getFnId.name, el.loc), "init", false, el.loc)
              );
            if (entry.setFnId)
              accProps.push(
                propNode(id("set", el.loc), id(entry.setFnId.name, el.loc), "init", false, el.loc)
              );
            staticPostStatements.push(
              varDecl1(
                entry.storageId,
                { type: "ObjectExpression", properties: accProps, loc: el.loc },
                el.loc
              )
            );
          }
          continue;
        }
        const keyExpr = this.computeClassKey(el.key, el.computed);
        // Handle `super.prop` inside class methods via helper rewrites
        const savedInMethod = this.currentClassCtx.inStaticMethod;
        const savedSuperFlag = this.currentClassCtx.isDerivedConstructor;
        this.currentClassCtx.inStaticMethod = !!el.static;
        this.currentClassCtx.isDerivedConstructor = false;
        const fn = this.transformFunctionNode(el.value, { asExpression: true });
        this.currentClassCtx.inStaticMethod = savedInMethod;
        this.currentClassCtx.isDerivedConstructor = savedSuperFlag;

        const propKey = el.kind === "get" ? "get" : el.kind === "set" ? "set" : "value";
        const descObj = {
          type: "ObjectExpression",
          properties: [
            propNode(id("key", el.loc), keyExpr, "init", false, el.loc),
            propNode(id(propKey, el.loc), fn, "init", false, el.loc),
          ],
          loc: el.loc,
        };
        if (el.static) staticDescriptors.push(descObj);
        else protoDescriptors.push(descObj);
      } else if (el.type === "PropertyDefinition") {
        if (el.key.type === "PrivateIdentifier") {
          const entry = privateDecls.get(el.key.name);
          const initVal = el.value ? this.transformExpression(el.value) : undefExpr(el.loc);
          if (entry.static) {
            staticPostStatements.push(
              varDecl1(
                entry.storageId,
                {
                  type: "ObjectExpression",
                  properties: [
                    propNode(id("writable", el.loc), lit(true, el.loc), "init", false, el.loc),
                    propNode(id("value", el.loc), initVal, "init", false, el.loc),
                  ],
                  loc: el.loc,
                },
                el.loc
              )
            );
          } else {
            instanceFieldInits.push(
              exprStmt(
                call(
                  this.useHelper("_classPrivateFieldInitSpec", el.loc),
                  [
                    { type: "ThisExpression", loc: el.loc },
                    id(entry.storageId.name, el.loc),
                    {
                      type: "ObjectExpression",
                      properties: [
                        propNode(id("writable", el.loc), lit(true, el.loc), "init", false, el.loc),
                        propNode(id("value", el.loc), initVal, "init", false, el.loc),
                      ],
                      loc: el.loc,
                    },
                  ],
                  el.loc
                ),
                el.loc
              )
            );
          }
          continue;
        }
        // Public field
        if (el.static) {
          const keyExpr = this.computeClassKey(el.key, el.computed);
          const valExpr = el.value ? this.transformExpression(el.value) : undefExpr(el.loc);
          staticPostStatements.push(
            exprStmt(
              call(
                this.useHelper("_defineProperty", el.loc),
                [id(classId.name, el.loc), keyExpr, valExpr],
                el.loc
              ),
              el.loc
            )
          );
        } else {
          // Hoist computed key at class definition time so side effects run once
          const keyExpr = el.computed
            ? this.hoistClassComputedKey(el.key, iifeBody, el.loc)
            : this.computeClassKey(el.key, false);
          const valExpr = el.value ? this.transformExpression(el.value) : undefExpr(el.loc);
          instanceFieldInits.push(
            exprStmt(
              call(
                this.useHelper("_defineProperty", el.loc),
                [{ type: "ThisExpression", loc: el.loc }, keyExpr, valExpr],
                el.loc
              ),
              el.loc
            )
          );
        }
      } else if (el.type === "StaticBlock") {
        const bodyStmts = this.transformStatementList(el.body);
        staticPostStatements.push(
          exprStmt(
            call(
              member(fnExpr([], bodyStmts, null, el.loc), id("call", el.loc), false, el.loc),
              [id(classId.name, el.loc)],
              el.loc
            ),
            el.loc
          )
        );
      }
    }

    // Build constructor function
    const ctorFn = this.buildConstructorFunction(
      classId,
      hasSuper,
      superVarId,
      ctorThisId,
      constructorNode,
      instancePrivateMethodInits,
      instanceFieldInits,
      loc
    );
    iifeBody.push(ctorFn);

    if (protoDescriptors.length > 0 || staticDescriptors.length > 0) {
      iifeBody.push(
        exprStmt(
          call(
            this.useHelper("_createClass", loc),
            [
              id(classId.name, loc),
              protoDescriptors.length > 0
                ? { type: "ArrayExpression", elements: protoDescriptors, loc }
                : lit(null, loc),
              staticDescriptors.length > 0
                ? { type: "ArrayExpression", elements: staticDescriptors, loc }
                : lit(null, loc),
            ],
            loc
          ),
          loc
        )
      );
    }

    iifeBody.push(...staticPostStatements);
    iifeBody.push({ type: "ReturnStatement", argument: id(classId.name, loc), loc });

    this.currentClassCtx = prevClassCtx;

    // If `node.id` existed on a ClassExpression (`const x = class MyName {}`),
    // ensure internal references to `MyName` inside the class use `classId`.
    const outerIife = fnExpr(hasSuper ? [superParamId] : [], iifeBody, null, loc);
    return call(outerIife, hasSuper ? [this.transformExpression(node.superClass)] : [], loc);
  }

  hoistClassComputedKey(keyNode, iifeBody, loc) {
    const tmp = id(this.uid("key"), loc);
    iifeBody.push(varDecl1(tmp, this.transformExpression(keyNode), loc));
    return id(tmp.name, loc);
  }

  computeClassKey(keyNode, computed) {
    if (computed) return this.transformExpression(keyNode);
    if (keyNode.type === "Identifier") return lit(keyNode.name, keyNode.loc);
    if (keyNode.type === "Literal") return this.transformLiteral(keyNode);
    return this.transformExpression(keyNode);
  }

  buildConstructorFunction(
    classId,
    hasSuper,
    superVarId,
    ctorThisId,
    constructorNode,
    privateMethodInits,
    fieldInits,
    loc
  ) {
    const callCheck = exprStmt(
      call(
        this.useHelper("_classCallCheck", loc),
        [{ type: "ThisExpression", loc }, id(classId.name, loc)],
        loc
      ),
      loc
    );

    if (!constructorNode) {
      if (!hasSuper) {
        return fnDecl(classId, [], [callCheck, ...privateMethodInits, ...fieldInits], loc);
      }
      // Default derived constructor:
      // var _this = _super.apply(this, arguments);
      // ...privateMethodInits & fieldInits (rewriting `this` -> `_this`)
      // return _this;
      const superApply = varDecl1(
        ctorThisId,
        call(
          member(id(superVarId.name, loc), id("apply", loc), false, loc),
          [{ type: "ThisExpression", loc }, id("arguments", loc)],
          loc
        ),
        loc
      );
      const rewrittenPrivateInits = this.rewriteThisToIdent(privateMethodInits, ctorThisId.name);
      const rewrittenFieldInits = this.rewriteThisToIdent(fieldInits, ctorThisId.name);
      return fnDecl(
        classId,
        [],
        [
          callCheck,
          superApply,
          ...rewrittenPrivateInits,
          ...rewrittenFieldInits,
          { type: "ReturnStatement", argument: id(ctorThisId.name, loc), loc },
        ],
        loc
      );
    }

    // Explicit constructor
    if (!hasSuper) {
      const loweredFn = this.transformFunctionNode(constructorNode.value, { asExpression: true });
      return fnDecl(
        classId,
        loweredFn.params,
        [callCheck, ...privateMethodInits, ...fieldInits, ...loweredFn.body.body],
        loc
      );
    }

    // Derived explicit constructor: rewrite `super(...)` and `this`
    this.currentClassCtx.isDerivedConstructor = true;
    this.currentClassCtx.pendingInstanceInits = [...privateMethodInits, ...fieldInits];
    this.currentClassCtx.injectedSuperInits = false;
    const loweredFn = this.transformFunctionNode(constructorNode.value, { asExpression: true });
    this.currentClassCtx.isDerivedConstructor = false;
    const rawBody = loweredFn.body.body;
    // Inject `var _this;` at start of constructor and return `_possibleConstructorReturn(_this)` at end
    const bodyWithThisVar = [
      callCheck,
      varDecl1(id(ctorThisId.name, loc), null, loc),
      ...rawBody,
      {
        type: "ReturnStatement",
        argument: call(
          this.useHelper("_possibleConstructorReturn", loc),
          [id(ctorThisId.name, loc)],
          loc
        ),
        loc,
      },
    ];
    return fnDecl(classId, loweredFn.params, bodyWithThisVar, loc);
  }

  rewriteThisToIdent(nodes, targetName) {
    const clone = JSON.parse(JSON.stringify(nodes));
    const walk = (n) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) {
        for (let i = 0; i < n.length; i++) {
          if (n[i] && n[i].type === "ThisExpression") n[i] = id(targetName, n[i].loc);
          else walk(n[i]);
        }
        return;
      }
      if (isFunctionLike(n)) return;
      const keys = Object.keys(n);
      for (const k of keys) {
        if (k === "loc" || k === "start" || k === "end") continue;
        if (n[k] && n[k].type === "ThisExpression") n[k] = id(targetName, n[k].loc);
        else walk(n[k]);
      }
    };
    walk(clone);
    return clone;
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  transformExpression(node) {
    if (!node) return node;
    const loc = node.loc || null;

    switch (node.type) {
      case "Literal":
        return this.transformLiteral(node);

      case "Identifier": {
        if (node.name === "arguments" && this.currentArrowCtx) {
          const argAlias = this.currentArrowCtx.requestArguments();
          if (argAlias) return argAlias;
        }
        const binding = this.resolveBinding(node.name);
        if (binding && binding.outName !== node.name) {
          return id(binding.outName, loc);
        }
        return node;
      }

      case "ThisExpression": {
        if (this.currentArrowCtx) {
          return this.currentArrowCtx.requestThis();
        }
        if (this.currentClassCtx && this.currentClassCtx.isDerivedConstructor) {
          return call(
            this.useHelper("_assertThisInitialized", loc),
            [id(this.currentClassCtx.thisVar, loc)],
            loc
          );
        }
        return node;
      }

      case "Super":
        throw new SyntaxError("Invalid bare 'super' reference");

      case "MetaProperty":
        if (node.meta.name === "new" && node.property.name === "target") {
          return this.currentFunction ? undefExpr(loc) : undefExpr(loc);
        }
        throw new SyntaxError("import.meta is not supported in guest scripts");

      case "ArrayExpression":
        return this.transformArrayExpression(node);

      case "ObjectExpression":
        return this.transformObjectExpression(node);

      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return this.transformFunctionNode(node, { asExpression: true });

      case "ClassExpression":
        return this.transformClassExpression(node);

      case "TemplateLiteral":
        return this.transformTemplateLiteral(node);

      case "TaggedTemplateExpression":
        return this.transformTaggedTemplateLiteral(node);

      case "MemberExpression":
        return this.transformMemberExpression(node);

      case "ChainExpression":
        return this.transformChainExpression(node.expression, /* isDelete */ false);

      case "CallExpression":
        return this.transformCallExpression(node);

      case "NewExpression":
        return this.transformNewExpression(node);

      case "UnaryExpression":
        if (node.operator === "delete") {
          if (node.argument.type === "ChainExpression") {
            return this.transformChainExpression(node.argument.expression, /* isDelete */ true);
          }
          if (
            node.argument.type === "MemberExpression" &&
            node.argument.property.type === "PrivateIdentifier"
          ) {
            throw new SyntaxError("Private fields cannot be deleted");
          }
        }
        return {
          type: "UnaryExpression",
          operator: node.operator,
          prefix: true,
          argument: this.transformExpression(node.argument),
          loc,
        };

      case "UpdateExpression":
        return this.transformUpdateExpression(node);

      case "BinaryExpression":
        return this.transformBinaryExpression(node);

      case "LogicalExpression":
        if (node.operator === "??") {
          return this.transformNullishCoalescing(node.left, node.right, loc);
        }
        return logExpr(
          node.operator,
          this.transformExpression(node.left),
          this.transformExpression(node.right),
          loc
        );

      case "AssignmentExpression":
        return this.transformAssignmentExpression(node);

      case "ConditionalExpression":
        return condExpr(
          this.transformExpression(node.test),
          this.transformExpression(node.consequent),
          this.transformExpression(node.alternate),
          loc
        );

      case "SequenceExpression": {
        const list = node.expressions.map((e) => this.transformExpression(e));
        return seqExpr(list, loc);
      }

      case "ParenthesizedExpression":
        return this.transformExpression(node.expression);

      case "AwaitExpression":
      case "YieldExpression":
      case "ImportExpression":
        throw new SyntaxError(`${node.type} is not supported in synchronous guest scripts`);

      default:
        throw new SyntaxError(`Unsupported expression syntax in guest program: ${node.type}`);
    }
  }

  transformLiteral(node) {
    if (node.bigint != null) {
      return call(id("BigInt", node.loc), [lit(String(node.bigint), node.loc)], node.loc);
    }
    if (node.regex) return node;
    if (
      typeof node.value === "number" ||
      typeof node.value === "string" ||
      typeof node.value === "boolean" ||
      node.value === null
    ) {
      return {
        type: "Literal",
        value: node.value,
        raw: typeof node.value === "string" ? JSON.stringify(node.value) : String(node.value),
        loc: node.loc || null,
      };
    }
    return node;
  }

  transformArrayExpression(node) {
    const loc = node.loc;
    const hasSpread = node.elements.some((el) => el && el.type === "SpreadElement");
    if (!hasSpread) {
      return {
        type: "ArrayExpression",
        elements: node.elements.map((el) => (el ? this.transformExpression(el) : null)),
        loc,
      };
    }
    // Split into literal array chunks and `[...iterable]` spread chunks, joined with `[].concat(...)`
    const helper = this.useHelper("_toConsumableArray", loc);
    const concatArgs = [];
    let currentChunk = [];
    for (const el of node.elements) {
      if (el && el.type === "SpreadElement") {
        if (currentChunk.length > 0) {
          concatArgs.push({ type: "ArrayExpression", elements: currentChunk, loc });
          currentChunk = [];
        }
        concatArgs.push(call(helper, [this.transformExpression(el.argument)], el.loc));
      } else {
        currentChunk.push(el ? this.transformExpression(el) : null);
      }
    }
    if (currentChunk.length > 0) {
      concatArgs.push({ type: "ArrayExpression", elements: currentChunk, loc });
    }
    return call(
      member({ type: "ArrayExpression", elements: [], loc }, id("concat", loc), false, loc),
      concatArgs,
      loc
    );
  }

  transformObjectExpression(node) {
    const loc = node.loc;
    const props = node.properties;
    const needsSuper = this._subtreeContainsSuper(props);
    let objSuperVar = null;
    if (needsSuper) {
      objSuperVar = id(this.uid("obj"), loc);
    }

    let needsHelperPath = needsSuper;
    if (!needsHelperPath) {
      const seenKeys = new Map();
      for (const p of props) {
        if (p.type === "SpreadElement" || p.computed) {
          needsHelperPath = true;
          break;
        }
        const keyName = p.key.type === "Identifier" ? p.key.name : String(p.key.value);
        const prev = seenKeys.get(keyName);
        if (prev && !(prev === "init" && p.kind === "init" && !this.strict)) {
          // Strict duplicate key / accessor overwrite -> must lower via `_defineProperty`
          // to avoid FrontendCompiler's strict ES5.1 duplicate-key SyntaxError!
          needsHelperPath = true;
          break;
        }
        seenKeys.set(keyName, p.kind);
      }
    }

    if (!needsHelperPath) {
      return {
        type: "ObjectExpression",
        properties: props.map((p) => {
          const val =
            p.value.type === "FunctionExpression" || p.value.type === "ArrowFunctionExpression"
              ? this.transformFunctionNode(p.value, { asExpression: true })
              : this.transformExpression(p.value);
          // Key stays static Identifier/Literal (non-computed)
          const keyNode =
            p.key.type === "Literal" ? this.transformLiteral(p.key) : id(p.key.name, p.key.loc);
          return propNode(keyNode, val, p.kind, false, p.loc);
        }),
        loc,
      };
    }

    // Check if there are SpreadElements (`{ ...a, b: 2 }`)
    const hasSpread = props.some((p) => p.type === "SpreadElement");
    if (hasSpread) {
      // Group non-spread contiguous props into `_defineProperty` / small literal objects passed to `_objectSpread`
      const args = [{ type: "ObjectExpression", properties: [], loc }];
      let pendingProps = [];
      const flushPending = () => {
        if (pendingProps.length === 0) return;
        args.push(
          this.transformObjectExpression({
            type: "ObjectExpression",
            properties: pendingProps,
            loc,
          })
        );
        pendingProps = [];
      };
      for (const p of props) {
        if (p.type === "SpreadElement") {
          flushPending();
          args.push(this.transformExpression(p.argument));
        } else {
          pendingProps.push(p);
        }
      }
      flushPending();
      return call(this.useHelper("_objectSpread", loc), args, loc);
    }

    // Object with computed keys, duplicate strict keys, or `super` in object methods
    const tmpVar = objSuperVar || id(this.uid("obj"), loc);
    if (objSuperVar) {
      if (this.currentFunction) this.currentFunction.hoistedVars.push(tmpVar);
      else this.topLevelHoistedVars.push(tmpVar);
    } else {
      const allocated = this.allocateLocalVar("obj", loc);
      tmpVar.name = allocated.name;
    }

    const exprs = [
      assign(id(tmpVar.name, loc), { type: "ObjectExpression", properties: [], loc }, "=", loc),
    ];
    for (const p of props) {
      const keyExpr = p.computed
        ? this.transformExpression(p.key)
        : p.key.type === "Identifier"
        ? lit(p.key.name, p.key.loc)
        : this.transformLiteral(p.key);
      const valExpr = p.method
        ? this.transformFunctionNode(p.value, { asExpression: true, objectSuperVar: objSuperVar })
        : this.transformExpression(p.value);
      if (p.kind === "init") {
        exprs.push(
          call(
            this.useHelper("_defineProperty", p.loc),
            [id(tmpVar.name, p.loc), keyExpr, valExpr],
            p.loc
          )
        );
      } else {
        exprs.push(
          call(
            member(id("Object", p.loc), id("defineProperty", p.loc), false, p.loc),
            [
              id(tmpVar.name, p.loc),
              call(this.useHelper("_toPropertyKey", p.loc), [keyExpr], p.loc),
              {
                type: "ObjectExpression",
                properties: [
                  propNode(id(p.kind, p.loc), valExpr, "init", false, p.loc),
                  propNode(id("enumerable", p.loc), lit(true, p.loc), "init", false, p.loc),
                  propNode(id("configurable", p.loc), lit(true, p.loc), "init", false, p.loc),
                ],
                loc: p.loc,
              },
            ],
            p.loc
          )
        );
      }
    }
    exprs.push(id(tmpVar.name, loc));
    return seqExpr(exprs, loc);
  }

  _subtreeContainsSuper(node) {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some((item) => this._subtreeContainsSuper(item));
    if (node.type === "Super") return true;
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") return false;
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k === "loc" || k === "start" || k === "end") continue;
      if (this._subtreeContainsSuper(node[k])) return true;
    }
    return false;
  }

  transformTemplateLiteral(node) {
    const loc = node.loc;
    const { quasis, expressions } = node;
    const parts = [];
    for (let i = 0; i < quasis.length; i++) {
      const cooked = quasis[i].value.cooked;
      if (cooked !== "") parts.push(lit(cooked, quasis[i].loc));
      if (i < expressions.length) {
        parts.push(this.transformExpression(expressions[i]));
      }
    }
    if (parts.length === 0) return lit("", loc);
    let acc = parts[0];
    // Guarantee ToString coercion if starting with an expression (`${a}` or `${a}${b}`)
    if (acc.type !== "Literal" || typeof acc.value !== "string") {
      acc =
        parts.length > 1 && parts[1].type === "Literal" && typeof parts[1].value === "string"
          ? acc
          : binExpr("+", lit("", loc), acc, loc);
    }
    for (let i = 1; i < parts.length; i++) {
      acc = binExpr("+", acc, parts[i], loc);
    }
    return acc;
  }

  transformTaggedTemplateLiteral(node) {
    const loc = node.loc;
    const tplVar = this.hoistTopVar("tpl", loc);
    const helper = this.useHelper("_taggedTemplateLiteral", loc);

    const cookedElems = node.quasi.quasis.map((q) =>
      q.value.cooked === null || q.value.cooked === undefined
        ? undefExpr(q.loc)
        : lit(q.value.cooked, q.loc)
    );
    const rawElems = node.quasi.quasis.map((q) => lit(q.value.raw, q.loc));
    const callHelper = call(
      helper,
      [
        { type: "ArrayExpression", elements: cookedElems, loc },
        { type: "ArrayExpression", elements: rawElems, loc },
      ],
      loc
    );
    const templateArg = logExpr(
      "||",
      id(tplVar.name, loc),
      assign(id(tplVar.name, loc), callHelper, "=", loc),
      loc
    );
    const args = [templateArg, ...node.quasi.expressions.map((e) => this.transformExpression(e))];

    if (
      node.tag.type === "MemberExpression" &&
      !node.tag.optional &&
      node.tag.object.type !== "Super" &&
      node.tag.property.type !== "PrivateIdentifier"
    ) {
      return this.callMemberWithReceiver(node.tag, args, /* hasSpread */ false, loc);
    }
    return call(this.transformExpression(node.tag), args, loc);
  }

  transformMemberExpression(node) {
    const loc = node.loc;
    if (node.object.type === "Super") {
      const { target, receiver } = this.resolveSuperTargets(loc);
      const key = node.computed
        ? this.transformExpression(node.property)
        : lit(node.property.name, node.property.loc);
      return call(this.useHelper("_get", loc), [target, key, receiver], loc);
    }
    if (node.property && node.property.type === "PrivateIdentifier") {
      const entry = this.resolvePrivateElement(node.property.name, loc);
      const objExpr = this.transformExpression(node.object);
      if (entry.static) {
        if (entry.kind === "method") {
          return call(
            this.useHelper("_classStaticPrivateMethodGet", loc),
            [objExpr, id(this.currentClassCtx.classId.name, loc), id(entry.fnId.name, loc)],
            loc
          );
        }
        return call(
          this.useHelper("_classStaticPrivateFieldSpecGet", loc),
          [objExpr, id(this.currentClassCtx.classId.name, loc), id(entry.storageId.name, loc)],
          loc
        );
      }
      if (entry.kind === "method") {
        return call(
          this.useHelper("_classPrivateMethodGet", loc),
          [objExpr, id(entry.storageId.name, loc), id(entry.fnId.name, loc)],
          loc
        );
      }
      return call(
        this.useHelper("_classPrivateFieldGet", loc),
        [objExpr, id(entry.storageId.name, loc)],
        loc
      );
    }
    return member(
      this.transformExpression(node.object),
      node.computed
        ? this.transformExpression(node.property)
        : id(node.property.name, node.property.loc),
      !!node.computed,
      loc
    );
  }

  resolvePrivateElement(name, loc) {
    if (!this.currentClassCtx || !this.currentClassCtx.privateDecls.has(name)) {
      throw new SyntaxError(`Private field '#${name}' must be declared in an enclosing class`);
    }
    return this.currentClassCtx.privateDecls.get(name);
  }

  resolveSuperTargets(loc) {
    if (this.currentClassCtx) {
      const base = this.currentClassCtx.inStaticMethod
        ? id(this.currentClassCtx.classId.name, loc)
        : member(id(this.currentClassCtx.classId.name, loc), id("prototype", loc), false, loc);
      const protoTarget = call(
        member(id("Object", loc), id("getPrototypeOf", loc), false, loc),
        [base],
        loc
      );
      const receiver = this.currentClassCtx.isDerivedConstructor
        ? id(this.currentClassCtx.thisVar, loc)
        : this.currentArrowCtx
        ? this.currentArrowCtx.requestThis()
        : { type: "ThisExpression", loc };
      return { target: protoTarget, receiver };
    }
    if (this.currentObjectSuperRef) {
      const protoTarget = call(
        member(id("Object", loc), id("getPrototypeOf", loc), false, loc),
        [id(this.currentObjectSuperRef.name, loc)],
        loc
      );
      const receiver = this.currentArrowCtx
        ? this.currentArrowCtx.requestThis()
        : { type: "ThisExpression", loc };
      return { target: protoTarget, receiver };
    }
    throw new SyntaxError("'super' keyword unexpected here");
  }

  transformCallExpression(node) {
    const loc = node.loc;
    // Derived constructor `super(...args)`
    if (node.callee.type === "Super") {
      if (!this.currentClassCtx || !this.currentClassCtx.isDerivedConstructor) {
        throw new SyntaxError("'super()' call unexpected here");
      }
      const thisVar = this.currentClassCtx.thisVar;
      const superVar = this.currentClassCtx.superVarId;
      const superCallExpr = this.buildCallWithOptionalSpread(
        id(superVar.name, loc),
        { type: "ThisExpression", loc },
        node.arguments,
        loc
      );
      const assignThis = assign(id(thisVar, loc), superCallExpr, "=", loc);
      const inits = (this.currentClassCtx.pendingInstanceInits || []).map((st) =>
        this.rewriteThisToIdent(st.expression, thisVar)
      );
      return seqExpr([assignThis, ...inits, id(thisVar, loc)], loc);
    }

    // `super.m(...)`
    if (node.callee.type === "MemberExpression" && node.callee.object.type === "Super") {
      const { target, receiver } = this.resolveSuperTargets(loc);
      const recvTmp = this.allocateLocalVar("recv", loc);
      const key = node.callee.computed
        ? this.transformExpression(node.callee.property)
        : lit(node.callee.property.name, node.callee.property.loc);
      const fnExprNode = call(
        this.useHelper("_get", loc),
        [target, key, assign(id(recvTmp.name, loc), receiver, "=", loc)],
        loc
      );
      return this.buildCallWithOptionalSpread(
        fnExprNode,
        id(recvTmp.name, loc),
        node.arguments,
        loc
      );
    }

    const hasSpread = node.arguments.some((a) => a.type === "SpreadElement");
    if (!hasSpread) {
      // Also rewrite private-method call receiver binding (`obj.#m(a)`) cleanly
      if (
        node.callee.type === "MemberExpression" &&
        node.callee.property.type === "PrivateIdentifier"
      ) {
        const entry = this.resolvePrivateElement(node.callee.property.name, loc);
        const objTmp = this.allocateLocalVar("recv", loc);
        const objAssign = assign(
          id(objTmp.name, loc),
          this.transformExpression(node.callee.object),
          "=",
          loc
        );
        const fnExprNode = entry.static
          ? call(
              this.useHelper(
                entry.kind === "method"
                  ? "_classStaticPrivateMethodGet"
                  : "_classStaticPrivateFieldSpecGet",
                loc
              ),
              [
                objAssign,
                id(this.currentClassCtx.classId.name, loc),
                id(entry.fnId ? entry.fnId.name : entry.storageId.name, loc),
              ],
              loc
            )
          : call(
              this.useHelper(
                entry.kind === "method" ? "_classPrivateMethodGet" : "_classPrivateFieldGet",
                loc
              ),
              entry.kind === "method"
                ? [objAssign, id(entry.storageId.name, loc), id(entry.fnId.name, loc)]
                : [objAssign, id(entry.storageId.name, loc)],
              loc
            );
        const args = node.arguments.map((a) => this.transformExpression(a));
        return call(
          member(fnExprNode, id("call", loc), false, loc),
          [id(objTmp.name, loc), ...args],
          loc
        );
      }
      return {
        type: "CallExpression",
        callee: this.transformExpression(node.callee),
        arguments: node.arguments.map((a) => this.transformExpression(a)),
        optional: false,
        loc,
      };
    }

    // Call with spread: `fn(...args)` or `obj.m(...args)`
    if (node.callee.type === "MemberExpression") {
      return this.callMemberWithReceiver(node.callee, node.arguments, /* hasSpread */ true, loc);
    }
    const calleeExpr = this.transformExpression(node.callee);
    return this.buildCallWithOptionalSpread(calleeExpr, undefExpr(loc), node.arguments, loc);
  }

  callMemberWithReceiver(memberNode, rawArgs, hasSpread, loc) {
    const objTmp = this.allocateLocalVar("ctx", loc);
    const objAssign = assign(
      id(objTmp.name, loc),
      this.transformExpression(memberNode.object),
      "=",
      loc
    );
    const propExpr = memberNode.computed
      ? this.transformExpression(memberNode.property)
      : id(memberNode.property.name, memberNode.property.loc);
    const fnLookup = member(objAssign, propExpr, !!memberNode.computed, loc);
    if (!hasSpread) {
      return call(
        member(fnLookup, id("call", loc), false, loc),
        [id(objTmp.name, loc), ...rawArgs],
        loc
      );
    }
    return this.buildCallWithOptionalSpread(fnLookup, id(objTmp.name, loc), rawArgs, loc);
  }

  buildCallWithOptionalSpread(fnExprNode, thisArgExpr, rawArgs, loc) {
    const argsArray = this.transformArrayExpression({
      type: "ArrayExpression",
      elements: rawArgs,
      loc,
    });
    return call(member(fnExprNode, id("apply", loc), false, loc), [thisArgExpr, argsArray], loc);
  }

  transformNewExpression(node) {
    const loc = node.loc;
    const hasSpread = node.arguments.some((a) => a.type === "SpreadElement");
    const callee = this.transformExpression(node.callee);
    if (!hasSpread) {
      return {
        type: "NewExpression",
        callee,
        arguments: node.arguments.map((a) => this.transformExpression(a)),
        loc,
      };
    }
    // `new (Function.prototype.bind.apply(Ctor, [null].concat(spreadArgs)))()`
    const boundArgs = this.transformArrayExpression({
      type: "ArrayExpression",
      elements: [lit(null, loc), ...node.arguments],
      loc,
    });
    const bindApply = call(
      member(member(callee, id("bind", loc), false, loc), id("apply", loc), false, loc),
      [callee, boundArgs],
      loc
    );
    return { type: "NewExpression", callee: bindApply, arguments: [], loc };
  }

  // Lower ChainExpression (`a?.b`, `a.b?.(x)`, `delete a?.b`) with exact
  // single evaluation and receiver preservation.
  transformChainExpression(expr, isDelete) {
    const loc = expr.loc || null;
    // Flatten inner chain nodes left-to-right
    const steps = [];
    let cur = expr;
    while (cur && cur.type !== "ChainExpression") {
      if (
        cur.type === "MemberExpression" &&
        (cur.optional || this._chainContainsOptional(cur.object))
      ) {
        steps.unshift(cur);
        cur = cur.object;
      } else if (
        cur.type === "CallExpression" &&
        (cur.optional || this._chainContainsOptional(cur.callee))
      ) {
        steps.unshift(cur);
        cur = cur.callee;
      } else {
        break;
      }
    }
    if (steps.length === 0) {
      const lowered = this.transformExpression(expr);
      return isDelete ? unaryExpr("delete", lowered, loc) : lowered;
    }

    // Build nested ternary chain bottom-up using single-eval temp vars
    let baseExpr = this.transformExpression(cur);
    let receiverExpr = null;

    // If first optional step is `CallExpression` on `MemberExpression` (`a.b?.(x)`), `cur` is `a.b`
    if (steps[0].type === "CallExpression" && cur.type === "MemberExpression") {
      if (cur.object.type === "Super") {
        const { target, receiver } = this.resolveSuperTargets(cur.loc);
        const rTmp = this.allocateLocalVar("recv", cur.loc);
        receiverExpr = assign(id(rTmp.name, cur.loc), receiver, "=", cur.loc);
        const key = cur.computed
          ? this.transformExpression(cur.property)
          : lit(cur.property.name, cur.property.loc);
        baseExpr = call(this.useHelper("_get", cur.loc), [target, key, receiverExpr], cur.loc);
        receiverExpr = id(rTmp.name, cur.loc);
      } else {
        const rTmp = this.allocateLocalVar("ctx", cur.loc);
        const objAssign = assign(
          id(rTmp.name, cur.loc),
          this.transformExpression(cur.object),
          "=",
          cur.loc
        );
        const propNodeExpr = cur.computed
          ? this.transformExpression(cur.property)
          : id(cur.property.name, cur.property.loc);
        baseExpr = member(objAssign, propNodeExpr, !!cur.computed, cur.loc);
        receiverExpr = id(rTmp.name, cur.loc);
      }
    }

    const buildRemaining = (index, currentVal, currentReceiver) => {
      if (index >= steps.length) return currentVal;
      const step = steps[index];
      const stepLoc = step.loc || loc;
      const isLastDelete = isDelete && index === steps.length - 1;

      if (step.optional) {
        const tmp = this.allocateLocalVar("opt", stepLoc);
        const assignTmp = assign(id(tmp.name, stepLoc), currentVal, "=", stepLoc);
        const nullishTest = logExpr(
          "||",
          binExpr("===", assignTmp, lit(null, stepLoc), stepLoc),
          binExpr("===", id(tmp.name, stepLoc), undefExpr(stepLoc), stepLoc),
          stepLoc
        );
        const nextBase = id(tmp.name, stepLoc);
        let applied;
        let nextReceiver = currentReceiver;
        if (step.type === "MemberExpression") {
          const propExpr = step.computed
            ? this.transformExpression(step.property)
            : id(step.property.name, step.property.loc);
          applied = member(nextBase, propExpr, !!step.computed, stepLoc);
          nextReceiver = id(tmp.name, stepLoc);
        } else {
          // CallExpression
          const hasSpread = step.arguments.some((a) => a.type === "SpreadElement");
          const recv = currentReceiver || undefExpr(stepLoc);
          if (hasSpread) {
            applied = this.buildCallWithOptionalSpread(nextBase, recv, step.arguments, stepLoc);
          } else {
            const args = step.arguments.map((a) => this.transformExpression(a));
            applied = currentReceiver
              ? call(
                  member(nextBase, id("call", stepLoc), false, stepLoc),
                  [recv, ...args],
                  stepLoc
                )
              : call(nextBase, args, stepLoc);
          }
          nextReceiver = null;
        }
        const tail = isLastDelete
          ? unaryExpr("delete", applied, stepLoc)
          : buildRemaining(index + 1, applied, nextReceiver);
        return condExpr(
          nullishTest,
          isDelete ? lit(true, stepLoc) : undefExpr(stepLoc),
          tail,
          stepLoc
        );
      }

      // Non-optional intermediate step after an optional one (`a?.b.c(d)`)
      let applied;
      let nextReceiver = null;
      if (step.type === "MemberExpression") {
        // Need receiver preserved if next step is CallExpression!
        const needsRecv = index + 1 < steps.length && steps[index + 1].type === "CallExpression";
        let objNode = currentVal;
        if (needsRecv) {
          const rTmp = this.allocateLocalVar("ctx", stepLoc);
          objNode = assign(id(rTmp.name, stepLoc), currentVal, "=", stepLoc);
          nextReceiver = id(rTmp.name, stepLoc);
        }
        const propExpr = step.computed
          ? this.transformExpression(step.property)
          : id(step.property.name, step.property.loc);
        applied = member(objNode, propExpr, !!step.computed, stepLoc);
      } else {
        const hasSpread = step.arguments.some((a) => a.type === "SpreadElement");
        if (hasSpread || currentReceiver) {
          const recv = currentReceiver || undefExpr(stepLoc);
          if (hasSpread) {
            applied = this.buildCallWithOptionalSpread(currentVal, recv, step.arguments, stepLoc);
          } else {
            applied = call(
              member(currentVal, id("call", stepLoc), false, stepLoc),
              [recv, ...step.arguments.map((a) => this.transformExpression(a))],
              stepLoc
            );
          }
        } else {
          applied = call(
            currentVal,
            step.arguments.map((a) => this.transformExpression(a)),
            stepLoc
          );
        }
      }
      if (isLastDelete) return unaryExpr("delete", applied, stepLoc);
      return buildRemaining(index + 1, applied, nextReceiver);
    };

    return buildRemaining(0, baseExpr, receiverExpr);
  }

  _chainContainsOptional(node) {
    let cur = node;
    while (cur) {
      if (cur.optional) return true;
      if (cur.type === "MemberExpression") cur = cur.object;
      else if (cur.type === "CallExpression") cur = cur.callee;
      else break;
    }
    return false;
  }

  transformNullishCoalescing(left, right, loc) {
    const tmp = this.allocateLocalVar("nc", loc);
    const assignTmp = assign(id(tmp.name, loc), this.transformExpression(left), "=", loc);
    return condExpr(
      logExpr(
        "&&",
        binExpr("!==", assignTmp, lit(null, loc), loc),
        binExpr("!==", id(tmp.name, loc), undefExpr(loc), loc),
        loc
      ),
      id(tmp.name, loc),
      this.transformExpression(right),
      loc
    );
  }

  transformBinaryExpression(node) {
    const loc = node.loc;
    if (node.operator === "**") {
      return call(
        member(id("Math", loc), id("pow", loc), false, loc),
        [this.transformExpression(node.left), this.transformExpression(node.right)],
        loc
      );
    }
    if (node.operator === "in" && node.left.type === "PrivateIdentifier") {
      const entry = this.resolvePrivateElement(node.left.name, loc);
      const rhs = this.transformExpression(node.right);
      if (entry.static) {
        return binExpr("===", rhs, id(this.currentClassCtx.classId.name, loc), loc);
      }
      return call(member(id(entry.storageId.name, loc), id("has", loc), false, loc), [rhs], loc);
    }
    return binExpr(
      node.operator,
      this.transformExpression(node.left),
      this.transformExpression(node.right),
      loc
    );
  }

  transformUpdateExpression(node) {
    const loc = node.loc;
    if (node.argument.type === "Identifier") {
      const b = this.resolveBinding(node.argument.name);
      if (b && b.kind === "const") {
        return call(this.useHelper("_readOnlyError", loc), [lit(node.argument.name, loc)], loc);
      }
      return {
        type: "UpdateExpression",
        operator: node.operator,
        prefix: node.prefix,
        argument: id(b ? b.outName : node.argument.name, node.argument.loc),
        loc,
      };
    }
    if (
      node.argument.type === "MemberExpression" &&
      (node.argument.object.type === "Super" || node.argument.property.type === "PrivateIdentifier")
    ) {
      // Lower `++super.x` / `obj.#x++` via explicit read + +/- 1 + write
      const op = node.operator === "++" ? "+" : "-";
      if (node.prefix) {
        return this.transformAssignmentExpression({
          type: "AssignmentExpression",
          operator: `${op}=`,
          left: node.argument,
          right: lit(1, loc),
          loc,
        });
      }
      // Postfix: `var _old = +get; set(_old + 1); _old`
      return this.lowerSpecialCompoundOrPostfix(
        node.argument,
        op,
        lit(1, loc),
        /* returnOld */ true,
        loc
      );
    }
    return {
      type: "UpdateExpression",
      operator: node.operator,
      prefix: node.prefix,
      argument: this.transformExpression(node.argument),
      loc,
    };
  }

  transformAssignmentExpression(node) {
    const loc = node.loc;
    const { left, right, operator } = node;

    if (operator === "=" && left.type !== "Identifier" && left.type !== "MemberExpression") {
      return this.lowerPatternAssignment(left, this.transformExpression(right), loc);
    }

    if (left.type === "Identifier") {
      const b = this.resolveBinding(left.name);
      if (b && b.kind === "const") {
        if (operator === "&&=" || operator === "||=" || operator === "??=") {
          // Short-circuit may NOT assign unless condition fires!
          const curVal = id(b.outName, left.loc);
          const roExpr = call(this.useHelper("_readOnlyError", loc), [lit(left.name, loc)], loc);
          if (operator === "&&=") return logExpr("&&", curVal, roExpr, loc);
          if (operator === "||=") return logExpr("||", curVal, roExpr, loc);
          return condExpr(
            logExpr(
              "&&",
              binExpr("!==", curVal, lit(null, loc), loc),
              binExpr("!==", id(b.outName, left.loc), undefExpr(loc), loc),
              loc
            ),
            id(b.outName, left.loc),
            roExpr,
            loc
          );
        }
        return seqExpr(
          [
            this.transformExpression(right),
            call(this.useHelper("_readOnlyError", loc), [lit(left.name, loc)], loc),
          ],
          loc
        );
      }
    }

    const loweredRight = this.transformExpression(right);

    if (operator === "&&=" || operator === "||=" || operator === "??=") {
      return this.lowerLogicalAssignment(left, loweredRight, operator, loc);
    }

    if (operator === "**=") {
      return this.lowerExponentiationAssignment(left, loweredRight, loc);
    }

    if (
      left.type === "MemberExpression" &&
      (left.object.type === "Super" || left.property.type === "PrivateIdentifier")
    ) {
      if (operator === "=") {
        return this.emitSpecialWrite(left, loweredRight, loc);
      }
      return this.lowerSpecialCompoundOrPostfix(
        left,
        operator.slice(0, -1),
        loweredRight,
        /* returnOld */ false,
        loc
      );
    }

    return assign(this.transformExpression(left), loweredRight, operator, loc);
  }

  emitSpecialWrite(memberLeft, valExpr, loc) {
    if (memberLeft.object.type === "Super") {
      const { target, receiver } = this.resolveSuperTargets(loc);
      const key = memberLeft.computed
        ? this.transformExpression(memberLeft.property)
        : lit(memberLeft.property.name, memberLeft.property.loc);
      const vTmp = this.allocateLocalVar("val", loc);
      const vAssign = assign(id(vTmp.name, loc), valExpr, "=", loc);
      const setCall = call(
        this.useHelper("_set", loc),
        [target, key, vAssign, receiver, lit(this.strict, loc)],
        loc
      );
      return seqExpr([setCall, id(vTmp.name, loc)], loc);
    }
    // PrivateIdentifier
    const entry = this.resolvePrivateElement(memberLeft.property.name, loc);
    const objExpr = this.transformExpression(memberLeft.object);
    if (entry.static) {
      return call(
        this.useHelper("_classStaticPrivateFieldSpecSet", loc),
        [
          objExpr,
          id(this.currentClassCtx.classId.name, loc),
          id(entry.storageId.name, loc),
          valExpr,
        ],
        loc
      );
    }
    return call(
      this.useHelper("_classPrivateFieldSet", loc),
      [objExpr, id(entry.storageId.name, loc), valExpr],
      loc
    );
  }

  lowerSpecialCompoundOrPostfix(memberLeft, binaryOp, rightExpr, returnOld, loc) {
    if (memberLeft.property.type === "PrivateIdentifier") {
      const entry = this.resolvePrivateElement(memberLeft.property.name, loc);
      const objTmp = this.allocateLocalVar("obj", loc);
      const objAssign = assign(
        id(objTmp.name, loc),
        this.transformExpression(memberLeft.object),
        "=",
        loc
      );
      const getCall = entry.static
        ? call(
            this.useHelper("_classStaticPrivateFieldSpecGet", loc),
            [objAssign, id(this.currentClassCtx.classId.name, loc), id(entry.storageId.name, loc)],
            loc
          )
        : call(
            this.useHelper("_classPrivateFieldGet", loc),
            [objAssign, id(entry.storageId.name, loc)],
            loc
          );
      const oldTmp = this.allocateLocalVar("old", loc);
      const newExpr = binExpr(binaryOp, id(oldTmp.name, loc), rightExpr, loc);
      const setCall = entry.static
        ? call(
            this.useHelper("_classStaticPrivateFieldSpecSet", loc),
            [
              id(objTmp.name, loc),
              id(this.currentClassCtx.classId.name, loc),
              id(entry.storageId.name, loc),
              newExpr,
            ],
            loc
          )
        : call(
            this.useHelper("_classPrivateFieldSet", loc),
            [id(objTmp.name, loc), id(entry.storageId.name, loc), newExpr],
            loc
          );
      if (returnOld) {
        const coerced = unaryExpr("+", getCall, loc);
        return seqExpr(
          [assign(id(oldTmp.name, loc), coerced, "=", loc), setCall, id(oldTmp.name, loc)],
          loc
        );
      }
      return seqExpr([assign(id(oldTmp.name, loc), getCall, "=", loc), setCall], loc);
    }
    // `super` compound / postfix
    const { target, receiver } = this.resolveSuperTargets(loc);
    const recvTmp = this.allocateLocalVar("recv", loc);
    const recvAssign = assign(id(recvTmp.name, loc), receiver, "=", loc);
    const keyExpr = memberLeft.computed
      ? this.transformExpression(memberLeft.property)
      : lit(memberLeft.property.name, memberLeft.property.loc);
    const keyTmp = isSimpleExpression(keyExpr)
      ? keyExpr
      : id(this.allocateLocalVar("key", loc).name, loc);
    const setupExprs = [];
    if (keyTmp !== keyExpr) setupExprs.push(assign(id(keyTmp.name, loc), keyExpr, "=", loc));
    const getCall = call(
      this.useHelper("_get", loc),
      [target, id(keyTmp.name, loc), recvAssign],
      loc
    );
    const oldTmp = this.allocateLocalVar("old", loc);
    const newTmp = this.allocateLocalVar("val", loc);
    const initOld = assign(
      id(oldTmp.name, loc),
      returnOld ? unaryExpr("+", getCall, loc) : getCall,
      "=",
      loc
    );
    const newVal = assign(
      id(newTmp.name, loc),
      binExpr(binaryOp, id(oldTmp.name, loc), rightExpr, loc),
      "=",
      loc
    );
    const setCall = call(
      this.useHelper("_set", loc),
      [target, id(keyTmp.name, loc), newVal, id(recvTmp.name, loc), lit(this.strict, loc)],
      loc
    );
    return seqExpr(
      [...setupExprs, initOld, setCall, id(returnOld ? oldTmp.name : newTmp.name, loc)],
      loc
    );
  }

  lowerExponentiationAssignment(left, rightExpr, loc) {
    const powCall = (lhsExpr) =>
      call(member(id("Math", loc), id("pow", loc), false, loc), [lhsExpr, rightExpr], loc);
    if (left.type === "Identifier") {
      const target = this.transformExpression(left);
      return assign(target, powCall(id(target.name, loc)), "=", loc);
    }
    if (left.type === "MemberExpression") {
      if (left.object.type === "Super" || left.property.type === "PrivateIdentifier") {
        // Evaluate pow(old, right) via temp helper
        throw new SyntaxError("**= on super or private properties is not supported");
      }
      const objTmp = this.allocateLocalVar("obj", loc);
      const setupExprs = [
        assign(id(objTmp.name, loc), this.transformExpression(left.object), "=", loc),
      ];
      let keyRead;
      let keyWrite;
      if (left.computed && !isSimpleExpression(left.property)) {
        const keyTmp = this.allocateLocalVar("key", loc);
        setupExprs.push(
          assign(id(keyTmp.name, loc), this.transformExpression(left.property), "=", loc)
        );
        keyRead = id(keyTmp.name, loc);
        keyWrite = id(keyTmp.name, loc);
      } else {
        keyRead = left.computed
          ? this.transformExpression(left.property)
          : id(left.property.name, left.property.loc);
        keyWrite = left.computed
          ? this.transformExpression(left.property)
          : id(left.property.name, left.property.loc);
      }
      const lhsRead = member(id(objTmp.name, loc), keyRead, !!left.computed, loc);
      const lhsWrite = member(id(objTmp.name, loc), keyWrite, !!left.computed, loc);
      return seqExpr([...setupExprs, assign(lhsWrite, powCall(lhsRead), "=", loc)], loc);
    }
    throw new SyntaxError("Invalid left-hand side in assignment");
  }

  lowerLogicalAssignment(left, rightExpr, operator, loc) {
    const combine = (readExpr, writeExpr) => {
      if (operator === "&&=") {
        return logExpr("&&", readExpr, assign(writeExpr, rightExpr, "=", loc), loc);
      }
      if (operator === "||=") {
        return logExpr("||", readExpr, assign(writeExpr, rightExpr, "=", loc), loc);
      }
      // `lhs ??= right`: evaluate lhs once, assign only if null/undefined
      const valTmp = this.allocateLocalVar("na", loc);
      const readTmp = assign(id(valTmp.name, loc), readExpr, "=", loc);
      return condExpr(
        logExpr(
          "&&",
          binExpr("!==", readTmp, lit(null, loc), loc),
          binExpr("!==", id(valTmp.name, loc), undefExpr(loc), loc),
          loc
        ),
        id(valTmp.name, loc),
        assign(writeExpr, rightExpr, "=", loc),
        loc
      );
    };

    if (left.type === "Identifier") {
      const target = this.transformExpression(left);
      return combine(target, id(target.name, loc));
    }
    if (left.type === "MemberExpression") {
      if (left.object.type === "Super" || left.property.type === "PrivateIdentifier") {
        // Rare case: delegate nullish/logical test to temp read + conditional special write
        const curVal = this.transformMemberExpression(left);
        const valTmp = this.allocateLocalVar("na", loc);
        const readTmp = assign(id(valTmp.name, loc), curVal, "=", loc);
        const writeExpr = this.emitSpecialWrite(left, rightExpr, loc);
        if (operator === "&&=") return logExpr("&&", readTmp, writeExpr, loc);
        if (operator === "||=") return logExpr("||", readTmp, writeExpr, loc);
        return condExpr(
          logExpr(
            "&&",
            binExpr("!==", readTmp, lit(null, loc), loc),
            binExpr("!==", id(valTmp.name, loc), undefExpr(loc), loc),
            loc
          ),
          id(valTmp.name, loc),
          writeExpr,
          loc
        );
      }
      const objTmp = this.allocateLocalVar("obj", loc);
      const objAssign = assign(
        id(objTmp.name, loc),
        this.transformExpression(left.object),
        "=",
        loc
      );
      let keyRead;
      let keyWrite;
      if (left.computed && !isSimpleExpression(left.property)) {
        const keyTmp = this.allocateLocalVar("key", loc);
        keyRead = assign(id(keyTmp.name, loc), this.transformExpression(left.property), "=", loc);
        keyWrite = id(keyTmp.name, loc);
      } else {
        keyRead = left.computed
          ? this.transformExpression(left.property)
          : id(left.property.name, left.property.loc);
        keyWrite = left.computed
          ? this.transformExpression(left.property)
          : id(left.property.name, left.property.loc);
      }
      return combine(
        member(objAssign, keyRead, !!left.computed, loc),
        member(id(objTmp.name, loc), keyWrite, !!left.computed, loc)
      );
    }
    throw new SyntaxError("Invalid left-hand side in logical assignment");
  }
}

// ---------------------------------------------------------------------------
// Compact ES5.1 ESTree Printer (for transformToES5() & dumpDir inspection)
// ---------------------------------------------------------------------------

const BINARY_PRECEDENCE = {
  "||": 1,
  "&&": 2,
  "|": 3,
  "^": 4,
  "&": 5,
  "==": 6,
  "!=": 6,
  "===": 6,
  "!==": 6,
  "<": 7,
  "<=": 7,
  ">": 7,
  ">=": 7,
  in: 7,
  instanceof: 7,
  "<<": 8,
  ">>": 8,
  ">>>": 8,
  "+": 9,
  "-": 9,
  "*": 10,
  "/": 10,
  "%": 10,
};

function printExpr(node, minPrec = 0, { forbidIn = false, stmtStart = false } = {}) {
  if (!node) return "";
  switch (node.type) {
    case "Identifier":
      return node.name;
    case "ThisExpression":
      return "this";
    case "Literal":
      if (node.regex) return `/${node.regex.pattern}/${node.regex.flags}`;
      if (typeof node.value === "string") return JSON.stringify(node.value);
      return node.value === null ? "null" : String(node.value);
    case "ArrayExpression":
      return `[${node.elements.map((e) => (e === null ? "" : printExpr(e, 1))).join(", ")}]`;
    case "ObjectExpression": {
      const inner = node.properties
        .map((p) => {
          const keyStr = p.key.type === "Identifier" ? p.key.name : printExpr(p.key, 0);
          if (p.kind === "get" || p.kind === "set") {
            const paramsStr = p.value.params.map((pm) => pm.name).join(", ");
            return `${p.kind} ${keyStr}(${paramsStr}) ${printBlock(p.value.body, "")}`;
          }
          return `${keyStr}: ${printExpr(p.value, 1)}`;
        })
        .join(", ");
      const out = inner ? `{ ${inner} }` : "{}";
      return stmtStart ? `(${out})` : out;
    }
    case "FunctionExpression": {
      const namePart = node.id ? ` ${node.id.name}` : "";
      const paramsStr = node.params.map((p) => p.name).join(", ");
      const out = `function${namePart}(${paramsStr}) ${printBlock(node.body, "")}`;
      return stmtStart ? `(${out})` : out;
    }
    case "SequenceExpression": {
      const inner = node.expressions.map((e) => printExpr(e, 1)).join(", ");
      return minPrec > 0 ? `(${inner})` : inner;
    }
    case "AssignmentExpression": {
      const out = `${printExpr(node.left, 14)} ${node.operator} ${printExpr(node.right, 1, {
        forbidIn,
      })}`;
      return minPrec > 1 ? `(${out})` : out;
    }
    case "ConditionalExpression": {
      const out = `${printExpr(node.test, 2, { forbidIn })} ? ${printExpr(
        node.consequent,
        1
      )} : ${printExpr(node.alternate, 1, { forbidIn })}`;
      return minPrec > 1 ? `(${out})` : out;
    }
    case "LogicalExpression":
    case "BinaryExpression": {
      const prec = BINARY_PRECEDENCE[node.operator] || 1;
      const needsParens = prec < minPrec || (forbidIn && node.operator === "in");
      const leftStr = printExpr(node.left, prec, {
        forbidIn,
        stmtStart: stmtStart && !needsParens,
      });
      const rightStr = printExpr(node.right, prec + 1, { forbidIn });
      const out = `${leftStr} ${node.operator} ${rightStr}`;
      return needsParens ? `(${out})` : out;
    }
    case "UnaryExpression": {
      const arg = printExpr(node.argument, 11);
      const sep = /^[a-z]+$/.test(node.operator) ? " " : "";
      // Guard `-- -x` / `++ +x` collisions with leading unary +/-
      const space = !sep && arg.startsWith(node.operator) ? " " : "";
      const out = `${node.operator}${sep}${space}${arg}`;
      return minPrec > 11 ? `(${out})` : out;
    }
    case "UpdateExpression": {
      const arg = printExpr(node.argument, 13);
      const out = node.prefix ? `${node.operator}${arg}` : `${arg}${node.operator}`;
      return minPrec > 12 ? `(${out})` : out;
    }
    case "MemberExpression": {
      const needsNumberDotParens =
        node.object.type === "Literal" && typeof node.object.value === "number" && !node.computed;
      const objStr = printExpr(node.object, 13, { stmtStart: stmtStart && !needsNumberDotParens });
      const finalObj = needsNumberDotParens ? `(${objStr})` : objStr;
      return node.computed
        ? `${finalObj}[${printExpr(node.property, 0)}]`
        : `${finalObj}.${node.property.name}`;
    }
    case "CallExpression": {
      const calleeStr = printExpr(node.callee, 13, { stmtStart });
      const needsGroup = node.callee.type === "FunctionExpression" && !calleeStr.startsWith("(");
      return `${needsGroup ? `(${calleeStr})` : calleeStr}(${node.arguments
        .map((a) => printExpr(a, 1))
        .join(", ")})`;
    }
    case "NewExpression": {
      const calleeStr = printExpr(node.callee, 14);
      const argsStr = node.arguments.map((a) => printExpr(a, 1)).join(", ");
      const out = `new ${calleeStr}(${argsStr})`;
      return minPrec > 13 ? `(${out})` : out;
    }
    default:
      throw new Error(`Cannot print unsupported ES5 node: ${node.type}`);
  }
}

function printBlock(block, indent) {
  if (!block || block.body.length === 0) return "{}";
  const nextIndent = `${indent}  `;
  return `{\n${block.body
    .map((s) => `${nextIndent}${printStmt(s, nextIndent)}`)
    .join("\n")}\n${indent}}`;
}

function printVarDecl(node, forbidIn = false) {
  const items = node.declarations.map((d) =>
    d.init ? `${d.id.name} = ${printExpr(d.init, 1, { forbidIn })}` : d.id.name
  );
  return `var ${items.join(", ")}`;
}

function printStmt(node, indent = "") {
  if (!node) return "";
  switch (node.type) {
    case "EmptyStatement":
      return ";";
    case "BlockStatement":
      return printBlock(node, indent);
    case "ExpressionStatement":
      return `${printExpr(node.expression, 0, { stmtStart: true })};`;
    case "VariableDeclaration":
      return `${printVarDecl(node, false)};`;
    case "ReturnStatement":
      return node.argument ? `return ${printExpr(node.argument, 0)};` : "return;";
    case "ThrowStatement":
      return `throw ${printExpr(node.argument, 0)};`;
    case "BreakStatement":
      return node.label ? `break ${node.label.name};` : "break;";
    case "ContinueStatement":
      return node.label ? `continue ${node.label.name};` : "continue;";
    case "DebuggerStatement":
      return "debugger;";
    case "IfStatement": {
      const cons =
        node.consequent.type === "BlockStatement"
          ? printBlock(node.consequent, indent)
          : printStmt(node.consequent, indent);
      const alt = node.alternate
        ? ` else ${
            node.alternate.type === "BlockStatement" || node.alternate.type === "IfStatement"
              ? printStmt(node.alternate, indent)
              : printStmt(node.alternate, indent)
          }`
        : "";
      return `if (${printExpr(node.test, 0)}) ${cons}${alt}`;
    }
    case "WhileStatement":
      return `while (${printExpr(node.test, 0)}) ${printStmt(node.body, indent)}`;
    case "DoWhileStatement":
      return `do ${printStmt(node.body, indent)} while (${printExpr(node.test, 0)});`;
    case "ForStatement": {
      const initStr = !node.init
        ? ""
        : node.init.type === "VariableDeclaration"
        ? printVarDecl(node.init, true)
        : printExpr(node.init, 0, { forbidIn: true });
      const testStr = node.test ? printExpr(node.test, 0) : "";
      const updStr = node.update ? printExpr(node.update, 0) : "";
      return `for (${initStr}; ${testStr}; ${updStr}) ${printStmt(node.body, indent)}`;
    }
    case "ForInStatement": {
      const leftStr =
        node.left.type === "VariableDeclaration"
          ? printVarDecl(node.left, true)
          : printExpr(node.left, 0);
      return `for (${leftStr} in ${printExpr(node.right, 0)}) ${printStmt(node.body, indent)}`;
    }
    case "SwitchStatement": {
      const next = `${indent}  `;
      const casesStr = node.cases
        .map((c) => {
          const head = c.test ? `case ${printExpr(c.test, 0)}:` : "default:";
          const stmts = c.consequent.map((s) => `${next}  ${printStmt(s, `${next}  `)}`).join("\n");
          return stmts ? `${next}${head}\n${stmts}` : `${next}${head}`;
        })
        .join("\n");
      return `switch (${printExpr(node.discriminant, 0)}) {\n${casesStr}\n${indent}}`;
    }
    case "LabeledStatement":
      return `${node.label.name}: ${printStmt(node.body, indent)}`;
    case "WithStatement":
      return `with (${printExpr(node.object, 0)}) ${printStmt(node.body, indent)}`;
    case "TryStatement": {
      let out = `try ${printBlock(node.block, indent)}`;
      if (node.handler) {
        out += ` catch (${node.handler.param.name}) ${printBlock(node.handler.body, indent)}`;
      }
      if (node.finalizer) {
        out += ` finally ${printBlock(node.finalizer, indent)}`;
      }
      return out;
    }
    case "FunctionDeclaration": {
      const paramsStr = node.params.map((p) => p.name).join(", ");
      return `function ${node.id.name}(${paramsStr}) ${printBlock(node.body, indent)}`;
    }
    default:
      throw new Error(`Cannot print unsupported ES5 statement: ${node.type}`);
  }
}

function printES5(ast) {
  return ast.body.map((s) => printStmt(s, "")).join("\n");
}

function parseScriptWithModuleHint(source) {
  try {
    return parse(source, { ecmaVersion: "latest", locations: true, sourceType: "script" });
  } catch (scriptErr) {
    try {
      const modAst = parse(source, { ecmaVersion: "latest", sourceType: "module" });
      const hasModuleSyntax = modAst.body.some(
        (s) =>
          s.type === "ImportDeclaration" ||
          s.type === "ExportNamedDeclaration" ||
          s.type === "ExportDefaultDeclaration" ||
          s.type === "ExportAllDeclaration"
      );
      if (hasModuleSyntax) {
        throw new SyntaxError(
          "ES module import/export declarations are not supported in guest scripts; compile a script without imports that returns its final expression"
        );
      }
    } catch (inner) {
      if (
        inner instanceof SyntaxError &&
        inner.message.includes("ES module import/export declarations")
      ) {
        throw inner;
      }
    }
    throw scriptErr;
  }
}

function prepareProgramAST(source, options = {}) {
  if (typeof source !== "string") {
    throw new TypeError("sablejs source must be a string");
  }
  const normalized = normalizeTransformOptions(options.transform);
  let workingSource = source;
  let customInputMap = null;
  let customApplied = false;

  if (normalized.mode === "custom") {
    const hookResult = normalized.fn(source, {
      sourceFile: options.sourceFile || "<sablejs-input>",
      strict: !!options.strict,
    });
    if (typeof hookResult === "string") {
      workingSource = hookResult;
    } else if (
      hookResult &&
      typeof hookResult === "object" &&
      typeof hookResult.code === "string"
    ) {
      workingSource = hookResult.code;
      customInputMap = hookResult.map != null ? hookResult.map : null;
    } else {
      throw new TypeError("Custom transform function must return a code string or { code, map? }");
    }
    customApplied = true;
  }

  if (normalized.mode === "none") {
    const ast = parse(workingSource, { ecmaVersion: 5, locations: true });
    return {
      ast,
      es5Source: workingSource,
      transformed: false,
      inputLanguage: "es5.1",
      inputMap: null,
    };
  }

  if (normalized.mode === "auto" || normalized.mode === "custom") {
    try {
      const es5Ast = parse(workingSource, { ecmaVersion: 5, locations: true });
      return {
        ast: es5Ast,
        es5Source: workingSource,
        transformed: customApplied,
        inputLanguage: "es5.1",
        inputMap: customInputMap,
      };
    } catch (_) {
      // Fall through to ES2015+ parsing & lowering
    }
  }

  const modernAst = parseScriptWithModuleHint(workingSource);
  const transformer = new ES5Transformer({ strict: !!options.strict });
  const es5Ast = transformer.transformProgram(modernAst);
  return {
    ast: es5Ast,
    es5Source: workingSource,
    transformed: true,
    inputLanguage: "esnext",
    inputMap: customInputMap,
  };
}

function transformToES5(source, options = {}) {
  const mode = options.transform === undefined ? true : options.transform;
  const prepared = prepareProgramAST(source, { ...options, transform: mode });
  return {
    code: prepared.transformed ? printES5(prepared.ast) : prepared.es5Source,
    transformed: prepared.transformed,
    inputLanguage: prepared.inputLanguage,
  };
}

module.exports = {
  normalizeTransformOptions,
  prepareProgramAST,
  printES5,
  transformToES5,
};
