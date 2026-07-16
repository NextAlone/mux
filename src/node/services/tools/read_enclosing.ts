import { tool, type Tool } from "ai";
import { CODE_STRUCTURE_MAX_SOURCE_BYTES } from "@/common/constants/toolLimits";
import type { ReadEnclosingToolArgs, ReadEnclosingToolResult } from "@/common/types/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import type { CodeStructureService } from "@/node/services/codeStructure/codeStructureService";
import { getCodeStructureService } from "@/node/services/codeStructure/codeStructureService";
import { readCodeStructureFile } from "./codeStructureCommon";

export function createReadEnclosingTool(
  config: ToolConfiguration,
  service: CodeStructureService = getCodeStructureService()
): Tool {
  return tool({
    description: TOOL_DEFINITIONS.read_enclosing.description,
    inputSchema: TOOL_DEFINITIONS.read_enclosing.schema,
    execute: async (
      args: ReadEnclosingToolArgs,
      { abortSignal }
    ): Promise<ReadEnclosingToolResult> => {
      const file = await readCodeStructureFile(config, args.path, abortSignal);
      if (!file.success) return { ...file, reason: "error" };

      try {
        const result = await service.readEnclosing(file.path, file.source, args.line, abortSignal);
        if (!result.found) {
          return {
            success: false,
            reason: "no_enclosing_symbol",
            error: `No named symbol encloses line ${args.line} in '${file.path}'.`,
          };
        }

        if (Buffer.byteLength(result.source, "utf8") > CODE_STRUCTURE_MAX_SOURCE_BYTES) {
          return {
            success: false,
            reason: "too_large",
            error: `Enclosing symbol exceeds ${CODE_STRUCTURE_MAX_SOURCE_BYTES} bytes; use file_read with offset ${result.startLine} and limit ${result.endLine - result.startLine + 1}.`,
            startLine: result.startLine,
            endLine: result.endLine,
          };
        }

        const { found: _found, members: _members, ...readResult } = result;
        return {
          success: true,
          ...readResult,
          ...(file.warning ? { warning: file.warning } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          reason: message.startsWith("Unsupported code structure language")
            ? "unsupported"
            : "error",
          error: message,
        };
      }
    },
  });
}
