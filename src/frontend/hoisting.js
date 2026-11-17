const { isFutureWord, addLocal } = require("./util");
const Scope = require("./scope");
const OPCODE = require("./opcode");

function StatementList(compiler, node, scope) {
  const body = [].concat(node.body || node.consequent);
  for (let i = 0; i < body.length; i++) {
    Statement(compiler, body[i], scope);
  }
}

function Statement(compiler, node, scope) {
  switch (node.type) {
    case "EmptyStatement": {
      break;
    }
    case "BlockStatement": {
      StatementList(compiler, node, scope);
      break;
    }
    case "VariableDeclaration": {
      VariableDeclaration(compiler, node, scope);
      break;
    }
    case "IfStatement": {
      IfStatement(compiler, node, scope);
      break;
    }
    case "DoWhileStatement": {
      DoWhileStatement(compiler, node, scope);
      break;
    }
    case "WhileStatement": {
      WhileStatement(compiler, node, scope);
      break;
    }
    case "ForStatement": {
      ForStatement(compiler, node, scope);
      break;
    }
    case "ForInStatement": {
      ForInStatement(compiler, node, scope);
      break;
    }
    case "SwitchStatement": {
      SwitchStatement(compiler, node, scope);
      break;
    }
    case "LabeledStatement": {
      LabeledStatement(compiler, node, scope);
      break;
    }
    case "BreakStatement": {
      BreakStatement(compiler, node, scope);
      break;
    }
    case "ContinueStatement": {
      ContinueStatement(compiler, node, scope);
      break;
    }
    case "ReturnStatement": {
      ReturnStatement(compiler, node, scope);
      break;
    }
    case "ThrowStatement": {
      ThrowStatement(compiler, node, scope);
      break;
    }
    case "WithStatement": {
      WithStatement(compiler, node, scope);
      break;
    }
    case "TryStatement": {
      TryStatement(compiler, node, scope);
      break;
    }
    case "ExpressionStatement": {
      Expression(compiler, node, scope);
      break;
    }
    case "FunctionDeclaration": {
      FunctionDeclaration(compiler, node, scope);
      break;
    }
  }
}

function VariableDeclaration(compiler, node, scope) {
  const { declarations } = node;
  for (let i = 0; i < declarations.length; i++) {
    const { id } = declarations[i];
    const isArguments = !scope.strict && id.name == "arguments";
    if (isArguments) {
      continue;
    }

    isFutureWord(id.name, scope.strict);
    addLocal(id, scope, true);
  }
}

function IfStatement(compiler, node, scope) {
  const { consequent, alternate } = node;
  Statement(compiler, consequent, scope);
  if (alternate) {
    Statement(compiler, alternate, scope);
  }
}

function DoWhileStatement(compiler, node, scope) {
  const { body } = node;
  Statement(compiler, body, scope);
}

function WhileStatement(compiler, node, scope) {
  const { body } = node;
  Statement(compiler, body, scope);
}

function ForStatement(compiler, node, scope) {
  const { init, body } = node;
  if (init && init.type == "VariableDeclaration") {
    VariableDeclaration(compiler, init, scope);
  }
  Statement(compiler, body, scope);
}

function ForInStatement(compiler, node, scope) {
  const { left, body } = node;
  if (left.type == "VariableDeclaration") {
    VariableDeclaration(compiler, left, scope);
  }
  Statement(compiler, body, scope);
}

function SwitchStatement(compiler, node, scope) {
  const { cases } = node;
  for (let i = 0; i < cases.length; i++) {
    StatementList(compiler, cases[i], scope);
  }
}

function LabeledStatement(compiler, node, scope) {
  let { body } = node;
  if (body.type != "BlockStatement") {
    body = { type: "BlockStatement", body: [body] };
  }
  Statement(compiler, body, scope);
}

function BreakStatement(compiler, node, scope) {
  // nothing to do...
}

function ContinueStatement(compiler, node, scope) {
  // nothing to do...
}

function ReturnStatement(compiler, node, scope) {
  // nothing to do...
}

function ThrowStatement(compiler, node, scope) {
  // nothing to do...
}

function WithStatement(compiler, node, scope) {
  const { body } = node;
  Statement(compiler, body, scope);
}

function TryStatement(compiler, node, scope) {
  const { block, handler, finalizer } = node;
  Statement(compiler, block, scope);
  if (handler) {
    Statement(compiler, handler.body, scope);
  }
  if (finalizer) {
    Statement(compiler, finalizer, scope);
  }
}

function Expression(compiler, node, scope) {
  // nothing to do...
}

function FunctionDeclaration(compiler, node, scope) {
  const funcScope = new Scope();
  funcScope.strict = scope.strict;
  compiler.FunctionDeclaration(node, funcScope);
  compiler.emitter.emitFunction(scope, funcScope);
  compiler.emitter.emit(scope, OPCODE.SETLOCAL);
  compiler.emitter.emit(scope, addLocal(node.id, scope, true));
  compiler.emitter.emit(scope, OPCODE.POP);
}

module.exports = (compiler, node, scope) => {
  StatementList(compiler, { body: node }, scope);
};
