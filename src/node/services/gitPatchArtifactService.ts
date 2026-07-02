import * as path from "node:path";
import assert from "node:assert/strict";
import * as fsPromises from "fs/promises";

import type { Config } from "@/node/config";
import type {
  SubagentGitPatchArtifact,
  SubagentGitProjectPatchArtifact,
} from "@/common/utils/tools/toolDefinitions";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { ProjectRef } from "@/common/types/workspace";
import {
  coerceNonEmptyString,
  tryReadJjCurrentChangeId,
  tryResolveJjChangeId,
  findWorkspaceEntry,
} from "@/node/services/taskUtils";
import { log } from "@/node/services/log";
import { readAgentDefinition } from "@/node/services/agentDefinitions/agentDefinitionsService";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";
import { isExecLikeEditingCapableInResolvedChain } from "@/common/utils/agentTools";
import {
  createRuntimeContextForWorkspace,
  createRuntimeForWorkspace,
  type WorkspaceRuntimeContext,
} from "@/node/runtime/runtimeHelpers";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { AgentIdSchema } from "@/common/orpc/schemas";
import { resolvePersistedAgentIdCandidates } from "@/common/utils/agentIds";
import {
  getSubagentGitPatchDiffPath,
  matchesProjectArtifactProjectPathForUpdate,
  upsertSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import { shellQuote } from "@/common/utils/shell";
import { streamToString } from "@/node/runtime/streamUtils";
import { getErrorMessage } from "@/common/utils/errors";
import { PlatformPaths } from "@/common/utils/paths";
import {
  getWorkspaceProjectRepos,
  getWorkspaceProjectStorageKeys,
} from "@/node/services/workspaceProjectRepos";

/** Callback invoked after patch generation completes (success or failure). */
export type OnPatchGenerationComplete = (childWorkspaceId: string) => Promise<void>;

function isPathInsideDir(dirPath: string, filePath: string): boolean {
  const resolvedDir = path.resolve(dirPath);
  const resolvedFile = path.resolve(filePath);
  const relativePath = path.relative(resolvedDir, resolvedFile);
  return (
    relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
  );
}

async function writeReadableStreamToLocalFile(
  stream: ReadableStream<Uint8Array>,
  filePath: string
): Promise<void> {
  assert(filePath.length > 0, "writeReadableStreamToLocalFile: filePath must be non-empty");

  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });

  const fileHandle = await fsPromises.open(filePath, "w");
  try {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          await fileHandle.write(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    await fileHandle.close();
  }
}

function getPrimaryProjectName(projectPath: string, projects?: ProjectRef[]): string {
  const matchingProjectName = projects
    ?.find((project) => project.projectPath.trim() === projectPath.trim())
    ?.projectName?.trim();
  return matchingProjectName && matchingProjectName.length > 0
    ? matchingProjectName
    : PlatformPaths.getProjectName(projectPath).trim();
}

function createAgentDiscoveryContext(
  entry: ReturnType<typeof findWorkspaceEntry>
): WorkspaceRuntimeContext | undefined {
  const workspace = entry?.workspace;
  const workspacePath = coerceNonEmptyString(workspace?.path);
  const workspaceName =
    coerceNonEmptyString(workspace?.name) ??
    (workspacePath == null ? undefined : PlatformPaths.getProjectName(workspacePath));
  if (entry == null || workspace == null || workspaceName == null) {
    return undefined;
  }

  const metadata = {
    runtimeConfig: workspace.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG,
    projectPath: entry.projectPath,
    name: workspaceName,
    namedWorkspacePath: workspacePath,
  };

  try {
    return createRuntimeContextForWorkspace(metadata);
  } catch {
    // Older task records/tests can pair a project-dir local runtime with a child worktree path.
    // Fall back to the pre-existing persisted-path behavior rather than blocking patch cleanup.
    const runtime = createRuntimeForWorkspace(metadata);
    return {
      runtime,
      workspacePath: workspacePath ?? runtime.getWorkspacePath(entry.projectPath, workspaceName),
    };
  }
}

async function resolveAgentEditingCapability(args: {
  discoveryContexts: readonly WorkspaceRuntimeContext[];
  agentId: string;
  workspaceId: string;
}): Promise<{ editingCapable: boolean; projectScoped: boolean } | undefined> {
  const parsedAgentId = AgentIdSchema.safeParse(args.agentId);
  if (!parsedAgentId.success) {
    return undefined;
  }

  let fallbackChain: Awaited<ReturnType<typeof resolveAgentInheritanceChain>> | undefined;

  for (const discovery of args.discoveryContexts) {
    try {
      const agentDefinition = await readAgentDefinition(
        discovery.runtime,
        discovery.workspacePath,
        parsedAgentId.data
      );
      const chain = await resolveAgentInheritanceChain({
        runtime: discovery.runtime,
        workspacePath: discovery.workspacePath,
        agentId: agentDefinition.id,
        agentDefinition,
        workspaceId: args.workspaceId,
      });

      if (agentDefinition.scope === "project") {
        return {
          editingCapable: isExecLikeEditingCapableInResolvedChain(chain),
          projectScoped: true,
        };
      }
      fallbackChain ??= chain;
    } catch {
      // Try the next discovery context before falling back to global/built-in definitions.
    }
  }

  return fallbackChain == null
    ? undefined
    : {
        editingCapable: isExecLikeEditingCapableInResolvedChain(fallbackChain),
        projectScoped: false,
      };
}

function buildTaskBaseCommitShaByProjectPath(params: {
  projectPath: string;
  projects?: ProjectRef[];
  taskBaseCommitSha?: string;
  taskBaseCommitShaByProjectPath?: Record<string, string>;
}): Record<string, string> {
  const baseCommitShaByProjectPath = { ...(params.taskBaseCommitShaByProjectPath ?? {}) };
  if (params.taskBaseCommitSha?.trim()) {
    baseCommitShaByProjectPath[params.projectPath] = params.taskBaseCommitSha.trim();
  }

  if (Array.isArray(params.projects)) {
    for (const project of params.projects) {
      if (!project.projectPath.trim()) {
        continue;
      }
      if (!(project.projectPath in baseCommitShaByProjectPath)) {
        baseCommitShaByProjectPath[project.projectPath] = "";
      }
    }
  }

  return baseCommitShaByProjectPath;
}

function buildPendingProjectArtifacts(params: {
  projectPath: string;
  projects?: ProjectRef[];
  taskBaseCommitSha?: string;
  taskBaseCommitShaByProjectPath?: Record<string, string>;
}): SubagentGitProjectPatchArtifact[] {
  const baseCommitShaByProjectPath = buildTaskBaseCommitShaByProjectPath(params);
  const projectRefs =
    params.projects && params.projects.length > 0
      ? params.projects
      : [
          {
            projectPath: params.projectPath,
            projectName: getPrimaryProjectName(params.projectPath),
          },
        ];

  return getWorkspaceProjectStorageKeys({
    projectPath: params.projectPath,
    projectName: getPrimaryProjectName(params.projectPath),
    projects: projectRefs,
  }).map(
    (project) =>
      ({
        projectPath: project.projectPath,
        projectName: project.projectName,
        storageKey: project.storageKey,
        status: "pending",
        baseChangeId: baseCommitShaByProjectPath[project.projectPath] || undefined,
      }) satisfies SubagentGitProjectPatchArtifact
  );
}

function buildPendingPatchArtifact(params: {
  childTaskId: string;
  parentWorkspaceId: string;
  createdAtMs: number;
  updatedAtMs: number;
  projectArtifacts: SubagentGitProjectPatchArtifact[];
}): SubagentGitPatchArtifact {
  return {
    childTaskId: params.childTaskId,
    parentWorkspaceId: params.parentWorkspaceId,
    createdAtMs: params.createdAtMs,
    updatedAtMs: params.updatedAtMs,
    status: "pending",
    projectArtifacts: params.projectArtifacts,
    readyProjectCount: 0,
    failedProjectCount: 0,
    skippedProjectCount: 0,
    totalCommitCount: 0,
  };
}

export function upsertProjectArtifact(params: {
  artifact: SubagentGitPatchArtifact;
  nextProjectArtifact: SubagentGitProjectPatchArtifact;
  updatedAtMs: number;
}): SubagentGitPatchArtifact {
  let didMatchExistingArtifact = false;
  const projectArtifacts = params.artifact.projectArtifacts.map((projectArtifact) => {
    if (
      !matchesProjectArtifactProjectPathForUpdate(
        projectArtifact,
        params.nextProjectArtifact.projectPath
      )
    ) {
      return projectArtifact;
    }

    didMatchExistingArtifact = true;
    return params.nextProjectArtifact;
  });

  return {
    ...params.artifact,
    updatedAtMs: params.updatedAtMs,
    projectArtifacts: didMatchExistingArtifact
      ? projectArtifacts
      : [...projectArtifacts, params.nextProjectArtifact],
  };
}

function failPendingProjectArtifacts(params: {
  artifact: SubagentGitPatchArtifact;
  error: string;
  updatedAtMs: number;
}): SubagentGitPatchArtifact {
  return {
    ...params.artifact,
    updatedAtMs: params.updatedAtMs,
    projectArtifacts: params.artifact.projectArtifacts.map((projectArtifact) =>
      projectArtifact.status === "pending"
        ? {
            ...projectArtifact,
            status: "failed",
            error: params.error,
          }
        : projectArtifact
    ),
  };
}

// ---------------------------------------------------------------------------
// GitPatchArtifactService
// ---------------------------------------------------------------------------

/**
 * Handles jj-native task-change artifact generation for subagent tasks.
 *
 * Extracted from TaskService to keep patch-specific logic self-contained.
 */
export class GitPatchArtifactService {
  private readonly pendingJobsByTaskId = new Map<string, Promise<void>>();

  constructor(private readonly config: Config) {}

  /**
   * If the child workspace is an exec-like agent, write a pending patch artifact
   * marker and kick off background jj diff metadata generation.
   *
   * @param onComplete - called after generation finishes (success *or* failure),
   *   typically used to trigger reported-leaf-task cleanup.
   */
  async maybeStartGeneration(
    parentWorkspaceId: string,
    childWorkspaceId: string,
    onComplete: OnPatchGenerationComplete
  ): Promise<void> {
    assert(
      parentWorkspaceId.length > 0,
      "maybeStartGeneration: parentWorkspaceId must be non-empty"
    );
    assert(childWorkspaceId.length > 0, "maybeStartGeneration: childWorkspaceId must be non-empty");

    const parentSessionDir = this.config.getSessionDir(parentWorkspaceId);

    // Write a pending marker before we attempt cleanup, so the reported task workspace isn't deleted
    // while we're still reading commits from it.
    const nowMs = Date.now();
    const cfg = this.config.loadConfigOrDefault();
    const childEntry = findWorkspaceEntry(cfg, childWorkspaceId);

    // Only exec-like subagents are expected to make commits that should be handed back to the parent.
    // NOTE: Custom agents can inherit from exec (base: exec). Those should also generate patches,
    // but read-only subagents (e.g. explore) should not.
    const childAgentIds = resolvePersistedAgentIdCandidates(childEntry?.workspace);
    if (childAgentIds.length === 0) {
      return;
    }

    const discoveryContexts = [
      createAgentDiscoveryContext(childEntry),
      createAgentDiscoveryContext(findWorkspaceEntry(cfg, parentWorkspaceId)),
    ].filter((context): context is WorkspaceRuntimeContext => context != null);

    let shouldGeneratePatch = false;
    for (const childAgentId of childAgentIds) {
      const editingCapability = await resolveAgentEditingCapability({
        discoveryContexts,
        agentId: childAgentId,
        workspaceId: childWorkspaceId,
      });
      if (editingCapability == null) {
        continue;
      }
      shouldGeneratePatch = editingCapability.editingCapable;
      break;
    }

    if (!shouldGeneratePatch || !childEntry) {
      return;
    }

    const pendingProjectArtifacts = buildPendingProjectArtifacts({
      projectPath: childEntry.projectPath,
      projects: childEntry.workspace.projects,
      taskBaseCommitSha: coerceNonEmptyString(childEntry.workspace.taskBaseCommitSha) ?? undefined,
      taskBaseCommitShaByProjectPath: childEntry.workspace.taskBaseCommitShaByProjectPath,
    });

    const artifact = await upsertSubagentGitPatchArtifact({
      workspaceId: parentWorkspaceId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childWorkspaceId,
      updater: (existing) => {
        if (existing && existing.status !== "pending") {
          return existing;
        }

        return (
          existing ??
          buildPendingPatchArtifact({
            childTaskId: childWorkspaceId,
            parentWorkspaceId,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
            projectArtifacts: pendingProjectArtifacts,
          })
        );
      },
    });

    if (artifact.status !== "pending") {
      return;
    }

    if (this.pendingJobsByTaskId.has(childWorkspaceId)) {
      return;
    }

    let job: Promise<void>;
    try {
      job = this.generate(parentWorkspaceId, childWorkspaceId, onComplete)
        .catch(async (error: unknown) => {
          log.error("Subagent git patch generation failed", {
            parentWorkspaceId,
            childWorkspaceId,
            error,
          });

          try {
            await upsertSubagentGitPatchArtifact({
              workspaceId: parentWorkspaceId,
              workspaceSessionDir: parentSessionDir,
              childTaskId: childWorkspaceId,
              updater: (existing) => {
                const failedAtMs = Date.now();
                const pendingArtifact =
                  existing ??
                  buildPendingPatchArtifact({
                    childTaskId: childWorkspaceId,
                    parentWorkspaceId,
                    createdAtMs: failedAtMs,
                    updatedAtMs: failedAtMs,
                    projectArtifacts: pendingProjectArtifacts,
                  });
                return failPendingProjectArtifacts({
                  artifact: pendingArtifact,
                  error: getErrorMessage(error),
                  updatedAtMs: failedAtMs,
                });
              },
            });
          } catch (updateError: unknown) {
            log.error("Failed to mark subagent git patch artifact as failed", {
              parentWorkspaceId,
              childWorkspaceId,
              error: updateError,
            });
          }
        })
        .finally(() => {
          this.pendingJobsByTaskId.delete(childWorkspaceId);
        });
    } catch (error: unknown) {
      await upsertSubagentGitPatchArtifact({
        workspaceId: parentWorkspaceId,
        workspaceSessionDir: parentSessionDir,
        childTaskId: childWorkspaceId,
        updater: (existing) => {
          const failedAtMs = Date.now();
          const pendingArtifact =
            existing ??
            buildPendingPatchArtifact({
              childTaskId: childWorkspaceId,
              parentWorkspaceId,
              createdAtMs: failedAtMs,
              updatedAtMs: failedAtMs,
              projectArtifacts: pendingProjectArtifacts,
            });
          return failPendingProjectArtifacts({
            artifact: pendingArtifact,
            error: getErrorMessage(error),
            updatedAtMs: failedAtMs,
          });
        },
      });
      return;
    }

    this.pendingJobsByTaskId.set(childWorkspaceId, job);
  }

  private async generate(
    parentWorkspaceId: string,
    childWorkspaceId: string,
    onComplete: OnPatchGenerationComplete
  ): Promise<void> {
    assert(parentWorkspaceId.length > 0, "generate: parentWorkspaceId must be non-empty");
    assert(childWorkspaceId.length > 0, "generate: childWorkspaceId must be non-empty");

    const parentSessionDir = this.config.getSessionDir(parentWorkspaceId);

    const updateArtifact = async (
      updater: Parameters<typeof upsertSubagentGitPatchArtifact>[0]["updater"]
    ): Promise<SubagentGitPatchArtifact> => {
      return await upsertSubagentGitPatchArtifact({
        workspaceId: parentWorkspaceId,
        workspaceSessionDir: parentSessionDir,
        childTaskId: childWorkspaceId,
        updater,
      });
    };

    const nowMs = Date.now();

    try {
      const cfg = this.config.loadConfigOrDefault();
      const entry = findWorkspaceEntry(cfg, childWorkspaceId);

      if (!entry) {
        await updateArtifact((existing) =>
          failPendingProjectArtifacts({
            artifact:
              existing ??
              buildPendingPatchArtifact({
                childTaskId: childWorkspaceId,
                parentWorkspaceId,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
                projectArtifacts: [],
              }),
            error: "Task workspace not found in config.",
            updatedAtMs: nowMs,
          })
        );
        return;
      }

      const ws = entry.workspace;

      const workspacePath = coerceNonEmptyString(ws.path);
      if (!workspacePath) {
        await updateArtifact((existing) =>
          failPendingProjectArtifacts({
            artifact:
              existing ??
              buildPendingPatchArtifact({
                childTaskId: childWorkspaceId,
                parentWorkspaceId,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
                projectArtifacts: buildPendingProjectArtifacts({
                  projectPath: entry.projectPath,
                  projects: ws.projects,
                  taskBaseCommitSha: coerceNonEmptyString(ws.taskBaseCommitSha) ?? undefined,
                  taskBaseCommitShaByProjectPath: ws.taskBaseCommitShaByProjectPath,
                }),
              }),
            error: "Task workspace path missing.",
            updatedAtMs: nowMs,
          })
        );
        return;
      }

      if (!ws.runtimeConfig) {
        await updateArtifact((existing) =>
          failPendingProjectArtifacts({
            artifact:
              existing ??
              buildPendingPatchArtifact({
                childTaskId: childWorkspaceId,
                parentWorkspaceId,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
                projectArtifacts: buildPendingProjectArtifacts({
                  projectPath: entry.projectPath,
                  projects: ws.projects,
                  taskBaseCommitSha: coerceNonEmptyString(ws.taskBaseCommitSha) ?? undefined,
                  taskBaseCommitShaByProjectPath: ws.taskBaseCommitShaByProjectPath,
                }),
              }),
            error: "Task runtimeConfig missing.",
            updatedAtMs: nowMs,
          })
        );
        return;
      }

      const fallbackName = workspacePath.split("/").pop() ?? workspacePath.split("\\").pop() ?? "";
      const workspaceName = coerceNonEmptyString(ws.name) ?? coerceNonEmptyString(fallbackName);
      if (!workspaceName) {
        await updateArtifact((existing) =>
          failPendingProjectArtifacts({
            artifact:
              existing ??
              buildPendingPatchArtifact({
                childTaskId: childWorkspaceId,
                parentWorkspaceId,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
                projectArtifacts: buildPendingProjectArtifacts({
                  projectPath: entry.projectPath,
                  projects: ws.projects,
                  taskBaseCommitSha: coerceNonEmptyString(ws.taskBaseCommitSha) ?? undefined,
                  taskBaseCommitShaByProjectPath: ws.taskBaseCommitShaByProjectPath,
                }),
              }),
            error: "Task workspace name missing.",
            updatedAtMs: nowMs,
          })
        );
        return;
      }

      const runtime = createRuntimeForWorkspace({
        runtimeConfig: ws.runtimeConfig,
        projectPath: entry.projectPath,
        name: workspaceName,
      });

      const projectRepos = getWorkspaceProjectRepos({
        workspaceId: childWorkspaceId,
        workspaceName,
        workspacePath,
        runtimeConfig: ws.runtimeConfig,
        projectPath: entry.projectPath,
        projectName: getPrimaryProjectName(entry.projectPath, ws.projects),
        projects: ws.projects,
      });
      const taskBaseCommitShaByProjectPath = buildTaskBaseCommitShaByProjectPath({
        projectPath: entry.projectPath,
        projects: ws.projects,
        taskBaseCommitSha: coerceNonEmptyString(ws.taskBaseCommitSha) ?? undefined,
        taskBaseCommitShaByProjectPath: ws.taskBaseCommitShaByProjectPath,
      });

      const ensureProjectArtifact = async (
        nextProjectArtifact: SubagentGitProjectPatchArtifact
      ): Promise<void> => {
        await updateArtifact((existing) => {
          const pendingArtifact =
            existing ??
            buildPendingPatchArtifact({
              childTaskId: childWorkspaceId,
              parentWorkspaceId,
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
              projectArtifacts: buildPendingProjectArtifacts({
                projectPath: entry.projectPath,
                projects: ws.projects,
                taskBaseCommitSha: coerceNonEmptyString(ws.taskBaseCommitSha) ?? undefined,
                taskBaseCommitShaByProjectPath: ws.taskBaseCommitShaByProjectPath,
              }),
            });
          return upsertProjectArtifact({
            artifact: pendingArtifact,
            nextProjectArtifact,
            updatedAtMs: Date.now(),
          });
        });
      };

      for (const projectRepo of projectRepos) {
        try {
          let baseRevision = coerceNonEmptyString(
            taskBaseCommitShaByProjectPath[projectRepo.projectPath]
          );
          if (!baseRevision) {
            const trunkBranch =
              coerceNonEmptyString(ws.taskTrunkBranch) ??
              coerceNonEmptyString(findWorkspaceEntry(cfg, parentWorkspaceId)?.workspace.name);

            if (!trunkBranch) {
              await ensureProjectArtifact({
                projectPath: projectRepo.projectPath,
                projectName: projectRepo.projectName,
                storageKey: projectRepo.storageKey,
                status: "failed",
                error: "Task base change missing and could not determine trunk bookmark fallback.",
              });
              continue;
            }

            baseRevision = trunkBranch;
          }

          const baseChangeId = await tryResolveJjChangeId(
            runtime,
            projectRepo.repoCwd,
            baseRevision
          );
          if (!baseChangeId) {
            await ensureProjectArtifact({
              projectPath: projectRepo.projectPath,
              projectName: projectRepo.projectName,
              storageKey: projectRepo.storageKey,
              status: "failed",
              error: `Could not resolve jj base revision ${baseRevision}.`,
            });
            continue;
          }

          const headChangeId = await tryReadJjCurrentChangeId(runtime, projectRepo.repoCwd);
          if (!headChangeId) {
            await ensureProjectArtifact({
              projectPath: projectRepo.projectPath,
              projectName: projectRepo.projectName,
              storageKey: projectRepo.storageKey,
              status: "failed",
              baseChangeId,
              error: "Could not determine current jj change.",
            });
            continue;
          }

          const changedPathsResult = await execBuffered(
            runtime,
            `jj --no-pager --color never diff --from ${shellQuote(
              baseChangeId
            )} --to ${shellQuote(headChangeId)} --name-only`,
            { cwd: projectRepo.repoCwd, timeout: 30 }
          );
          if (changedPathsResult.exitCode !== 0) {
            await ensureProjectArtifact({
              projectPath: projectRepo.projectPath,
              projectName: projectRepo.projectName,
              storageKey: projectRepo.storageKey,
              status: "failed",
              baseChangeId,
              headChangeId,
              error:
                changedPathsResult.stderr.trim() ||
                changedPathsResult.stdout.trim() ||
                "jj diff --name-only failed.",
            });
            continue;
          }

          const changedPaths = changedPathsResult.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

          const countResult = await execBuffered(
            runtime,
            `jj --no-pager --color never log --no-graph -r ${shellQuote(
              `${baseChangeId}..${headChangeId}`
            )} -T 'change_id ++ "\\n"'`,
            { cwd: projectRepo.repoCwd, timeout: 30 }
          );
          const commitCount =
            countResult.exitCode === 0
              ? countResult.stdout
                  .split(/\r?\n/)
                  .map((line) => line.trim())
                  .filter((line) => line.length > 0).length
              : undefined;

          if (changedPaths.length === 0) {
            await ensureProjectArtifact({
              projectPath: projectRepo.projectPath,
              projectName: projectRepo.projectName,
              storageKey: projectRepo.storageKey,
              status: "skipped",
              baseChangeId,
              headChangeId,
              commitCount: commitCount ?? 0,
            });
            continue;
          }

          const patchPath = getSubagentGitPatchDiffPath(
            parentSessionDir,
            childWorkspaceId,
            projectRepo.storageKey
          );

          if (!isPathInsideDir(parentSessionDir, patchPath)) {
            await ensureProjectArtifact({
              projectPath: projectRepo.projectPath,
              projectName: projectRepo.projectName,
              storageKey: projectRepo.storageKey,
              status: "failed",
              baseChangeId,
              headChangeId,
              commitCount,
              error: `Refusing to write patch outside session dir for storage key ${projectRepo.storageKey}.`,
            });
            continue;
          }

          const diffStream = await runtime.exec(
            `jj --no-pager --color never diff --git --from ${shellQuote(
              baseChangeId
            )} --to ${shellQuote(headChangeId)}`,
            { cwd: projectRepo.repoCwd, timeout: 120 }
          );
          await diffStream.stdin.close();

          const stderrPromise = streamToString(diffStream.stderr);
          const writePromise = writeReadableStreamToLocalFile(diffStream.stdout, patchPath);

          const [exitCode, stderr] = await Promise.all([
            diffStream.exitCode,
            stderrPromise,
            writePromise,
          ]);

          if (exitCode !== 0) {
            await fsPromises.rm(patchPath, { force: true });
            await ensureProjectArtifact({
              projectPath: projectRepo.projectPath,
              projectName: projectRepo.projectName,
              storageKey: projectRepo.storageKey,
              status: "failed",
              baseChangeId,
              headChangeId,
              commitCount,
              error: `jj diff --git failed (exitCode=${exitCode}): ${stderr.trim() || "unknown error"}`,
            });
            continue;
          }

          await ensureProjectArtifact({
            projectPath: projectRepo.projectPath,
            projectName: projectRepo.projectName,
            storageKey: projectRepo.storageKey,
            status: "ready",
            baseChangeId,
            headChangeId,
            commitCount,
            diffPath: patchPath,
          });
        } catch (error: unknown) {
          await ensureProjectArtifact({
            projectPath: projectRepo.projectPath,
            projectName: projectRepo.projectName,
            storageKey: projectRepo.storageKey,
            status: "failed",
            error: getErrorMessage(error),
          });
        }
      }
    } catch (error: unknown) {
      await updateArtifact((existing) =>
        failPendingProjectArtifacts({
          artifact:
            existing ??
            buildPendingPatchArtifact({
              childTaskId: childWorkspaceId,
              parentWorkspaceId,
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
              projectArtifacts: [],
            }),
          error: getErrorMessage(error),
          updatedAtMs: Date.now(),
        })
      );
    } finally {
      // Unblock auto-cleanup once the patch generation attempt has finished.
      await onComplete(childWorkspaceId);
    }
  }
}
