import { describe, expect, it, mock } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { createTestToolConfig } from "./testHelpers";
import { createMcpRestartTool } from "./mcp_restart";

const toolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

interface McpRestartResult {
  success: boolean;
  restarted: boolean;
  note: string;
}

async function executeMcpRestartTool(tool: ReturnType<typeof createMcpRestartTool>) {
  if (!tool.execute) {
    throw new Error("mcp_restart test tool is missing execute");
  }
  return (await tool.execute({}, toolCallOptions)) as McpRestartResult;
}

describe("mcp_restart", () => {
  it("stops cached MCP servers for the current workspace", async () => {
    const stopServers = mock(async () => {
      await Promise.resolve();
    });
    const config = createTestToolConfig("/tmp", { workspaceId: "workspace-1" });
    config.mcpServerManager = { stopServers };

    const result = await executeMcpRestartTool(createMcpRestartTool(config));

    expect(stopServers).toHaveBeenCalledWith("workspace-1");
    expect(result).toMatchObject({ success: true, restarted: true });
  });

  it("reports unavailable MCP manager", async () => {
    const result = await executeMcpRestartTool(createMcpRestartTool(createTestToolConfig("/tmp")));

    expect(result).toMatchObject({ success: false, restarted: false });
  });
});
