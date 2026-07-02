import assert from "node:assert/strict";
import * as path from "node:path";

import type { z } from "zod";

import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  TaskApplyGitPatchToolArgsSchema,
  TaskApplyGitPatchToolResultSchema,
  TOOL_DEFINITIONS,
  type SubagentGitPatchArtifact,
  type SubagentGitProjectPatchArtifact,
} from "@/common/utils/tools/toolDefinitions";
import { shellQuote } from "@/common/utils/shell";
import { Config } from "@/node/config";
import { log } from "@/node/services/log";
import {
  coerceNonEmptyString,
  findWorkspaceEntry,
  tryReadJjCurrentRevision,
} from "@/node/services/taskUtils";
import {
  isSafeSubagentGitPatchPathComponent,
  markSubagentGitPatchArtifactApplied,
  matchesProjectArtifactProjectPath,
  readSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import { getWorkspaceProjectRepos } from "@/node/services/workspaceProjectRepos";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { isPathInsideDir } from "@/node/utils/pathUtils";

import { parseToolResult, requireWorkspaceId } from "./toolUtils";

export type TaskApplyGitPatchArgs = z.infer<typeof TaskApplyGitPatchToolArgsSchema>;
export type TaskApplyGitPatchResult = z.infer<typeof TaskApplyGitPatchToolResultSchema>;

export type TaskApplyGitPatchConfiguration = Pick<
  ToolConfiguration,
  "workspaceId" | "cwd" | "runtime" | "runtimeTempDir" | "workspaceSessionDir" | "trusted"
>;

interface AppliedCommit {
  subject: string;
  sha?: string;
}

interface TaskApplyGitPatchProjectResult {
  projectPath: string;
  projectName: string;
  status: "applied" | "failed" | "skipped";
  appliedCommits?: AppliedCommit[];
  headCommitSha?: string;
  headChangeId?: string;
  error?: string;
  failedPatchSubject?: string;
  conflictPaths?: string[];
  note?: string;
}

interface JjRevisionIdentity {
  changeId: string;
  commitId?: string;
}

const JJ = "jj --no-pager --color never";
const MAX_PARENT_WORKSPACE_DEPTH = 32;
const PENDING_PATCH_GENERATION_WAIT_MS = 120_000;
const PENDING_PATCH_GENERATION_POLL_INTERVAL_MS = 500;

function mergeNotes(...notes: Array<string | undefined>): string | undefined {
  const parts = notes
    .map((note) => (typeof note === "string" ? note.trim() : ""))
    .filter((note) => note.length > 0);

  return parts.length > 0 ? parts.join("\n") : undefined;
}

function inferMuxRootFromWorkspaceSessionDir(workspaceSessionDir: string): string | undefined {
  assert(
    workspaceSessionDir.length > 0,
    "inferMuxRootFromWorkspaceSessionDir: workspaceSessionDir must be non-empty"
  );

  const sessionsDir = path.dirname(workspaceSessionDir);
  if (path.basename(sessionsDir) !== "sessions") {
    return undefined;
  }

  return path.dirname(sessionsDir);
}

export async function findGitPatchArtifactInWorkspaceOrAncestors(params: {
  workspaceId: string;
  workspaceSessionDir: string;
  childTaskId: string;
}): Promise<{
  artifact: SubagentGitPatchArtifact;
  artifactWorkspaceId: string;
  artifactSessionDir: string;
  note?: string;
} | null> {
  assert(
    params.workspaceId.length > 0,
    "findGitPatchArtifactInWorkspaceOrAncestors: workspaceId must be non-empty"
  );
  assert(
    params.workspaceSessionDir.length > 0,
    "findGitPatchArtifactInWorkspaceOrAncestors: workspaceSessionDir must be non-empty"
  );
  assert(
    params.childTaskId.length > 0,
    "findGitPatchArtifactInWorkspaceOrAncestors: childTaskId must be non-empty"
  );

  const direct = await readSubagentGitPatchArtifact(params.workspaceSessionDir, params.childTaskId);
  if (direct) {
    return {
      artifact: direct,
      artifactWorkspaceId: params.workspaceId,
      artifactSessionDir: params.workspaceSessionDir,
    };
  }

  const muxRootDir = inferMuxRootFromWorkspaceSessionDir(params.workspaceSessionDir);
  if (!muxRootDir) {
    log.debug(
      "task_apply_git_patch: workspaceSessionDir not under sessions/; skipping ancestor lookup",
      {
        workspaceId: params.workspaceId,
        workspaceSessionDir: params.workspaceSessionDir,
        childTaskId: params.childTaskId,
      }
    );
    return null;
  }

  const configService = new Config(muxRootDir);

  let cfg: ReturnType<Config["loadConfigOrDefault"]>;
  try {
    cfg = configService.loadConfigOrDefault();
  } catch (error) {
    log.debug("task_apply_git_patch: failed to load mux config for ancestor lookup", {
      workspaceId: params.workspaceId,
      muxRootDir,
      error,
    });
    return null;
  }

  const parentById = new Map<string, string | undefined>();
  for (const project of cfg.projects.values()) {
    for (const workspace of project.workspaces) {
      if (!workspace.id) continue;
      parentById.set(workspace.id, workspace.parentWorkspaceId);
    }
  }

  const visited = new Set<string>();
  visited.add(params.workspaceId);

  let current = params.workspaceId;
  for (let i = 0; i < MAX_PARENT_WORKSPACE_DEPTH; i++) {
    const parent = parentById.get(current);
    if (!parent) {
      return null;
    }

    if (visited.has(parent)) {
      log.warn("task_apply_git_patch: possible parentWorkspaceId cycle during ancestor lookup", {
        workspaceId: params.workspaceId,
        childTaskId: params.childTaskId,
        current,
        parent,
      });
      return null;
    }

    visited.add(parent);

    const parentSessionDir = configService.getSessionDir(parent);
    const artifact = await readSubagentGitPatchArtifact(parentSessionDir, params.childTaskId);
    if (artifact) {
      return {
        artifact,
        artifactWorkspaceId: parent,
        artifactSessionDir: parentSessionDir,
        note: `Patch artifact loaded from ancestor workspace ${parent}.`,
      };
    }

    current = parent;
  }

  log.warn("task_apply_git_patch: exceeded parentWorkspaceId depth during ancestor lookup", {
    workspaceId: params.workspaceId,
    childTaskId: params.childTaskId,
  });

  return null;
}

function listRelevantProjectArtifacts(
  artifact: SubagentGitPatchArtifact,
  requestedProjectPath: string | null | undefined
): SubagentGitPatchArtifact["projectArtifacts"] {
  return requestedProjectPath != null
    ? artifact.projectArtifacts.filter((projectArtifact) =>
        matchesProjectArtifactProjectPath(projectArtifact, requestedProjectPath)
      )
    : artifact.projectArtifacts;
}

async function sleepResolvingOnAbort(delayMs: number, abortSignal?: AbortSignal): Promise<void> {
  assert(delayMs > 0, "sleepResolvingOnAbort: delayMs must be positive");
  if (abortSignal?.aborted === true) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForPendingPatchGeneration(params: {
  artifact: SubagentGitPatchArtifact;
  artifactSessionDir: string;
  childTaskId: string;
  requestedProjectPath: string | null | undefined;
  waitMs: number;
  pollIntervalMs: number;
  abortSignal?: AbortSignal;
  onPoll?: () => void;
}): Promise<SubagentGitPatchArtifact> {
  assert(params.waitMs >= 0, "waitForPendingPatchGeneration: waitMs must be non-negative");
  assert(
    params.pollIntervalMs > 0,
    "waitForPendingPatchGeneration: pollIntervalMs must be positive"
  );

  let artifact = params.artifact;
  const deadlineMs = Date.now() + params.waitMs;
  const startedAtMs = Date.now();
  let waited = false;

  while (
    listRelevantProjectArtifacts(artifact, params.requestedProjectPath).some(
      (projectArtifact) => projectArtifact.status === "pending"
    ) &&
    Date.now() < deadlineMs &&
    params.abortSignal?.aborted !== true
  ) {
    waited = true;
    params.onPoll?.();
    await sleepResolvingOnAbort(params.pollIntervalMs, params.abortSignal);
    const refreshed = await readSubagentGitPatchArtifact(
      params.artifactSessionDir,
      params.childTaskId
    );
    if (refreshed != null) {
      artifact = refreshed;
    }
  }

  if (waited) {
    log.debug("task_apply_git_patch: waited for pending patch generation", {
      childTaskId: params.childTaskId,
      waitedMs: Date.now() - startedAtMs,
      settledStatuses: listRelevantProjectArtifacts(artifact, params.requestedProjectPath).map(
        (projectArtifact) => projectArtifact.status
      ),
      requestedProjectPath: params.requestedProjectPath ?? null,
    });
  }

  return artifact;
}

function toLegacyFields(projectResults: TaskApplyGitPatchProjectResult[]): {
  appliedCommits?: AppliedCommit[];
  headCommitSha?: string;
  conflictPaths?: string[];
  failedPatchSubject?: string;
} {
  if (projectResults.length !== 1) {
    return {};
  }

  const [onlyProjectResult] = projectResults;
  return {
    ...(onlyProjectResult.appliedCommits
      ? { appliedCommits: onlyProjectResult.appliedCommits }
      : {}),
    ...(onlyProjectResult.headCommitSha ? { headCommitSha: onlyProjectResult.headCommitSha } : {}),
    ...(onlyProjectResult.conflictPaths ? { conflictPaths: onlyProjectResult.conflictPaths } : {}),
    ...(onlyProjectResult.failedPatchSubject
      ? { failedPatchSubject: onlyProjectResult.failedPatchSubject }
      : {}),
  };
}

function summarizeNonReadyProjectArtifact(params: {
  projectArtifact: SubagentGitProjectPatchArtifact;
}): TaskApplyGitPatchProjectResult {
  const noteByStatus: Record<string, string | undefined> = {
    pending: "Patch generation is still in progress for this project.",
    skipped: "Patch generation was skipped because this project produced no file changes.",
    failed: undefined,
    ready: undefined,
  };

  return {
    projectPath: params.projectArtifact.projectPath,
    projectName: params.projectArtifact.projectName,
    status: params.projectArtifact.status === "failed" ? "failed" : "skipped",
    error:
      params.projectArtifact.error ??
      noteByStatus[params.projectArtifact.status] ??
      `Project patch status is ${params.projectArtifact.status}.`,
  };
}

function resolveCurrentWorkspaceRepoTargets(params: {
  workspaceId: string;
  workspaceSessionDir: string;
}): Map<string, { projectName: string; repoCwd: string }> {
  const muxRootDir = inferMuxRootFromWorkspaceSessionDir(params.workspaceSessionDir);
  if (!muxRootDir) {
    return new Map();
  }

  const configService = new Config(muxRootDir);
  let cfg: ReturnType<Config["loadConfigOrDefault"]>;
  try {
    cfg = configService.loadConfigOrDefault();
  } catch {
    return new Map();
  }

  const entry = findWorkspaceEntry(cfg, params.workspaceId);
  const workspace = entry?.workspace;
  const workspacePath = coerceNonEmptyString(workspace?.path);
  const workspaceName = coerceNonEmptyString(workspace?.name);
  if (!entry || !workspace?.runtimeConfig || !workspacePath || !workspaceName) {
    return new Map();
  }

  const projectRepos = getWorkspaceProjectRepos({
    workspaceId: params.workspaceId,
    workspaceName,
    workspacePath,
    runtimeConfig: workspace.runtimeConfig,
    projectPath: entry.projectPath,
    projectName:
      workspace.projects?.find((project) => project.projectPath === entry.projectPath)
        ?.projectName ??
      entry.projectPath.split("/").filter(Boolean).at(-1) ??
      entry.projectPath,
    projects: workspace.projects,
  });

  return new Map(
    projectRepos.map((projectRepo) => [
      projectRepo.projectPath,
      {
        projectName: projectRepo.projectName,
        repoCwd: projectRepo.repoCwd,
      },
    ])
  );
}

function patchPathOverlapsDirtyPath(patchPath: string, dirtyPath: string): boolean {
  const normalizedPatchPath = patchPath.replace(/\/+$/, "");
  const normalizedDirtyPath = dirtyPath.replace(/\/+$/, "");
  return (
    normalizedPatchPath === normalizedDirtyPath ||
    normalizedPatchPath.startsWith(`${normalizedDirtyPath}/`) ||
    normalizedDirtyPath.startsWith(`${normalizedPatchPath}/`)
  );
}

async function listJjChangedPaths(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  fromRevision: string;
  toRevision: string;
}): Promise<{ paths: string[] } | { error: string }> {
  const result = await execBuffered(
    params.runtime,
    `${JJ} diff --from ${shellQuote(params.fromRevision)} --to ${shellQuote(
      params.toRevision
    )} --name-only`,
    { cwd: params.cwd, timeout: 30 }
  );
  if (result.exitCode !== 0) {
    return { error: result.stderr.trim() || result.stdout.trim() || "jj diff --name-only failed" };
  }

  return {
    paths: Array.from(
      new Set(
        result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      )
    ).sort(),
  };
}

async function listJjDirtyPaths(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
}): Promise<{ paths: string[] } | { error: string }> {
  const result = await execBuffered(params.runtime, `${JJ} diff --name-only`, {
    cwd: params.cwd,
    timeout: 30,
  });
  if (result.exitCode !== 0) {
    return { error: result.stderr.trim() || result.stdout.trim() || "jj diff --name-only failed" };
  }

  return {
    paths: Array.from(
      new Set(
        result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      )
    ).sort(),
  };
}

function findPathOverlaps(leftPaths: string[], rightPaths: string[]): string[] {
  return [
    ...new Set(
      rightPaths.filter((rightPath) =>
        leftPaths.some((leftPath) => patchPathOverlapsDirtyPath(leftPath, rightPath))
      )
    ),
  ].sort();
}

async function readJjRevisionIdentity(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
}): Promise<JjRevisionIdentity | undefined> {
  return await tryReadJjCurrentRevision(params.runtime, params.cwd);
}

async function readJjRevisionDescription(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  revision: string;
}): Promise<string | undefined> {
  const result = await execBuffered(
    params.runtime,
    `${JJ} log --no-graph -r ${shellQuote(params.revision)} -T 'description.first_line() ++ "\\n"' -n 1`,
    { cwd: params.cwd, timeout: 30 }
  );
  if (result.exitCode !== 0) {
    return undefined;
  }
  const description = result.stdout.trim();
  return description.length > 0 ? description : undefined;
}

async function checkExpectedHead(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  expectedHeadSha?: string;
}): Promise<string | undefined> {
  if (params.expectedHeadSha == null) {
    return undefined;
  }
  const current = await readJjRevisionIdentity(params);
  if (current == null) {
    return "Could not determine current jj revision before applying patch.";
  }
  if (params.expectedHeadSha !== current.changeId && params.expectedHeadSha !== current.commitId) {
    return `Current jj change ${current.changeId} does not match expected revision ${params.expectedHeadSha}.`;
  }
  return undefined;
}

function validatePatchRuntimePathComponent(value: string, label: string): string | undefined {
  if (isSafeSubagentGitPatchPathComponent(value)) {
    return undefined;
  }
  return `${label} must be a safe path component.`;
}

function buildRuntimeTempPath(params: {
  runtimeTempDir: string;
  filename: string;
  purpose: string;
}): string {
  const runtimePath = path.posix.join(params.runtimeTempDir, params.filename);
  assert(
    isPathInsideDir(params.runtimeTempDir, runtimePath),
    `task_apply_git_patch ${params.purpose} path must stay inside runtimeTempDir`
  );
  return runtimePath;
}

async function applyJjRestore(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  fromRevision: string;
  paths: string[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (params.paths.length === 0) {
    return { ok: true };
  }

  const result = await execBuffered(
    params.runtime,
    `${JJ} restore --from ${shellQuote(params.fromRevision)} --into @ -- ${params.paths
      .map((filePath) => shellQuote(filePath))
      .join(" ")}`,
    { cwd: params.cwd, timeout: 300 }
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || result.stdout.trim() || "jj restore failed",
    };
  }

  return { ok: true };
}

async function cleanupDryRunWorkspace(params: {
  runtime: ToolConfiguration["runtime"];
  repoCwd: string;
  dryRunWorkspacePath: string;
  dryRunWorkspaceName: string;
  taskId: string;
  workspaceId: string;
}): Promise<void> {
  try {
    const forgetResult = await execBuffered(
      params.runtime,
      `${JJ} workspace forget ${shellQuote(params.dryRunWorkspaceName)}`,
      { cwd: params.repoCwd, timeout: 60 }
    );
    if (forgetResult.exitCode !== 0) {
      log.debug("task_apply_git_patch: dry-run jj workspace forget failed", {
        taskId: params.taskId,
        workspaceId: params.workspaceId,
        exitCode: forgetResult.exitCode,
        stderr: forgetResult.stderr.trim(),
        stdout: forgetResult.stdout.trim(),
      });
    }
  } catch (error) {
    log.debug("task_apply_git_patch: dry-run jj workspace forget threw", {
      taskId: params.taskId,
      workspaceId: params.workspaceId,
      error,
    });
  }

  try {
    const removeResult = await execBuffered(
      params.runtime,
      `rm -rf ${shellQuote(params.dryRunWorkspacePath)}`,
      { cwd: params.repoCwd, timeout: 60 }
    );
    if (removeResult.exitCode !== 0) {
      log.debug("task_apply_git_patch: dry-run workspace dir cleanup failed", {
        taskId: params.taskId,
        workspaceId: params.workspaceId,
        dryRunWorkspacePath: params.dryRunWorkspacePath,
        exitCode: removeResult.exitCode,
        stderr: removeResult.stderr.trim(),
        stdout: removeResult.stdout.trim(),
      });
    }
  } catch (error) {
    log.debug("task_apply_git_patch: dry-run workspace dir cleanup threw", {
      taskId: params.taskId,
      workspaceId: params.workspaceId,
      dryRunWorkspacePath: params.dryRunWorkspacePath,
      error,
    });
  }
}

async function dryRunJjRestore(params: {
  taskId: string;
  workspaceId: string;
  runtime: ToolConfiguration["runtime"];
  runtimeTempDir: string;
  repoCwd: string;
  fromRevision: string;
  paths: string[];
}): Promise<{ success: true } | { success: false; error: string }> {
  const dryRunId = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
  const dryRunWorkspaceName = `mux-jj-restore-dry-run-${params.taskId}-${dryRunId}`;
  const dryRunWorkspacePath = buildRuntimeTempPath({
    runtimeTempDir: params.runtimeTempDir,
    filename: dryRunWorkspaceName,
    purpose: "dry-run workspace",
  });

  const addResult = await execBuffered(
    params.runtime,
    `${JJ} workspace add --revision @ ${shellQuote(dryRunWorkspacePath)}`,
    { cwd: params.repoCwd, timeout: 60 }
  );
  if (addResult.exitCode !== 0) {
    return {
      success: false,
      error: addResult.stderr.trim() || addResult.stdout.trim() || "jj workspace add failed",
    };
  }

  try {
    const restoreResult = await applyJjRestore({
      runtime: params.runtime,
      cwd: dryRunWorkspacePath,
      fromRevision: params.fromRevision,
      paths: params.paths,
    });
    if (!restoreResult.ok) {
      return { success: false, error: restoreResult.error };
    }
    return { success: true };
  } finally {
    await cleanupDryRunWorkspace({
      runtime: params.runtime,
      repoCwd: params.repoCwd,
      dryRunWorkspacePath,
      dryRunWorkspaceName,
      taskId: params.taskId,
      workspaceId: params.workspaceId,
    });
  }
}

async function applyProjectPatch(params: {
  taskId: string;
  workspaceId: string;
  runtime: ToolConfiguration["runtime"];
  runtimeTempDir: string;
  repoCwd: string;
  projectArtifact: SubagentGitProjectPatchArtifact;
  artifactWorkspaceId: string;
  artifactSessionDir: string;
  artifactLookupNote?: string;
  dryRun: boolean;
  force: boolean;
  expectedHeadSha?: string;
  isReplay: boolean;
}): Promise<{ success: boolean; projectResult: TaskApplyGitPatchProjectResult }> {
  const taskIdError = validatePatchRuntimePathComponent(params.taskId, "task_id");
  const storageKeyError = validatePatchRuntimePathComponent(
    params.projectArtifact.storageKey,
    "storageKey"
  );
  if (taskIdError != null || storageKeyError != null) {
    return {
      success: false,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "failed",
        error: taskIdError ?? storageKeyError,
      },
    };
  }

  const headChangeId =
    coerceNonEmptyString(params.projectArtifact.headChangeId) ??
    coerceNonEmptyString(params.projectArtifact.headCommitSha);
  const baseChangeId =
    coerceNonEmptyString(params.projectArtifact.baseChangeId) ??
    coerceNonEmptyString(params.projectArtifact.baseCommitSha);
  if (!headChangeId || !baseChangeId) {
    return {
      success: false,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "failed",
        error:
          "Patch artifact is missing jj change metadata; rerun the child task after jj-native patch generation is enabled.",
        note: params.artifactLookupNote,
      },
    };
  }

  const expectedHeadError = await checkExpectedHead({
    runtime: params.runtime,
    cwd: params.repoCwd,
    expectedHeadSha: params.expectedHeadSha,
  });
  if (expectedHeadError != null) {
    return {
      success: false,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "failed",
        error: expectedHeadError,
        note: params.artifactLookupNote,
      },
    };
  }

  const changedPathsResult = await listJjChangedPaths({
    runtime: params.runtime,
    cwd: params.repoCwd,
    fromRevision: baseChangeId,
    toRevision: headChangeId,
  });
  if ("error" in changedPathsResult) {
    return {
      success: false,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "failed",
        error: changedPathsResult.error,
        note: params.artifactLookupNote,
      },
    };
  }

  if (changedPathsResult.paths.length === 0) {
    return {
      success: true,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "skipped",
        note: mergeNotes(params.artifactLookupNote, "Task change has no file changes to apply."),
      },
    };
  }

  const dirtyPathsResult = await listJjDirtyPaths({ runtime: params.runtime, cwd: params.repoCwd });
  if ("error" in dirtyPathsResult) {
    return {
      success: false,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "failed",
        error: dirtyPathsResult.error,
        note: params.artifactLookupNote,
      },
    };
  }

  const conflictPaths = findPathOverlaps(changedPathsResult.paths, dirtyPathsResult.paths);
  if (conflictPaths.length > 0) {
    return {
      success: false,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "failed",
        conflictPaths,
        error: "Working copy has local changes that overlap task change paths.",
        note: mergeNotes(
          params.artifactLookupNote,
          "Commit or shelve local changes on overlapping paths before applying. Unrelated dirty files can remain in place."
        ),
      },
    };
  }

  if (params.dryRun) {
    const dryRunResult = await dryRunJjRestore({
      taskId: params.taskId,
      workspaceId: params.workspaceId,
      runtime: params.runtime,
      runtimeTempDir: params.runtimeTempDir,
      repoCwd: params.repoCwd,
      fromRevision: headChangeId,
      paths: changedPathsResult.paths,
    });
    if (!dryRunResult.success) {
      return {
        success: false,
        projectResult: {
          projectPath: params.projectArtifact.projectPath,
          projectName: params.projectArtifact.projectName,
          status: "failed",
          error: dryRunResult.error,
          note: mergeNotes(
            params.artifactLookupNote,
            "Dry run failed; the task change does not restore cleanly against the current jj workspace."
          ),
        },
      };
    }

    const description = await readJjRevisionDescription({
      runtime: params.runtime,
      cwd: params.repoCwd,
      revision: headChangeId,
    });
    return {
      success: true,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "applied",
        appliedCommits: [{ subject: description ?? `Task change ${headChangeId}` }],
        headChangeId,
        note: mergeNotes(params.artifactLookupNote, "Dry run succeeded; no changes were applied."),
      },
    };
  }

  const restoreResult = await applyJjRestore({
    runtime: params.runtime,
    cwd: params.repoCwd,
    fromRevision: headChangeId,
    paths: changedPathsResult.paths,
  });
  if (!restoreResult.ok) {
    return {
      success: false,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "failed",
        error: restoreResult.error,
        note: params.artifactLookupNote,
      },
    };
  }

  const currentRevision = await readJjRevisionIdentity({
    runtime: params.runtime,
    cwd: params.repoCwd,
  });
  const description = await readJjRevisionDescription({
    runtime: params.runtime,
    cwd: params.repoCwd,
    revision: headChangeId,
  });

  if (!params.isReplay) {
    await markSubagentGitPatchArtifactApplied({
      workspaceId: params.artifactWorkspaceId,
      workspaceSessionDir: params.artifactSessionDir,
      childTaskId: params.taskId,
      projectPath: params.projectArtifact.projectPath,
      appliedAtMs: Date.now(),
    });
  }

  return {
    success: true,
    projectResult: {
      projectPath: params.projectArtifact.projectPath,
      projectName: params.projectArtifact.projectName,
      status: "applied",
      appliedCommits: [{ subject: description ?? `Task change ${headChangeId}` }],
      headCommitSha: currentRevision?.commitId,
      headChangeId: currentRevision?.changeId,
      note: params.artifactLookupNote,
    },
  };
}

export async function applyTaskGitPatchArtifact(
  config: TaskApplyGitPatchConfiguration,
  args: TaskApplyGitPatchArgs,
  options: {
    abortSignal?: AbortSignal;
    allowAlreadyApplied?: boolean;
    pendingGenerationWaitMs?: number;
    pendingGenerationPollIntervalMs?: number;
    pendingGenerationOnPoll?: () => void;
  } = {}
): Promise<TaskApplyGitPatchResult> {
  const workspaceId = requireWorkspaceId(config, "task_apply_git_patch");
  assert(config.cwd, "task_apply_git_patch requires cwd");
  assert(config.runtimeTempDir, "task_apply_git_patch requires runtimeTempDir");
  const workspaceSessionDir = config.workspaceSessionDir;
  assert(workspaceSessionDir, "task_apply_git_patch requires workspaceSessionDir");

  const parsedArgs = TaskApplyGitPatchToolArgsSchema.parse(args);
  const taskId = parsedArgs.task_id;
  const dryRun = parsedArgs.dry_run === true;
  const force = parsedArgs.force === true;
  const expectedHeadSha = parsedArgs.expected_head_sha ?? undefined;

  if (!isSafeSubagentGitPatchPathComponent(taskId)) {
    return parseToolResult(
      TaskApplyGitPatchToolResultSchema,
      {
        success: false as const,
        taskId,
        dryRun,
        error: "Invalid task_id.",
        note: "task_id must be a safe path component.",
      },
      "task_apply_git_patch"
    );
  }

  await config.runtime.ensureDir(config.runtimeTempDir, options.abortSignal);

  const artifactLookup = await findGitPatchArtifactInWorkspaceOrAncestors({
    workspaceId,
    workspaceSessionDir,
    childTaskId: taskId,
  });

  if (!artifactLookup) {
    return parseToolResult(
      TaskApplyGitPatchToolResultSchema,
      {
        success: false as const,
        taskId,
        dryRun,
        error: "No jj task-change artifact found for this taskId.",
      },
      "task_apply_git_patch"
    );
  }

  let artifact = artifactLookup.artifact;
  const artifactWorkspaceId = artifactLookup.artifactWorkspaceId;
  const artifactSessionDir = artifactLookup.artifactSessionDir;
  const isReplay = artifactWorkspaceId !== workspaceId;
  const artifactLookupNote = artifactLookup.note;

  if (artifact.parentWorkspaceId !== artifactWorkspaceId) {
    return parseToolResult(
      TaskApplyGitPatchToolResultSchema,
      {
        success: false as const,
        taskId,
        dryRun,
        error: "This task-change artifact belongs to a different parent workspace.",
        note: mergeNotes(
          artifactLookupNote,
          `Expected parent workspace ${artifactWorkspaceId} but artifact metadata says ${artifact.parentWorkspaceId}.`
        ),
      },
      "task_apply_git_patch"
    );
  }

  const requestedProjectPath = parsedArgs.project_path;

  artifact = await waitForPendingPatchGeneration({
    artifact,
    artifactSessionDir,
    childTaskId: taskId,
    requestedProjectPath,
    waitMs: options.pendingGenerationWaitMs ?? PENDING_PATCH_GENERATION_WAIT_MS,
    pollIntervalMs:
      options.pendingGenerationPollIntervalMs ?? PENDING_PATCH_GENERATION_POLL_INTERVAL_MS,
    abortSignal: options.abortSignal,
    onPoll: options.pendingGenerationOnPoll,
  });

  if (options.abortSignal?.aborted === true) {
    return parseToolResult(
      TaskApplyGitPatchToolResultSchema,
      {
        success: false as const,
        taskId,
        dryRun,
        error: "Aborted while waiting for patch generation; the task change was not applied.",
        note: artifactLookupNote,
      },
      "task_apply_git_patch"
    );
  }

  const projectArtifacts = listRelevantProjectArtifacts(artifact, requestedProjectPath);

  if (parsedArgs.project_path != null && projectArtifacts.length === 0) {
    return parseToolResult(
      TaskApplyGitPatchToolResultSchema,
      {
        success: false as const,
        taskId,
        dryRun,
        error: `No project task-change artifact found for ${parsedArgs.project_path}.`,
      },
      "task_apply_git_patch"
    );
  }

  if (projectArtifacts.length === 0) {
    return parseToolResult(
      TaskApplyGitPatchToolResultSchema,
      {
        success: false as const,
        taskId,
        dryRun,
        error: "This task has no project task-change artifacts.",
      },
      "task_apply_git_patch"
    );
  }

  if (projectArtifacts.some((projectArtifact) => projectArtifact.status === "pending")) {
    const pendingProjectResults = projectArtifacts.map((projectArtifact) =>
      projectArtifact.status === "ready"
        ? {
            projectPath: projectArtifact.projectPath,
            projectName: projectArtifact.projectName,
            status: "skipped" as const,
            error:
              "Not attempted because task-change generation has not finished for another project in this task.",
          }
        : summarizeNonReadyProjectArtifact({ projectArtifact })
    );
    return parseToolResult(
      TaskApplyGitPatchToolResultSchema,
      {
        success: false as const,
        taskId,
        dryRun,
        projectResults: pendingProjectResults,
        error:
          "Task-change generation has not finished for this task yet. This is not an apply conflict; retry task_apply_git_patch shortly.",
        note: artifactLookupNote,
        ...toLegacyFields(pendingProjectResults),
      },
      "task_apply_git_patch"
    );
  }

  const repoTargetsByProjectPath = resolveCurrentWorkspaceRepoTargets({
    workspaceId,
    workspaceSessionDir,
  });
  const projectResults: TaskApplyGitPatchProjectResult[] = [];

  const readyProjectArtifacts = projectArtifacts.filter(
    (projectArtifact) => projectArtifact.status === "ready"
  );
  if (readyProjectArtifacts.length === 0) {
    for (const projectArtifact of projectArtifacts) {
      projectResults.push(summarizeNonReadyProjectArtifact({ projectArtifact }));
    }

    const legacyFields = toLegacyFields(projectResults);
    return parseToolResult(
      TaskApplyGitPatchToolResultSchema,
      {
        success: false as const,
        taskId,
        dryRun,
        projectResults,
        error: "This task has no ready project task-change artifacts.",
        note: artifactLookupNote,
        ...legacyFields,
      },
      "task_apply_git_patch"
    );
  }

  let shouldStopAfterFailure = false;
  for (const projectArtifact of projectArtifacts) {
    if (shouldStopAfterFailure) {
      projectResults.push({
        projectPath: projectArtifact.projectPath,
        projectName: projectArtifact.projectName,
        status: "skipped",
        error: "Not attempted because an earlier project apply failed.",
      });
      continue;
    }

    if (projectArtifact.status !== "ready") {
      projectResults.push(summarizeNonReadyProjectArtifact({ projectArtifact }));
      if (parsedArgs.project_path != null) {
        shouldStopAfterFailure = true;
      }
      continue;
    }

    if (!isReplay && projectArtifact.appliedAtMs && !force) {
      const appliedAt = new Date(projectArtifact.appliedAtMs).toISOString();
      if (options.allowAlreadyApplied === true) {
        projectResults.push({
          projectPath: projectArtifact.projectPath,
          projectName: projectArtifact.projectName,
          status: "applied",
          note: `Task change already applied at ${appliedAt}; treating as applied for replay-safe workflow integration.`,
        });
        continue;
      }
      if (!dryRun) {
        projectResults.push({
          projectPath: projectArtifact.projectPath,
          projectName: projectArtifact.projectName,
          status: "failed",
          error: `Task change already applied at ${appliedAt}.`,
          note: "Re-run with force=true to apply again.",
        });
        shouldStopAfterFailure = true;
        continue;
      }
    }

    const repoTarget = repoTargetsByProjectPath.get(projectArtifact.projectPath);
    const repoCwd =
      repoTarget?.repoCwd ?? (artifact.projectArtifacts.length === 1 ? config.cwd : undefined);
    if (!repoCwd) {
      projectResults.push({
        projectPath: projectArtifact.projectPath,
        projectName: projectArtifact.projectName,
        status: "failed",
        error: "Could not resolve the current workspace repo root for this project.",
      });
      shouldStopAfterFailure = true;
      continue;
    }

    const applyResult = await applyProjectPatch({
      taskId,
      workspaceId,
      runtime: config.runtime,
      runtimeTempDir: config.runtimeTempDir,
      repoCwd,
      projectArtifact,
      artifactWorkspaceId,
      artifactSessionDir,
      artifactLookupNote,
      dryRun,
      force,
      expectedHeadSha,
      isReplay,
    });
    projectResults.push(applyResult.projectResult);
    if (!applyResult.success) {
      shouldStopAfterFailure = true;
    }
  }

  const legacyFields = toLegacyFields(projectResults);
  const attemptedReadyCount = projectArtifacts.filter(
    (projectArtifact) => projectArtifact.status === "ready"
  ).length;
  const appliedReadyCount = projectResults.filter(
    (projectResult) => projectResult.status === "applied"
  ).length;
  const hasApplyFailure = projectResults.some(
    (projectResult, index) =>
      projectResult.status === "failed" && projectArtifacts[index]?.status === "ready"
  );
  const overallNote = mergeNotes(
    artifactLookupNote,
    projectResults
      .map((projectResult) => projectResult.note)
      .filter((note): note is string => typeof note === "string")
      .join("\n") || undefined
  );

  if (hasApplyFailure) {
    const firstFailedProject = projectResults.find(
      (projectResult) => projectResult.status === "failed"
    );
    return parseToolResult(
      TaskApplyGitPatchToolResultSchema,
      {
        success: false as const,
        taskId,
        dryRun,
        projectResults,
        error:
          firstFailedProject?.error ??
          `Failed while applying project task changes (${appliedReadyCount}/${attemptedReadyCount} ready projects applied).`,
        note: overallNote,
        ...legacyFields,
      },
      "task_apply_git_patch"
    );
  }

  return parseToolResult(
    TaskApplyGitPatchToolResultSchema,
    {
      success: true as const,
      taskId,
      projectResults,
      dryRun,
      note: overallNote,
      ...(projectResults.length === 1 ? legacyFields : {}),
    },
    "task_apply_git_patch"
  );
}

export const createTaskApplyGitPatchTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_apply_git_patch.description,
    inputSchema: TOOL_DEFINITIONS.task_apply_git_patch.schema,
    execute: async (args, { abortSignal }): Promise<unknown> => {
      return await applyTaskGitPatchArtifact(config, args, { abortSignal });
    },
  });
};
