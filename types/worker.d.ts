/**
 * sablejs worker isolation module (`sablejs/worker`).
 *
 * A Worker is a separately terminable execution agent: the host enforces a
 * wall-clock timeout per request and can terminate the worker to stop an
 * infinite loop. See docs/worker-isolation.md for the full contract.
 *
 * The two sides speak a plain-data protocol:
 *   host -> worker: { id, input, program? }   (`program` absent = bound run)
 *   worker -> host: { id, ok, value? | error? }
 */

import type { CompiledProgram } from "./runtime";

/**
 * A Worker the client can talk to. Both the browser `Worker` and Node's
 * `worker_threads.Worker` satisfy this structurally. Note the event shape is
 * the browser's: "message" listeners receive `{ data }`. Node's
 * worker_threads delivers bare values and has no `addEventListener`, so an
 * adapter must bind `on("message")`/`on("error")` and normalize events
 * (`listener({ data: value })`) — see examples/worker/host.cjs.
 */
export interface SandboxWorker {
  addEventListener(type: "message" | "error", listener: (event: any) => void): void;
  postMessage(message: unknown): void;
  terminate(): void;
}

/** Options for {@link createSandboxClient}. */
export interface SandboxClientOptions {
  /**
   * Default per-call wall-clock timeout in milliseconds (positive number).
   * A timeout terminates the worker. Default 1000.
   */
  timeoutMs?: number;
}

/** Per-call override of the client's default timeout. */
export interface SandboxCallOptions {
  timeoutMs?: number;
}

/**
 * Async host handle to one worker. All calls are message round-trips and
 * return promises; each message runs a fresh instance that is disposed
 * afterwards, so one worker serves many serialized requests.
 */
export interface SandboxClient {
  /**
   * Runs the bound program with copied `input` data (structured-cloneable
   * plain data, the same shape `RuntimeInstanceOptions.globals` accepts).
   */
  run(input?: unknown, perCallOptions?: SandboxCallOptions): Promise<any>;
  /**
   * Loads and runs one compiled artifact (the `code` string from
   * `compile()`) with copied `input`. The artifact is loaded at worker
   * privilege — never pass un-compiled user source here. The worker
   * survives repeated run/evaluate calls.
   */
  evaluate(program: string, input?: unknown, perCallOptions?: SandboxCallOptions): Promise<any>;
  /** Terminates the worker and rejects all in-flight requests. */
  terminate(): void;
}

/** Module specifier the worker-side helpers import the runtime from. */
export const WORKER_MODULE: "sablejs/worker";

/**
 * Creates the host side of a sandboxed worker. Rejects requests that time
 * out (terminating the worker), validates every response, and rejects on
 * worker errors.
 */
export function createSandboxClient(
  worker: SandboxWorker,
  options?: SandboxClientOptions
): SandboxClient;

/** Worker-side options for {@link handleSandboxMessages}. */
export interface SandboxWorkerHandlerOptions {
  /** Message sink; defaults to `self.postMessage`. */
  postMessage?: (message: any) => void;
  /** Message source; defaults to `self` (the worker global scope). */
  scope?: { onmessage: ((event: any) => void) | null };
  /**
   * Artifact loader; defaults to {@link loadCompiledArtifact} (Node).
   * Browser builds bundle the runtime into the worker script instead and
   * pass a loader that resolves the bundled runtime.
   */
  loadProgram?: (code: string) => CompiledProgram;
}

/**
 * Installs the worker side of the protocol: receives `{ id, input,
 * program? }` messages, runs each on a fresh instance, and posts validated
 * responses. Requests are serialized (one at a time). `evaluate` messages
 * load the artifact code through `loadProgram` and cache it.
 */
export function handleSandboxMessages(
  program: CompiledProgram,
  options?: SandboxWorkerHandlerOptions
): void;

/**
 * Default artifact loader (Node). The generated code is AOT-compiled output
 * with no evaluator, and the only module it imports is the sablejs runtime.
 * Throws if the artifact imports anything else.
 */
export function loadCompiledArtifact(code: string): CompiledProgram;

/**
 * Validates one worker response message. Returns null when the message is
 * well-formed, else a human-readable problem string.
 */
export function validateResponse(message: any): string | null;
