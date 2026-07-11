import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { ExecOptions, ExecStream, Runtime } from "@/node/runtime/Runtime";
import { applyTaskGitPatchArtifact } from "@/node/services/tools/task_apply_git_patch";
import {
  readSubagentGitPatchArtifact,
  upsertSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import type { SubagentGitProjectPatchArtifact } from "@/common/utils/tools/toolDefinitions";

function streamFromString(value: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function createExecStream(stdout: string, stderr = "", exitCode = 0): ExecStream {
  return {
    stdout: streamFromString(stdout),
    stderr: streamFromString(stderr),
    stdin: new WritableStream<Uint8Array>(),
    exitCode: Promise.resolve(exitCode),
    duration: Promise.resolve(1),
  };
}

interface JjRepoScenario {
  changedPaths?: string[];
  dirtyPaths?: string[];
  currentChangeId?: string;
  currentCommitId?: string;
  descriptions?: Record<string, string>;
  restoreError?: string;
}

interface JjCommandCall {
  command: string;
  cwd?: string;
}

function createJjApplyRuntime(params: {
  scenariosByCwd: Record<string, JjRepoScenario>;
  calls: JjCommandCall[];
  ensureDirs?: string[];
}): Runtime {
  return {
    exec(command: string, options: ExecOptions): Promise<ExecStream> {
      const cwd = options.cwd;
      params.calls.push({ command, cwd });
      const scenario = params.scenariosByCwd[cwd ?? ""];

      if (command.includes(" diff --from ") && command.endsWith(" --name-only")) {
        return Promise.resolve(createExecStream(`${scenario?.changedPaths?.join("\n") ?? ""}\n`));
      }
      if (command.endsWith(" diff --name-only")) {
        return Promise.resolve(createExecStream(`${scenario?.dirtyPaths?.join("\n") ?? ""}\n`));
      }
      if (command.includes(" log --no-graph -r @ ")) {
        return Promise.resolve(
          createExecStream(
            `${scenario?.currentChangeId ?? "target-change"}\n${scenario?.currentCommitId ?? "target-commit"}\n`
          )
        );
      }
      const descriptionMatch = / log --no-graph -r '([^']+)' /.exec(command);
      if (descriptionMatch) {
        const revision = descriptionMatch[1];
        return Promise.resolve(
          createExecStream(`${scenario?.descriptions?.[revision] ?? `Task change ${revision}`}\n`)
        );
      }
      if (command.includes(" restore --from ")) {
        if (scenario?.restoreError) {
          return Promise.resolve(createExecStream("", scenario.restoreError, 1));
        }
        return Promise.resolve(createExecStream(""));
      }
      if (
        command.includes(" workspace add ") ||
        command.includes(" workspace forget ") ||
        command.startsWith("rm -rf ")
      ) {
        return Promise.resolve(createExecStream(""));
      }

      return Promise.resolve(createExecStream("", `unexpected command: ${command}`, 1));
    },
    ensureDir: (directory: string) => {
      params.ensureDirs?.push(directory);
      return Promise.resolve();
    },
    readFile() {
      throw new Error("not implemented");
    },
    writeFile() {
      throw new Error("not implemented");
    },
    stat: () => Promise.reject(new Error("not implemented")),
    resolvePath: (targetPath: string) => Promise.resolve(targetPath),
    normalizePath(targetPath: string) {
      return targetPath;
    },
    getWorkspacePath(_projectPath: string, workspaceName: string) {
      return `/work/${workspaceName}`;
    },
    create: () => Promise.reject(new Error("not implemented")),
    delete: () => Promise.reject(new Error("not implemented")),
    rename: () => Promise.reject(new Error("not implemented")),
    fork: () => Promise.reject(new Error("not implemented")),
    archive: () => Promise.reject(new Error("not implemented")),
    unarchive: () => Promise.reject(new Error("not implemented")),
    list: () => Promise.resolve([]),
    exists: () => Promise.resolve(true),
    getMuxHome() {
      return "/tmp/mux";
    },
    dispose: () => Promise.resolve(),
  } as unknown as Runtime;
}

async function writeWorkspaceConfig(params: {
  muxRoot: string;
  workspaceId: string;
  workspacePath: string;
  projectPath: string;
  projects?: Array<{ projectPath: string; projectName: string }>;
  parentWorkspaceId?: string;
}): Promise<void> {
  await fsPromises.mkdir(path.join(params.muxRoot, "sessions", params.workspaceId), {
    recursive: true,
  });
  await fsPromises.writeFile(
    path.join(params.muxRoot, "config.json"),
    JSON.stringify(
      {
        routePriority: ["direct"],
        migrations: { defaultModelFallbacksSeeded: true },
        projects: [
          [
            params.projectPath,
            {
              workspaces: [
                {
                  id: params.workspaceId,
                  name: "main",
                  path: params.workspacePath,
                  parentWorkspaceId: params.parentWorkspaceId,
                  runtimeConfig: { type: "local" },
                  projects: params.projects ?? [
                    { projectPath: params.projectPath, projectName: "repo" },
                  ],
                },
              ],
            },
          ],
        ],
      },
      null,
      2
    ),
    "utf-8"
  );
}

function readyProjectArtifact(params: {
  projectPath: string;
  projectName: string;
  storageKey: string;
  baseChangeId?: string;
  headChangeId?: string;
}): SubagentGitProjectPatchArtifact {
  return {
    projectPath: params.projectPath,
    projectName: params.projectName,
    storageKey: params.storageKey,
    status: "ready",
    baseChangeId: params.baseChangeId ?? `base-${params.storageKey}`,
    headChangeId: params.headChangeId ?? `head-${params.storageKey}`,
    commitCount: 1,
  };
}

async function writeTaskArtifact(params: {
  workspaceId: string;
  workspaceSessionDir: string;
  childTaskId: string;
  projectArtifacts: SubagentGitProjectPatchArtifact[];
}): Promise<void> {
  await upsertSubagentGitPatchArtifact({
    workspaceId: params.workspaceId,
    workspaceSessionDir: params.workspaceSessionDir,
    childTaskId: params.childTaskId,
    updater: () => ({
      childTaskId: params.childTaskId,
      parentWorkspaceId: params.workspaceId,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      status: "pending",
      projectArtifacts: params.projectArtifacts,
      readyProjectCount: 0,
      failedProjectCount: 0,
      skippedProjectCount: 0,
      totalCommitCount: 0,
    }),
  });
}

async function setupTaskFixture(params: {
  rootDir: string;
  childTaskId: string;
  projectPath: string;
  workspacePath: string;
  projectArtifacts: SubagentGitProjectPatchArtifact[];
  projects?: Array<{ projectPath: string; projectName: string }>;
}): Promise<{ workspaceId: string; sessionDir: string; muxRoot: string }> {
  const workspaceId = "parent";
  const muxRoot = path.join(params.rootDir, "mux");
  const sessionDir = path.join(muxRoot, "sessions", workspaceId);
  await writeWorkspaceConfig({
    muxRoot,
    workspaceId,
    workspacePath: params.workspacePath,
    projectPath: params.projectPath,
    projects: params.projects,
  });
  await writeTaskArtifact({
    workspaceId,
    workspaceSessionDir: sessionDir,
    childTaskId: params.childTaskId,
    projectArtifacts: params.projectArtifacts,
  });
  return { workspaceId, sessionDir, muxRoot };
}

describe("task_apply_git_patch jj-native path", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-task-apply-jj-patch-"));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  test("applies a ready task change with jj restore", async () => {
    const muxRoot = path.join(rootDir, "mux");
    const workspaceId = "parent";
    const childTaskId = "child";
    const projectPath = "/repo";
    const workspacePath = "/workspace/repo";
    const sessionDir = path.join(muxRoot, "sessions", workspaceId);
    await writeWorkspaceConfig({ muxRoot, workspaceId, workspacePath, projectPath });

    await writeTaskArtifact({
      workspaceId,
      workspaceSessionDir: sessionDir,
      childTaskId,
      projectArtifacts: [
        readyProjectArtifact({
          projectPath,
          projectName: "repo",
          storageKey: "repo",
          baseChangeId: "base-change",
          headChangeId: "child-change",
        }),
      ],
    });

    const calls: JjCommandCall[] = [];
    const result = await applyTaskGitPatchArtifact(
      {
        workspaceId,
        cwd: workspacePath,
        runtime: createJjApplyRuntime({
          calls,
          scenariosByCwd: {
            [workspacePath]: {
              changedPaths: ["src/a.txt"],
              descriptions: { "child-change": "child summary" },
            },
          },
        }),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: sessionDir,
        trusted: true,
      },
      { task_id: childTaskId, dry_run: false, three_way: null }
    );

    expect(result.success).toBe(true);
    expect(calls.map((call) => call.command)).toContain(
      "jj --no-pager --color never restore --from 'child-change' --into @ -- 'src/a.txt'"
    );
    expect(calls.map((call) => call.command).join("\n")).not.toMatch(
      /\bgit\s+(am|apply|worktree|status|rev-parse)\b/
    );
  });

  test("applies ready task changes in configured project order and marks both artifacts", async () => {
    const childTaskId = "child-multi";
    const projectA = "/repo/a";
    const projectB = "/repo/b";
    const { workspaceId, sessionDir } = await setupTaskFixture({
      rootDir,
      childTaskId,
      projectPath: projectA,
      workspacePath: projectA,
      projects: [
        { projectPath: projectA, projectName: "project-a" },
        { projectPath: projectB, projectName: "project-b" },
      ],
      projectArtifacts: [
        readyProjectArtifact({ projectPath: projectA, projectName: "project-a", storageKey: "a" }),
        readyProjectArtifact({ projectPath: projectB, projectName: "project-b", storageKey: "b" }),
      ],
    });
    const calls: JjCommandCall[] = [];

    const result = await applyTaskGitPatchArtifact(
      {
        workspaceId,
        cwd: projectA,
        runtime: createJjApplyRuntime({
          calls,
          scenariosByCwd: {
            [projectA]: {
              changedPaths: ["src/a.ts"],
              descriptions: { "head-a": "apply a" },
            },
            [projectB]: {
              changedPaths: ["src/b.ts"],
              descriptions: { "head-b": "apply b" },
            },
          },
        }),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: sessionDir,
        trusted: true,
      },
      { task_id: childTaskId, three_way: null }
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error("Expected task changes to apply");
    expect(result.projectResults.map((projectResult) => projectResult.projectPath)).toEqual([
      projectA,
      projectB,
    ]);
    expect(
      calls.filter((call) => call.command.includes(" restore --from ")).map((call) => call.cwd)
    ).toEqual([projectA, projectB]);
    const artifact = await readSubagentGitPatchArtifact(sessionDir, childTaskId);
    expect(
      artifact?.projectArtifacts.every((projectArtifact) => projectArtifact.appliedAtMs != null)
    ).toBe(true);
  });

  test("allows unrelated dirty paths but refuses overlapping paths before restore", async () => {
    const childTaskId = "child-dirty";
    const projectPath = "/repo";
    const workspacePath = "/workspace/repo";
    const { workspaceId, sessionDir } = await setupTaskFixture({
      rootDir,
      childTaskId,
      projectPath,
      workspacePath,
      projectArtifacts: [
        readyProjectArtifact({ projectPath, projectName: "repo", storageKey: "repo" }),
      ],
    });
    const unrelatedCalls: JjCommandCall[] = [];
    const unrelatedResult = await applyTaskGitPatchArtifact(
      {
        workspaceId,
        cwd: workspacePath,
        runtime: createJjApplyRuntime({
          calls: unrelatedCalls,
          scenariosByCwd: {
            [workspacePath]: {
              changedPaths: ["src/task.ts"],
              dirtyPaths: ["notes.txt"],
            },
          },
        }),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: sessionDir,
        trusted: true,
      },
      { task_id: childTaskId, three_way: null }
    );

    expect(unrelatedResult.success).toBe(true);
    expect(unrelatedCalls.some((call) => call.command.includes(" restore --from "))).toBe(true);

    const overlapCalls: JjCommandCall[] = [];
    const overlapResult = await applyTaskGitPatchArtifact(
      {
        workspaceId,
        cwd: workspacePath,
        runtime: createJjApplyRuntime({
          calls: overlapCalls,
          scenariosByCwd: {
            [workspacePath]: {
              changedPaths: ["dir/task.ts"],
              dirtyPaths: ["dir"],
            },
          },
        }),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: sessionDir,
        trusted: true,
      },
      { task_id: childTaskId, force: true, three_way: null }
    );

    expect(overlapResult.success).toBe(false);
    if (overlapResult.success) throw new Error("Expected dirty-path overlap failure");
    expect(overlapResult.conflictPaths).toEqual(["dir"]);
    expect(overlapCalls.some((call) => call.command.includes(" restore --from "))).toBe(false);
  });

  test("uses a disposable jj workspace for dry runs and leaves metadata unapplied", async () => {
    const childTaskId = "child-dry-run";
    const projectPath = "/repo";
    const workspacePath = "/workspace/repo";
    const { workspaceId, sessionDir } = await setupTaskFixture({
      rootDir,
      childTaskId,
      projectPath,
      workspacePath,
      projectArtifacts: [
        readyProjectArtifact({
          projectPath,
          projectName: "repo",
          storageKey: "repo",
          headChangeId: "child-change",
        }),
      ],
    });
    const calls: JjCommandCall[] = [];
    const result = await applyTaskGitPatchArtifact(
      {
        workspaceId,
        cwd: workspacePath,
        runtime: createJjApplyRuntime({
          calls,
          scenariosByCwd: {
            [workspacePath]: {
              changedPaths: ["src/a.ts"],
              descriptions: { "child-change": "dry-run change" },
            },
          },
        }),
        runtimeTempDir: "/runtime-tmp",
        workspaceSessionDir: sessionDir,
        trusted: true,
      },
      { task_id: childTaskId, dry_run: true, three_way: null }
    );

    expect(result.success).toBe(true);
    const restoreCall = calls.find((call) => call.command.includes(" restore --from "));
    expect(restoreCall?.cwd).toStartWith("/runtime-tmp/mux-jj-restore-dry-run-");
    expect(calls.some((call) => call.command.includes(" workspace add --revision @ "))).toBe(true);
    expect(calls.some((call) => call.command.includes(" workspace forget "))).toBe(true);
    expect(calls.some((call) => call.command.startsWith("rm -rf "))).toBe(true);
    const artifact = await readSubagentGitPatchArtifact(sessionDir, childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedAtMs).toBeUndefined();
  });

  test("checks the target jj revision before computing or restoring task changes", async () => {
    const childTaskId = "child-expected-head";
    const projectPath = "/repo";
    const workspacePath = "/workspace/repo";
    const { workspaceId, sessionDir } = await setupTaskFixture({
      rootDir,
      childTaskId,
      projectPath,
      workspacePath,
      projectArtifacts: [
        readyProjectArtifact({ projectPath, projectName: "repo", storageKey: "repo" }),
      ],
    });
    const calls: JjCommandCall[] = [];
    const result = await applyTaskGitPatchArtifact(
      {
        workspaceId,
        cwd: workspacePath,
        runtime: createJjApplyRuntime({
          calls,
          scenariosByCwd: {
            [workspacePath]: { currentChangeId: "actual-change", currentCommitId: "actual-commit" },
          },
        }),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: sessionDir,
        trusted: true,
      },
      { task_id: childTaskId, expected_head_sha: "expected-change", three_way: null }
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected expected-head refusal");
    expect(result.error).toContain("does not match expected revision");
    expect(calls.some((call) => call.command.includes(" diff --from "))).toBe(false);
    expect(calls.some((call) => call.command.includes(" restore --from "))).toBe(false);
  });

  test("stops after a failed project restore and marks only earlier projects applied", async () => {
    const childTaskId = "child-stop-on-failure";
    const projectA = "/repo/a";
    const projectB = "/repo/b";
    const projectC = "/repo/c";
    const { workspaceId, sessionDir } = await setupTaskFixture({
      rootDir,
      childTaskId,
      projectPath: projectA,
      workspacePath: projectA,
      projects: [
        { projectPath: projectA, projectName: "project-a" },
        { projectPath: projectB, projectName: "project-b" },
        { projectPath: projectC, projectName: "project-c" },
      ],
      projectArtifacts: [
        readyProjectArtifact({ projectPath: projectA, projectName: "project-a", storageKey: "a" }),
        readyProjectArtifact({ projectPath: projectB, projectName: "project-b", storageKey: "b" }),
        readyProjectArtifact({ projectPath: projectC, projectName: "project-c", storageKey: "c" }),
      ],
    });
    const calls: JjCommandCall[] = [];
    const result = await applyTaskGitPatchArtifact(
      {
        workspaceId,
        cwd: projectA,
        runtime: createJjApplyRuntime({
          calls,
          scenariosByCwd: {
            [projectA]: { changedPaths: ["a.ts"] },
            [projectB]: { changedPaths: ["b.ts"], restoreError: "restore conflict" },
            [projectC]: { changedPaths: ["c.ts"] },
          },
        }),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: sessionDir,
        trusted: true,
      },
      { task_id: childTaskId, three_way: null }
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected restore failure");
    expect(result.projectResults?.map((projectResult) => projectResult.status)).toEqual([
      "applied",
      "failed",
      "skipped",
    ]);
    expect(
      calls.filter((call) => call.command.includes(" restore --from ")).map((call) => call.cwd)
    ).toEqual([projectA, projectB]);
    const artifact = await readSubagentGitPatchArtifact(sessionDir, childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedAtMs).toBeDefined();
    expect(artifact?.projectArtifacts[1]?.appliedAtMs).toBeUndefined();
    expect(artifact?.projectArtifacts[2]?.appliedAtMs).toBeUndefined();
  });

  test("does not wait on a pending sibling when project_path selects a ready project", async () => {
    const childTaskId = "child-filtered";
    const projectA = "/repo/a";
    const projectB = "/repo/b";
    const readyProject = readyProjectArtifact({
      projectPath: projectA,
      projectName: "project-a",
      storageKey: "a",
    });
    const pendingProject = {
      ...readyProjectArtifact({ projectPath: projectB, projectName: "project-b", storageKey: "b" }),
      status: "pending" as const,
    };
    const { workspaceId, sessionDir } = await setupTaskFixture({
      rootDir,
      childTaskId,
      projectPath: projectA,
      workspacePath: projectA,
      projects: [
        { projectPath: projectA, projectName: "project-a" },
        { projectPath: projectB, projectName: "project-b" },
      ],
      projectArtifacts: [readyProject, pendingProject],
    });
    let pollCount = 0;
    const calls: JjCommandCall[] = [];
    const result = await applyTaskGitPatchArtifact(
      {
        workspaceId,
        cwd: projectA,
        runtime: createJjApplyRuntime({
          calls,
          scenariosByCwd: { [projectA]: { changedPaths: ["a.ts"] } },
        }),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: sessionDir,
        trusted: true,
      },
      { task_id: childTaskId, project_path: projectA, three_way: null },
      { pendingGenerationOnPoll: () => (pollCount += 1) }
    );

    expect(result.success).toBe(true);
    expect(pollCount).toBe(0);
    expect(calls.some((call) => call.cwd === projectB)).toBe(false);
  });

  test("fails atomically while any selected project remains pending", async () => {
    const childTaskId = "child-pending";
    const projectA = "/repo/a";
    const projectB = "/repo/b";
    const { workspaceId, sessionDir } = await setupTaskFixture({
      rootDir,
      childTaskId,
      projectPath: projectA,
      workspacePath: projectA,
      projects: [
        { projectPath: projectA, projectName: "project-a" },
        { projectPath: projectB, projectName: "project-b" },
      ],
      projectArtifacts: [
        readyProjectArtifact({ projectPath: projectA, projectName: "project-a", storageKey: "a" }),
        {
          ...readyProjectArtifact({
            projectPath: projectB,
            projectName: "project-b",
            storageKey: "b",
          }),
          status: "pending",
        },
      ],
    });
    const calls: JjCommandCall[] = [];
    const result = await applyTaskGitPatchArtifact(
      {
        workspaceId,
        cwd: projectA,
        runtime: createJjApplyRuntime({
          calls,
          scenariosByCwd: { [projectA]: { changedPaths: ["a.ts"] } },
        }),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: sessionDir,
        trusted: true,
      },
      { task_id: childTaskId, three_way: null },
      { pendingGenerationWaitMs: 0 }
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected pending-generation refusal");
    expect(result.error).toContain("not finished");
    expect(result.projectResults?.map((projectResult) => projectResult.status)).toEqual([
      "skipped",
      "skipped",
    ]);
    expect(calls.some((call) => call.command.includes(" restore --from "))).toBe(false);
  });

  test("rejects unsafe task IDs before touching the runtime", async () => {
    const ensureDirs: string[] = [];
    const result = await applyTaskGitPatchArtifact(
      {
        workspaceId: "parent",
        cwd: "/workspace/repo",
        runtime: createJjApplyRuntime({
          calls: [],
          ensureDirs,
          scenariosByCwd: {},
        }),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: path.join(rootDir, "mux", "sessions", "parent"),
        trusted: true,
      },
      { task_id: "child/../../escape", three_way: null }
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected invalid task ID refusal");
    expect(result.error).toBe("Invalid task_id.");
    expect(ensureDirs).toEqual([]);
  });
});
