/** Codex-compatible Code Mode backed by Mux's existing QuickJS sandbox. */

import crypto from "crypto";
import { openai } from "@ai-sdk/openai";
import { tool, type Tool } from "ai";
import { z } from "zod";

import type { ToolBridge } from "@/node/services/ptc/toolBridge";
import type { IJSRuntime, IJSRuntimeFactory } from "@/node/services/ptc/runtime";
import type { PTCEvent } from "@/node/services/ptc/types";
import type { PTCEventWithParent } from "./code_execution";

const DEFAULT_YIELD_MS = 10_000;
const MAX_YIELD_MS = 30_000;
const DEFAULT_MAX_TOKENS = 10_000;
const MAX_CELLS = 64;

interface ExecPragma {
  yield_time_ms?: number;
  max_output_tokens?: number;
}

interface CodeCell {
  id: string;
  runtime: IJSRuntime;
  promise: Promise<void>;
  result?: unknown;
  error?: string;
  output: unknown[];
  outputCursor: number;
  status: "running" | "completed" | "failed" | "terminated";
  requestYield: Promise<void>;
}

export interface CodeModeResult {
  cell_id: string;
  status: CodeCell["status"] | "yielded";
  output?: string;
  result?: unknown;
  error?: string;
}

function parseExecPragma(source: string): ExecPragma {
  const firstLine = source.split(/\r?\n/, 1)[0];
  const match = /^\s*\/\/\s*@exec:\s*(\{.*\})\s*$/.exec(firstLine);
  if (!match) return {};
  try {
    return JSON.parse(match[1]) as ExecPragma;
  } catch {
    return {};
  }
}

function clampInteger(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(Math.trunc(value), max))
    : fallback;
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

  constructor(private readonly runtimeFactory: IJSRuntimeFactory) {}

  async exec(
    source: string,
    bridge: ToolBridge,
    toolCallId: string,
    abortSignal: AbortSignal | undefined,
    emitNestedEvent?: (event: PTCEventWithParent) => void
  ): Promise<CodeModeResult> {
    const pragma = parseExecPragma(source);
    const yieldMs = clampInteger(pragma.yield_time_ms, DEFAULT_YIELD_MS, MAX_YIELD_MS);
    const maxTokens = clampInteger(
      pragma.max_output_tokens,
      DEFAULT_MAX_TOKENS,
      DEFAULT_MAX_TOKENS
    );
    const runtime = await this.runtimeFactory.create();
    runtime.setLimits({ timeoutMs: 60 * 60 * 1000 });
    bridge.register(runtime, "tools");
    runtime.registerValue?.("ALL_TOOLS", bridge.getBridgeableToolNames());

    const output: unknown[] = [];
    runtime.registerFunction("text", (value) => {
      output.push(value);
      return Promise.resolve();
    });
    runtime.registerFunction("image", (value) => {
      output.push({ type: "image", value });
      return Promise.resolve();
    });
    runtime.registerFunction("generatedImage", (value) => {
      output.push({ type: "generated_image", value });
      return Promise.resolve();
    });
    runtime.registerFunction("notify", (value) => {
      output.push({ type: "notification", value });
      return Promise.resolve();
    });
    runtime.registerFunction("store", (key, value) => {
      if (typeof key !== "string") throw new Error("store key must be a string");
      this.store.set(key, value);
      return Promise.resolve();
    });
    runtime.registerFunction("load", (key) => {
      if (typeof key !== "string") throw new Error("load key must be a string");
      return Promise.resolve(this.store.get(key));
    });

    let signalYield: (() => void) | undefined;
    const requestYield = new Promise<void>((resolve) => {
      signalYield = resolve;
    });
    runtime.registerFunction("yield_control", () => {
      signalYield?.();
      return Promise.resolve();
    });

    if (emitNestedEvent) {
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

    const id = crypto.randomBytes(8).toString("hex");
    const cell: CodeCell = {
      id,
      runtime,
      promise: Promise.resolve(),
      output,
      outputCursor: 0,
      status: "running",
      requestYield,
    };
    this.cells.set(id, cell);

    const abort = () => runtime.abort();
    if (abortSignal?.aborted) abort();
    else abortSignal?.addEventListener("abort", abort, { once: true });

    cell.promise = runtime
      .eval(source)
      .then((result) => {
        if (cell.status === "terminated") return;
        if (result.success) {
          cell.status = "completed";
          cell.result = result.result;
        } else {
          cell.status = "failed";
          cell.error = result.error;
        }
      })
      .finally(() => {
        abortSignal?.removeEventListener("abort", abort);
        runtime.dispose();
      });

    this.pruneCells();
    await this.waitUntil(cell, yieldMs, true);
    return this.formatResult(cell, maxTokens);
  }

  async wait(
    cellId: string,
    yieldMs: number,
    maxTokens: number,
    terminate: boolean
  ): Promise<CodeModeResult> {
    const cell = this.cells.get(cellId);
    if (!cell) throw new Error(`Unknown code cell: ${cellId}`);

    if (terminate && cell.status === "running") {
      cell.status = "terminated";
      cell.runtime.abort();
    }
    if (cell.status === "running") {
      await this.waitUntil(cell, yieldMs, false);
    }
    return this.formatResult(cell, maxTokens);
  }

  private async waitUntil(cell: CodeCell, yieldMs: number, allowExplicitYield: boolean) {
    if (cell.status !== "running") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, yieldMs);
    });
    try {
      await Promise.race(
        allowExplicitYield ? [cell.promise, timeout, cell.requestYield] : [cell.promise, timeout]
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private formatResult(cell: CodeCell, maxTokens: number): CodeModeResult {
    const nextOutput = cell.output.slice(cell.outputCursor).map(stringifyOutput).join("\n");
    cell.outputCursor = cell.output.length;
    const maxChars = Math.max(1, maxTokens) * 4;
    const output =
      nextOutput.length > maxChars
        ? `${nextOutput.slice(0, maxChars)}\n[output truncated]`
        : nextOutput;
    return {
      cell_id: cell.id,
      status: cell.status === "running" ? "yielded" : cell.status,
      ...(output && { output }),
      ...(cell.status === "completed" && { result: cell.result }),
      ...(cell.error && { error: cell.error }),
    };
  }

  private pruneCells(): void {
    if (this.cells.size <= MAX_CELLS) return;
    for (const [id, cell] of this.cells) {
      if (cell.status !== "running") this.cells.delete(id);
      if (this.cells.size <= MAX_CELLS) break;
    }
  }
}

const sessions = new Map<string, CodeModeSession>();

export function createCodeModeTools(opts: {
  workspaceId: string;
  runtimeFactory: IJSRuntimeFactory;
  toolBridge: ToolBridge;
  emitNestedEvent?: (event: PTCEventWithParent) => void;
}): Record<string, Tool> {
  let session = sessions.get(opts.workspaceId);
  if (!session) {
    session = new CodeModeSession(opts.runtimeFactory);
    sessions.set(opts.workspaceId, session);
  }

  const exec = openai.tools.customTool({
    description:
      'Execute raw JavaScript in a persistent Code Mode session. Globals: tools.* (awaitable Mux tools), ALL_TOOLS, text(), image(), generatedImage(), notify(), store()/load(), and yield_control(). An optional first line // @exec: {"yield_time_ms":10000,"max_output_tokens":1000} controls the initial yield.',
    format: {
      type: "grammar",
      syntax: "lark",
      definition: "start: /[\\s\\S]+/",
    },
    execute: async (source, { abortSignal, toolCallId }) =>
      session.exec(source, opts.toolBridge, toolCallId, abortSignal, opts.emitNestedEvent),
  });

  const wait = tool({
    description: "Wait for, poll, or terminate a yielded Code Mode cell.",
    inputSchema: z.object({
      cell_id: z.string(),
      yield_time_ms: z.number().int().nonnegative().max(MAX_YIELD_MS).nullish(),
      max_tokens: z.number().int().positive().max(DEFAULT_MAX_TOKENS).nullish(),
      terminate: z.boolean().nullish(),
    }),
    execute: ({ cell_id, yield_time_ms, max_tokens, terminate }) =>
      session.wait(
        cell_id,
        yield_time_ms ?? DEFAULT_YIELD_MS,
        max_tokens ?? DEFAULT_MAX_TOKENS,
        terminate === true
      ),
  });

  return { exec, wait };
}
