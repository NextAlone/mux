import { describe, expect, it } from "bun:test";
import { tool, type Tool } from "ai";
import { z } from "zod";

import { markBuiltInTaskTool } from "./tools/task";
import { applyToolPolicyAndExperiments, resolveTaskDelegationCallSurface } from "./toolAssembly";

function executableTool(): Tool {
  return tool({
    inputSchema: z.object({ value: z.string().nullish() }),
    execute: () => Promise.resolve({ ok: true }),
  });
}

function builtInTaskTool(): Tool {
  return markBuiltInTaskTool(executableTool());
}

describe("applyToolPolicyAndExperiments Code Mode", () => {
  it("keeps direct control tools and replaces bridgeable/provider tools with exec/wait", async () => {
    const result = await applyToolPolicyAndExperiments({
      allTools: {
        bash: executableTool(),
        task: builtInTaskTool(),
        ask_user_question: executableTool(),
        web_search: { inputSchema: z.object({ query: z.string() }) },
      },
      effectiveToolPolicy: undefined,
      codeModeOnly: { workspaceId: `tool-assembly-${Date.now()}` },
      emitNestedToolEvent: () => undefined,
    });

    expect(Object.keys(result.tools).sort()).toEqual(["ask_user_question", "exec", "wait"]);
    expect(
      resolveTaskDelegationCallSurface({
        tools: result.tools,
        bridgedBuiltInTask: result.bridgedBuiltInTask,
        taskServiceAvailable: true,
        trusted: true,
        delegatedToAcp: false,
      })
    ).toBe("code_mode");
  });
});

describe("task delegation call surface", () => {
  const resolve = (
    result: Awaited<ReturnType<typeof applyToolPolicyAndExperiments>>,
    overrides: Partial<Parameters<typeof resolveTaskDelegationCallSurface>[0]> = {}
  ) =>
    resolveTaskDelegationCallSurface({
      tools: result.tools,
      bridgedBuiltInTask: result.bridgedBuiltInTask,
      taskServiceAvailable: true,
      trusted: true,
      delegatedToAcp: false,
      ...overrides,
    });

  it("prefers direct task in PTC supplement mode", () => {
    const carrier = executableTool();
    const result = {
      tools: { task: builtInTaskTool(), code_execution: carrier },
      bridgedBuiltInTask: {
        surface: "code_execution" as const,
        carrierName: "code_execution" as const,
        carrier,
      },
    };

    expect(Object.keys(result.tools).sort()).toEqual(["code_execution", "task"]);
    expect(resolve(result)).toBe("direct");
  });

  it("uses synchronous code_execution in PTC exclusive mode", () => {
    const carrier = executableTool();
    const result = {
      tools: { code_execution: carrier },
      bridgedBuiltInTask: {
        surface: "code_execution" as const,
        carrierName: "code_execution" as const,
        carrier,
      },
    };

    expect(Object.keys(result.tools)).toEqual(["code_execution"]);
    expect(resolve(result)).toBe("code_execution");
  });

  it("does not advertise policy-removed or same-name unmarked task tools", async () => {
    const policyRemoved = await applyToolPolicyAndExperiments({
      allTools: { task: builtInTaskTool() },
      effectiveToolPolicy: [{ regex_match: "task", action: "disable" }],
      emitNestedToolEvent: () => undefined,
    });
    const shadowed = await applyToolPolicyAndExperiments({
      allTools: { task: builtInTaskTool() },
      extraTools: { task: executableTool() },
      effectiveToolPolicy: undefined,
      emitNestedToolEvent: () => undefined,
    });

    expect(resolve(policyRemoved)).toBeUndefined();
    expect(resolve(shadowed)).toBeUndefined();
  });

  it("invalidates bridged provenance when the final carrier is replaced", async () => {
    const result = await applyToolPolicyAndExperiments({
      allTools: { task: builtInTaskTool() },
      effectiveToolPolicy: undefined,
      codeModeOnly: { workspaceId: `tool-assembly-carrier-${Date.now()}` },
      emitNestedToolEvent: () => undefined,
    });

    expect(resolve(result, { tools: { ...result.tools, exec: executableTool() } })).toBeUndefined();
  });

  it("fails closed without local service, trust, or when task is ACP delegated", async () => {
    const result = await applyToolPolicyAndExperiments({
      allTools: { task: builtInTaskTool() },
      effectiveToolPolicy: undefined,
      emitNestedToolEvent: () => undefined,
    });

    expect(resolve(result, { taskServiceAvailable: false })).toBeUndefined();
    expect(resolve(result, { trusted: false })).toBeUndefined();
    expect(resolve(result, { delegatedToAcp: true })).toBeUndefined();
  });
});
