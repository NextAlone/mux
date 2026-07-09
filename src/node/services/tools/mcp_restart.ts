import { tool } from "ai";

import { McpRestartToolResultSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { parseToolResult, requireWorkspaceId } from "./toolUtils";

export const createMcpRestartTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.mcp_restart.description,
    inputSchema: TOOL_DEFINITIONS.mcp_restart.schema,
    execute: async (): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "mcp_restart");
      const manager = config.mcpServerManager;
      if (!manager) {
        return parseToolResult(
          McpRestartToolResultSchema,
          {
            success: false,
            restarted: false,
            note: "MCP is not available in this session.",
          },
          "mcp_restart"
        );
      }

      await manager.stopServers(workspaceId);
      return parseToolResult(
        McpRestartToolResultSchema,
        {
          success: true,
          restarted: true,
          note: "MCP clients were stopped. They will reconnect with fresh credentials on the next model turn.",
        },
        "mcp_restart"
      );
    },
  });
};
