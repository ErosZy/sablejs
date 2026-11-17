/**
 * sablejs runtime module (`sablejs/runtime`).
 *
 * Generated artifacts require this module at runtime (`require("sablejs/runtime")`),
 * so it is the only production dependency a compiled program carries. Hosts
 * normally reach it through the main entry (`require("sablejs").runtime`) or
 * through the compiled artifact itself; the functions below marked "ABI
 * internal" are called by generated code and are not part of the stable
 * host-facing contract.
 */

/**
 * AOT ABI version shared by the compiler and the runtime. Generated artifacts
 * carry it in their metadata and `createProgram` rejects artifacts compiled
 * against a different ABI.
 */
export const ABI_VERSION: string;

/**
 * Opaque token returned by {@link capability}. Host functions placed in
 * `globals` become capabilities automatically; `capability()` produces an
 * explicit token so you can control the wrapper's name and receiver.
 */
export interface CapabilityToken {
  /** Brand that makes this type opaque to callers. */
  readonly [capabilityTokenBrand]: unique symbol;
}
declare const capabilityTokenBrand: unique symbol;

/** Options controlling an explicit capability wrapper. */
export interface CapabilityOptions {
  /**
   * Wrapper name shown to guest code (function name / property path /
   * "capability" are the automatic fallbacks).
   */
  name?: string;
  /** Receiver the wrapped function is called with. */
  thisValue?: unknown;
}

/**
 * Wraps a host function as an explicit capability. Works in both security
 * modes: sandbox mode mediates the call (arguments/results copied, thrown
 * errors sanitized, wrapper revoked at dispose); trusted mode unwraps the
 * token back to the raw function. Bare functions are called with no receiver.
 */
export function capability(
  callable: (...args: any[]) => any,
  options?: CapabilityOptions
): CapabilityToken;

/**
 * Options for {@link RuntimeInstance} — supplied to the compiled artifact's
 * `createInstance()`.
 */
export interface RuntimeInstanceOptions {
  /**
   * Host data injected as guest globals. Plain data is deep-copied in
   * sandbox mode so guest mutations never reach the host graph; any host
   * function found anywhere in `globals` becomes a capability. In trusted
   * mode the value is passed through by reference.
   */
  globals?: Record<string, any>;
  /**
   * Must match the mode the program was compiled with. Omitted defaults to
   * the compiled mode; a mismatch throws.
   */
  security?: SecurityMode;
  /** Count sandbox boundary events (calls, capability invocations). */
  profileBoundary?: boolean;
}

/**
 * A single-run execution of a compiled program. Create one per run via
 * `CompiledProgram.createInstance(options)`, call {@link run}, then
 * {@link dispose}. Instances are single-run by contract.
 */
export class RuntimeInstance {
  constructor(
    execute: (instance: RuntimeInstance, frame: unknown) => any,
    metadata: Record<string, any>,
    scopeTable: Record<string, unknown>,
    options?: RuntimeInstanceOptions,
    programOptions?: { security?: SecurityMode }
  );

  /** Security mode the program was compiled with. */
  readonly security: SecurityMode;
  /** True after {@link dispose}. */
  readonly disposed: boolean;
  /** Whether boundary profiling is enabled on this instance. */
  readonly profileBoundary: boolean;
  /** The host-visible globals object (injected data plus host-added state). */
  readonly global: Record<string, any>;

  /**
   * Runs the program synchronously and returns the value of its final
   * expression. Throws for any guest error. When the program ends in an
   * async capability call, the returned value is the host Promise (which
   * hosts should `await` — generated programs are otherwise synchronous).
   */
  run(): any;
  /**
   * Releases the instance. Revokes all sandbox capability wrappers and
   * clears execution state. Subsequent {@link run} calls throw. Safe to call
   * multiple times and in `finally` blocks.
   */
  dispose(): void;
  /** Sandbox boundary counters when `profileBoundary` is enabled. */
  boundaryStats(): any;
}

/** Security mode a program was compiled with. */
export type SecurityMode = "sandbox" | "trusted";

/**
 * The module shape a compiled artifact exports. Generated code is a
 * dependency-free CommonJS module whose only import is the sablejs runtime:
 *
 * ```js
 * const program = require("./program.cjs");
 * const instance = program.createInstance({ globals: { input } });
 * const result = instance.run();
 * instance.dispose();
 * ```
 */
export interface CompiledProgram {
  /** AOT ABI version (must match the runtime's `ABI_VERSION`). */
  readonly abiVersion: string;
  /** Security mode the program was compiled with. */
  readonly security: SecurityMode;
  /** Creates a fresh single-run instance with the given host options. */
  createInstance(options?: RuntimeInstanceOptions): RuntimeInstance;
}

/** Runtime metadata recorded on every generated program. */
export interface ProgramMetadata {
  abiVersion: string;
  security: SecurityMode;
}

/**
 * Binds generated code to this runtime. The compiled artifact calls this
 * once at module scope; hosts use it only when loading artifacts manually.
 * Throws when `compilerAbi` does not match the runtime's `ABI_VERSION`.
 */
export function createProgram(
  execute: (instance: RuntimeInstance, frame: unknown) => any,
  metadata: ProgramMetadata,
  compilerAbi?: string,
  scopeTable?: Record<string, unknown>,
  programOptions?: { security?: SecurityMode }
): CompiledProgram;

// ---------------------------------------------------------------------------
// ABI-internal helpers. Generated code imports these directly; hosts and
// bundlers should treat their signatures as implementation details.
// ---------------------------------------------------------------------------

/** @internal */
export function applyValue(...args: any[]): any;
/** @internal */
export function applySandboxValue(...args: any[]): any;
/** @internal */
export function applySandboxValue0(...args: any[]): any;
/** @internal */
export function applySandboxValue1(...args: any[]): any;
/** @internal */
export function applySandboxValue2(...args: any[]): any;
/** @internal */
export function applySandboxValue3(...args: any[]): any;
/** @internal */
export function applySandboxValue4(...args: any[]): any;
/** @internal */
export function applySandboxValue5(...args: any[]): any;
/** @internal */
export function constructValue(...args: any[]): any;
/** @internal */
export function constructSandboxValue(...args: any[]): any;
/** @internal */
export function constructSandboxValue0(...args: any[]): any;
/** @internal */
export function constructSandboxValue1(...args: any[]): any;
/** @internal */
export function constructSandboxValue2(...args: any[]): any;
/** @internal */
export function constructSandboxValue3(...args: any[]): any;
/** @internal */
export function constructSandboxValue4(...args: any[]): any;
/** @internal */
export function constructSandboxValue5(...args: any[]): any;
/** @internal */
export function deleteGlobalVariableValue(...args: any[]): any;
/** @internal */
export function deleteVariableValue(...args: any[]): any;
/** @internal */
export function getArgumentsValue(...args: any[]): any;
/** @internal */
export function getSandboxPropertyValue(...args: any[]): any;
/** @internal */
export function hostCallIntrinsic0(...args: any[]): any;
/** @internal */
export function hostCallIntrinsic1(...args: any[]): any;
/** @internal */
export function hostCallIntrinsic2(...args: any[]): any;
/** @internal */
export function hostCallIntrinsic3(...args: any[]): any;
/** @internal */
export function hostCallIntrinsic4(...args: any[]): any;
/** @internal */
export function hostCallIntrinsic5(...args: any[]): any;
/** @internal */
export function initializeCompiledFunction(...args: any[]): any;
/** @internal */
export function instanceOfTarget(...args: any[]): any;
/** @internal */
export function invokeCompiledFunction(...args: any[]): any;
/** @internal */
export function isPrototypeSetterUnsafe(...args: any[]): boolean;
/** @internal */
export function readGlobalVariableValue(...args: any[]): any;
/** @internal */
export function readVariableValue(...args: any[]): any;
/** @internal */
export function setArgumentsValue(...args: any[]): any;
/** @internal */
export function setGuestPropertyValue(...args: any[]): any;
/** @internal */
export function setSandboxPropertyValue(...args: any[]): any;
/** @internal */
export function writeGlobalVariableValue(...args: any[]): any;
/** @internal */
export function writePropertyValue(...args: any[]): any;
/** @internal */
export function writeSloppyPropertyValue(...args: any[]): any;
/** @internal */
export function writeStrictPropertyValue(...args: any[]): any;
/** @internal */
export function writeVariableValue(...args: any[]): any;
/** @internal */
export const arrayPrototypeIndexOf: typeof Array.prototype.indexOf;
/** @internal */
export const arrayPrototypeJoin: typeof Array.prototype.join;
/** @internal */
export const arrayPrototypePush: typeof Array.prototype.push;
/** @internal */
export const arrayPrototypeSlice: typeof Array.prototype.slice;
/** @internal */
export const arrayPrototypeSort: typeof Array.prototype.sort;
/** @internal */
export const regexpPrototypeTest: typeof RegExp.prototype.test;
/** @internal */
export const stringPrototypeCharAt: typeof String.prototype.charAt;
/** @internal */
export const stringPrototypeIndexOf: typeof String.prototype.indexOf;
/** @internal */
export const stringPrototypeReplace: typeof String.prototype.replace;
/** @internal */
export const stringPrototypeSlice: typeof String.prototype.slice;
