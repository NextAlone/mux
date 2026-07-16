import { tool, type Tool } from "ai";
import { CODE_STRUCTURE_MAX_SOURCE_BYTES } from "@/common/constants/toolLimits";
import type { ReadSymbolToolArgs, ReadSymbolToolResult } from "@/common/types/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import type { ReadSymbolSelector } from "@/node/services/codeStructure/codeStructureAnalysis";
import type { CodeStructureService } from "@/node/services/codeStructure/codeStructureService";
import { getCodeStructureService } from "@/node/services/codeStructure/codeStructureService";
import { readCodeStructureFile } from "./codeStructureCommon";

export function createReadSymbolTool(
  config: ToolConfiguration,
  service: CodeStructureService = getCodeStructureService()
): Tool {
  return tool({
    description: TOOL_DEFINITIONS.read_symbol.description,
    inputSchema: TOOL_DEFINITIONS.read_symbol.schema,
    execute: async (args: ReadSymbolToolArgs, { abortSignal }): Promise<ReadSymbolToolResult> => {
      const file = await readCodeStructureFile(config, args.path, abortSignal);
      if (!file.success) return { ...file, reason: "error" };

      const selector: ReadSymbolSelector = {
        symbol: args.symbol,
        ...(args.kind != null ? { kind: args.kind } : {}),
        ...(args.startLine != null ? { startLine: args.startLine } : {}),
      };

      try {
        const result = await service.readSymbol(file.path, file.source, selector, abortSignal);
        if (!result.found) {
          if (result.reason === "ambiguous") {
            return {
              success: false,
              reason: "ambiguous",
              error: `Symbol '${args.symbol}' is ambiguous; pass kind or startLine.`,
              candidates: result.candidates,
            };
          }
          return {
            success: false,
            reason: "not_found",
            error: `Symbol '${args.symbol}' was not found in '${file.path}'.`,
          };
        }

        if (Buffer.byteLength(result.source, "utf8") > CODE_STRUCTURE_MAX_SOURCE_BYTES) {
          return {
            success: false,
            reason: "too_large",
            error: `Symbol source exceeds ${CODE_STRUCTURE_MAX_SOURCE_BYTES} bytes; use file_read with offset ${result.startLine} and limit ${result.endLine - result.startLine + 1}.`,
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
