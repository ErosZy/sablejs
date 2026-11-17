"use strict";

const chalk = require("chalk");
const FUTURE_WORDS = ["class", "const", "enum", "export", "extends", "import", "super"];
const STRICT_FUTURE_WORDS = [
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
];

const util = {
  isFunction(type) {
    return type == "FunctionDeclaration" || type == "FunctionExpression";
  },
  isLoop(type) {
    return (
      type == "DoWhileStatement" ||
      type == "WhileStatement" ||
      type == "ForStatement" ||
      type == "ForInStatement"
    );
  },
  isFutureWord(word, strict = false) {
    if (FUTURE_WORDS.indexOf(word) != -1) {
      throw new SyntaxError(`${word} is a future reserved word`);
    }

    if (strict && STRICT_FUTURE_WORDS.indexOf(word) != -1) {
      throw new SyntaxError(`${word} is a strict mode future reserved word`);
    }
  },
  addString(node, scope) {
    const { name } = node;
    // The string table stays an array (the HIR decoder indexes it), but a
    // parallel Map keeps dedup O(1) instead of a linear scan per entry.
    if (!scope.stMap) scope.stMap = new Map();
    const known = scope.stMap.get(name);
    if (known !== undefined) return known;
    const index = scope.st.push(name) - 1;
    scope.stMap.set(name, index);
    return index;
  },
  addLocal(node, scope, reuse = false) {
    const { name } = node;
    const { strict, vt } = scope;
    if (strict) {
      if (name == "arguments") {
        throw new SyntaxError(`redefining 'arguments' is not allowed in strict mode`);
      } else if (name == "eval") {
        throw new SyntaxError(`redefining 'eval' is not allowed in strict mode`);
      }
    } else if (name == "eval") {
      throw new SyntaxError(`invalid use of 'eval'`);
    }

    if (reuse || strict) {
      for (let i = 0; i < vt.length; i++) {
        if (vt[i] == name) {
          if (reuse) {
            return i + 1;
          } else if (strict) {
            throw new SyntaxError(`duplicate formal parameter '${name}'`);
          }
        }
      }
    }

    return vt.push(name);
  },
  findLocal(name, scope) {
    const { vt } = scope;
    for (let i = vt.length; i > 0; i--) {
      if (vt[i - 1] == name) {
        return i;
      }
    }
    return -1;
  },
  labelTo(inst, addr, scope) {
    scope.opcode[addr] = inst;
  },
  labelJumps(jumps, baddr, caddr, scope) {
    for (let i = 0; i < jumps.length; i++) {
      const { type, inst } = jumps[i];
      if (type == "BreakStatement") {
        util.labelTo(baddr, inst, scope);
      } else if (type == "ContinueStatement") {
        util.labelTo(caddr, inst, scope);
      }
    }
  },
  matchLabel(node, label) {
    while (node && node.type == "BlockStatement") {
      node = node.parent;
    }

    while (node && node.type == "LabeledStatement") {
      if (node.label.name == label) {
        return true;
      }
      node = node.parent;
    }
    return false;
  },
  breakTarget(node, label) {
    if (label != null) {
      let current = node;
      while (current != null && !util.isFunction(current.type)) {
        if (current.type == "LabeledStatement" && current.label.name == label) {
          let target = current._labelTarget || current.body;
          while (target.type == "LabeledStatement") target = target._labelTarget || target.body;
          return target;
        }
        current = current.parent;
      }
      return null;
    }
    while (node != null) {
      if (util.isFunction(node.type)) {
        break;
      } else if (util.isLoop(node.type) || node.type == "SwitchStatement") {
        return node;
      }
      node = node.parent;
    }
    return null;
  },
  continueTarget(node, label) {
    if (label != null) {
      let current = node;
      while (current != null && !util.isFunction(current.type)) {
        if (current.type == "LabeledStatement" && current.label.name == label) {
          let target = current._labelTarget || current.body;
          while (target.type == "LabeledStatement") target = target._labelTarget || target.body;
          return util.isLoop(target.type) ? target : null;
        }
        current = current.parent;
      }
      return null;
    }
    while (node != null) {
      if (util.isFunction(node.type)) {
        break;
      } else if (util.isLoop(node.type)) {
        return node;
      }
      node = node.parent;
    }
    return null;
  },
  returnTarget(node) {
    while (node) {
      if (util.isFunction(node.type)) {
        return node;
      }
      node = node.parent;
    }
    return null;
  },
  dynamicExpConcat(arg) {
    let str = "";
    let position = `error at (${arg.start}:${arg.end}).`;
    if (arg.type == "BinaryExpression") {
      let expression = arg;
      const temp = [];
      do {
        let values = [];
        const { left, right, operator } = expression;
        if (operator != "+") {
          console.log(
            chalk.yellow(
              `[WARN] operator ${operator} isn't allowed on eval/Function dynamic executing, ${position}`
            )
          );
          return -1;
        }

        if (left.type == "BinaryExpression") {
          expression = left;
          values.push(right);
        } else if (right.type == "BinaryExpression") {
          expression = right;
          values.push(left);
        } else {
          values.push(right, left);
          expression = null;
        }

        for (let value of values) {
          if (value.type == "Literal") {
            temp.push("" + value.value);
          } else if (arg.type == "Identifier" && arg.name == "undefined") {
            temp.push("undefined");
          } else {
            console.log(
              chalk.yellow(
                `[WARN] eval/Function only accept undefined/null/string/number, ${position}`
              )
            );
            return -1;
          }
        }
      } while (expression && expression.type == "BinaryExpression");
      str = temp.reverse().join("");
    } else if (arg.type == "Literal") {
      str = "" + arg.value;
    } else if (arg.type == "Identifier" && arg.name == "undefined") {
      str = "undefined";
    } else {
      console.log(
        chalk.yellow(`[WARN] eval/Function only accept undefined/null/string/number, ${position}`)
      );
      return -1;
    }
    return str;
  },
};

module.exports = util;
