import { getErrorMessage } from "@/common/utils/errors";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import type { CodeSymbol } from "@/node/services/codeStructure/codeStructureAnalysis";
import { readFileString } from "@/node/utils/runtime/helpers";
import { resolvePathWithinCwd, validateFileSize } from "./fileCommon";

export type CodeStructureFileResult =
  | {
      success: true;
      path: string;
      resolvedPath: string;
      source: string;
      warning?: string;
    }
  | { success: false; error: string };

export async function readCodeStructureFile(
  config: ToolConfiguration,
  requestedPath: string,
  abortSignal?: AbortSignal
): Promise<CodeStructureFileResult> {
  try {
    const { correctedPath, resolvedPath, warning } = resolvePathWithinCwd(
      requestedPath,
      config.cwd,
      config.runtime
    );
    const stats = await config.runtime.stat(resolvedPath, abortSignal);
    if (stats.isDirectory) {
      return { success: false, error: `Path is a directory, not a file: ${requestedPath}` };
    }
    const sizeError = validateFileSize(stats);
    if (sizeError) return { success: false, error: sizeError.error };

    return {
      success: true,
      path: correctedPath,
      resolvedPath,
      source: await readFileString(config.runtime, resolvedPath, abortSignal),
      ...(warning ? { warning } : {}),
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to read '${requestedPath}': ${getErrorMessage(error)}`,
    };
  }
}

export function truncateCodeSymbols(
  symbols: CodeSymbol[],
  maxSymbols: number
): { symbols: CodeSymbol[]; truncated: boolean } {
  let remaining = maxSymbols;
  let truncated = false;

  const visit = (items: CodeSymbol[]): CodeSymbol[] => {
    const result: CodeSymbol[] = [];
    for (const item of items) {
      if (remaining === 0) {
        truncated = true;
        break;
      }
      remaining -= 1;
      const members = item.members ? visit(item.members) : undefined;
      result.push({
        ...item,
        ...(members && members.length > 0 ? { members } : { members: undefined }),
      });
    }
    return result;
  };

  return { symbols: visit(symbols), truncated };
}
