"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { describe, it } = require("node:test");
const { runNative, runSableJS, same } = require("./fuzz");

const directory = path.resolve(__dirname, "corpus");
const levels = ["O0", "O1", "O2", "Os"];
const securities = ["trusted", "sandbox"];

describe("saved optimizer differential corpus", function () {
  fs.readdirSync(directory)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .forEach((name) => {
      it(name, function () {
        const source = fs.readFileSync(path.join(directory, name), "utf8");
        const native = runNative(source);
        levels.forEach((optimization) =>
          securities.forEach((security) => {
            const actual = runSableJS(source, optimization, security);
            assert(
              same(native, actual),
              `${name}/${optimization}/${security}: ${JSON.stringify({ native, actual })}`
            );
          })
        );
      });
    });
});
