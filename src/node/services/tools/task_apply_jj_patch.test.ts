import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { ExecOptions, ExecStream, Runtime } from "@/node/runtime/Runtime";
import { applyTaskGitPatchArtifact } from "@/node/services/tools/task_apply_git_patch";
import { upsertSubagentGitPatchArtifact } from "@/node/services/subagentGitPatchArtifacts";

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

function createJjApplyRuntime(commands: string[]): Runtime {
  return {
    async exec(command: string, _options: ExecOptions): Promise<ExecStream> {
      commands.push(command);

      if (command.includes(" diff --from 'base-change' --to 'child-change' --name-only")) {
        return createExecStream("src/a.txt\n");
      }
      if (command.endsWith(" diff --name-only")) {
        return createExecStream("");
      }
      if (command.includes(" log --no-graph -r @ ")) {
        return createExecStream("target-change\ntarget-commit\n");
      }
      if (command.includes(" log --no-graph -r 'child-change' ")) {
        return createExecStream("child summary\n");
      }
      if (command.includes(" restore --from 'child-change' --into @ -- 'src/a.txt'")) {
        return createExecStream("");
      }

      return createExecStream("", `unexpected command: ${command}`, 1);
    },
    async ensureDir() {},
    readFile() {
      throw new Error("not implemented");
    },
    writeFile() {
      throw new Error("not implemented");
    },
    async stat() {
      throw new Error("not implemented");
    },
    async resolvePath(targetPath: string) {
      return targetPath;
    },
    normalizePath(targetPath: string) {
      return targetPath;
    },
    getWorkspacePath(_projectPath: string, workspaceName: string) {
      return `/work/${workspaceName}`;
    },
    async create() {
      throw new Error("not implemented");
    },
    async delete() {
      throw new Error("not implemented");
    },
    async rename() {
      throw new Error("not implemented");
    },
    async fork() {
      throw new Error("not implemented");
    },
    async archive() {
      throw new Error("not implemented");
    },
    async unarchive() {
      throw new Error("not implemented");
    },
    async list() {
      return [];
    },
    async exists() {
      return true;
    },
    getMuxHome() {
      return "/tmp/mux";
    },
    async dispose() {},
  } as unknown as Runtime;
}

async function writeWorkspaceConfig(params: {
  muxRoot: string;
  workspaceId: string;
  workspacePath: string;
  projectPath: string;
}): Promise<void> {
  await fsPromises.mkdir(path.join(params.muxRoot, "sessions", params.workspaceId), {
    recursive: true,
  });
  await fsPromises.writeFile(
    path.join(params.muxRoot, "config.json"),
    JSON.stringify(
      {
        projects: [
          [
            params.projectPath,
            {
              workspaces: [
                {
                  id: params.workspaceId,
                  name: "main",
                  path: params.workspacePath,
                  runtimeConfig: { type: "local" },
                  projects: [{ projectPath: params.projectPath, projectName: "repo" }],
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

    await upsertSubagentGitPatchArtifact({
      workspaceId,
      workspaceSessionDir: sessionDir,
      childTaskId,
      updater: () => ({
        childTaskId,
        parentWorkspaceId: workspaceId,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        status: "pending",
        projectArtifacts: [
          {
            projectPath,
            projectName: "repo",
            storageKey: "repo",
            status: "ready",
            baseChangeId: "base-change",
            headChangeId: "child-change",
            commitCount: 1,
          },
        ],
        readyProjectCount: 0,
        failedProjectCount: 0,
        skippedProjectCount: 0,
        totalCommitCount: 0,
      }),
    });

    const commands: string[] = [];
    const result = await applyTaskGitPatchArtifact(
      {
        workspaceId,
        cwd: workspacePath,
        runtime: createJjApplyRuntime(commands),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: sessionDir,
        trusted: true,
      },
      { task_id: childTaskId, dry_run: false, three_way: null }
    );

    expect(result.success).toBe(true);
    expect(commands).toContain(
      "jj --no-pager --color never restore --from 'child-change' --into @ -- 'src/a.txt'"
    );
    expect(commands.join("\n")).not.toMatch(/\bgit\s+(am|apply|worktree|status|rev-parse)\b/);
  });
});
