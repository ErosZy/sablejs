"use strict";
// Minimal stand-in for a compiled artifact's module shape (what generated
// code exports). Real artifacts come from compile(); this only exercises
// the CompiledProgram type.
module.exports = {
  abiVersion: "2.0.0-aot.5",
  security: "sandbox",
  createInstance() {
    return {
      security: "sandbox",
      disposed: false,
      profileBoundary: false,
      global: {},
      run() {
        return { total: 120 };
      },
      dispose() {
        this.disposed = true;
      },
      boundaryStats() {
        return null;
      },
    };
  },
};
