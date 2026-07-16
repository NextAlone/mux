import { tool, type Tool } from "ai";
import { CODE_STRUCTURE_MAX_SYMBOLS } from "@/common/constants/toolLimits";
import type { ModuleReportToolArgs, ModuleReportToolResult } from "@/common/types/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import type { CodeStructureService } from "@/node/services/codeStructure/codeStructureService";
import { getCodeStructureService } from "@/node/services/codeStructure/codeStructureService";
import { readCodeStructureFile, truncateCodeSymbols } from "./codeStructureCommon";

export function createModuleReportTool(
  config: ToolConfiguration,
  service: CodeStructureService = getCodeStructureService()
): Tool {
  return tool({
    description: TOOL_DEFINITIONS.module_report.description,
    inputSchema: TOOL_DEFINITIONS.module_report.schema,
    execute: async (
      args: ModuleReportToolArgs,
      { abortSignal }
    ): Promise<ModuleReportToolResult> => {
      const file = await readCodeStructureFile(config, args.path, abortSignal);
      if (!file.success) return file;

      try {
        const report = await service.analyze(file.path, file.source, abortSignal);
        const limited = truncateCodeSymbols(report.symbols, CODE_STRUCTURE_MAX_SYMBOLS);
        return {
          success: true,
          ...report,
          symbols: limited.symbols,
          truncated: limited.truncated,
          ...(file.warning ? { warning: file.warning } : {}),
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
