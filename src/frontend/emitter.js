"use strict";

const { isFutureWord, findLocal, addString } = require("./util");
const OPCODE = require("./opcode");

class Emitter {
  emit(scope, value) {
    scope.opcode.push(value);
  }

  emitString(scope, opcode, value) {
    this.emit(scope, opcode);
    this.emit(scope, addString(value, scope));
  }

  emitNumber(scope, value) {
    this.emit(scope, OPCODE.NUMBER);

    value = value.value;
    if (isNaN(value)) {
      value = "NaN";
    } else if (!isFinite(value)) {
      value = value > 0 ? "+Infinity" : "-Infinity";
    }

    // The number table stays an array (the HIR decoder indexes it), but a
    // parallel Map keeps dedup O(1) instead of a linear scan per entry.
    if (!scope.ntMap) scope.ntMap = new Map();
    const known = scope.ntMap.get(value);
    if (known !== undefined) {
      this.emit(scope, known);
      return;
    }
    const index = scope.nt.push(value) - 1;
    scope.ntMap.set(value, index);
    this.emit(scope, index);
  }

  emitLocal(scope, opLoc, opVar, node) {
    this.validateLocalName(scope, node, opLoc);

    const index = findLocal(node.name, scope);
    if (index < 0) {
      this.emitString(scope, opVar, node);
    } else {
      this.emit(scope, opLoc);
      this.emit(scope, index);
    }
  }

  // Identifier stores in a scope that contains a with/catch/eval must resolve
  // the reference base BEFORE the right-hand side evaluates (ES5 8.7.2: the
  // Reference is created when the left-hand side evaluates, and PutValue uses
  // it even if the binding disappears in between). Emits REFVAR to capture
  // the base and PUTVAR to write through it.
  emitLocalRef(scope, opcode, node) {
    // PUTVAR is a store: validate it with the write opcode so strict-mode
    // read-only checks on 'arguments'/'eval' still apply.
    this.validateLocalName(scope, node, opcode == OPCODE.PUTVAR ? OPCODE.SETLOCAL : opcode);
    this.emitString(scope, opcode, node);
  }

  validateLocalName(scope, node, opLoc) {
    const isArguments = node.name == "arguments";
    const isEval = node.name == "eval";

    if (isArguments) {
      const { ps } = scope;
      if (ps.indexOf("arguments") == -1) {
        scope.lightweight = false;
        scope.arguments = true;
      }
    }

    isFutureWord(node, scope.strict);
    if (scope.strict && opLoc == OPCODE.SETLOCAL) {
      if (isArguments) {
        throw new SyntaxError(`'arguments' is read-only in strict mode`);
      } else if (isEval) {
        throw new SyntaxError(`'eval' is read-only in strict mode`);
      }
    }

    if (isEval) {
      throw new Error(`invalid use of 'eval'`);
    }
  }

  emitFunction(scope, node) {
    scope.lightweight = false;
    this.emit(scope, OPCODE.CLOSURE);
    this.emit(scope, scope.ft.push(node) - 1);
  }

  emitJump(scope, cond) {
    this.emit(scope, cond);
    const inst = scope.opcode.length;
    this.emit(scope, 0);
    return inst;
  }

  emitJumpTo(scope, cond, inst) {
    this.emit(scope, cond);
    this.emit(scope, inst);
  }
}

module.exports = Emitter;
