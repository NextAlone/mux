import { describe, expect, it, mock } from "bun:test";
import { tool, type Tool, type ToolExecutionOptions } from "ai";
import { z } from "zod";

import { ToolBridge } from "@/node/services/ptc/toolBridge";
import type { IJSRuntime, IJSRuntimeFactory, RuntimeLimits } from "@/node/services/ptc/runtime";
import type { PTCEvent, PTCExecutionResult } from "@/node/services/ptc/types";
import { createCodeModeTools, type CodeModeResult } from "./code_mode";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";

const toolOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "call-code-mode",
  messages: [],
  context: undefined,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

class DeferredRuntime implements IJSRuntime {
  readonly result = deferred<PTCExecutionResult>();

  eval(): Promise<PTCExecutionResult> {
    return this.result.promise;
  }
  registerFunction(): void {
    return undefined;
  }
  registerSyncFunction(): void {
    return undefined;
  }
  registerValue(): void {
    return undefined;
  }
  registerObject(): void {
    return undefined;
  }
  setLimits(_limits: RuntimeLimits): void {
    return undefined;
  }
  onEvent(_handler: (event: PTCEvent) => void): void {
    return undefined;
  }
  abort(): void {
    this.result.resolve({
      success: false,
      error: "Execution aborted",
      toolCalls: [],
      consoleOutput: [],
      duration_ms: 0,
    });
  }
  getAbortSignal(): AbortSignal | undefined {
    return undefined;
  }
  dispose(): void {
    return undefined;
  }
  [Symbol.dispose](): void {
    return undefined;
  }
}

class DeferredRuntimeFactory implements IJSRuntimeFactory {
  latest?: DeferredRuntime;

  create(): Promise<IJSRuntime> {
    this.latest = new DeferredRuntime();
    return Promise.resolve(this.latest);
  }
}

function executable(tool: Tool): NonNullable<Tool["execute"]> {
  if (!tool.execute) throw new Error("Expected executable tool");
  return tool.execute;
}

describe("createCodeModeTools", () => {
  it("persists store/load values across cells", async () => {
    const tools = createCodeModeTools({
      workspaceId: `code-mode-store-${Date.now()}`,
      runtimeFactory: new QuickJSRuntimeFactory(),
      toolBridge: new ToolBridge({}),
    });

    const stored = (await executable(tools.exec)(
      'store("answer", 40); return "stored";',
      toolOptions
    )) as CodeModeResult;
    const loaded = (await executable(tools.exec)(
      'return load("answer") + 2;',
      toolOptions
    )) as CodeModeResult;

    expect(stored).toMatchObject({ status: "completed", result: "stored" });
    expect(loaded).toMatchObject({ status: "completed", result: 42 });
  });

  it("completes after outputting an awaited bridged tool result", async () => {
    const tools = createCodeModeTools({
      workspaceId: `code-mode-output-${Date.now()}`,
      runtimeFactory: new QuickJSRuntimeFactory(),
      toolBridge: new ToolBridge({
        echo: tool({
          inputSchema: z.object({}),
          execute: () => Promise.resolve({ output: "ok" }),
        }),
      }),
    });

    const result = (await executable(tools.exec)(
      "const value = await tools.echo({}); text(value.output); return value.output;",
      toolOptions
    )) as CodeModeResult;

    expect(result).toMatchObject({ status: "completed", output: "ok", result: "ok" });
  });

  it("executes the advertised await tools.task protocol", async () => {
    const executeTask = mock((args: unknown) => Promise.resolve({ status: "queued", args }));
    const tools = createCodeModeTools({
      workspaceId: `code-mode-task-${Date.now()}`,
      runtimeFactory: new QuickJSRuntimeFactory(),
      toolBridge: new ToolBridge({
        task: tool({
          inputSchema: z.object({
            agentId: z.string(),
            prompt: z.string(),
            title: z.string(),
            run_in_background: z.boolean().nullish(),
          }),
          execute: executeTask,
        }),
      }),
    });

    const result = (await executable(tools.exec)(
      'return await tools.task({ agentId: "explore", prompt: "inspect", title: "Inspect", run_in_background: true });',
      toolOptions
    )) as CodeModeResult;

    expect(result).toMatchObject({ status: "completed", result: { status: "queued" } });
    expect(executeTask).toHaveBeenCalledWith(
      {
        agentId: "explore",
        prompt: "inspect",
        title: "Inspect",
        run_in_background: true,
      },
      expect.anything()
    );
  });

  it("returns a yielded cell that wait can poll to completion", async () => {
    const runtimeFactory = new DeferredRuntimeFactory();
    const tools = createCodeModeTools({
      workspaceId: `code-mode-${Date.now()}`,
      runtimeFactory,
      toolBridge: new ToolBridge({}),
    });

    const first = (await executable(tools.exec)(
      '// @exec: {"yield_time_ms":0}\nreturn 42;',
      toolOptions
    )) as CodeModeResult;
    expect(first.status).toBe("yielded");

    const pending = (await executable(tools.wait)(
      { cell_id: first.cell_id, yield_time_ms: 0, max_tokens: 100, terminate: false },
      toolOptions
    )) as CodeModeResult;
    expect(pending.status).toBe("yielded");

    runtimeFactory.latest?.result.resolve({
      success: true,
      result: 42,
      toolCalls: [],
      consoleOutput: [],
      duration_ms: 1,
    });
    await Promise.resolve();

    const completed = (await executable(tools.wait)(
      { cell_id: first.cell_id, yield_time_ms: 10, max_tokens: 100, terminate: false },
      toolOptions
    )) as CodeModeResult;
    expect(completed).toMatchObject({
      cell_id: first.cell_id,
      status: "completed",
      result: 42,
    });
  });
});
