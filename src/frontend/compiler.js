"use strict";

const { parse } = require("acorn");
const { prepareProgramAST } = require("./transform");
const Scope = require("./scope");
const Emitter = require("./emitter");
const {
  isLoop,
  isFutureWord,
  addLocal,
  findLocal,
  addString,
  labelTo,
  labelJumps,
  breakTarget,
  continueTarget,
  returnTarget,
  dynamicExpConcat,
} = require("./util");

let DYNAMIC_COMPILE_INDEX = 0;
const OPCODE = require("./opcode");
const hoisting = require("./hoisting");

function collectDirectFunctionDeclarations(node, allowed, seen = new WeakSet()) {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (node.type === "Program") {
    node.body.forEach((statement) => {
      if (statement.type === "FunctionDeclaration") allowed.add(statement);
    });
  } else if (
    (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") &&
    node.body &&
    node.body.type === "BlockStatement"
  ) {
    node.body.body.forEach((statement) => {
      if (statement.type === "FunctionDeclaration") allowed.add(statement);
    });
  }
  Object.keys(node).forEach((key) => {
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((child) => collectDirectFunctionDeclarations(child, allowed, seen));
    } else {
      collectDirectFunctionDeclarations(value, allowed, seen);
    }
  });
}

class Compiler {
  constructor(options = {}) {
    this.scope = new Scope();
    this.emitter = new Emitter();
    this.structuredMetadata = options.structuredMetadata === true;
    this.transform = options.transform !== undefined ? options.transform : "none";
  }

  beginControlRegion(scope, kind, start = scope.opcode.length) {
    if (!this.structuredMetadata) return null;
    if (!scope.controlRegions) scope.controlRegions = [];
    const region = { id: scope.controlRegions.length, kind, start, end: null };
    scope.controlRegions.push(region);
    return region;
  }

  recordSyntheticRange(scope, kind, start, end = scope.opcode.length) {
    if (!this.structuredMetadata || start === end) return;
    if (!scope.syntheticRanges) scope.syntheticRanges = [];
    scope.syntheticRanges.push({ id: scope.syntheticRanges.length, kind, start, end });
  }

  compileAST(node, strict = false) {
    this.allowedFunctionDeclarations = new WeakSet();
    collectDirectFunctionDeclarations(node, this.allowedFunctionDeclarations);
    this.scope.script = true;
    this.scope.strict = strict;
    this.FunctionDeclaration(node, this.scope, true);
    return this.scope;
  }

  compile(source, strict = false) {
    if (this.transform === "none" || this.transform === false) {
      const node = parse(source, { ecmaVersion: 5, locations: true });
      return this.compileAST(node, strict);
    }
    const { ast } = prepareProgramAST(source, {
      transform: this.transform,
      strict,
    });
    return this.compileAST(ast, strict);
  }

  FunctionDeclaration(node, scope, script = false) {
    let { type, id, body, params = [] } = node;
    id = type == "Program" ? "" : id ? id.name : id;
    body = type == "Program" ? body : body.body;
    body = [].concat(body);

    scope.name = id;
    scope.arguments = false;
    scope.lightweight = !script;
    scope.numparams = params.length;
    if (!scope.strict) {
      for (const statement of body) {
        if (statement.type != "ExpressionStatement" || statement.directive === undefined) break;
        if (statement.directive == "use strict") {
          scope.strict = true;
          break;
        }
      }
    }

    for (let i = 0; i < params.length; i++) {
      const { name } = params[i];
      isFutureWord(name, scope.strict);
      addLocal(params[i], scope, false);
      scope.ps.push(params[i].name);
    }

    // Hoist variable and function declarations before emitting the body.
    hoisting(this, body, scope);

    if (id) {
      isFutureWord(id, scope.strict);
      if (findLocal(id, scope) < 0) {
        this.emitter.emit(scope, OPCODE.CURRENT);
        this.emitter.emit(scope, OPCODE.SETLOCAL);
        this.emitter.emit(scope, addLocal({ name: id }, scope, 0));
        this.emitter.emit(scope, OPCODE.POP);
      }
    }

    if (scope.script) {
      this.emitter.emit(scope, OPCODE.UNDEF);
      this.StatementList(node, scope);
      this.emitter.emit(scope, OPCODE.RETURN);
    } else {
      this.StatementList(node, scope);
      this.emitter.emit(scope, OPCODE.UNDEF);
      this.emitter.emit(scope, OPCODE.RETURN);
    }
  }

  VariableDeclaration(node, scope) {
    const { declarations } = node;
    for (let i = 0; i < declarations.length; i++) {
      const { id, init } = declarations[i];
      isFutureWord(id.name, scope.strict);
      if (!(!scope.strict && id.name == "arguments")) {
        addLocal(id, scope, true);
      }

      if (init) {
        if (scope.hasWith) {
          // The initializer assignment resolves the identifier reference
          // dynamically; capture the base before evaluating it so the store
          // survives a binding that disappears mid-expression.
          this.emitter.emitLocalRef(scope, OPCODE.REFVAR, id);
          this.Expression(init, scope);
          this.emitter.emitLocalRef(scope, OPCODE.PUTVAR, id);
        } else {
          this.Expression(init, scope);
          this.emitter.emitLocal(scope, OPCODE.SETLOCAL, OPCODE.SETVAR, id);
        }
        this.emitter.emit(scope, OPCODE.POP);
      }
    }
  }

  StatementList(node, scope) {
    const body = [].concat(node.body || node.consequent);
    for (let i = 0; i < body.length; i++) {
      body[i].parent = node;
      this.Statement(body[i], scope);
    }
  }

  Statement(node, scope) {
    if (node.loc) {
      const { start } = node.loc;
      this.emitter.emit(scope, OPCODE.LOC);
      this.emitter.emit(scope, start.line);
      this.emitter.emit(scope, start.column);
    }

    switch (node.type) {
      case "EmptyStatement": {
        if (scope.script) {
          this.emitter.emit(scope, OPCODE.POP);
          this.emitter.emit(scope, OPCODE.UNDEF);
        }
        break;
      }
      case "BlockStatement": {
        this.StatementList(node, scope);
        break;
      }
      case "VariableDeclaration": {
        this.VariableDeclaration(node, scope);
        break;
      }
      case "IfStatement": {
        this.IfStatement(node, scope);
        break;
      }
      case "DoWhileStatement": {
        this.DoWhileStatement(node, scope);
        break;
      }
      case "WhileStatement": {
        this.WhileStatement(node, scope);
        break;
      }
      case "ForStatement": {
        this.ForStatement(node, scope);
        break;
      }
      case "ForInStatement": {
        this.ForInStatement(node, scope);
        break;
      }
      case "SwitchStatement": {
        this.SwitchStatement(node, scope);
        break;
      }
      case "LabeledStatement": {
        this.LabeledStatement(node, scope);
        break;
      }
      case "BreakStatement": {
        this.BreakStatement(node, scope);
        break;
      }
      case "ContinueStatement": {
        this.ContinueStatement(node, scope);
        break;
      }
      case "ReturnStatement": {
        this.ReturnStatement(node, scope);
        break;
      }
      case "ThrowStatement": {
        this.ThrowStatement(node, scope);
        break;
      }
      case "WithStatement": {
        this.WithStatement(node, scope);
        break;
      }
      case "TryStatement": {
        this.TryStatement(node, scope);
        break;
      }
      case "ExpressionStatement": {
        const { expression } = node;
        if (scope.script) {
          this.emitter.emit(scope, OPCODE.POP);
          this.Expression(expression, scope);
        } else {
          this.Expression(expression, scope);
          this.emitter.emit(scope, OPCODE.POP);
        }
        break;
      }
      case "FunctionDeclaration": {
        if (scope.strict && !this.allowedFunctionDeclarations.has(node)) {
          throw new SyntaxError(
            "Function declarations inside statements are not allowed in ES5.1 strict code"
          );
        }
        // Parsed during the hoisting phase; skip it here.
        break;
      }
    }
  }

  IfStatement(node, scope) {
    const { test, consequent, alternate } = node;
    const region = this.beginControlRegion(scope, "If");
    if (region) region.testStart = scope.opcode.length;
    if (!alternate) {
      this.Expression(test, scope);
      const labelIndex = this.emitter.emitJump(scope, OPCODE.JFALSE);
      if (region) {
        region.branch = labelIndex - 1;
        region.consequentStart = scope.opcode.length;
      }
      consequent.parent = node;
      this.Statement(consequent, scope);
      labelTo(scope.opcode.length, labelIndex, scope);
      if (region) {
        region.consequentEnd = scope.opcode.length;
        region.alternateStart = null;
        region.alternateEnd = null;
      }
    } else {
      this.Expression(test, scope);
      const thenIndex = this.emitter.emitJump(scope, OPCODE.JTRUE);
      if (region) {
        region.branch = thenIndex - 1;
        region.alternateStart = scope.opcode.length;
      }
      alternate.parent = node;
      this.Statement(alternate, scope);
      const endIndex = this.emitter.emitJump(scope, OPCODE.JUMP);
      if (region) {
        region.alternateEnd = endIndex - 1;
        region.alternateExit = endIndex - 1;
      }
      labelTo(scope.opcode.length, thenIndex, scope);
      if (region) region.consequentStart = scope.opcode.length;
      consequent.parent = node;
      this.Statement(consequent, scope);
      labelTo(scope.opcode.length, endIndex, scope);
      if (region) region.consequentEnd = scope.opcode.length;
    }
    if (region) region.end = scope.opcode.length;
  }

  DoWhileStatement(node, scope) {
    const { test, body } = node;
    const loopIndex = scope.opcode.length;
    const region = this.beginControlRegion(scope, "DoWhile", loopIndex);
    if (region) node._controlRegion = region;
    if (region) region.bodyStart = loopIndex;
    body.parent = node;
    this.Statement(body, scope);
    const condIndex = scope.opcode.length;
    if (region) {
      region.bodyEnd = condIndex;
      region.testStart = condIndex;
      region.continueTarget = condIndex;
    }
    this.Expression(test, scope);
    const branch = scope.opcode.length;
    this.emitter.emitJumpTo(scope, OPCODE.JTRUE, loopIndex);
    labelJumps(node.jumps || [], scope.opcode.length, condIndex, scope);
    if (region) {
      region.branch = branch;
      region.end = scope.opcode.length;
      region.breakTarget = region.end;
    }
  }

  WhileStatement(node, scope) {
    const { test, body } = node;
    const loopIndex = scope.opcode.length;
    const region = this.beginControlRegion(scope, "While", loopIndex);
    if (region) node._controlRegion = region;
    if (region) region.testStart = loopIndex;
    this.Expression(test, scope);
    const endIndex = this.emitter.emitJump(scope, OPCODE.JFALSE);
    if (region) {
      region.branch = endIndex - 1;
      region.bodyStart = scope.opcode.length;
    }
    body.parent = node;
    this.Statement(body, scope);
    const bodyEnd = scope.opcode.length;
    const backedge = scope.opcode.length;
    this.emitter.emitJumpTo(scope, OPCODE.JUMP, loopIndex);
    labelTo(scope.opcode.length, endIndex, scope);
    labelJumps(node.jumps || [], scope.opcode.length, loopIndex, scope);
    if (region) {
      region.bodyEnd = bodyEnd;
      region.backedge = backedge;
      region.continueTarget = loopIndex;
      region.end = scope.opcode.length;
      region.breakTarget = region.end;
    }
  }

  ForStatement(node, scope) {
    const { init, test, update, body } = node;
    const region = this.beginControlRegion(scope, "For");
    if (region) node._controlRegion = region;
    if (region) region.initStart = scope.opcode.length;
    if (init != null) {
      if (init.type == "VariableDeclaration") {
        this.VariableDeclaration(init, scope);
      } else {
        this.Expression(init, scope);
        this.emitter.emit(scope, OPCODE.POP);
      }
    }
    if (region) region.initEnd = scope.opcode.length;

    let endIndex = 0;
    const loopIndex = scope.opcode.length;
    if (region) region.testStart = loopIndex;
    if (test != null) {
      this.Expression(test, scope);
      endIndex = this.emitter.emitJump(scope, OPCODE.JFALSE);
    }
    if (region) {
      region.branch = endIndex ? endIndex - 1 : null;
      region.bodyStart = scope.opcode.length;
    }

    body.parent = node;
    this.Statement(body, scope);
    const contIndex = scope.opcode.length;
    if (region) {
      region.bodyEnd = contIndex;
      region.updateStart = contIndex;
      region.continueTarget = contIndex;
    }
    if (update != null) {
      this.Expression(update, scope);
      this.emitter.emit(scope, OPCODE.POP);
    }
    if (region) region.updateEnd = scope.opcode.length;

    const backedge = scope.opcode.length;
    this.emitter.emitJumpTo(scope, OPCODE.JUMP, loopIndex);
    if (endIndex) {
      labelTo(scope.opcode.length, endIndex, scope);
    }
    labelJumps(node.jumps || [], scope.opcode.length, contIndex, scope);
    if (region) {
      region.backedge = backedge;
      region.end = scope.opcode.length;
      region.breakTarget = region.end;
    }
  }

  ForInStatement(node, scope) {
    const { left, right, body } = node;
    const region = this.beginControlRegion(scope, "ForIn");
    if (region) node._controlRegion = region;
    if (region) region.iteratorStart = scope.opcode.length;
    this.Expression(right, scope);
    this.emitter.emit(scope, OPCODE.ITERATOR);
    const loopIndex = scope.opcode.length;
    if (region) {
      region.iteratorEnd = loopIndex;
      region.testStart = loopIndex;
    }

    this.emitter.emit(scope, OPCODE.NEXTITER);
    const endIndex = this.emitter.emitJump(scope, OPCODE.JFALSE);
    if (region) {
      region.branch = endIndex - 1;
      region.bodyStart = scope.opcode.length;
    }
    if (left.type == "VariableDeclaration") {
      this.VariableDeclaration(left, scope);
      this.emitter.emitLocal(scope, OPCODE.SETLOCAL, OPCODE.SETVAR, left.declarations[0].id);
    } else if (left.type == "Identifier") {
      this.emitter.emitLocal(scope, OPCODE.SETLOCAL, OPCODE.SETVAR, left);
    } else if (left.type == "MemberExpression") {
      const { object, property } = left;
      if (!left.computed) {
        this.Expression(object, scope);
        this.emitter.emit(scope, OPCODE.ROT2);
        this.emitter.emitString(scope, OPCODE.SETPROP_S, property);
      } else {
        this.Expression(object, scope);
        this.Expression(property, scope);
        this.emitter.emit(scope, OPCODE.ROT3);
        this.emitter.emit(scope, OPCODE.SETPROP);
      }
    } else {
      throw new Error("invalid l-value in for-in loop assignment");
    }

    body.parent = node;
    this.emitter.emit(scope, OPCODE.POP);
    if (scope.script) {
      this.emitter.emit(scope, OPCODE.ROT2);
      this.Statement(body, scope);
      this.emitter.emit(scope, OPCODE.ROT2);
    } else {
      this.Statement(body, scope);
    }

    const bodyEnd = scope.opcode.length;
    const backedge = scope.opcode.length;
    this.emitter.emitJumpTo(scope, OPCODE.JUMP, loopIndex);
    labelTo(scope.opcode.length, endIndex, scope);
    labelJumps(node.jumps || [], scope.opcode.length, loopIndex, scope);
    if (region) {
      region.bodyEnd = bodyEnd;
      region.backedge = backedge;
      region.continueTarget = loopIndex;
      region.end = scope.opcode.length;
      region.breakTarget = region.end;
    }
  }

  SwitchStatement(node, scope) {
    const { discriminant, cases } = node;
    const region = this.beginControlRegion(scope, "Switch");
    if (region) {
      node._controlRegion = region;
      region.discriminantStart = scope.opcode.length;
      region.cases = cases.map((caseNode, index) => ({
        index,
        default: caseNode.test == null,
        testStart: null,
        branch: null,
        bodyStart: null,
        bodyEnd: null,
      }));
    }
    this.Expression(discriminant, scope);
    if (region) region.discriminantEnd = scope.opcode.length;

    let defaultStatement = null;
    for (let i = 0; i < cases.length; i++) {
      const { test } = cases[i];
      if (test == null) {
        defaultStatement = cases[i];
      } else {
        if (region) region.cases[i].testStart = scope.opcode.length;
        this.Expression(test, scope);
        cases[i].caseJump = this.emitter.emitJump(scope, OPCODE.JCASE);
        if (region) {
          region.cases[i].testEnd = cases[i].caseJump - 1;
          region.cases[i].branch = cases[i].caseJump - 1;
        }
      }
    }

    let endIndex = 0;
    if (region) region.dispatchPop = scope.opcode.length;
    this.emitter.emit(scope, OPCODE.POP);
    if (defaultStatement != null) {
      defaultStatement.caseJump = this.emitter.emitJump(scope, OPCODE.JUMP);
      if (region) region.dispatchExit = defaultStatement.caseJump - 1;
    } else {
      endIndex = this.emitter.emitJump(scope, OPCODE.JUMP);
      if (region) region.dispatchExit = endIndex - 1;
    }

    for (let i = 0; i < cases.length; i++) {
      const { caseJump } = cases[i];
      cases[i].parent = node;
      labelTo(scope.opcode.length, caseJump, scope);
      if (region) region.cases[i].bodyStart = scope.opcode.length;
      this.StatementList(cases[i], scope);
    }

    if (endIndex > 0) {
      labelTo(scope.opcode.length, endIndex, scope);
    }
    labelJumps(node.jumps || [], scope.opcode.length, 0, scope);
    if (region) {
      region.end = scope.opcode.length;
      region.breakTarget = region.end;
      region.cases.forEach((caseRegion, index) => {
        caseRegion.bodyEnd =
          index + 1 < region.cases.length ? region.cases[index + 1].bodyStart : region.end;
      });
    }
  }

  BreakStatement(node, scope) {
    let target = null;
    const { label } = node;
    if (label != null) {
      const { name } = label;
      isFutureWord(name, scope);
      target = breakTarget(node.parent, name);
      if (target == null) {
        throw new Error(`break label '${name}' not found`);
      }
    } else {
      target = breakTarget(node.parent, null);
      if (target == null) {
        throw new Error(`unlabelled break must be inside loop or switch`);
      }
    }

    this.ExitStatement("BreakStatement", node, target, scope);
    const jumpOffset = scope.opcode.length;
    const index = this.emitter.emitJump(scope, OPCODE.JUMP);
    if (this.structuredMetadata && target._controlRegion) {
      target._controlRegion.exits = target._controlRegion.exits || [];
      target._controlRegion.exits.push({ kind: "break", offset: jumpOffset });
    }
    target.jumps = target.jumps || [];
    target.jumps.push({ type: node.type, inst: index });
  }

  ContinueStatement(node, scope) {
    let target = null;
    const { label } = node;
    if (label != null) {
      const { name } = label;
      isFutureWord(name);
      target = continueTarget(node.parent, name);
      if (target == null) {
        throw new Error(`continue label '${name}' not found`);
      }
    } else {
      target = continueTarget(node.parent, null);
      if (!target) {
        throw new Error(`continue must be inside loop`);
      }
    }

    this.ExitStatement("ContinueStatement", node, target, scope);
    const jumpOffset = scope.opcode.length;
    const index = this.emitter.emitJump(scope, OPCODE.JUMP);
    if (this.structuredMetadata && target._controlRegion) {
      target._controlRegion.exits = target._controlRegion.exits || [];
      target._controlRegion.exits.push({ kind: "continue", offset: jumpOffset });
    }
    target.jumps = target.jumps || [];
    target.jumps.push({ type: node.type, inst: index });
  }

  LabeledStatement(node, scope) {
    let { body } = node;
    node._labelTarget = body;
    if (body.type != "BlockStatement") {
      body = node.body = {
        type: "BlockStatement",
        body: [body],
      };
    }

    const region = this.beginControlRegion(scope, "Label");
    if (region) {
      body._controlRegion = region;
      region.label = (node.label && node.label.name) || "";
      region.bodyStart = scope.opcode.length;
    }
    body.parent = node;
    this.Statement(body, scope);
    while (node.type == "LabeledStatement") {
      node = node.body;
    }

    if (!isLoop(node.type) && node.type != "SwitchStatement") {
      labelJumps(node.jumps || [], scope.opcode.length, 0, scope);
    }
    if (region) {
      region.bodyEnd = scope.opcode.length;
      region.end = scope.opcode.length;
    }
  }

  ReturnStatement(node, scope) {
    const { argument } = node;
    if (argument != null) {
      this.Expression(argument, scope);
    } else {
      this.emitter.emit(scope, OPCODE.UNDEF);
    }

    const target = returnTarget(node);
    if (target == null) {
      throw new Error("return not in function");
    }

    this.ExitStatement("ReturnStatement", node, target, scope);
    this.emitter.emit(scope, OPCODE.RETURN);
  }

  ThrowStatement(node, scope) {
    const { argument } = node;
    this.Expression(argument, scope);
    this.emitter.emit(scope, OPCODE.THROW);
  }

  WithStatement(node, scope) {
    scope.lightweight = false;
    // Identifiers inside a with body may resolve to the with object; stores
    // must capture the reference base before the rval evaluates (ES5 8.7.2).
    // Script scopes are already non-lightweight, so this marks the signal
    // explicitly rather than relying on `lightweight`.
    scope.hasWith = true;
    if (scope.strict) {
      throw new Error(`'with' statements are not allowed in strict mode`);
    }

    const { object, body } = node;
    this.Expression(object, scope);
    this.emitter.emit(scope, OPCODE.WITH);
    body.parent = node;
    this.Statement(body, scope);
    this.emitter.emit(scope, OPCODE.ENDWITH);
  }

  TryStatement(node, scope) {
    const { handler, finalizer } = node;
    if (handler != null && handler.param != null) {
      scope.lightweight = false;
      if (finalizer != null) {
        const region = this.beginControlRegion(scope, "TryFinally");
        if (region) region.hasCatch = true;
        this.TryCatchFinallyStatement(node, scope, region);
      } else {
        const region = this.beginControlRegion(scope, "TryCatch");
        this.TryCatchStatment(node, scope, region);
      }
    } else {
      const region = this.beginControlRegion(scope, "TryFinally");
      if (region) region.hasCatch = false;
      this.TryFinallyStatement(node, scope, region);
    }
  }

  TryCatchStatment(node, scope, region = null) {
    const { block, handler } = node;
    const { param, body } = handler;
    if (region) region.tryEnter = scope.opcode.length;
    let L1 = this.emitter.emitJump(scope, OPCODE.TRY);
    isFutureWord(param.name);
    if (scope.strict) {
      if (param.name == "arguments") {
        throw new SyntaxError(`redefining 'arguments' is not allowed in strict mode`);
      } else if (param.name == "eval") {
        throw new SyntaxError(`redefining 'eval' is not allowed in strict mode`);
      }
    }

    if (region) region.catchStart = scope.opcode.length;
    this.emitter.emitString(scope, OPCODE.CATCH, param);
    if (region) region.catchBodyStart = scope.opcode.length;
    body.parent = node;
    this.Statement(body, scope);
    if (region) region.catchBodyEnd = scope.opcode.length;
    this.emitter.emit(scope, OPCODE.ENDCATCH);

    if (region) region.catchExit = scope.opcode.length;
    let L2 = this.emitter.emitJump(scope, OPCODE.JUMP);
    labelTo(scope.opcode.length, L1, scope);
    if (region) region.tryBodyStart = scope.opcode.length;
    block.parent = node;
    this.Statement(block, scope);
    if (region) region.tryBodyEnd = scope.opcode.length;
    this.emitter.emit(scope, OPCODE.ENDTRY);
    labelTo(scope.opcode.length, L2, scope);
    if (region) {
      region.end = scope.opcode.length;
      region.tryExit = region.tryBodyEnd;
    }
  }

  TryFinallyStatement(node, scope, region = null) {
    node.handler = {
      type: "CatchClause",
      param: { type: "Identifier", name: "e" },
      body: [],
    };
    this.TryCatchFinallyStatement(node, scope, region);
  }

  TryCatchFinallyStatement(node, scope, region = null) {
    const { block, handler, finalizer } = node;
    const { param, body } = handler;
    if (region) region.tryEnter = scope.opcode.length;
    let L1 = this.emitter.emitJump(scope, OPCODE.TRY);
    if (region) region.innerTryEnter = scope.opcode.length;
    let L2 = this.emitter.emitJump(scope, OPCODE.TRY);

    if (region) region.exceptionalFinalizerStart = scope.opcode.length;
    finalizer.parent = node;
    this.Statement(finalizer, scope);
    if (region) {
      region.exceptionalFinalizerEnd = scope.opcode.length;
      region.exceptionThrow = scope.opcode.length;
    }
    this.emitter.emit(scope, OPCODE.THROW);
    labelTo(scope.opcode.length, L2, scope);
    if (scope.strict) {
      if (param.name == "arguments") {
        throw new SyntaxError(`redefining 'arguments' is not allowed in strict mode`);
      } else if (param.name == "eval") {
        throw new SyntaxError(`redefining 'eval' is not allowed in strict mode`);
      }
    }

    if (region) region.catchStart = scope.opcode.length;
    this.emitter.emitString(scope, OPCODE.CATCH, param);
    if (region) region.catchBodyStart = scope.opcode.length;
    body.parent = node;
    this.Statement(body, scope);
    if (region) region.catchBodyEnd = scope.opcode.length;
    this.emitter.emit(scope, OPCODE.ENDCATCH);
    if (region) region.innerTryExit = scope.opcode.length;
    this.emitter.emit(scope, OPCODE.ENDTRY);

    if (region) region.catchExit = scope.opcode.length;
    let L3 = this.emitter.emitJump(scope, OPCODE.JUMP);
    labelTo(scope.opcode.length, L1, scope);
    if (region) region.tryBodyStart = scope.opcode.length;
    block.parent = node;
    this.Statement(block, scope);
    if (region) region.tryBodyEnd = scope.opcode.length;
    if (region) region.tryExit = scope.opcode.length;
    this.emitter.emit(scope, OPCODE.ENDTRY);
    labelTo(scope.opcode.length, L3, scope);
    if (region) region.finalizerStart = scope.opcode.length;
    this.Statement(finalizer, scope);
    if (region) {
      region.finalizerEnd = scope.opcode.length;
      region.end = scope.opcode.length;
    }
  }

  ExitStatement(type, node, target, scope) {
    let prev = null;
    do {
      prev = node;
      node = node.parent;
      switch (node.type) {
        case "WithStatement": {
          this.emitter.emit(scope, OPCODE.ENDWITH);
          break;
        }
        case "ForInStatement": {
          if (scope.script) {
            if (
              type == "ReturnStatement" ||
              type == "BreakStatement" ||
              (type == "ContinueStatement" && node != target)
            ) {
              this.emitter.emit(scope, OPCODE.ROT2);
              this.emitter.emit(scope, OPCODE.POP);
            }
            if (type == "ContinueStatement") {
              this.emitter.emit(scope, OPCODE.ROT2);
            }
          } else {
            if (type == "ReturnStatement") {
              this.emitter.emit(scope, OPCODE.ROT2);
              this.emitter.emit(scope, OPCODE.POP);
            }
            if (type == "BreakStatement" || (type == "ContinueStatement" && node != target)) {
              this.emitter.emit(scope, OPCODE.POP);
            }
          }
          break;
        }
        case "TryStatement": {
          const { block, handler, finalizer } = node;
          if (prev == block) {
            this.emitter.emit(scope, OPCODE.ENDTRY);
            if (finalizer != null) {
              const syntheticStart = scope.opcode.length;
              finalizer.parent = node;
              this.Statement(finalizer, scope);
              this.recordSyntheticRange(scope, "AbruptFinally", syntheticStart);
            }
          } else if (handler && prev == handler.body) {
            if (finalizer != null) {
              this.emitter.emit(scope, OPCODE.ENDCATCH);
              this.emitter.emit(scope, OPCODE.ENDTRY);
              const syntheticStart = scope.opcode.length;
              finalizer.parent = node;
              this.Statement(finalizer, scope);
              this.recordSyntheticRange(scope, "AbruptFinally", syntheticStart);
            } else {
              this.emitter.emit(scope, OPCODE.ENDCATCH);
            }
          }
          break;
        }
      }
    } while (node != target);
  }

  Literal(node, scope) {
    if (typeof node.value == "number") {
      this.emitter.emitNumber(scope, node);
    } else if (typeof node.value == "string") {
      this.emitter.emitString(scope, OPCODE.STRING, { name: node.value });
    } else if (node.value == null) {
      this.emitter.emit(scope, OPCODE.NULL);
    } else if (typeof node.value == "boolean") {
      this.emitter.emit(scope, node.value ? OPCODE.TRUE : OPCODE.FALSE);
    } else if (node.regex) {
      this.emitter.emit(scope, OPCODE.NEWREGEXP);
      this.emitter.emit(scope, addString({ name: node.regex.pattern }, scope));
      this.emitter.emit(scope, addString({ name: node.regex.flags }, scope));
    }
  }

  ObjectExpression(node, scope) {
    const { properties } = node;
    const propertyKinds = new Map();
    for (let i = 0; i < properties.length; i++) {
      const { kind, key, value } = properties[i];
      if (key.type == "Identifier" || (key.type == "Literal" && typeof key.value == "string")) {
        this.emitter.emitString(scope, OPCODE.STRING, { name: key.name || key.value });
      } else if (key.type == "Literal" && typeof key.value == "number") {
        this.emitter.emitNumber(scope, key);
      } else {
        throw new Error(`invalid property name in object initializer`);
      }

      if (scope.strict) {
        const name = key.name || key.value;
        const previousKinds = propertyKinds.get(String(name)) || [];
        const conflicts =
          previousKinds.length &&
          (kind == "init" || previousKinds.includes("init") || previousKinds.includes(kind));
        if (conflicts) {
          throw new Error(`duplicate property '${name}' in object literal`);
        }
        previousKinds.push(kind);
        propertyKinds.set(String(name), previousKinds);
      }

      if (kind == "init") {
        this.Expression(value, scope);
        this.emitter.emit(scope, OPCODE.INITPROP);
      } else {
        const funcScope = new Scope();
        funcScope.strict = scope.strict;
        this.FunctionDeclaration(value, funcScope);
        this.emitter.emitFunction(scope, funcScope);
        this.emitter.emit(scope, kind == "get" ? OPCODE.INITGETTER : OPCODE.INITSETTER);
      }
    }
  }

  ArrayExpression(node, scope) {
    const { elements } = node;
    for (let i = 0; i < elements.length; i++) {
      this.emitter.emitNumber(scope, { value: i });
      if (elements[i] == null) {
        this.emitter.emit(scope, OPCODE.EMPTY);
      } else {
        this.Expression(elements[i], scope);
      }
      this.emitter.emit(scope, OPCODE.INITPROP);
    }
  }

  MemberExpression(node, scope) {
    const { object, property } = node;
    this.Expression(object, scope);
    this.emitter.emitString(scope, OPCODE.GETPROP_S, property);
  }

  IndexExpression(node, scope) {
    this.Expression(node.object, scope);
    this.Expression(node.property, scope);
    this.emitter.emit(scope, OPCODE.GETPROP);
  }

  CallExpression(node, scope) {
    const { callee, arguments: args } = node;
    if (callee.type == "MemberExpression") {
      const { object, property } = callee;
      this.Expression(object, scope);
      this.emitter.emit(scope, OPCODE.DUP);
      if (!callee.computed) {
        this.emitter.emitString(scope, OPCODE.GETPROP_S, property);
      } else {
        this.Expression(property, scope);
        this.emitter.emit(scope, OPCODE.GETPROP);
      }
      this.emitter.emit(scope, OPCODE.ROT2);
    } else {
      const { name } = callee;
      if (name == "eval") {
        this.EvalExpression(node, scope);
        return;
      }

      this.Expression(callee, scope);
      this.emitter.emit(scope, OPCODE.UNDEF);
      if (name == "Function") {
        this.CallFunctionExpression(node, scope);
        this.emitter.emit(scope, OPCODE.CALL);
        this.emitter.emit(scope, 1);
        return;
      }
    }

    for (let i = 0; i < args.length; i++) {
      this.Expression(args[i], scope);
    }

    this.emitter.emit(scope, OPCODE.CALL);
    this.emitter.emit(scope, args.length);
  }

  EvalExpression(node, scope) {
    scope.lightweight = false;
    scope.arguments = true;

    let { arguments: args } = node;
    if (args.length == 0) {
      return;
    }

    try {
      let evalstr = dynamicExpConcat(args[0]);
      this.emitter.emit(scope, OPCODE.UNDEF);
      this.emitter.emit(scope, OPCODE.EVAL);

      if (evalstr === -1) {
        this.emitter.emit(scope, scope.et.push(evalstr) - 1);
      } else {
        // Source maps expose the eval body as a virtual source
        // (`<root>#eval-N`). The parsed text may carry a `'use strict';`
        // prefix injected here, so record the geometry that maps parsed
        // positions back to the eval string exactly as the guest wrote it.
        const strictPrefix = scope.strict ? "'use strict';" : "";
        const parsed = `${strictPrefix}${evalstr}`;
        const compiler = new Compiler({
          structuredMetadata: this.structuredMetadata,
          transform: this.transform,
        });
        const evalScope = compiler.compile(parsed, scope.strict);
        evalScope.syntheticSource = {
          text: evalstr,
          lines: 0,
          columns: strictPrefix.length,
        };
        this.emitter.emit(scope, scope.et.push(evalScope) - 1);
      }
    } catch (e) {
      throw new SyntaxError(e.message);
    }
  }

  CallFunctionExpression(node, scope) {
    scope.lightweight = false;
    scope.arguments = true;

    let { arguments: args } = node;
    try {
      for (let i = 0; i < args.length; i++) {
        args[i] = dynamicExpConcat(args[i]);
        if (args[i] === -1) {
          this.emitter.emitNumber(scope, { value: scope.dft.push(args[i]) - 1 });
          return;
        }
      }

      args = args.map((v) => v.trim());
      let body = args[args.length - 1] || "";
      let params = args.length > 1 ? args.slice(0, -1) : [];
      params = params.map((v) => v.split(","));
      params = [].concat.apply([], params);
      for (let i = params.length - 1; i >= 0; i--) {
        const index = params.lastIndexOf(params[i]);
        if (index != i) {
          params.splice(index, 1);
        }
      }

      const funcName = `_dynamic_${DYNAMIC_COMPILE_INDEX++}`;
      const prefix = `function ${funcName}(${params.join(",")}){ `;
      const funcStr = `${prefix}${body} }`;
      const compiler = new Compiler({
        structuredMetadata: this.structuredMetadata,
        transform: this.transform,
      });
      const funcScope = compiler.compile(funcStr, false);
      // Source maps expose the body as a virtual source (`<root>#dynamic-N`).
      // The descriptor's `lines`/`columns` are the prefix geometry: how many
      // parsed lines the wrapper occupies and how long its final line is.
      // Body line 1 starts at the end of the prefix's last line, so its
      // columns shift by `columns`; later body lines are fresh parsed lines
      // and map to themselves. The geometry generalizes to multi-line
      // parameter lists (a param string may contain newlines) — `lines` is
      // the wrapper's newline count, `columns` the length of its last line.
      const rootScope =
        funcScope.ft.find((entry) => entry && entry.name === funcName) || funcScope.ft[0];
      const prefixLines = prefix.split(/\r\n|\n|\r/);
      rootScope.syntheticSource = {
        text: body,
        lines: prefixLines.length - 1,
        columns: prefixLines[prefixLines.length - 1].length,
      };
      this.emitter.emitNumber(scope, { value: scope.dft.push(rootScope) - 1 });
    } catch (e) {
      throw new SyntaxError(e.message);
    }
  }

  NewExpression(node, scope) {
    const { callee, arguments: args } = node;
    this.Expression(callee, scope);
    if (callee.name == "Function") {
      this.CallFunctionExpression(node, scope);
      this.emitter.emit(scope, OPCODE.NEW);
      this.emitter.emit(scope, 1);
      return;
    }

    for (let i = 0; i < args.length; i++) {
      this.Expression(args[i], scope);
    }

    this.emitter.emit(scope, OPCODE.NEW);
    this.emitter.emit(scope, args.length);
  }

  DeleteExpression(node, scope) {
    const { argument } = node;
    if (argument.type == "Identifier") {
      if (scope.strict) {
        throw new SyntaxError("delete on an unqualified name is not allowed in strict mode");
      }
      this.emitter.emitLocal(scope, OPCODE.DELLOCAL, OPCODE.DELVAR, argument);
    } else if (argument.type == "MemberExpression") {
      const { object, property } = argument;
      if (!argument.computed) {
        this.Expression(object, scope);
        this.emitter.emitString(scope, OPCODE.DELPROP_S, property);
      } else {
        this.Expression(object, scope);
        this.Expression(property, scope);
        this.emitter.emit(scope, OPCODE.DELPROP);
      }
    } else {
      // ES5 delete accepts any non-Reference expression, evaluates it for
      // effects, and produces true. Only unqualified identifiers in strict
      // code are an early error.
      this.Expression(argument, scope);
      this.emitter.emit(scope, OPCODE.POP);
      this.emitter.emit(scope, OPCODE.TRUE);
    }
  }

  PrefixIncExpression(node, scope) {
    const { argument } = node;
    if (argument.type == "Identifier") {
      if (scope.hasWith) this.emitter.emitLocalRef(scope, OPCODE.REFVAR, argument);
      this.emitter.emitLocal(scope, OPCODE.GETLOCAL, OPCODE.GETVAR, argument);
      this.emitter.emit(scope, OPCODE.INC);
      if (scope.hasWith) {
        this.emitter.emitLocalRef(scope, OPCODE.PUTVAR, argument);
      } else {
        this.emitter.emitLocal(scope, OPCODE.SETLOCAL, OPCODE.SETVAR, argument);
      }
    } else if (argument.type == "MemberExpression") {
      const { object, property } = argument;
      if (!argument.computed) {
        this.Expression(object, scope);
        this.emitter.emit(scope, OPCODE.DUP);
        this.emitter.emitString(scope, OPCODE.GETPROP_S, property);
        this.emitter.emit(scope, OPCODE.INC);
        this.emitter.emitString(scope, OPCODE.SETPROP_S, property);
      } else {
        this.Expression(object, scope);
        this.Expression(property, scope);
        this.emitter.emit(scope, OPCODE.DUP2);
        this.emitter.emit(scope, OPCODE.GETPROP);
        this.emitter.emit(scope, OPCODE.INC);
        this.emitter.emit(scope, OPCODE.SETPROP);
      }
    } else {
      throw new Error("invalid l-value in assignment");
    }
  }

  PrefixDecExpression(node, scope) {
    const { argument } = node;
    if (argument.type == "Identifier") {
      if (scope.hasWith) this.emitter.emitLocalRef(scope, OPCODE.REFVAR, argument);
      this.emitter.emitLocal(scope, OPCODE.GETLOCAL, OPCODE.GETVAR, argument);
      this.emitter.emit(scope, OPCODE.DEC);
      if (scope.hasWith) {
        this.emitter.emitLocalRef(scope, OPCODE.PUTVAR, argument);
      } else {
        this.emitter.emitLocal(scope, OPCODE.SETLOCAL, OPCODE.SETVAR, argument);
      }
    } else if (argument.type == "MemberExpression") {
      const { object, property } = argument;
      if (!argument.computed) {
        this.Expression(object, scope);
        this.emitter.emit(scope, OPCODE.DUP);
        this.emitter.emitString(scope, OPCODE.GETPROP_S, property);
        this.emitter.emit(scope, OPCODE.DEC);
        this.emitter.emitString(scope, OPCODE.SETPROP_S, property);
      } else {
        this.Expression(object, scope);
        this.Expression(property, scope);
        this.emitter.emit(scope, OPCODE.DUP2);
        this.emitter.emit(scope, OPCODE.GETPROP);
        this.emitter.emit(scope, OPCODE.DEC);
        this.emitter.emit(scope, OPCODE.SETPROP);
      }
    } else {
      throw new Error("invalid l-value in assignment");
    }
  }

  PostIncExpression(node, scope) {
    const { argument } = node;
    if (argument.type == "Identifier") {
      if (scope.hasWith) this.emitter.emitLocalRef(scope, OPCODE.REFVAR, argument);
      this.emitter.emitLocal(scope, OPCODE.GETLOCAL, OPCODE.GETVAR, argument);
      this.emitter.emit(scope, OPCODE.POSTINC);
      // With a captured token the stack is [token, new, old]; ROT3 lifts
      // `old` (the expression result) below the token so PUTVAR pops
      // value+token.
      this.emitter.emit(scope, scope.hasWith ? OPCODE.ROT3 : OPCODE.ROT2);
      if (scope.hasWith) {
        this.emitter.emitLocalRef(scope, OPCODE.PUTVAR, argument);
      } else {
        this.emitter.emitLocal(scope, OPCODE.SETLOCAL, OPCODE.SETVAR, argument);
      }
      this.emitter.emit(scope, OPCODE.POP);
    } else if (argument.type == "MemberExpression") {
      const { object, property } = argument;
      if (!argument.computed) {
        this.Expression(object, scope);
        this.emitter.emit(scope, OPCODE.DUP);
        this.emitter.emitString(scope, OPCODE.GETPROP_S, property);
        this.emitter.emit(scope, OPCODE.POSTINC);
        this.emitter.emit(scope, OPCODE.ROT3);
        this.emitter.emitString(scope, OPCODE.SETPROP_S, property);
        this.emitter.emit(scope, OPCODE.POP);
      } else {
        this.Expression(object, scope);
        this.Expression(property, scope);
        this.emitter.emit(scope, OPCODE.DUP2);
        this.emitter.emit(scope, OPCODE.GETPROP);
        this.emitter.emit(scope, OPCODE.POSTINC);
        this.emitter.emit(scope, OPCODE.ROT4);
        this.emitter.emit(scope, OPCODE.SETPROP);
        this.emitter.emit(scope, OPCODE.POP);
      }
    } else {
      throw new Error("invalid l-value in assignment");
    }
  }

  PostDecExpression(node, scope) {
    const { argument } = node;
    if (argument.type == "Identifier") {
      if (scope.hasWith) this.emitter.emitLocalRef(scope, OPCODE.REFVAR, argument);
      this.emitter.emitLocal(scope, OPCODE.GETLOCAL, OPCODE.GETVAR, argument);
      this.emitter.emit(scope, OPCODE.POSTDEC);
      // With a captured token the stack is [token, new, old]; ROT3 lifts
      // `old` (the expression result) below the token so PUTVAR pops
      // value+token.
      this.emitter.emit(scope, scope.hasWith ? OPCODE.ROT3 : OPCODE.ROT2);
      if (scope.hasWith) {
        this.emitter.emitLocalRef(scope, OPCODE.PUTVAR, argument);
      } else {
        this.emitter.emitLocal(scope, OPCODE.SETLOCAL, OPCODE.SETVAR, argument);
      }
      this.emitter.emit(scope, OPCODE.POP);
    } else if (argument.type == "MemberExpression") {
      const { object, property } = argument;
      if (!argument.computed) {
        this.Expression(object, scope);
        this.emitter.emit(scope, OPCODE.DUP);
        this.emitter.emitString(scope, OPCODE.GETPROP_S, property);
        this.emitter.emit(scope, OPCODE.POSTDEC);
        this.emitter.emit(scope, OPCODE.ROT3);
        this.emitter.emitString(scope, OPCODE.SETPROP_S, property);
        this.emitter.emit(scope, OPCODE.POP);
      } else {
        this.Expression(object, scope);
        this.Expression(property, scope);
        this.emitter.emit(scope, OPCODE.DUP2);
        this.emitter.emit(scope, OPCODE.GETPROP);
        this.emitter.emit(scope, OPCODE.POSTDEC);
        this.emitter.emit(scope, OPCODE.ROT4);
        this.emitter.emit(scope, OPCODE.SETPROP);
        this.emitter.emit(scope, OPCODE.POP);
      }
    } else {
      throw new Error("invalid l-value in assignment");
    }
  }

  UnaryExpression(node, scope) {
    const { operator, argument } = node;
    if (operator == "delete") {
      this.DeleteExpression(node, scope);
    } else if (operator == "void") {
      this.Expression(argument, scope);
      this.emitter.emit(scope, OPCODE.POP);
      this.emitter.emit(scope, OPCODE.UNDEF);
    } else if (operator == "typeof") {
      this.TypeExpression(node, scope);
    } else if (operator == "+") {
      this.Expression(argument, scope);
      this.emitter.emit(scope, OPCODE.POS);
    } else if (operator == "-") {
      this.Expression(argument, scope);
      this.emitter.emit(scope, OPCODE.NEG);
    } else if (operator == "~") {
      this.Expression(argument, scope);
      this.emitter.emit(scope, OPCODE.BITNOT);
    } else if (operator == "!") {
      this.Expression(argument, scope);
      this.emitter.emit(scope, OPCODE.LOGNOT);
    }
  }

  TypeExpression(node, scope) {
    const { argument } = node;
    if (argument.type == "Identifier") {
      this.emitter.emitLocal(scope, OPCODE.GETLOCAL, OPCODE.HASVAR, argument);
    } else {
      this.Expression(argument, scope);
    }
    this.emitter.emit(scope, OPCODE.TYPEOF);
  }

  UpdateExpression(node, scope) {
    const { prefix, operator } = node;
    if (operator == "++") {
      this[prefix ? "PrefixIncExpression" : "PostIncExpression"](node, scope);
    } else if (operator == "--") {
      this[prefix ? "PrefixDecExpression" : "PostDecExpression"](node, scope);
    }
  }

  BinaryExpression(node, scope) {
    let opcode = OPCODE.UNDEF;
    switch (node.operator) {
      case "instanceof":
        opcode = OPCODE.INSTANCEOF;
        break;
      case "in":
        opcode = OPCODE.IN;
        break;
      case "==":
        opcode = OPCODE.EQ;
        break;
      case "!=":
        opcode = OPCODE.NE;
        break;
      case "===":
        opcode = OPCODE.STRICTEQ;
        break;
      case "!==":
        opcode = OPCODE.STRICTNE;
        break;
      case "|":
        opcode = OPCODE.BITOR;
        break;
      case "^":
        opcode = OPCODE.BITXOR;
        break;
      case "&":
        opcode = OPCODE.BITAND;
        break;
      case "<":
        opcode = OPCODE.LT;
        break;
      case ">":
        opcode = OPCODE.GT;
        break;
      case "<=":
        opcode = OPCODE.LE;
        break;
      case ">=":
        opcode = OPCODE.GE;
        break;
      case "<<":
        opcode = OPCODE.SHL;
        break;
      case ">>":
        opcode = OPCODE.SHR;
        break;
      case ">>>":
        opcode = OPCODE.USHR;
        break;
      case "+":
        opcode = OPCODE.ADD;
        break;
      case "-":
        opcode = OPCODE.SUB;
        break;
      case "*":
        opcode = OPCODE.MUL;
        break;
      case "/":
        opcode = OPCODE.DIV;
        break;
      case "%":
        opcode = OPCODE.MOD;
        break;
      default:
        throw new Error(`invalide binary operator '${node.operator}'`);
    }

    const { left, right } = node;
    this.Expression(left, scope);
    this.Expression(right, scope);
    this.emitter.emit(scope, opcode);
  }

  AssignmentExpression(node, scope) {
    const { left, right, operator } = node;
    if (operator == "=") {
      if (left.type == "Identifier") {
        if (scope.hasWith) {
          // ES5 8.7.2: PutValue uses the Reference created when the left-hand
          // side evaluates, even if the binding is gone by the time rval
          // finishes (e.g. `with (o) { x = (delete o.x, 2) }` must write o.x).
          this.emitter.emitLocalRef(scope, OPCODE.REFVAR, left);
          this.Expression(right, scope);
          this.emitter.emitLocalRef(scope, OPCODE.PUTVAR, left);
        } else {
          this.Expression(right, scope);
          this.emitter.emitLocal(scope, OPCODE.SETLOCAL, OPCODE.SETVAR, left);
        }
      } else if (left.type == "MemberExpression") {
        if (!left.computed) {
          this.Expression(left.object, scope);
          this.Expression(right, scope);
          this.emitter.emitString(scope, OPCODE.SETPROP_S, left.property);
        } else {
          this.Expression(left.object, scope);
          this.Expression(left.property, scope);
          this.Expression(right, scope);
          this.emitter.emit(scope, OPCODE.SETPROP);
        }
      } else {
        throw new Error("invalid l-value in assignment");
      }
    } else {
      if (left.type == "Identifier") {
        if (scope.hasWith) this.emitter.emitLocalRef(scope, OPCODE.REFVAR, left);
        this.emitter.emitLocal(scope, OPCODE.GETLOCAL, OPCODE.GETVAR, left);
      } else if (left.type == "MemberExpression") {
        const { object, property } = left;
        if (!left.computed) {
          this.Expression(object, scope);
          this.emitter.emit(scope, OPCODE.DUP);
          this.emitter.emitString(scope, OPCODE.GETPROP_S, property);
        } else {
          this.Expression(object, scope);
          this.Expression(property, scope);
          this.emitter.emit(scope, OPCODE.DUP2);
          this.emitter.emit(scope, OPCODE.GETPROP);
        }
      } else {
        throw new Error("invalid l-value in assignment");
      }

      this.Expression(right, scope);
      let opcode = OPCODE.UNDEF;
      switch (operator) {
        case "*=":
          opcode = OPCODE.MUL;
          break;
        case "/=":
          opcode = OPCODE.DIV;
          break;
        case "%=":
          opcode = OPCODE.MOD;
          break;
        case "+=":
          opcode = OPCODE.ADD;
          break;
        case "-=":
          opcode = OPCODE.SUB;
          break;
        case "<<=":
          opcode = OPCODE.SHL;
          break;
        case ">>=":
          opcode = OPCODE.SHR;
          break;
        case ">>>=":
          opcode = OPCODE.USHR;
          break;
        case "&=":
          opcode = OPCODE.BITAND;
          break;
        case "^=":
          opcode = OPCODE.BITXOR;
          break;
        case "|=":
          opcode = OPCODE.BITOR;
          break;
        default:
          throw new Error(`invalide binary operator '${operator}'`);
      }

      this.emitter.emit(scope, opcode);
      if (left.type == "Identifier") {
        if (scope.hasWith) {
          this.emitter.emitLocalRef(scope, OPCODE.PUTVAR, left);
        } else {
          this.emitter.emitLocal(scope, OPCODE.SETLOCAL, OPCODE.SETVAR, left);
        }
      } else if (left.type == "MemberExpression") {
        if (!left.computed) {
          this.emitter.emitString(scope, OPCODE.SETPROP_S, left.property);
        } else {
          this.emitter.emit(scope, OPCODE.SETPROP);
        }
      }
    }
  }

  SequenceExpression(node, scope) {
    const { expressions } = node;
    const { length } = expressions;
    if (length) {
      for (let i = 0; i < length - 1; i++) {
        this.Expression(expressions[i], scope);
        this.emitter.emit(scope, OPCODE.POP);
      }
      if (expressions.length > 1) {
        this.Expression(expressions[length - 1], scope);
      }
    }
  }

  LogicalExpression(node, scope) {
    const { left, right, operator } = node;
    const region = this.beginControlRegion(scope, "Logical");
    if (region) {
      region.operator = operator;
      region.leftStart = scope.opcode.length;
    }
    this.Expression(left, scope);
    this.emitter.emit(scope, OPCODE.DUP);
    const labelIndex = this.emitter.emitJump(
      scope,
      operator == "||" ? OPCODE.JTRUE : OPCODE.JFALSE
    );
    if (region) {
      region.branch = labelIndex - 1;
      region.rightStart = scope.opcode.length;
    }
    this.emitter.emit(scope, OPCODE.POP);
    this.Expression(right, scope);
    labelTo(scope.opcode.length, labelIndex, scope);
    if (region) {
      region.rightEnd = scope.opcode.length;
      region.end = scope.opcode.length;
    }
  }

  ConditionalExpression(node, scope) {
    const { test, consequent, alternate } = node;
    const region = this.beginControlRegion(scope, "Conditional");
    if (region) region.testStart = scope.opcode.length;
    this.Expression(test, scope);
    const thenIndex = this.emitter.emitJump(scope, OPCODE.JTRUE);
    if (region) {
      region.branch = thenIndex - 1;
      region.alternateStart = scope.opcode.length;
    }
    this.Expression(alternate, scope);
    const endIndex = this.emitter.emitJump(scope, OPCODE.JUMP);
    if (region) {
      region.alternateEnd = endIndex - 1;
      region.alternateExit = endIndex - 1;
    }
    labelTo(scope.opcode.length, thenIndex, scope);
    if (region) region.consequentStart = scope.opcode.length;
    this.Expression(consequent, scope);
    labelTo(scope.opcode.length, endIndex, scope);
    if (region) {
      region.consequentEnd = scope.opcode.length;
      region.end = scope.opcode.length;
    }
  }

  Expression(node, scope) {
    switch (node.type) {
      case "Literal": {
        this.Literal(node, scope);
        break;
      }
      case "Identifier": {
        if (node.name == "undefined") {
          this.emitter.emit(scope, OPCODE.UNDEF);
        } else {
          this.emitter.emitLocal(scope, OPCODE.GETLOCAL, OPCODE.GETVAR, node);
        }
        break;
      }
      case "ThisExpression": {
        this.emitter.emit(scope, OPCODE.THIS);
        break;
      }
      case "ObjectExpression": {
        this.emitter.emit(scope, OPCODE.NEWOBJECT);
        this.ObjectExpression(node, scope);
        break;
      }
      case "FunctionExpression": {
        const funcScope = new Scope();
        funcScope.strict = scope.strict;
        this.FunctionDeclaration(node, funcScope);
        this.emitter.emitFunction(scope, funcScope);
        break;
      }
      case "ArrayExpression": {
        this.emitter.emit(scope, OPCODE.NEWARRAY);
        this.ArrayExpression(node, scope);
        break;
      }
      case "MemberExpression": {
        if (!node.computed) {
          this.MemberExpression(node, scope);
        } else {
          this.IndexExpression(node, scope);
        }
        break;
      }
      case "CallExpression": {
        this.CallExpression(node, scope);
        break;
      }
      case "NewExpression": {
        this.NewExpression(node, scope);
        break;
      }
      case "UnaryExpression": {
        this.UnaryExpression(node, scope);
        break;
      }
      case "UpdateExpression": {
        this.UpdateExpression(node, scope);
        break;
      }
      case "BinaryExpression": {
        this.BinaryExpression(node, scope);
        break;
      }
      case "AssignmentExpression": {
        this.AssignmentExpression(node, scope);
        break;
      }
      case "SequenceExpression": {
        this.SequenceExpression(node, scope);
        break;
      }
      case "LogicalExpression": {
        this.LogicalExpression(node, scope);
        break;
      }
      case "ConditionalExpression": {
        this.ConditionalExpression(node, scope);
        break;
      }
      default:
        throw new Error("unknown expression");
    }
  }
}

module.exports = Compiler;
