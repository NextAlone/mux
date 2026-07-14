import { describe, expect, it, mock } from "bun:test";
import { tool, type Tool, type ToolExecutionOptions } from "ai";
import { z } from "zod";

import { ToolBridge } from "@/node/services/ptc/toolBridge";
import type { IJSRuntime, IJSRuntimeFactory, RuntimeLimits } from "@/node/services/ptc/runtime";
import type { PTCEvent, PTCExecutionResult } from "@/node/services/ptc/types";
import { createCodeModeTools, shutdownCodeModeSession, type CodeModeResult } from "./code_mode";
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
  readonly syncFunctions = new Map<string, (...args: unknown[]) => unknown>();
  abortCalled = false;
  disposed = false;
  disposeError?: Error;
  evaluatedSource?: string;

  eval(source: string): Promise<PTCExecutionResult> {
    this.evaluatedSource = source;
    return this.result.promise;
  }
  registerFunction(): void {
    return undefined;
  }
  registerSyncFunction(name: string, fn: (...args: unknown[]) => unknown): void {
    this.syncFunctions.set(name, fn);
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
    this.abortCalled = true;
  }
  getAbortSignal(): AbortSignal | undefined {
    return undefined;
  }
  dispose(): void {
    this.disposed = true;
    if (this.disposeError) throw this.disposeError;
  }
  [Symbol.dispose](): void {
    return undefined;
  }
}

class DeferredRuntimeFactory implements IJSRuntimeFactory {
  latest?: DeferredRuntime;
  readonly instances: DeferredRuntime[] = [];

  create(): Promise<IJSRuntime> {
    this.latest = new DeferredRuntime();
    this.instances.push(this.latest);
    return Promise.resolve(this.latest);
  }
}

class GatedRuntimeFactory implements IJSRuntimeFactory {
  readonly runtime = new DeferredRuntime();
  readonly gate = deferred<IJSRuntime>();

  create(): Promise<IJSRuntime> {
    return this.gate.promise;
  }
}

function completeRuntime(runtime: DeferredRuntime, result: unknown): void {
  runtime.result.resolve({
    success: true,
    result,
    toolCalls: [],
    consoleOutput: [],
    duration_ms: 1,
  });
}

function abortRuntime(runtime: DeferredRuntime): void {
  runtime.result.resolve({
    success: false,
    error: "Execution aborted",
    toolCalls: [],
    consoleOutput: [],
    duration_ms: 1,
  });
}

type TestToolExecute = (input: unknown, options: ToolExecutionOptions<unknown>) => unknown;

function executable(
  tool: Tool
): (input: unknown, options: ToolExecutionOptions<unknown>) => Promise<unknown> {
  const execute: unknown = tool.execute;
  if (typeof execute !== "function") throw new Error("Expected executable tool");
  const typedExecute = execute as TestToolExecute;
  return (input, options) => Promise.resolve(typedExecute(input, options));
}

async function expectRejectedWith(promise: Promise<unknown>, message: string): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
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

    completeRuntime(runtimeFactory.latest!, 42);
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

  it("closes a terminal cell after delivering its final response", async () => {
    const runtimeFactory = new DeferredRuntimeFactory();
    const tools = createCodeModeTools({
      workspaceId: `code-mode-close-${Date.now()}`,
      runtimeFactory,
      toolBridge: new ToolBridge({}),
    });

    const first = (await executable(tools.exec)(
      '// @exec: {"yield_time_ms":0}\nreturn 42;',
      toolOptions
    )) as CodeModeResult;
    const runtime = runtimeFactory.latest!;
    completeRuntime(runtime, 42);
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.disposed).toBe(true);

    const completed = (await executable(tools.wait)(
      { cell_id: first.cell_id, yield_time_ms: 10, max_tokens: 100, terminate: false },
      toolOptions
    )) as CodeModeResult;
    expect(completed.status).toBe("completed");
    expect(runtime.disposed).toBe(true);

    const missing = (await executable(tools.wait)(
      { cell_id: first.cell_id, yield_time_ms: 0, max_tokens: 100, terminate: false },
      toolOptions
    )) as CodeModeResult;
    expect(missing).toMatchObject({
      cell_id: first.cell_id,
      status: "failed",
      error: `exec cell ${first.cell_id} not found`,
    });
  });

  it("strictly validates and strips the exec pragma before evaluation", async () => {
    const runtimeFactory = new DeferredRuntimeFactory();
    const tools = createCodeModeTools({
      workspaceId: `code-mode-pragma-${Date.now()}`,
      runtimeFactory,
      toolBridge: new ToolBridge({}),
    });

    await expectRejectedWith(
      executable(tools.exec)(
        '// @exec: {"yield_time_ms":0,"unsupported":true}\nreturn 42;',
        toolOptions
      ),
      "exec pragma only supports"
    );
    expect(runtimeFactory.instances).toHaveLength(0);

    const first = (await executable(tools.exec)(
      '// @exec: {"yield_time_ms":0}\nreturn 42;',
      toolOptions
    )) as CodeModeResult;
    expect(runtimeFactory.latest?.evaluatedSource).toBe("return 42;");
    completeRuntime(runtimeFactory.latest!, 42);
    await executable(tools.wait)(
      { cell_id: first.cell_id, yield_time_ms: 10, max_tokens: 100, terminate: false },
      toolOptions
    );
  });

  it("waits for runtime cleanup before reporting termination", async () => {
    const runtimeFactory = new DeferredRuntimeFactory();
    const tools = createCodeModeTools({
      workspaceId: `code-mode-terminate-${Date.now()}`,
      runtimeFactory,
      toolBridge: new ToolBridge({}),
    });

    const first = (await executable(tools.exec)(
      '// @exec: {"yield_time_ms":0}\nawait tools.block({});',
      toolOptions
    )) as CodeModeResult;
    const runtime = runtimeFactory.latest!;
    let settled = false;
    const termination = executable(tools.wait)(
      { cell_id: first.cell_id, yield_time_ms: 0, max_tokens: 100, terminate: true },
      toolOptions
    ).then((result: unknown) => {
      settled = true;
      return result as CodeModeResult;
    });

    await Promise.resolve();
    expect(runtime.abortCalled).toBe(true);
    expect(settled).toBe(false);
    expect(runtime.disposed).toBe(false);

    abortRuntime(runtime);
    const terminated = await termination;
    expect(terminated.status).toBe("terminated");
    expect(runtime.disposed).toBe(true);
  });

  it("reports runtime cleanup failures on a terminated cell", async () => {
    const runtimeFactory = new DeferredRuntimeFactory();
    const tools = createCodeModeTools({
      workspaceId: `code-mode-terminate-cleanup-error-${Date.now()}`,
      runtimeFactory,
      toolBridge: new ToolBridge({}),
    });

    const first = (await executable(tools.exec)(
      '// @exec: {"yield_time_ms":0}\nawait tools.block({});',
      toolOptions
    )) as CodeModeResult;
    const runtime = runtimeFactory.latest!;
    runtime.disposeError = new Error("dispose failed");
    const termination = executable(tools.wait)(
      { cell_id: first.cell_id, yield_time_ms: 0, max_tokens: 100, terminate: true },
      toolOptions
    );
    abortRuntime(runtime);

    expect(await termination).toMatchObject({
      status: "terminated",
      error: "Failed to clean up exec runtime: dispose failed",
    });
  });

  it("lets termination resolve an active observer without displacing it", async () => {
    const runtimeFactory = new DeferredRuntimeFactory();
    const tools = createCodeModeTools({
      workspaceId: `code-mode-observed-termination-${Date.now()}`,
      runtimeFactory,
      toolBridge: new ToolBridge({}),
    });

    const first = (await executable(tools.exec)(
      '// @exec: {"yield_time_ms":0}\nawait tools.block({});',
      toolOptions
    )) as CodeModeResult;
    let observerSettled = false;
    const observer = executable(tools.wait)(
      { cell_id: first.cell_id, yield_time_ms: 0, max_tokens: 100, terminate: false },
      toolOptions
    ).then((result) => {
      observerSettled = true;
      return result;
    });
    let terminationSettled = false;
    const termination = executable(tools.wait)(
      { cell_id: first.cell_id, yield_time_ms: 0, max_tokens: 100, terminate: true },
      toolOptions
    ).then((result) => {
      terminationSettled = true;
      return result;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observerSettled).toBe(false);
    expect(terminationSettled).toBe(false);
    abortRuntime(runtimeFactory.latest!);
    expect(await observer).toMatchObject({ status: "terminated" });
    expect(await termination).toMatchObject({ status: "terminated" });
    expect(runtimeFactory.latest?.disposed).toBe(true);
  });

  it("preserves a natural completion that reaches the session before termination", async () => {
    const runtimeFactory = new DeferredRuntimeFactory();
    const tools = createCodeModeTools({
      workspaceId: `code-mode-natural-completion-${Date.now()}`,
      runtimeFactory,
      toolBridge: new ToolBridge({}),
    });

    const first = (await executable(tools.exec)(
      '// @exec: {"yield_time_ms":0}\nreturn 42;',
      toolOptions
    )) as CodeModeResult;
    completeRuntime(runtimeFactory.latest!, 42);
    await Promise.resolve();
    await Promise.resolve();

    expect(
      await executable(tools.wait)(
        { cell_id: first.cell_id, yield_time_ms: 0, max_tokens: 100, terminate: true },
        toolOptions
      )
    ).toMatchObject({ status: "completed", result: 42 });
  });

  it("rejects staged store writes when a cell is terminated", async () => {
    const runtimeFactory = new DeferredRuntimeFactory();
    const tools = createCodeModeTools({
      workspaceId: `code-mode-store-termination-${Date.now()}`,
      runtimeFactory,
      toolBridge: new ToolBridge({}),
    });

    const first = (await executable(tools.exec)(
      '// @exec: {"yield_time_ms":0}\nawait tools.block({});',
      toolOptions
    )) as CodeModeResult;
    const firstRuntime = runtimeFactory.latest!;
    firstRuntime.syncFunctions.get("store")?.("answer", 42);

    const termination = executable(tools.wait)(
      { cell_id: first.cell_id, yield_time_ms: 0, max_tokens: 100, terminate: true },
      toolOptions
    );
    abortRuntime(firstRuntime);
    await termination;

    const second = (await executable(tools.exec)(
      '// @exec: {"yield_time_ms":0}\nreturn load("answer");',
      toolOptions
    )) as CodeModeResult;
    const secondRuntime = runtimeFactory.latest!;
    expect(secondRuntime.syncFunctions.get("load")?.("answer")).toBeUndefined();
    completeRuntime(secondRuntime, undefined);
    await executable(tools.wait)(
      { cell_id: second.cell_id, yield_time_ms: 10, max_tokens: 100, terminate: false },
      toolOptions
    );
  });

  it("rejects a second observer without displacing the first", async () => {
    const runtimeFactory = new DeferredRuntimeFactory();
    const tools = createCodeModeTools({
      workspaceId: `code-mode-observer-${Date.now()}`,
      runtimeFactory,
      toolBridge: new ToolBridge({}),
    });

    const first = (await executable(tools.exec)(
      '// @exec: {"yield_time_ms":0}\nreturn 42;',
      toolOptions
    )) as CodeModeResult;
    const firstObserver = executable(tools.wait)(
      { cell_id: first.cell_id, yield_time_ms: 10_000, max_tokens: 100, terminate: false },
      toolOptions
    );
    const secondObserver = executable(tools.wait)(
      { cell_id: first.cell_id, yield_time_ms: 0, max_tokens: 100, terminate: false },
      toolOptions
    );

    await expectRejectedWith(
      secondObserver,
      `exec cell ${first.cell_id} already has an active observer`
    );
    completeRuntime(runtimeFactory.latest!, 42);
    expect(await firstObserver).toMatchObject({ status: "completed", result: 42 });
  });

  it("releases observer ownership when a wait request is aborted", async () => {
    const runtimeFactory = new DeferredRuntimeFactory();
    const tools = createCodeModeTools({
      workspaceId: `code-mode-observer-abort-${Date.now()}`,
      runtimeFactory,
      toolBridge: new ToolBridge({}),
    });

    const first = (await executable(tools.exec)(
      '// @exec: {"yield_time_ms":0}\nreturn 42;',
      toolOptions
    )) as CodeModeResult;
    const controller = new AbortController();
    const abortedObserver = executable(tools.wait)(
      { cell_id: first.cell_id, yield_time_ms: 10_000, max_tokens: 100, terminate: false },
      { ...toolOptions, abortSignal: controller.signal }
    ).then(
      (result) => result,
      (error: unknown) => error
    );
    controller.abort(new DOMException("Stopped", "AbortError"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const replacementObserver = executable(tools.wait)(
      { cell_id: first.cell_id, yield_time_ms: 10_000, max_tokens: 100, terminate: false },
      toolOptions
    ).then(
      (result) => result,
      (error: unknown) => error
    );
    completeRuntime(runtimeFactory.latest!, 42);

    const abortedResult = await abortedObserver;
    expect(abortedResult).toBeInstanceOf(DOMException);
    expect((abortedResult as DOMException).name).toBe("AbortError");
    expect(await replacementObserver).toMatchObject({ status: "completed", result: 42 });
  });

  it("supports repeated yield_control observations", async () => {
    const runtimeFactory = new DeferredRuntimeFactory();
    const tools = createCodeModeTools({
      workspaceId: `code-mode-yield-${Date.now()}`,
      runtimeFactory,
      toolBridge: new ToolBridge({}),
    });

    const first = (await executable(tools.exec)(
      '// @exec: {"yield_time_ms":0}\nawait tools.block({});',
      toolOptions
    )) as CodeModeResult;
    const runtime = runtimeFactory.latest!;

    const firstWait = executable(tools.wait)(
      { cell_id: first.cell_id, yield_time_ms: 10_000, max_tokens: 100, terminate: false },
      toolOptions
    );
    runtime.syncFunctions.get("yield_control")?.();
    expect(await firstWait).toMatchObject({ status: "yielded" });

    const secondWait = executable(tools.wait)(
      { cell_id: first.cell_id, yield_time_ms: 10_000, max_tokens: 100, terminate: false },
      toolOptions
    );
    runtime.syncFunctions.get("yield_control")?.();
    expect(await secondWait).toMatchObject({ status: "yielded" });

    completeRuntime(runtime, 42);
    expect(
      await executable(tools.wait)(
        { cell_id: first.cell_id, yield_time_ms: 10, max_tokens: 100, terminate: false },
        toolOptions
      )
    ).toMatchObject({ status: "completed", result: 42 });
  });

  it("shuts down a workspace session by aborting and joining active cells", async () => {
    const workspaceId = `code-mode-shutdown-${Date.now()}`;
    const runtimeFactory = new DeferredRuntimeFactory();
    const tools = createCodeModeTools({
      workspaceId,
      runtimeFactory,
      toolBridge: new ToolBridge({}),
    });

    await executable(tools.exec)(
      '// @exec: {"yield_time_ms":0}\nawait tools.block({});',
      toolOptions
    );
    const runtime = runtimeFactory.latest!;
    let settled = false;
    const shutdown = shutdownCodeModeSession(workspaceId).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(runtime.abortCalled).toBe(true);
    expect(settled).toBe(false);
    abortRuntime(runtime);
    await shutdown;
    expect(runtime.disposed).toBe(true);
    await expectRejectedWith(
      executable(tools.exec)("return 1;", toolOptions),
      "code mode session is shutting down"
    );
  });

  it("rejects a cell whose runtime creation finishes after shutdown begins", async () => {
    const workspaceId = `code-mode-shutdown-admission-${Date.now()}`;
    const runtimeFactory = new GatedRuntimeFactory();
    const tools = createCodeModeTools({
      workspaceId,
      runtimeFactory,
      toolBridge: new ToolBridge({}),
    });

    const execution = executable(tools.exec)(
      '// @exec: {"yield_time_ms":0}\nreturn 1;',
      toolOptions
    );
    await Promise.resolve();
    let shutdownSettled = false;
    const shutdown = shutdownCodeModeSession(workspaceId).then(() => {
      shutdownSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(shutdownSettled).toBe(false);
    runtimeFactory.gate.resolve(runtimeFactory.runtime);

    await expectRejectedWith(execution, "code mode session is shutting down");
    await shutdown;
    expect(runtimeFactory.runtime.disposed).toBe(true);
  });
});
