import * as fsPromises from "fs/promises";
import * as path from "path";
import type {
  WorkspaceCreationResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  InitLogger,
} from "@/node/runtime/Runtime";
import { listLocalBranches } from "@/node/git";
import { getProjectName } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";
import { expandTilde } from "@/node/runtime/tildeExpansion";
import { log } from "@/node/services/log";
import {
  createJjWorkspace,
  forgetJjWorkspace,
  getCurrentBookmark,
  getCurrentJjChangeId,
  hasJjWorkspaceChanges,
  renameJjWorkspace,
} from "@/node/vcs/jj";
import { syncMuxignoreFiles } from "./muxignore";

const JJ_WORKSPACE_MAP_FILENAME = "mux-workspaces.json";

export class WorktreeManager {
  private readonly srcBaseDir: string;

  constructor(srcBaseDir: string) {
    // Expand tilde to actual home directory path for local file system operations
    this.srcBaseDir = expandTilde(srcBaseDir);
  }

  getWorkspacePath(projectPath: string, workspaceName: string): string {
    const projectName = getProjectName(projectPath);
    return path.join(this.srcBaseDir, projectName, workspaceName);
  }

  private async forceRemoveWorkspaceDirectory(workspacePath: string): Promise<void> {
    await fsPromises.rm(workspacePath, { recursive: true, force: true });
  }

  async createWorkspace(params: {
    projectPath: string;
    branchName: string;
    directoryName?: string;
    trunkBranch: string;
    startPoint?: string;
    skipRemoteSync?: boolean;
    workspacePathOverride?: string;
    initLogger: InitLogger;
    abortSignal?: AbortSignal;
    env?: Record<string, string>;
    trusted?: boolean;
  }): Promise<WorkspaceCreationResult> {
    const { projectPath, branchName, trunkBranch, initLogger } = params;
    const workspaceName = params.directoryName ?? branchName;
    const workspacePath =
      params.workspacePathOverride ?? this.getWorkspacePath(projectPath, workspaceName);
    const trimmedStartPoint = params.startPoint?.trim();
    const startPoint =
      trimmedStartPoint && trimmedStartPoint.length > 0 ? trimmedStartPoint : undefined;
    let workspaceCreated = false;

    try {
      initLogger.logStep("Creating jj workspace...");

      // Create parent directory if needed
      const parentDir = path.dirname(workspacePath);
      try {
        await fsPromises.access(parentDir);
      } catch {
        await fsPromises.mkdir(parentDir, { recursive: true });
      }

      // Check if workspace already exists
      try {
        await fsPromises.access(workspacePath);
        return {
          success: false,
          error: `Workspace already exists at ${workspacePath}`,
        };
      } catch {
        // Workspace doesn't exist, proceed with creation
      }

      const localBookmarks = await listLocalBranches(projectPath);
      const branchExists = localBookmarks.includes(branchName);
      const baseRevision = startPoint ?? (branchExists ? branchName : trunkBranch);
      if (!startPoint && !branchExists && !localBookmarks.includes(trunkBranch)) {
        return {
          success: false,
          error: `Source bookmark "${trunkBranch}" does not exist locally`,
        };
      }
      await createJjWorkspace({
        projectPath,
        workspacePath,
        workspaceName,
        revision: baseRevision,
        message: branchName,
      });
      workspaceCreated = true;

      initLogger.logStep("Jj workspace created successfully");

      // Sync gitignored files declared in .muxignore (e.g. .env)
      // before init hooks run so they have access to secrets/config
      initLogger.logStep("Syncing .muxignore files...");
      await syncMuxignoreFiles(projectPath, workspacePath);

      await this.persistWorkspaceBranchMapping(projectPath, workspaceName, branchName);
      return { success: true, workspacePath };
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      if (!workspaceCreated) {
        return {
          success: false,
          error: errorMessage,
        };
      }

      try {
        await this.rollbackFailedWorkspaceCreation({
          projectPath,
          workspacePath,
          workspaceName,
        });
        return {
          success: false,
          error: errorMessage,
        };
      } catch (rollbackError) {
        return {
          success: false,
          error: `${errorMessage} (rollback failed: ${getErrorMessage(rollbackError)})`,
        };
      }
    }
  }

  private async rollbackFailedWorkspaceCreation(args: {
    projectPath: string;
    workspacePath: string;
    workspaceName: string;
  }): Promise<void> {
    try {
      await forgetJjWorkspace({ projectPath: args.projectPath, workspaceName: args.workspaceName });
    } catch {
      // Keep rollback idempotent: directory cleanup below still makes retries possible.
    }
    await this.forceRemoveWorkspaceDirectory(args.workspacePath);
  }

  async renameWorkspace(
    projectPath: string,
    oldName: string,
    newName: string,
    _trusted?: boolean
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  > {
    // Compute workspace paths using canonical method
    const oldPath = this.getWorkspacePath(projectPath, oldName);
    const newPath = this.getWorkspacePath(projectPath, newName);

    try {
      await renameJjWorkspace({ workspacePath: oldPath, newWorkspaceName: newName });
      await fsPromises.rename(oldPath, newPath);

      const originalBookmark =
        (await this.getPersistedWorkspaceBranchName(projectPath, oldName)) ?? oldName;
      await this.updateWorkspaceBranchMapping(projectPath, oldName, newName, originalBookmark);
      return { success: true, oldPath, newPath };
    } catch (error) {
      return { success: false, error: `Failed to rename workspace: ${getErrorMessage(error)}` };
    }
  }

  async canDeleteWorkspaceWithoutForce(
    projectPath: string,
    workspaceName: string,
    _trusted?: boolean
  ): Promise<{ success: true } | { success: false; error: string }> {
    const workspacePath = this.getWorkspacePath(projectPath, workspaceName);
    const isInPlace = projectPath === workspaceName;

    try {
      await fsPromises.access(workspacePath);
    } catch {
      return { success: true };
    }

    if (isInPlace) {
      return { success: true };
    }

    try {
      if (await hasJjWorkspaceChanges(workspacePath)) {
        return {
          success: false,
          error: "Workspace has working-copy changes",
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to inspect workspace before deletion: ${getErrorMessage(error)}`,
      };
    }

    return { success: true };
  }

  async deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    trusted?: boolean
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    // In-place workspaces are identified by projectPath === workspaceName.
    // These are direct workspace directories (e.g., CLI/benchmark sessions), not managed workspaces.
    const isInPlace = projectPath === workspaceName;
    const deletedPath = this.getWorkspacePath(projectPath, workspaceName);

    const forgetWorkspaceAndSucceed = async () => {
      if (!isInPlace) {
        await forgetJjWorkspace({ projectPath, workspaceName });
      }
      await this.deletePersistedWorkspaceBranchMapping(projectPath, workspaceName);
      return { success: true as const, deletedPath };
    };

    try {
      await fsPromises.access(deletedPath);
    } catch {
      return forgetWorkspaceAndSucceed();
    }

    // For in-place workspaces, there's no managed workspace directory to remove.
    // The workspace directory itself is the user's real project checkout.
    if (isInPlace) {
      return { success: true, deletedPath };
    }

    if (!force) {
      const canDelete = await this.canDeleteWorkspaceWithoutForce(
        projectPath,
        workspaceName,
        trusted
      );
      if (!canDelete.success) {
        return canDelete;
      }
    }

    try {
      await forgetWorkspaceAndSucceed();
      await this.forceRemoveWorkspaceDirectory(deletedPath);
      return { success: true, deletedPath };
    } catch (error) {
      return { success: false, error: `Failed to delete workspace: ${getErrorMessage(error)}` };
    }
  }

  private async persistWorkspaceBranchMapping(
    projectPath: string,
    workspaceName: string,
    branchName: string
  ): Promise<void> {
    // Divergent workspace and source names rely on this mapping for safe stale-checkout
    // cleanup, so callers must see persistence failures instead of silently proceeding.
    const branchMap = await this.readWorkspaceBranchMap(projectPath);
    branchMap[workspaceName] = branchName;
    await this.writeWorkspaceBranchMap(projectPath, branchMap);
  }

  private async updateWorkspaceBranchMapping(
    projectPath: string,
    oldWorkspaceName: string,
    newWorkspaceName: string,
    branchName: string | null
  ): Promise<void> {
    // Rename can leave the source name different from the workspace directory, so keep the
    // mapping update on the main control path rather than silently ignoring write failures.
    const branchMap = await this.readWorkspaceBranchMap(projectPath);
    const resolvedBranchName = branchName?.trim() ?? branchMap[oldWorkspaceName]?.trim();
    delete branchMap[oldWorkspaceName];
    if (resolvedBranchName) {
      branchMap[newWorkspaceName] = resolvedBranchName;
    }
    await this.writeWorkspaceBranchMap(projectPath, branchMap);
  }

  private async getPersistedWorkspaceBranchName(
    projectPath: string,
    workspaceName: string
  ): Promise<string | null> {
    const branchName = (await this.readWorkspaceBranchMap(projectPath))[workspaceName]?.trim();
    return branchName || null;
  }

  private async deletePersistedWorkspaceBranchMapping(
    projectPath: string,
    workspaceName: string
  ): Promise<void> {
    try {
      const branchMap = await this.readWorkspaceBranchMap(projectPath);
      if (!(workspaceName in branchMap)) {
        return;
      }
      delete branchMap[workspaceName];
      await this.writeWorkspaceBranchMap(projectPath, branchMap);
    } catch (error) {
      log.debug("Failed to delete workspace source mapping", {
        projectPath,
        workspaceName,
        error: getErrorMessage(error),
      });
    }
  }

  private async readWorkspaceBranchMap(projectPath: string): Promise<Record<string, string>> {
    try {
      const contents = await fsPromises.readFile(
        await this.getWorkspaceBranchMapPath(projectPath),
        "utf8"
      );
      const parsed: unknown = JSON.parse(contents);
      if (typeof parsed !== "object" || parsed === null) {
        return {};
      }
      return Object.fromEntries(
        Object.entries(parsed).filter(([workspaceName, branchName]) => {
          return (
            workspaceName.trim().length > 0 &&
            typeof branchName === "string" &&
            branchName.trim().length > 0
          );
        })
      );
    } catch {
      return {};
    }
  }

  private async writeWorkspaceBranchMap(
    projectPath: string,
    branchMap: Record<string, string>
  ): Promise<void> {
    const branchMapPath = await this.getWorkspaceBranchMapPath(projectPath);
    if (Object.keys(branchMap).length === 0) {
      await fsPromises.rm(branchMapPath, { force: true });
      return;
    }
    await fsPromises.writeFile(branchMapPath, `${JSON.stringify(branchMap, null, 2)}\n`);
  }

  private async getWorkspaceBranchMapPath(projectPath: string): Promise<string> {
    const jjRepoPath = path.join(projectPath, ".jj", "repo");
    try {
      const jjRepoStat = await fsPromises.stat(jjRepoPath);
      if (jjRepoStat.isDirectory()) {
        return path.join(jjRepoPath, JJ_WORKSPACE_MAP_FILENAME);
      }
    } catch {
      // Fall through to legacy git metadata for pre-jj workspaces.
    }

    const gitPath = path.join(projectPath, ".git");

    try {
      const gitPathStat = await fsPromises.stat(gitPath);
      if (gitPathStat.isDirectory()) {
        return path.join(gitPath, "mux-workspace-branches.json");
      }

      const gitDirRef = await fsPromises.readFile(gitPath, "utf8");
      const gitDirPrefix = "gitdir:";
      const gitDirLine = gitDirRef.trim();
      if (gitDirLine.startsWith(gitDirPrefix)) {
        return path.join(
          path.resolve(projectPath, gitDirLine.slice(gitDirPrefix.length).trim()),
          "mux-workspace-branches.json"
        );
      }
    } catch {
      // Fall through to the default .git path when git metadata is unavailable.
    }

    return path.join(gitPath, "mux-workspace-branches.json");
  }

  async forkWorkspace(
    params: WorkspaceForkParams,
    options?: {
      /**
       * Explicit source checkout path. Overrides the name-derived path for sources whose
       * persisted path diverges from their name (e.g. isolation: "none" tasks sharing a parent
       * checkout). See WorktreeRuntime.forkWorkspace.
       */
      sourceWorkspacePath?: string;
    }
  ): Promise<WorkspaceForkResult> {
    const { projectPath, sourceWorkspaceName, newWorkspaceName, initLogger } = params;

    // Get source workspace path
    const sourceWorkspacePath =
      options?.sourceWorkspacePath ?? this.getWorkspacePath(projectPath, sourceWorkspaceName);

    try {
      const sourceBookmark = await getCurrentBookmark(sourceWorkspacePath);
      const sourceChangeId = await getCurrentJjChangeId(sourceWorkspacePath);
      const sourceRevision = sourceChangeId ?? sourceBookmark;

      if (!sourceRevision) {
        return {
          success: false,
          error: "Failed to detect source revision in source workspace",
        };
      }

      // Fork from the source workspace's current jj change. Workspaces are often anonymous
      // changes, so bookmarks are display metadata rather than the source of truth.
      const createResult = await this.createWorkspace({
        projectPath,
        branchName: newWorkspaceName,
        directoryName: newWorkspaceName,
        trunkBranch: sourceBookmark ?? sourceRevision,
        startPoint: sourceRevision,
        initLogger,
        abortSignal: params.abortSignal,
        env: params.env,
        trusted: params.trusted,
      });

      if (!createResult.success || !createResult.workspacePath) {
        return {
          success: false,
          error: createResult.error ?? "Failed to create workspace",
        };
      }

      return {
        success: true,
        workspacePath: createResult.workspacePath,
        sourceBranch: sourceBookmark ?? sourceRevision,
      };
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  }
}
