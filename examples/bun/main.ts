// Bun consumer: Bun runs TypeScript natively and resolves the package
// through its Node-compatible module resolution (same exports map as Node).
//
//   bun examples/bun/main.ts
//
// This example compiles in-process (fine for prototyping). For production,
// precompile at build time (see ../precompile) and require the artifact —
// the compiler is the expensive part.

import { compile } from "sablejs";

// 1. Compile the guest program.
const { code, metadata } = compile(
  "function total(input) { var line = 0; for (var i = 0; i < input.length; i++) { line += input[i]; } return line; } total(input);",
  { optimization: "O1", security: "sandbox" }
);
console.log("compiled:", metadata.optimize, "·", metadata.security, "·", code.length, "bytes");

// 2. Load the artifact from its code string (only imports the runtime).
const module_ = { exports: {} as any };
new Function("require", "module", "exports", code)(
  (specifier: string) => {
    if (specifier === "sablejs/runtime" || specifier === "sablejs")
      return require("sablejs/runtime");
    throw new Error(`unexpected module ${specifier}`);
  },
  module_,
  module_.exports
);
const program = module_.exports as {
  createInstance(opts: { globals: any }): { run(): any; dispose(): void };
};

// 3. Run it.
const instance = program.createInstance({ globals: { input: [1, 2, 3, 4, 5] } });
try {
  console.log("bun guest returned:", instance.run());
} finally {
  instance.dispose();
}
