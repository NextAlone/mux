/**
 * Utilities for reading file lines to expand diff context.
 * Used by the read-more feature in code review.
 */

import type { APIClient } from "@/browser/contexts/API";
import { normalizeRepoRootFilePath, repoRootBashOptions } from "@/browser/utils/executeBash";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { normalizeJjDiffBase } from "@/common/utils/git/diffParser";
import { shellQuote } from "@/common/utils/shell";

/** Number of lines to expand per click */
export const LINES_PER_EXPANSION = 20;

/**
 * Read lines from a file at a specific jj revision.
 * @returns Array of lines or null if error
 */
export async function readFileLines(
  api: APIClient | null,
  workspaceId: string,
  workspaceMetadata: Pick<FrontendWorkspaceMetadata, "projects"> | null | undefined,
  filePath: string,
  startLine: number,
  endLine: number,
  gitRef: string,
  repoRootProjectPath?: string | null
): Promise<string[] | null> {
  if (!api || startLine < 1 || endLine < startLine) return null;

  const repoRootFilePath = normalizeRepoRootFilePath(
    workspaceMetadata,
    filePath,
    repoRootProjectPath
  );
  const script = gitRef
    ? `jj --no-pager --color never file show --revision ${shellQuote(gitRef)} -- ${shellQuote(repoRootFilePath)} 2>/dev/null | sed -n '${startLine},${endLine}p'`
    : `sed -n '${startLine},${endLine}p' "${filePath.replace(/"/g, '\\"')}"`;

  // Plain reads must stay on the shared container root for sibling-project paths, while
  // revision lookups still need repo-root jj context for `jj file show`. Path-targeted callers pass
  // the owning project explicitly so multi-project repo-root execution lands in the right checkout.
  const result = await api.workspace.executeBash({
    workspaceId,
    script,
    options: gitRef ? repoRootBashOptions(3, repoRootProjectPath) : { timeout_secs: 3 },
  });

  if (!result?.success) return null;

  // Empty output means we're past EOF - return empty array (not null)
  if (!result.data.output) return [];

  const lines = result.data.output.split("\n");
  // Remove trailing empty line if present
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Determine which jj revision to use for reading file context.
 */
export function getOldFileRef(diffBase: string, _includeUncommitted: boolean): string {
  return normalizeJjDiffBase(diffBase);
}

/**
 * Format lines as diff context (prefix with space).
 */
export function formatAsContextLines(lines: string[]): string {
  return lines.map((line) => ` ${line}`).join("\n");
}
