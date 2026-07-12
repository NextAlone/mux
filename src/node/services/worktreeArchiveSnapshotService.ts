import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import type { ArchiveLossyUntrackedFilesConfirmation } from "@/common/orpc/schemas/api";
import type { WorktreeArchiveSnapshot } from "@/common/schemas/project";
import { Err, Ok, type Result } from "@/common/types/result";
import { isWorktreeRuntime } from "@/common/types/runtime";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { getErrorMessage } from "@/common/utils/errors";
import type { Config } from "@/node/config";
import type { InitLogger } from "@/node/runtime/Runtime";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { log } from "@/node/services/log";
import { coerceNonEmptyString, findWorkspaceEntry } from "@/node/services/taskUtils";
import { getWorkspaceProjectRepos } from "@/node/services/workspaceProjectRepos";
import { isPathInsideDir } from "@/node/utils/pathUtils";
import {
  editJjRevision,
  forgetJjWorkspace,
  getCurrentJjRevisionIdentity,
  getJjSparsePatterns,
  getJjWorkspaceRegistration,
  listJjSubmodulePaths,
  listJjUntrackedPaths,
  resolveVisibleJjRevisionIdentities,
  setJjSparsePatterns,
  type JjRevisionIdentity,
} from "@/node/vcs/jj";

const LEGACY_GIT_ARCHIVE_SNAPSHOT_UNSUPPORTED =
  "Legacy Git archive snapshots cannot be restored by the JJ-native snapshot service.";
const JJ_WORKSPACE_MAP_FILENAME = "mux-workspaces.json";
const NOOP_INIT_LOGGER: InitLogger = {
  logStep: () => undefined,
  logStdout: () => undefined,
  logStderr: () => undefined,
  logComplete: () => undefined,
  enterHookPhase: () => undefined,
};

type CaptureSnapshotForArchiveError = string | ArchiveLossyUntrackedFilesConfirmation;
type JjArchiveSnapshot = Extract<WorktreeArchiveSnapshot, { version: 2 }>;
type JjArchiveSnapshotProject = JjArchiveSnapshot["projects"][number];

interface SnapshotContext {
  workspaceName: string;
  workspacePath: string;
  projectPath: string;
  projectName: string;
  storageKey: string;
  sourceBookmark: string;
}

function getPersistedWorkspaceName(workspace: { name?: string; path: string }): string | undefined {
  return (
    coerceNonEmptyString(workspace.name) ?? coerceNonEmptyString(path.basename(workspace.path))
  );
}

function findWorkspaceEntryByIdOrPath(
  config: Config,
  configSnapshot: ReturnType<Config["loadConfigOrDefault"]>,
  workspaceId: string
): ReturnType<typeof findWorkspaceEntry> {
  const directMatch = findWorkspaceEntry(configSnapshot, workspaceId);
  if (directMatch) {
    return directMatch;
  }

  const locatedWorkspace = config.findWorkspace(workspaceId);
  if (!locatedWorkspace) {
    return null;
  }

  const projectConfig = configSnapshot.projects.get(locatedWorkspace.projectPath);
  const workspace = projectConfig?.workspaces.find(
    (entry) => entry.path === locatedWorkspace.workspacePath
  );
  return workspace ? { projectPath: locatedWorkspace.projectPath, workspace } : null;
}

export class WorktreeArchiveSnapshotService {
  constructor(private readonly config: Config) {}

  async preflightSnapshotForArchive(args: {
    workspaceId: string;
    workspaceMetadata: WorkspaceMetadata;
  }): Promise<Result<void>> {
    const unsupportedPaths = await this.getUnsupportedUntrackedPaths(args);
    if (!unsupportedPaths.success) {
      return unsupportedPaths;
    }
    if (unsupportedPaths.data.length > 0) {
      return Err(
        `Archive snapshot does not support untracked files: ${unsupportedPaths.data.join(", ")}`
      );
    }
    return Ok(undefined);
  }

  async getUnsupportedUntrackedPaths(args: {
    workspaceId: string;
    workspaceMetadata: WorkspaceMetadata;
  }): Promise<Result<string[]>> {
    assert(
      args.workspaceId.trim().length > 0,
      "getUnsupportedUntrackedPaths: workspaceId must be non-empty"
    );
    if (!isWorktreeRuntime(args.workspaceMetadata.runtimeConfig)) {
      return Err("Archive snapshots are only supported for JJ Workspace runtimes");
    }

    try {
      const { workspaceName, workspacePath, projectRepos } = this.getWorkspaceContext(args);
      const unsupportedPaths: string[] = [];
      for (const projectRepo of projectRepos) {
        const submodulePaths = await listJjSubmodulePaths(projectRepo.repoCwd);
        if (submodulePaths.length > 0) {
          throw new Error(
            `JJ archive snapshots do not support submodules yet: ${submodulePaths.join(", ")}`
          );
        }
        // `jj status` snapshots and auto-tracks ordinary additions first, then reports only paths
        // excluded by ignore/size/auto-track policy as unsupported leftovers.
        const paths = await listJjUntrackedPaths(projectRepo.repoCwd);
        if (projectRepos.length === 1) {
          unsupportedPaths.push(...paths);
        } else {
          unsupportedPaths.push(...paths.map((entry) => `${projectRepo.projectName}/${entry}`));
        }
      }
      log.debug("Checked JJ workspace archive readiness", {
        workspaceId: args.workspaceId,
        workspaceName,
        workspacePath,
      });
      return Ok(unsupportedPaths.sort());
    } catch (error) {
      return Err(`Failed to check archive readiness: ${getErrorMessage(error)}`);
    }
  }

  async captureSnapshotForArchive(args: {
    workspaceId: string;
    workspaceMetadata: WorkspaceMetadata;
    acknowledgedUntrackedPaths?: string[];
  }): Promise<Result<WorktreeArchiveSnapshot, CaptureSnapshotForArchiveError>> {
    assert(
      args.workspaceId.trim().length > 0,
      "captureSnapshotForArchive: workspaceId must be non-empty"
    );
    if (!isWorktreeRuntime(args.workspaceMetadata.runtimeConfig)) {
      return Err("Archive snapshots are only supported for JJ Workspace runtimes");
    }

    const readiness = await this.validateAcknowledgedUntrackedPaths(args);
    if (!readiness.success) {
      return readiness;
    }

    try {
      const context = await this.getSingleProjectSnapshotContext(args);
      return Ok(await this.captureJjSnapshot(context));
    } catch (error) {
      return Err(`Failed to capture JJ archive snapshot: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Re-snapshot immediately before deletion so writes that land after the initial archive capture
   * are persisted before the checkout disappears. The final pointer is written durably before the
   * strict workspace-forget/delete sequence begins.
   */
  async finalizeSnapshotForArchive(args: {
    workspaceId: string;
    workspaceMetadata: WorkspaceMetadata;
    acknowledgedUntrackedPaths?: string[];
  }): Promise<Result<void>> {
    const finalCapture = await this.captureSnapshotForArchive(args);
    if (!finalCapture.success) {
      return Err(
        typeof finalCapture.error === "string"
          ? finalCapture.error
          : "Checkout gained untracked files after archive confirmation; keeping it on disk."
      );
    }
    if (finalCapture.data.version !== 2) {
      return Err("Expected a JJ-native archive snapshot before checkout deletion");
    }
    const finalSnapshot = finalCapture.data;

    try {
      let snapshotPersisted = false;
      await this.config.editConfig((config) => {
        const workspaceEntry = findWorkspaceEntryByIdOrPath(this.config, config, args.workspaceId);
        if (!workspaceEntry) {
          throw new Error("Workspace disappeared before archive snapshot finalization");
        }
        const currentSnapshot = workspaceEntry.workspace.worktreeArchiveSnapshot;
        if (currentSnapshot?.version !== 2) {
          throw new Error("Initial archive snapshot metadata is missing");
        }
        if (currentSnapshot.projects[0]?.changeId !== finalSnapshot.projects[0]?.changeId) {
          throw new Error("Archive snapshot changed concurrently before finalization");
        }
        workspaceEntry.workspace.worktreeArchiveSnapshot = finalSnapshot;
        snapshotPersisted = true;
        return config;
      });
      assert(snapshotPersisted, "finalizeSnapshotForArchive: final snapshot was not persisted");

      const projectSnapshot = finalSnapshot.projects[0];
      assert(projectSnapshot, "finalizeSnapshotForArchive: missing project snapshot");
      await this.strictlyRemoveWorkspaceCheckout({
        projectPath: projectSnapshot.projectPath,
        workspaceName: projectSnapshot.workspaceName,
        workspacePath: this.getPersistedWorkspacePath(args.workspaceId),
      });
      return Ok(undefined);
    } catch (error) {
      return Err(`Failed to finalize JJ archive snapshot: ${getErrorMessage(error)}`);
    }
  }

  async restoreSnapshotAfterUnarchive(args: {
    workspaceId: string;
    workspaceMetadata: WorkspaceMetadata;
  }): Promise<Result<"restored" | "skipped">> {
    assert(
      args.workspaceId.trim().length > 0,
      "restoreSnapshotAfterUnarchive: workspaceId must be non-empty"
    );

    const configSnapshot = this.config.loadConfigOrDefault();
    const workspaceEntry = findWorkspaceEntryByIdOrPath(
      this.config,
      configSnapshot,
      args.workspaceId
    );
    if (!workspaceEntry) {
      return Err("Workspace not found in config");
    }
    const snapshot = workspaceEntry.workspace.worktreeArchiveSnapshot;
    if (!snapshot) {
      return Ok("skipped");
    }
    if (snapshot.version === 1) {
      return Err(LEGACY_GIT_ARCHIVE_SNAPSHOT_UNSUPPORTED);
    }
    if (!isWorktreeRuntime(args.workspaceMetadata.runtimeConfig)) {
      return Err("Archive snapshot restore is only supported for JJ Workspace runtimes");
    }

    const projectSnapshot = snapshot.projects[0];
    if (!projectSnapshot) {
      return Err("JJ archive snapshot has no project state");
    }
    const workspacePath = workspaceEntry.workspace.path;
    let createdWorkspacePath: string | undefined;
    let checkoutReady = false;

    try {
      const target = await this.resolveRestoreTarget(projectSnapshot);
      if (await this.pathExists(workspacePath)) {
        const current = await getCurrentJjRevisionIdentity(workspacePath);
        if (current.changeId !== target.changeId) {
          throw new Error(
            "Persisted workspace path exists at a different JJ change; refusing to overwrite it."
          );
        }
        await this.clearSnapshotState(args.workspaceId, snapshot);
        return Ok("skipped");
      }

      // A previous cleanup may have removed the directory without forgetting its workspace name.
      // Only forget registrations that still point at this persisted path; a user may have reused
      // the name for a different workspace while this one was archived.
      const workspaceRegistration = await getJjWorkspaceRegistration({
        projectPath: projectSnapshot.projectPath,
        workspaceName: projectSnapshot.workspaceName,
      });
      if (
        workspaceRegistration.kind === "present" &&
        path.resolve(workspaceRegistration.root) !== path.resolve(workspacePath)
      ) {
        throw new Error(
          `JJ workspace name ${projectSnapshot.workspaceName} is now registered at another path.`
        );
      }
      if (workspaceRegistration.kind !== "absent") {
        await forgetJjWorkspace({
          projectPath: projectSnapshot.projectPath,
          workspaceName: projectSnapshot.workspaceName,
        });
      }

      const trusted = configSnapshot.projects.get(projectSnapshot.projectPath)?.trusted === true;
      const runtime = createRuntime(args.workspaceMetadata.runtimeConfig, {
        projectPath: projectSnapshot.projectPath,
        workspaceName: projectSnapshot.workspaceName,
        workspacePath,
      });
      const createResult = await runtime.createWorkspace({
        projectPath: projectSnapshot.projectPath,
        branchName: projectSnapshot.sourceBookmark,
        trunkBranch: projectSnapshot.sourceBookmark,
        directoryName: projectSnapshot.workspaceName,
        startPoint: target.commitId,
        skipRemoteSync: true,
        workspacePathOverride: workspacePath,
        initLogger: NOOP_INIT_LOGGER,
        trusted,
      });
      if (!createResult.success || !createResult.workspacePath) {
        throw new Error(createResult.error ?? "Runtime did not return a restored workspace path");
      }
      createdWorkspacePath = createResult.workspacePath;

      await editJjRevision({ workspacePath: createdWorkspacePath, revision: target.commitId });
      await setJjSparsePatterns({
        workspacePath: createdWorkspacePath,
        patterns: projectSnapshot.sparsePatterns,
      });

      const restored = await getCurrentJjRevisionIdentity(createdWorkspacePath);
      if (restored.changeId !== target.changeId || restored.commitId !== target.commitId) {
        throw new Error("Restored JJ workspace does not match the selected archive revision");
      }

      checkoutReady = true;
      await this.clearSnapshotState(args.workspaceId, snapshot);
      return Ok("restored");
    } catch (error) {
      log.debug("Failed to restore JJ checkout archive snapshot", {
        workspaceId: args.workspaceId,
        error: getErrorMessage(error),
      });
      if (!checkoutReady && createdWorkspacePath) {
        await this.cleanupFailedRestore({
          projectPath: projectSnapshot.projectPath,
          workspaceName: projectSnapshot.workspaceName,
          workspacePath: createdWorkspacePath,
        });
      }
      if (checkoutReady) {
        // The user-visible checkout is valid; stale metadata can self-heal on the next unarchive.
        return Ok("restored");
      }
      return Err(`Failed to restore JJ archive snapshot: ${getErrorMessage(error)}`);
    }
  }

  private getWorkspaceContext(args: { workspaceId: string; workspaceMetadata: WorkspaceMetadata }) {
    const configSnapshot = this.config.loadConfigOrDefault();
    const workspaceEntry = findWorkspaceEntryByIdOrPath(
      this.config,
      configSnapshot,
      args.workspaceId
    );
    if (!workspaceEntry) {
      throw new Error("Workspace not found in config");
    }
    const workspaceName = getPersistedWorkspaceName(workspaceEntry.workspace);
    if (!workspaceName) {
      throw new Error("Workspace is missing its persisted source name");
    }
    const projectRepos = getWorkspaceProjectRepos({
      workspaceId: args.workspaceId,
      workspaceName,
      workspacePath: workspaceEntry.workspace.path,
      runtimeConfig: args.workspaceMetadata.runtimeConfig,
      projectPath: args.workspaceMetadata.projectPath,
      projectName: args.workspaceMetadata.projectName,
      projects: workspaceEntry.workspace.projects,
    });
    if (projectRepos.length === 0) {
      throw new Error("Workspace has no project repositories");
    }
    return {
      configSnapshot,
      workspaceEntry,
      workspaceName,
      workspacePath: workspaceEntry.workspace.path,
      projectRepos,
    };
  }

  private async getSingleProjectSnapshotContext(args: {
    workspaceId: string;
    workspaceMetadata: WorkspaceMetadata;
  }): Promise<SnapshotContext> {
    const context = this.getWorkspaceContext(args);
    if (context.projectRepos.length !== 1) {
      throw new Error("JJ-native archive snapshots currently support one project per workspace");
    }
    const projectRepo = context.projectRepos[0];
    assert(projectRepo, "getSingleProjectSnapshotContext: missing project repo");
    const sourceBookmark =
      (await this.getPersistedWorkspaceBranchName(
        projectRepo.projectPath,
        context.workspaceName
      )) ?? context.workspaceName;
    return {
      workspaceName: context.workspaceName,
      workspacePath: context.workspacePath,
      projectPath: projectRepo.projectPath,
      projectName: projectRepo.projectName,
      storageKey: projectRepo.storageKey,
      sourceBookmark,
    };
  }

  private async captureJjSnapshot(context: SnapshotContext): Promise<JjArchiveSnapshot> {
    // This command intentionally snapshots the working copy; do not add --ignore-working-copy.
    const identity = await getCurrentJjRevisionIdentity(context.workspacePath);
    const sparsePatterns = await getJjSparsePatterns(context.workspacePath);
    return {
      version: 2,
      capturedAt: new Date().toISOString(),
      projects: [
        {
          projectPath: context.projectPath,
          projectName: context.projectName,
          storageKey: context.storageKey,
          workspaceName: context.workspaceName,
          sourceBookmark: context.sourceBookmark,
          changeId: identity.changeId,
          commitId: identity.commitId,
          sparsePatterns,
        },
      ],
    };
  }

  private async validateAcknowledgedUntrackedPaths(args: {
    workspaceId: string;
    workspaceMetadata: WorkspaceMetadata;
    acknowledgedUntrackedPaths?: string[];
  }): Promise<Result<void, CaptureSnapshotForArchiveError>> {
    const unsupported = await this.getUnsupportedUntrackedPaths(args);
    if (!unsupported.success) {
      return unsupported;
    }
    if (unsupported.data.length === 0) {
      return Ok(undefined);
    }

    const acknowledged = args.acknowledgedUntrackedPaths;
    const acknowledgedSet = acknowledged == null ? null : new Set(acknowledged);
    const hasNewPaths =
      acknowledgedSet == null || unsupported.data.some((entry) => !acknowledgedSet.has(entry));
    if (!hasNewPaths) {
      return Ok(undefined);
    }
    return Err({ kind: "confirm-lossy-untracked-files", paths: unsupported.data });
  }

  private async resolveRestoreTarget(
    snapshot: JjArchiveSnapshotProject
  ): Promise<JjRevisionIdentity> {
    let identities: JjRevisionIdentity[];
    try {
      identities = await resolveVisibleJjRevisionIdentities(
        snapshot.projectPath,
        snapshot.changeId
      );
    } catch {
      identities = [];
    }
    const matching = identities.filter((identity) => identity.changeId === snapshot.changeId);
    if (matching.length === 0) {
      throw new Error(
        "Archived JJ change is no longer visible; refusing to resurrect a superseded commit automatically."
      );
    }
    if (matching.length > 1) {
      throw new Error(
        "Archived JJ change is divergent; reconcile it before restoring the workspace."
      );
    }
    const target = matching[0];
    assert(target, "resolveRestoreTarget: missing unique revision");
    if (target.commitId !== snapshot.commitId) {
      log.info("Restoring rewritten JJ archive change", {
        projectPath: snapshot.projectPath,
        changeId: snapshot.changeId,
        archivedCommitId: snapshot.commitId,
        currentCommitId: target.commitId,
      });
    }
    return target;
  }

  private async strictlyRemoveWorkspaceCheckout(args: {
    projectPath: string;
    workspaceName: string;
    workspacePath: string;
  }): Promise<void> {
    const projectPath = path.resolve(args.projectPath);
    const workspacePath = path.resolve(args.workspacePath);
    if (
      projectPath === workspacePath ||
      workspacePath === path.parse(workspacePath).root ||
      isPathInsideDir(workspacePath, projectPath)
    ) {
      throw new Error("Refusing to delete a path that contains the project checkout");
    }

    // A real forget failure must keep the directory intact so no unsnapshotted files are lost.
    await forgetJjWorkspace({
      projectPath: args.projectPath,
      workspaceName: args.workspaceName,
    });
    await fsPromises.rm(workspacePath, { recursive: true, force: true });
  }

  private getPersistedWorkspacePath(workspaceId: string): string {
    const workspace = this.config.findWorkspace(workspaceId);
    if (!workspace) {
      throw new Error("Workspace disappeared before archive checkout deletion");
    }
    return workspace.workspacePath;
  }

  private async clearSnapshotState(
    workspaceId: string,
    snapshot: WorktreeArchiveSnapshot
  ): Promise<void> {
    if (snapshot.version === 1) {
      const sessionDir = this.config.getSessionDir(workspaceId);
      const stateDir = path.resolve(sessionDir, snapshot.stateDirPath);
      assert(
        isPathInsideDir(sessionDir, stateDir) && stateDir !== sessionDir,
        "clearSnapshotState: refusing to remove a path outside the session directory"
      );
      await fsPromises.rm(stateDir, { recursive: true, force: true });
    }

    await this.config.editConfig((config) => {
      const workspaceEntry = findWorkspaceEntryByIdOrPath(this.config, config, workspaceId);
      const current = workspaceEntry?.workspace.worktreeArchiveSnapshot;
      if (
        current?.version === snapshot.version &&
        current.capturedAt === snapshot.capturedAt &&
        workspaceEntry
      ) {
        delete workspaceEntry.workspace.worktreeArchiveSnapshot;
      }
      return config;
    });
  }

  private async cleanupFailedRestore(args: {
    projectPath: string;
    workspaceName: string;
    workspacePath: string;
  }): Promise<void> {
    try {
      await forgetJjWorkspace({
        projectPath: args.projectPath,
        workspaceName: args.workspaceName,
      });
      await fsPromises.rm(args.workspacePath, { recursive: true, force: true });
    } catch (error) {
      log.debug("Failed to clean up partially restored JJ workspace", {
        workspacePath: args.workspacePath,
        error: getErrorMessage(error),
      });
    }
  }

  private async getPersistedWorkspaceBranchName(
    projectPath: string,
    workspaceName: string
  ): Promise<string | null> {
    const branchName = (await this.readWorkspaceBranchMap(projectPath))[workspaceName]?.trim();
    return branchName || null;
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
        Object.entries(parsed).filter(
          ([workspaceName, branchName]) =>
            workspaceName.trim().length > 0 &&
            typeof branchName === "string" &&
            branchName.trim().length > 0
        )
      );
    } catch {
      return {};
    }
  }

  private async getWorkspaceBranchMapPath(projectPath: string): Promise<string> {
    const jjMapPath = path.join(projectPath, ".jj", "repo", JJ_WORKSPACE_MAP_FILENAME);
    try {
      if ((await fsPromises.stat(path.dirname(jjMapPath))).isDirectory()) {
        return jjMapPath;
      }
    } catch {
      // Fall through to the legacy colocated Git metadata path.
    }
    return path.join(projectPath, ".git", "mux-workspace-branches.json");
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    return fsPromises
      .access(targetPath)
      .then(() => true)
      .catch(() => false);
  }
}
