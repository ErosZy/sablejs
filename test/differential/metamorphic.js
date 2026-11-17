"use strict";

const assert = require("assert");
const { describe, it } = require("node:test");
const { runNative, runSableJS, same } = require("./fuzz");

const levels = ["O0", "O1", "O2", "Os"];
const securities = ["trusted", "sandbox"];
const pairs = [
  ["dot-bracket", "var o={x:4};o.x+o.x;", 'var o={x:4};o["x"]+o["x"];'],
  [
    "harmless-alias",
    "function f(){var x=7;return x+x;}f();",
    "function f(){var x=7,y=x;return y+x;}f();",
  ],
  [
    "no-op-branch",
    "function f(x){return x+1;}f(4);",
    "function f(x){if(false){x=99;}return x+1;}f(4);",
  ],
  [
    "independent-declarations",
    "function f(){var x=2;var y=5;return x*y;}f();",
    "function f(){var y=5;var x=2;return x*y;}f();",
  ],
  ["loop-spelling", "var i=0,s=0;while(i<4){s+=i;i++;}s;", "var i=0,s=0;for(;i<4;i++){s+=i;}s;"],
  [
    "literal-runtime-alias",
    "function f(x){return x.a+x.b;}f({a:2,b:3});",
    "function f(x){return x.a+x.b;}var input={a:2,b:3};f(input);",
  ],
];

describe("optimizer metamorphic pairs", function () {
  pairs.forEach(([name, left, right]) =>
    it(name, function () {
      const leftNative = runNative(left);
      const rightNative = runNative(right);
      assert(same(leftNative, rightNative), `${name}: native variants disagree`);
      levels.forEach((optimization) =>
        securities.forEach((security) => {
          const leftResult = runSableJS(left, optimization, security);
          const rightResult = runSableJS(right, optimization, security);
          assert(same(leftNative, leftResult), `${name}/left/${optimization}/${security}`);
          assert(same(rightNative, rightResult), `${name}/right/${optimization}/${security}`);
          assert(same(leftResult, rightResult), `${name}/pair/${optimization}/${security}`);
        })
      );
    })
  );
});
