/**
 * Small pure helpers shared by TaskService and GitPatchArtifactService.
 * Extracted to a standalone module to avoid circular imports.
 */
import assert from "node:assert/strict";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { Runtime } from "@/node/runtime/Runtime";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { resolveModelFallbackChain } from "@/common/utils/ai/modelFallbacks";

export function coerceNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function tryReadJjCurrentRevision(
  runtime: Runtime,
  workspacePath: string
): Promise<{ changeId: string; commitId?: string } | undefined> {
  assert(workspacePath.length > 0, "tryReadJjCurrentRevision: workspacePath must be non-empty");

  try {
    const result = await execBuffered(
      runtime,
      `jj --no-pager --color never log --no-graph -r @ -T 'change_id ++ "\\n" ++ commit_id ++ "\\n"' -n 1`,
      {
        cwd: workspacePath,
        timeout: 10,
      }
    );
    if (result.exitCode !== 0) {
      return undefined;
    }

    const [changeId, commitId] = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return changeId ? { changeId, commitId } : undefined;
  } catch {
    return undefined;
  }
}

export async function tryReadJjCurrentChangeId(
  runtime: Runtime,
  workspacePath: string
): Promise<string | undefined> {
  assert(workspacePath.length > 0, "tryReadJjCurrentChangeId: workspacePath must be non-empty");
  return (await tryReadJjCurrentRevision(runtime, workspacePath))?.changeId;
}

export async function tryResolveJjChangeId(
  runtime: Runtime,
  workspacePath: string,
  revision: string
): Promise<string | undefined> {
  assert(workspacePath.length > 0, "tryResolveJjChangeId: workspacePath must be non-empty");
  assert(revision.length > 0, "tryResolveJjChangeId: revision must be non-empty");

  try {
    const safeRevision = `'${revision.replace(/'/g, `'\\''`)}'`;
    const result = await execBuffered(
      runtime,
      `jj --no-pager --color never log --no-graph -r ${safeRevision} -T 'change_id ++ "\\n"' -n 1`,
      {
        cwd: workspacePath,
        timeout: 10,
      }
    );
    if (result.exitCode !== 0) {
      return undefined;
    }

    const changeId = result.stdout.trim();
    return changeId.length > 0 ? changeId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the effective refusal-fallback chain for a workspace's turn.
 * Task children can opt out via taskOnRefusal: "fail" (e.g. workflow verifier
 * steps that demand an honest terminal failure instead of a silent model
 * swap). Workspaces not found in config (non-task sends) keep the configured
 * chain.
 */
export function resolveWorkspaceModelFallbackChain(
  config: ReturnType<Config["loadConfigOrDefault"]>,
  workspaceId: string,
  canonicalModelString: string
): string[] {
  assert(workspaceId.length > 0, "resolveWorkspaceModelFallbackChain: workspaceId required");
  const chain = resolveModelFallbackChain(config.modelFallbacks, canonicalModelString);
  if (chain.length === 0) {
    return chain;
  }
  const entry = findWorkspaceEntry(config, workspaceId);
  return entry?.workspace.taskOnRefusal === "fail" ? [] : chain;
}

export function findWorkspaceEntry(
  config: ReturnType<Config["loadConfigOrDefault"]>,
  workspaceId: string
): { projectPath: string; workspace: WorkspaceConfigEntry } | null {
  for (const [projectPath, project] of config.projects) {
    for (const workspace of project.workspaces) {
      if (workspace.id === workspaceId) {
        return { projectPath, workspace };
      }
    }
  }
  return null;
}

/**
 * Walk the parentWorkspaceId chain to compute task nesting depth.
 * Detects cycles (max 32 hops).
 */
export function getTaskDepthFromConfig(
  config: ReturnType<Config["loadConfigOrDefault"]>,
  workspaceId: string
): number {
  const parentById = new Map<string, string | undefined>();
  for (const project of config.projects.values()) {
    for (const workspace of project.workspaces) {
      if (!workspace.id) continue;
      parentById.set(workspace.id, workspace.parentWorkspaceId);
    }
  }

  let depth = 0;
  let current = workspaceId;
  for (let i = 0; i < 32; i++) {
    const parent = parentById.get(current);
    if (!parent) break;
    depth += 1;
    current = parent;
  }

  if (depth >= 32) {
    throw new Error(
      `getTaskDepthFromConfig: possible parentWorkspaceId cycle starting at ${workspaceId}`
    );
  }

  return depth;
}
