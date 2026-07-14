/**
 * Codex-compatible Code Mode backed by Mux's existing QuickJS sandbox.
 *
 * A workspace owns the durable session and shared store; each cell owns one
 * runtime only until execution settles. Buffered terminal results never retain
 * the disposed runtime, which is the lifecycle boundary that prevents long
 * tool-heavy conversations from accumulating QuickJS/WASM memory.
 */

import { openai } from "@ai-sdk/openai";
import { tool, type Tool } from "ai";
import { z } from "zod";

import type { ToolBridge } from "@/node/services/ptc/toolBridge";
import type { IJSRuntime, IJSRuntimeFactory } from "@/node/services/ptc/runtime";
import type { PTCEvent } from "@/node/services/ptc/types";
import { getCachedCodeModeTypes } from "@/node/services/ptc/typeGenerator";
import type { PTCEventWithParent } from "./code_execution";

const DEFAULT_YIELD_MS = 10_000;
const DEFAULT_MAX_TOKENS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

interface ExecPragma {
  yield_time_ms?: number;
  max_output_tokens?: number;
}

type TerminalCellStatus = "completed" | "failed" | "terminated";
type CellStatus = "running" | "terminating" | TerminalCellStatus;

interface CodeCell {
  id: string;
  runtime?: IJSRuntime;
  promise: Promise<void>;
  result?: unknown;
  error?: string;
  output: unknown[];
  outputCursor: number;
  status: CellStatus;
  storeSnapshot: Map<string, unknown>;
  storeWrites: Map<string, unknown>;
  observing: boolean;
  yieldRequested: boolean;
  yieldObserver?: () => void;
  closeOnSettle: boolean;
}

export interface CodeModeResult {
  cell_id: string;
  status: TerminalCellStatus | "yielded";
  output?: string;
  result?: unknown;
  error?: string;
}

interface ParsedExecSource extends ExecPragma {
  code: string;
}

function parseExecSource(source: string): ParsedExecSource {
  if (!source.trim()) {
    throw new Error(
      'exec expects raw JavaScript source text (non-empty). Provide JS only, optionally with first-line `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}`.'
    );
  }

  const lines = source.split(/\r?\n/, 2);
  const firstLine = lines[0] ?? "";
  const match = /^\s*\/\/ @exec:\s*(.*)$/.exec(firstLine);
  if (!match) return { code: source };

  const newlineIndex = source.indexOf("\n");
  const code = newlineIndex === -1 ? "" : source.slice(newlineIndex + 1);
  if (!code.trim()) {
    throw new Error("exec pragma must be followed by JavaScript source on subsequent lines");
  }

  const directive = match[1]?.trim();
  if (!directive) {
    throw new Error(
      "exec pragma must be a JSON object with supported fields `yield_time_ms` and `max_output_tokens`"
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(directive);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `exec pragma must be valid JSON with supported fields \`yield_time_ms\` and \`max_output_tokens\`: ${message}`
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      "exec pragma must be a JSON object with supported fields `yield_time_ms` and `max_output_tokens`"
    );
  }

  const pragma = value as Record<string, unknown>;
  for (const key of Object.keys(pragma)) {
    if (key !== "yield_time_ms" && key !== "max_output_tokens") {
      throw new Error(
        `exec pragma only supports \`yield_time_ms\` and \`max_output_tokens\`; got \`${key}\``
      );
    }
  }

  const parseInteger = (key: keyof ExecPragma): number | undefined => {
    const candidate = pragma[key];
    if (candidate === undefined) return undefined;
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate < 0 ||
      candidate > MAX_SAFE_INTEGER
    ) {
      throw new Error(`exec pragma field \`${key}\` must be a non-negative safe integer`);
    }
    return candidate;
  };

  return {
    code,
    yield_time_ms: parseInteger("yield_time_ms"),
    max_output_tokens: parseInteger("max_output_tokens"),
  };
}

function cloneStoredValue(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    throw new Error("store value must be serializable");
  }
}

function cloneStore(store: Map<string, unknown>): Map<string, unknown> {
  return new Map(Array.from(store, ([key, value]) => [key, cloneStoredValue(value)]));
}

function getAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Wait observation aborted", "AbortError");
}

function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

class CodeModeSession {
  private readonly cells = new Map<string, CodeCell>();
  private readonly store = new Map<string, unknown>();
  private readonly pendingAdmissions = new Set<Promise<void>>();
  private nextCellId = 1;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly runtimeFactory: IJSRuntimeFactory) {}

  async exec(
    source: string,
    bridge: ToolBridge,
    toolCallId: string,
    abortSignal: AbortSignal | undefined,
    emitNestedEvent?: (event: PTCEventWithParent) => void
  ): Promise<CodeModeResult> {
    if (this.shuttingDown) throw new Error("code mode session is shutting down");
    const parsed = parseExecSource(source);
    const releaseAdmission = this.beginAdmission();
    const yieldMs = parsed.yield_time_ms ?? DEFAULT_YIELD_MS;
    const maxTokens = parsed.max_output_tokens ?? DEFAULT_MAX_TOKENS;
    try {
      const cellId = this.allocateCellId();
      const storeSnapshot = cloneStore(this.store);
      const runtime = await this.runtimeFactory.create();
      // Runtime creation may yield while shutdown starts. Re-check admission before
      // registering the cell so shutdown cannot miss a late arrival.
      if (this.shuttingDown) {
        runtime.dispose();
        throw new Error("code mode session is shutting down");
      }
      const cell: CodeCell = {
        id: cellId,
        runtime,
        promise: Promise.resolve(),
        output: [],
        outputCursor: 0,
        status: "running",
        storeSnapshot,
        storeWrites: new Map(),
        observing: false,
        yieldRequested: false,
        closeOnSettle: false,
      };
      try {
        runtime.setLimits({ timeoutMs: 60 * 60 * 1000 });
        // Codex emits `await tools.*` and concurrent Promise combinators. Real guest
        // promises avoid Asyncify's single-suspension limit while preserving legacy
        // synchronous `mux.*` behavior for code_execution.
        bridge.register(runtime, "tools", true);
        runtime.registerValue?.("ALL_TOOLS", bridge.getBridgeableToolNames());
        this.registerHelpers(runtime, cell);
        this.registerNestedEvents(runtime, toolCallId, emitNestedEvent);
      } catch (error) {
        runtime.dispose();
        throw error;
      }

      this.cells.set(cell.id, cell);
      const abort = () => {
        cell.closeOnSettle = true;
        this.beginTermination(cell);
      };
      cell.promise = this.runCell(cell, parsed.code, abortSignal, abort);
      if (abortSignal?.aborted) abort();
      else abortSignal?.addEventListener("abort", abort, { once: true });

      return this.observe(cell, yieldMs, maxTokens);
    } finally {
      releaseAdmission();
    }
  }

  async wait(
    cellId: string,
    yieldMs: number,
    maxTokens: number,
    terminate: boolean,
    abortSignal?: AbortSignal
  ): Promise<CodeModeResult> {
    const cell = this.cells.get(cellId);
    if (!cell) return this.missingCell(cellId);

    if (terminate) {
      if (cell.status === "terminating") {
        throw new Error(`exec cell ${cell.id} is already terminating`);
      }
      if (cell.status === "running") {
        this.beginTermination(cell);
        await cell.promise;
      }
      return this.deliver(cell, maxTokens);
    }

    return this.observe(cell, yieldMs, maxTokens, abortSignal);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      // Join cells that passed the admission check but are still creating their runtime.
      await Promise.all(Array.from(this.pendingAdmissions));
      const cells = Array.from(this.cells.values());
      for (const cell of cells) {
        cell.closeOnSettle = true;
        if (cell.status === "running") this.beginTermination(cell);
        else if (this.isTerminal(cell.status)) this.closeCell(cell);
      }
      await Promise.all(cells.map((cell) => cell.promise));
      for (const cell of cells) this.closeCell(cell);
      this.store.clear();
    })();
    return this.shutdownPromise;
  }

  private allocateCellId(): string {
    const id = this.nextCellId;
    if (!Number.isSafeInteger(id)) throw new Error("code mode cell ID space exhausted");
    this.nextCellId += 1;
    return String(id);
  }

  private beginAdmission(): () => void {
    let resolveAdmission!: () => void;
    const admission = new Promise<void>((resolve) => {
      resolveAdmission = resolve;
    });
    this.pendingAdmissions.add(admission);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingAdmissions.delete(admission);
      resolveAdmission();
    };
  }

  private registerHelpers(runtime: IJSRuntime, cell: CodeCell): void {
    const registerHelper = (name: string, fn: (...args: unknown[]) => unknown) => {
      if (runtime.registerSyncFunction) {
        runtime.registerSyncFunction(name, fn);
      } else {
        runtime.registerFunction(name, (...args) => Promise.resolve(fn(...args)));
      }
    };
    // These helpers are cell-local. Store writes are committed only after natural completion.
    registerHelper("text", (value) => {
      cell.output.push(value);
    });
    registerHelper("image", (value) => {
      cell.output.push({ type: "image", value });
    });
    registerHelper("generatedImage", (value) => {
      cell.output.push({ type: "generated_image", value });
    });
    registerHelper("notify", (value) => {
      cell.output.push({ type: "notification", value });
    });
    registerHelper("store", (key, value) => {
      if (typeof key !== "string") throw new Error("store key must be a string");
      cell.storeWrites.set(key, cloneStoredValue(value));
    });
    registerHelper("load", (key) => {
      if (typeof key !== "string") throw new Error("load key must be a string");
      const value = cell.storeWrites.has(key)
        ? cell.storeWrites.get(key)
        : cell.storeSnapshot.get(key);
      return cloneStoredValue(value);
    });
    registerHelper("yield_control", () => {
      cell.yieldRequested = true;
      cell.yieldObserver?.();
    });
  }

  private registerNestedEvents(
    runtime: IJSRuntime,
    toolCallId: string,
    emitNestedEvent?: (event: PTCEventWithParent) => void
  ): void {
    if (!emitNestedEvent) return;
    const helperNames = new Set([
      "text",
      "image",
      "generatedImage",
      "notify",
      "store",
      "load",
      "yield_control",
    ]);
    runtime.onEvent((event: PTCEvent) => {
      if ("toolName" in event && helperNames.has(event.toolName)) return;
      emitNestedEvent({ ...event, parentToolCallId: toolCallId });
    });
  }

  private async runCell(
    cell: CodeCell,
    source: string,
    abortSignal: AbortSignal | undefined,
    abort: () => void
  ): Promise<void> {
    const runtime = cell.runtime!;
    let cleanupError: string | undefined;
    try {
      const result = await runtime.eval(source);
      if (cell.status !== "running") return;
      if (result.success) {
        cell.status = "completed";
        cell.result = result.result;
      } else {
        cell.status = "failed";
        cell.error = result.error;
      }
      for (const [key, value] of cell.storeWrites) {
        this.store.set(key, cloneStoredValue(value));
      }
    } catch (error) {
      if (cell.status === "running") {
        cell.status = "failed";
        cell.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      abortSignal?.removeEventListener("abort", abort);
      // Natural completion cancels unawaited nested tools before releasing the isolate.
      try {
        runtime.abort();
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error);
      }
      try {
        runtime.dispose();
      } catch (error) {
        cleanupError ??= error instanceof Error ? error.message : String(error);
      }
      cell.runtime = undefined;
      if (cell.status === "terminating") cell.status = "terminated";
      if (cleanupError) {
        if (cell.status !== "terminated") cell.status = "failed";
        cell.error = `Failed to clean up exec runtime: ${cleanupError}`;
      }
      cell.yieldObserver?.();
      if (cell.closeOnSettle) this.closeCell(cell);
    }
  }

  private beginTermination(cell: CodeCell): void {
    if (cell.status !== "running") return;
    cell.status = "terminating";
    cell.runtime?.abort();
  }

  private async observe(
    cell: CodeCell,
    yieldMs: number,
    maxTokens: number,
    abortSignal?: AbortSignal
  ): Promise<CodeModeResult> {
    if (cell.observing) {
      throw new Error(`exec cell ${cell.id} already has an active observer`);
    }
    cell.observing = true;
    try {
      if (cell.status === "running" || cell.status === "terminating") {
        await this.waitUntil(cell, yieldMs, abortSignal);
      }
      // Termination owns the terminal outcome. A timeout or yield must not let an
      // existing observer report before runtime and nested-tool cleanup finishes.
      if (cell.status === "terminating") await cell.promise;
      return this.deliver(cell, maxTokens);
    } finally {
      cell.observing = false;
    }
  }

  private async waitUntil(
    cell: CodeCell,
    yieldMs: number,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (cell.status !== "running" && cell.status !== "terminating") return;
    if (abortSignal?.aborted) throw getAbortError(abortSignal);
    if (cell.yieldRequested) {
      cell.yieldRequested = false;
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let signalYield: (() => void) | undefined;
    const explicitYield = new Promise<void>((resolve) => {
      signalYield = resolve;
      cell.yieldObserver = resolve;
    });
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.min(yieldMs, MAX_TIMER_MS));
    });
    let abortListener: (() => void) | undefined;
    const observationAborted = abortSignal
      ? new Promise<void>((_resolve, reject) => {
          abortListener = () => reject(getAbortError(abortSignal));
          abortSignal.addEventListener("abort", abortListener, { once: true });
        })
      : undefined;
    try {
      await Promise.race([
        cell.promise,
        timeout,
        explicitYield,
        ...(observationAborted ? [observationAborted] : []),
      ]);
      if (cell.yieldRequested) cell.yieldRequested = false;
    } finally {
      if (timer) clearTimeout(timer);
      if (abortListener) abortSignal?.removeEventListener("abort", abortListener);
      if (cell.yieldObserver === signalYield) cell.yieldObserver = undefined;
    }
  }

  private deliver(cell: CodeCell, maxTokens: number): CodeModeResult {
    const result = this.formatResult(cell, maxTokens);
    if (this.isTerminal(cell.status)) this.closeCell(cell);
    return result;
  }

  private formatResult(cell: CodeCell, maxTokens: number): CodeModeResult {
    const nextOutput = cell.output.slice(cell.outputCursor).map(stringifyOutput).join("\n");
    cell.outputCursor = cell.output.length;
    const maxChars = Math.max(1, maxTokens) * 4;
    const output =
      nextOutput.length > maxChars
        ? `${nextOutput.slice(0, maxChars)}\n[output truncated]`
        : nextOutput;
    const status =
      cell.status === "running" || cell.status === "terminating" ? "yielded" : cell.status;
    return {
      cell_id: cell.id,
      status,
      ...(output && { output }),
      ...(cell.status === "completed" && { result: cell.result }),
      ...(cell.error && { error: cell.error }),
    };
  }

  private missingCell(cellId: string): CodeModeResult {
    return {
      cell_id: cellId,
      status: "failed",
      error: `exec cell ${cellId} not found`,
    };
  }

  private closeCell(cell: CodeCell): void {
    if (this.cells.get(cell.id) === cell) this.cells.delete(cell.id);
  }

  private isTerminal(status: CellStatus): status is TerminalCellStatus {
    return status === "completed" || status === "failed" || status === "terminated";
  }
}

const sessions = new Map<string, CodeModeSession>();
const closingSessions = new Map<string, Promise<void>>();
let shutdownAllPromise: Promise<void> | undefined;

export async function shutdownCodeModeSession(workspaceId: string): Promise<void> {
  const closing = closingSessions.get(workspaceId);
  if (closing) return closing;
  const session = sessions.get(workspaceId);
  if (!session) return;

  sessions.delete(workspaceId);
  const shutdown = session.shutdown().finally(() => {
    if (closingSessions.get(workspaceId) === shutdown) closingSessions.delete(workspaceId);
  });
  closingSessions.set(workspaceId, shutdown);
  return shutdown;
}

export function shutdownAllCodeModeSessions(): Promise<void> {
  if (shutdownAllPromise) return shutdownAllPromise;
  const activeSessions = Array.from(sessions.entries());
  const alreadyClosing = Array.from(closingSessions.values());
  sessions.clear();
  shutdownAllPromise = Promise.all([
    ...alreadyClosing,
    ...activeSessions.map(async ([workspaceId, session]) => {
      const shutdown = session.shutdown();
      closingSessions.set(workspaceId, shutdown);
      try {
        await shutdown;
      } finally {
        if (closingSessions.get(workspaceId) === shutdown) closingSessions.delete(workspaceId);
      }
    }),
  ]).then(() => undefined);
  return shutdownAllPromise.finally(() => {
    shutdownAllPromise = undefined;
  });
}

export async function createCodeModeTools(opts: {
  workspaceId: string;
  runtimeFactory: IJSRuntimeFactory;
  toolBridge: ToolBridge;
  emitNestedEvent?: (event: PTCEventWithParent) => void;
}): Promise<Record<string, Tool>> {
  if (shutdownAllPromise || closingSessions.has(opts.workspaceId)) {
    throw new Error("code mode session is shutting down");
  }
  const toolTypes = await getCachedCodeModeTypes(opts.toolBridge.getBridgeableTools());
  // Type generation yields; re-check before publishing tools backed by this session.
  if (shutdownAllPromise || closingSessions.has(opts.workspaceId)) {
    throw new Error("code mode session is shutting down");
  }
  let session = sessions.get(opts.workspaceId);
  if (!session) {
    session = new CodeModeSession(opts.runtimeFactory);
    sessions.set(opts.workspaceId, session);
  }

  const exec = openai.tools.customTool({
    description: `Run raw JavaScript in a fresh isolated runtime. Awaitable Mux tools are on \`tools.*\`; \`ALL_TOOLS\` lists their names. Helpers: \`text()\`, \`image()\`, \`generatedImage()\`, \`notify()\`, \`store()\`/\`load()\`, and \`yield_control()\`. Cells in the same workspace share stored values, not runtime state. An optional first line \`// @exec: {"yield_time_ms":10000,"max_output_tokens":1000}\` controls the initial response. Pass JavaScript source directly, not JSON, quotes, or a Markdown code fence.

Available tools:
\`\`\`typescript
${toolTypes}
\`\`\``,
    format: {
      type: "grammar",
      syntax: "lark",
      definition: `start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \\t]*\\/\\/ @exec:[^\\r\\n]*/
NEWLINE: /\\r?\\n/
SOURCE: /[\\s\\S]+/`,
    },
    execute: async (source, { abortSignal, toolCallId }) =>
      session.exec(source, opts.toolBridge, toolCallId, abortSignal, opts.emitNestedEvent),
  });

  const wait = tool({
    description:
      "Wait on a yielded exec cell and return only new output or its terminal result. `yield_time_ms` defaults to 10000, `max_tokens` defaults to 10000, and `terminate: true` stops the cell after runtime cleanup. A terminal response closes the cell.",
    inputSchema: z.object({
      cell_id: z.string(),
      yield_time_ms: z.number().int().nonnegative().safe().nullish(),
      max_tokens: z.number().int().nonnegative().safe().nullish(),
      terminate: z.boolean().nullish(),
    }),
    execute: ({ cell_id, yield_time_ms, max_tokens, terminate }, { abortSignal }) =>
      session.wait(
        cell_id,
        yield_time_ms ?? DEFAULT_YIELD_MS,
        max_tokens ?? DEFAULT_MAX_TOKENS,
        terminate === true,
        abortSignal
      ),
  });

  return { exec, wait };
}
