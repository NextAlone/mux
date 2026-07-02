import * as fsPromises from "fs/promises";
import * as path from "path";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { forgetJjWorkspace } from "@/node/vcs/jj";

async function worktreePathExists(worktreePath: string): Promise<boolean> {
  try {
    await fsPromises.access(worktreePath);
    return true;
  } catch {
    return false;
  }
}

async function forgetWorkspaceBestEffort(projectPath: string, worktreePath: string): Promise<void> {
  const workspaceName = path.basename(worktreePath);
  if (workspaceName.trim().length === 0) {
    return;
  }

  try {
    await forgetJjWorkspace({ projectPath, workspaceName });
  } catch (error) {
    log.debug("Failed to forget managed jj workspace during cleanup", {
      projectPath,
      workspaceName,
      error: getErrorMessage(error),
    });
  }
}

export async function removeManagedGitWorktree(
  projectPath: string,
  worktreePath: string
): Promise<void> {
  const resolvedProjectPath = path.resolve(projectPath);
  const resolvedWorktreePath = path.resolve(worktreePath);

  if (resolvedProjectPath === resolvedWorktreePath) {
    throw new Error("Refusing to delete the project checkout as a managed workspace");
  }

  await forgetWorkspaceBestEffort(projectPath, worktreePath);

  if (!(await worktreePathExists(worktreePath))) {
    return;
  }

  try {
    await fsPromises.rm(resolvedWorktreePath, { recursive: true, force: true });
  } catch (error) {
    const worktreeStillExists = await worktreePathExists(worktreePath);
    if (worktreeStillExists) {
      throw error;
    }
  }
}
