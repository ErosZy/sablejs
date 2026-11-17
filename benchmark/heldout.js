"use strict";

// The executable held-out gate is intentionally fail-closed until the frozen
// corpus is populated. It prevents a release workflow from treating an empty
// selection as a successful benchmark run.
const { validateManifest } = require("./check");

function main() {
  const result = validateManifest(true);
  if (result.errors.length) {
    result.errors.forEach((error) => console.error(`[heldout] ${error}`));
    process.exitCode = 1;
    return;
  }
  throw new Error(
    "Held-out manifest is populated but no runner contract is configured; " +
      "add inputPath/expected fields and the lifecycle-symmetric runner before enabling O2"
  );
}

if (require.main === module) main();
