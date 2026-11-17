"use strict";

const DYNAMIC_LOCAL_OPERATIONS = new Set(["WITH", "ENDWITH", "EVAL", "CATCH", "ENDCATCH"]);

const PROTECTED_REGION_KINDS = new Set(["TryCatch", "TryFinally"]);
const WITH_EVAL_OPERATIONS = new Set(["WITH", "ENDWITH", "EVAL"]);

// With/eval/catch environments shadow name resolution at runtime. The parent
// chain matters because a nested closure can observe an ancestor environment.
function hasDynamicChain(scope, scopesById, memo = new Map()) {
  if (memo.has(scope.id)) return memo.get(scope.id);
  const parent = scope.parentId != null ? scopesById.get(scope.parentId) : null;
  const dynamic =
    scope.instructions.some((instruction) => DYNAMIC_LOCAL_OPERATIONS.has(instruction.op)) ||
    (parent != null && hasDynamicChain(parent, scopesById, memo));
  memo.set(scope.id, dynamic);
  return dynamic;
}

function hasWithEvalChain(scope, scopesById, memo = new Map()) {
  if (memo.has(scope.id)) return memo.get(scope.id);
  const parent = scope.parentId != null ? scopesById.get(scope.parentId) : null;
  const dynamic =
    scope.instructions.some((instruction) => WITH_EVAL_OPERATIONS.has(instruction.op)) ||
    (parent != null && hasWithEvalChain(parent, scopesById, memo));
  memo.set(scope.id, dynamic);
  return dynamic;
}

// The current MIR CFG does not model all exceptional and abrupt completion
// edges. Consumers that move facts across blocks must conservatively gate on
// these regions until they explicitly opt into a completion-aware CFG.
function hasProtectedControlFlow(scope) {
  return (
    (scope.controlRegions || []).some((region) => PROTECTED_REGION_KINDS.has(region.kind)) ||
    (scope.syntheticRanges || []).some((range) => range.kind === "AbruptFinally") ||
    scope.instructions.some(
      (instruction) =>
        instruction.op === "TRY" ||
        instruction.op === "ENDTRY" ||
        instruction.op === "CATCH" ||
        instruction.op === "ENDCATCH"
    )
  );
}

module.exports = { hasDynamicChain, hasProtectedControlFlow, hasWithEvalChain };
