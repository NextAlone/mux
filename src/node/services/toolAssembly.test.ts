import { describe, expect, it } from "bun:test";
import { tool, type Tool } from "ai";
import { z } from "zod";

import { applyToolPolicyAndExperiments } from "./toolAssembly";

function executableTool(): Tool {
  return tool({
    inputSchema: z.object({ value: z.string().nullish() }),
    execute: () => Promise.resolve({ ok: true }),
  });
}

describe("applyToolPolicyAndExperiments Code Mode", () => {
  it("keeps direct control tools and replaces bridgeable/provider tools with exec/wait", async () => {
    const tools = await applyToolPolicyAndExperiments({
      allTools: {
        bash: executableTool(),
        ask_user_question: executableTool(),
        web_search: { inputSchema: z.object({ query: z.string() }) },
      },
      effectiveToolPolicy: undefined,
      codeModeOnly: { workspaceId: `tool-assembly-${Date.now()}` },
      emitNestedToolEvent: () => undefined,
    });

    expect(Object.keys(tools).sort()).toEqual(["ask_user_question", "exec", "wait"]);
  });
});
