import { describe, expect, it, spyOn } from "bun:test";
import * as os from "os";
import * as path from "path";
import * as fsPromises from "fs/promises";
import { execSync } from "node:child_process";
import * as disposableExec from "@/node/utils/disposableExec";
import type { InitLogger } from "@/node/runtime/Runtime";
import { initJjGitRepository } from "@/node/vcs/jj";
import * as muxignore from "./muxignore";
import { WorktreeManager } from "./WorktreeManager";

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

function createMockExecResult(
  result: Promise<{ stdout: string; stderr: string }>
): ReturnType<typeof disposableExec.execFileAsync> {
  void result.catch(noop);
  return {
    result,
    get promise() {
      return result;
    },
    child: {},
    [Symbol.dispose]: noop,
  } as unknown as ReturnType<typeof disposableExec.execFileAsync>;
}

function initGitRepo(projectPath: string): void {
  execSync("git init -b main", { cwd: projectPath, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: projectPath, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: projectPath, stdio: "ignore" });
  // Ensure tests don't hang when developers have global commit signing enabled.
  execSync("git config commit.gpgsign false", { cwd: projectPath, stdio: "ignore" });
  execSync("bash -lc 'echo \"hello\" > README.md'", { cwd: projectPath, stdio: "ignore" });
  execSync("git add README.md", { cwd: projectPath, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: projectPath, stdio: "ignore" });
}

function createNullInitLogger(): InitLogger {
  return {
    logStep: (_message: string) => undefined,
    logStdout: (_line: string) => undefined,
    logStderr: (_line: string) => undefined,
    logComplete: (_exitCode: number) => undefined,
  };
}

async function createWorktreeManagerFixture(options?: {
  existingBranchName?: string;
  currentBranchName?: string;
  tempDirPrefix?: string;
}) {
  const rootDir = await fsPromises.realpath(
    await fsPromises.mkdtemp(
      path.join(os.tmpdir(), options?.tempDirPrefix ?? "worktree-manager-create-")
    )
  );
  const projectPath = path.join(rootDir, "repo");
  await fsPromises.mkdir(projectPath, { recursive: true });
  initGitRepo(projectPath);
  await initJjGitRepository(projectPath);

  if (options?.currentBranchName) {
    execSync(`git checkout -b ${options.currentBranchName}`, { cwd: projectPath, stdio: "ignore" });
  }

  if (options?.existingBranchName) {
    execSync(`git branch ${options.existingBranchName}`, { cwd: projectPath, stdio: "ignore" });
  }

  const srcBaseDir = path.join(rootDir, "src");
  await fsPromises.mkdir(srcBaseDir, { recursive: true });

  return {
    rootDir,
    projectPath,
    manager: new WorktreeManager(srcBaseDir),
    initLogger: createNullInitLogger(),
    cleanup: () => fsPromises.rm(rootDir, { recursive: true, force: true }),
  };
}

describe("WorktreeManager constructor", () => {
  it("should expand tilde in srcBaseDir", () => {
    const manager = new WorktreeManager("~/workspace");
    const workspacePath = manager.getWorkspacePath("/home/user/project", "branch");

    // The workspace path should use the expanded home directory
    const expected = path.join(os.homedir(), "workspace", "project", "branch");
    expect(workspacePath).toBe(expected);
  });

  it("should handle absolute paths without expansion", () => {
    const manager = new WorktreeManager("/absolute/path");
    const workspacePath = manager.getWorkspacePath("/home/user/project", "branch");

    const expected = path.join("/absolute/path", "project", "branch");
    expect(workspacePath).toBe(expected);
  });

  it("should handle bare tilde", () => {
    const manager = new WorktreeManager("~");
    const workspacePath = manager.getWorkspacePath("/home/user/project", "branch");

    const expected = path.join(os.homedir(), "project", "branch");
    expect(workspacePath).toBe(expected);
  });

  it("should support flat workspace paths for project-local checkout directories", () => {
    const manager = new WorktreeManager("/repo/.worktrees", "flat");
    const workspacePath = manager.getWorkspacePath("/repo", "branch");

    expect(workspacePath).toBe(path.join("/repo/.worktrees", "branch"));
  });
});

describe("WorktreeManager.createWorkspace", () => {
  it("creates jj workspaces without invoking git commands", async () => {
    const rootDir = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(os.tmpdir(), "worktree-manager-jj-create-"))
    );
    const projectPath = path.join(rootDir, "repo");
    const srcBaseDir = path.join(rootDir, "src");
    const workspaceName = "agent-task";
    const workspacePath = path.join(srcBaseDir, "repo", workspaceName);

    await fsPromises.mkdir(path.join(projectPath, ".jj", "repo"), { recursive: true });
    await fsPromises.mkdir(srcBaseDir, { recursive: true });

    const execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation(
      (file, args) => {
        if (file === "git") {
          return createMockExecResult(
            Promise.reject(new Error(`unexpected git command: ${(args ?? []).join(" ")}`))
          );
        }

        expect(file).toBe("jj");
        const commandArgs = args ?? [];
        if (commandArgs.includes("bookmark") && commandArgs.includes("list")) {
          return createMockExecResult(Promise.resolve({ stdout: "main\n", stderr: "" }));
        }

        if (commandArgs.includes("workspace") && commandArgs.includes("add")) {
          expect(commandArgs).toEqual([
            "--no-pager",
            "--color",
            "never",
            "--repository",
            projectPath,
            "workspace",
            "add",
            "--name",
            workspaceName,
            "--revision",
            "main",
            "--message",
            workspaceName,
            workspacePath,
          ]);
          return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
        }

        return createMockExecResult(
          Promise.reject(new Error(`unexpected jj command: ${commandArgs.join(" ")}`))
        );
      }
    );

    try {
      const manager = new WorktreeManager(srcBaseDir);
      const result = await manager.createWorkspace({
        projectPath,
        branchName: workspaceName,
        trunkBranch: "main",
        initLogger: createNullInitLogger(),
        trusted: true,
      });

      expect(result.success).toBe(true);
      if (!result.success || !result.workspacePath) {
        throw new Error("Expected createWorkspace to return a workspace path");
      }
      expect(result.workspacePath).toBe(workspacePath);

      const bookmarkMap = JSON.parse(
        await fsPromises.readFile(
          path.join(projectPath, ".jj", "repo", "mux-workspaces.json"),
          "utf8"
        )
      ) as Record<string, string>;
      expect(bookmarkMap).toEqual({ [workspaceName]: workspaceName });

      for (const [file] of execFileAsyncSpy.mock.calls) {
        expect(file).toBe("jj");
      }
    } finally {
      execFileAsyncSpy.mockRestore();
      await fsPromises.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("allows the parent revision source even when it is not a bookmark", async () => {
    const rootDir = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(os.tmpdir(), "worktree-manager-jj-parent-revision-"))
    );
    const projectPath = path.join(rootDir, "repo");
    const srcBaseDir = path.join(rootDir, "src");
    const workspaceName = "agent-task";
    const workspacePath = path.join(srcBaseDir, "repo", workspaceName);

    await fsPromises.mkdir(path.join(projectPath, ".jj", "repo"), { recursive: true });
    await fsPromises.mkdir(srcBaseDir, { recursive: true });

    const execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation(
      (file, args) => {
        if (file === "git") {
          return createMockExecResult(
            Promise.reject(new Error(`unexpected git command: ${(args ?? []).join(" ")}`))
          );
        }

        expect(file).toBe("jj");
        const commandArgs = args ?? [];
        if (commandArgs.includes("bookmark") && commandArgs.includes("list")) {
          return createMockExecResult(Promise.resolve({ stdout: "main\n", stderr: "" }));
        }

        if (commandArgs.includes("workspace") && commandArgs.includes("add")) {
          expect(commandArgs).toEqual([
            "--no-pager",
            "--color",
            "never",
            "--repository",
            projectPath,
            "workspace",
            "add",
            "--name",
            workspaceName,
            "--revision",
            "@-",
            "--message",
            workspaceName,
            workspacePath,
          ]);
          return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
        }

        return createMockExecResult(
          Promise.reject(new Error(`unexpected jj command: ${commandArgs.join(" ")}`))
        );
      }
    );

    try {
      const manager = new WorktreeManager(srcBaseDir);
      const result = await manager.createWorkspace({
        projectPath,
        branchName: workspaceName,
        trunkBranch: "@-",
        initLogger: createNullInitLogger(),
        trusted: true,
      });

      expect(result.success).toBe(true);
    } finally {
      execFileAsyncSpy.mockRestore();
      await fsPromises.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("forgets a partially created jj workspace when .muxignore sync fails", async () => {
    const fixture = await createWorktreeManagerFixture();
    const workspaceName = "feature-rollback";
    const workspacePath = fixture.manager.getWorkspacePath(fixture.projectPath, workspaceName);
    const syncSpy = spyOn(muxignore, "syncMuxignoreFiles").mockRejectedValue(
      new Error("muxignore sync failed")
    );

    try {
      const failed = await fixture.manager.createWorkspace({
        projectPath: fixture.projectPath,
        branchName: workspaceName,
        trunkBranch: "main",
        initLogger: fixture.initLogger,
      });

      expect(failed).toEqual({ success: false, error: "muxignore sync failed" });
      const workspaceExists = await fsPromises
        .access(workspacePath)
        .then(() => true)
        .catch(() => false);
      expect(workspaceExists).toBe(false);

      syncSpy.mockRestore();
      const retried = await fixture.manager.createWorkspace({
        projectPath: fixture.projectPath,
        branchName: workspaceName,
        trunkBranch: "main",
        initLogger: fixture.initLogger,
      });
      expect(retried.success).toBe(true);
    } finally {
      syncSpy.mockRestore();
      await fixture.cleanup();
    }
  }, 20_000);

  it("uses directoryName for the jj workspace path while preserving its source mapping", async () => {
    const fixture = await createWorktreeManagerFixture();
    const branchName = "feature-branch";
    const directoryName = "review-slot";

    try {
      const result = await fixture.manager.createWorkspace({
        projectPath: fixture.projectPath,
        branchName,
        directoryName,
        trunkBranch: "main",
        initLogger: fixture.initLogger,
        trusted: true,
      });

      expect(result.success).toBe(true);
      if (!result.success || !result.workspacePath) {
        throw new Error("Expected createWorkspace to return a workspace path");
      }

      expect(result.workspacePath).toBe(
        fixture.manager.getWorkspacePath(fixture.projectPath, directoryName)
      );
      const mapping = JSON.parse(
        await fsPromises.readFile(
          path.join(fixture.projectPath, ".jj", "repo", "mux-workspaces.json"),
          "utf8"
        )
      ) as Record<string, string>;
      expect(mapping).toEqual({ [directoryName]: branchName });
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});

describe("WorktreeManager.renameWorkspace", () => {
  it("renames jj workspaces and their mapping without invoking git commands", async () => {
    const rootDir = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(os.tmpdir(), "worktree-manager-jj-rename-"))
    );
    const projectPath = path.join(rootDir, "repo");
    const srcBaseDir = path.join(rootDir, "src");
    const oldName = "old-task";
    const newName = "new-task";
    const oldPath = path.join(srcBaseDir, "repo", oldName);
    const newPath = path.join(srcBaseDir, "repo", newName);
    const workspaceMapPath = path.join(projectPath, ".jj", "repo", "mux-workspaces.json");

    await fsPromises.mkdir(path.join(projectPath, ".jj", "repo"), { recursive: true });
    await fsPromises.mkdir(oldPath, { recursive: true });
    await fsPromises.writeFile(workspaceMapPath, `${JSON.stringify({ [oldName]: "topic" })}\n`);

    const execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation(
      (file, args) => {
        if (file === "git") {
          return createMockExecResult(
            Promise.reject(new Error(`unexpected git command: ${(args ?? []).join(" ")}`))
          );
        }

        expect(file).toBe("jj");
        expect(args).toEqual([
          "--no-pager",
          "--color",
          "never",
          "--repository",
          oldPath,
          "workspace",
          "rename",
          newName,
        ]);
        return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
      }
    );

    try {
      const manager = new WorktreeManager(srcBaseDir);
      const result = await manager.renameWorkspace(projectPath, oldName, newName, true);

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error("Expected renameWorkspace to succeed");
      }
      expect(result.oldPath).toBe(oldPath);
      expect(result.newPath).toBe(newPath);
      let oldPathExists = true;
      try {
        await fsPromises.access(oldPath);
      } catch {
        oldPathExists = false;
      }
      expect(oldPathExists).toBe(false);
      let newPathExists = true;
      try {
        await fsPromises.access(newPath);
      } catch {
        newPathExists = false;
      }
      expect(newPathExists).toBe(true);

      const bookmarkMap = JSON.parse(await fsPromises.readFile(workspaceMapPath, "utf8")) as Record<
        string,
        string
      >;
      expect(bookmarkMap).toEqual({ [newName]: "topic" });

      for (const [file] of execFileAsyncSpy.mock.calls) {
        expect(file).toBe("jj");
      }
    } finally {
      execFileAsyncSpy.mockRestore();
      await fsPromises.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("renames the jj workspace while preserving its source mapping", async () => {
    const fixture = await createWorktreeManagerFixture();

    try {
      const { projectPath, manager, initLogger } = fixture;
      const branchName = "feature-branch";
      const oldName = "review-slot";
      const newName = "renamed-slot";
      const createResult = await manager.createWorkspace({
        projectPath,
        branchName,
        directoryName: oldName,
        trunkBranch: "main",
        initLogger,
        trusted: true,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const renameResult = await manager.renameWorkspace(projectPath, oldName, newName, true);
      expect(renameResult.success).toBe(true);
      const mapping = JSON.parse(
        await fsPromises.readFile(
          path.join(projectPath, ".jj", "repo", "mux-workspaces.json"),
          "utf8"
        )
      ) as Record<string, string>;
      expect(mapping).toEqual({ [newName]: branchName });
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});

describe("WorktreeManager.deleteWorkspace", () => {
  it("forgets jj workspaces and removes their directory without invoking git commands", async () => {
    const rootDir = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(os.tmpdir(), "worktree-manager-jj-delete-"))
    );
    const projectPath = path.join(rootDir, "repo");
    const srcBaseDir = path.join(rootDir, "src");
    const workspaceName = "agent-task";
    const workspacePath = path.join(srcBaseDir, "repo", workspaceName);
    const workspaceMapPath = path.join(projectPath, ".jj", "repo", "mux-workspaces.json");

    await fsPromises.mkdir(path.join(projectPath, ".jj", "repo"), { recursive: true });
    await fsPromises.mkdir(workspacePath, { recursive: true });
    await fsPromises.writeFile(
      workspaceMapPath,
      `${JSON.stringify({ [workspaceName]: workspaceName })}\n`
    );

    const execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation(
      (file, args) => {
        if (file === "git") {
          return createMockExecResult(
            Promise.reject(new Error(`unexpected git command: ${(args ?? []).join(" ")}`))
          );
        }

        expect(file).toBe("jj");
        expect(args).toEqual([
          "--no-pager",
          "--color",
          "never",
          "--repository",
          projectPath,
          "--ignore-working-copy",
          "workspace",
          "forget",
          workspaceName,
        ]);
        return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
      }
    );

    try {
      const manager = new WorktreeManager(srcBaseDir);
      const result = await manager.deleteWorkspace(projectPath, workspaceName, true, true);

      expect(result.success).toBe(true);
      let workspacePathExists = true;
      try {
        await fsPromises.access(workspacePath);
      } catch {
        workspacePathExists = false;
      }
      expect(workspacePathExists).toBe(false);

      let workspaceMapPathExists = true;
      try {
        await fsPromises.access(workspaceMapPath);
      } catch {
        workspaceMapPathExists = false;
      }
      expect(workspaceMapPathExists).toBe(false);

      for (const [file] of execFileAsyncSpy.mock.calls) {
        expect(file).toBe("jj");
      }
    } finally {
      execFileAsyncSpy.mockRestore();
      await fsPromises.rm(rootDir, { recursive: true, force: true });
    }
  });

  // JJ deletion forgets a workspace and cleans its mapping; it does not manage Git branches.

  it("refuses to delete dirty jj workspaces without force", async () => {
    const fixture = await createWorktreeManagerFixture({
      tempDirPrefix: "worktree-manager-delete-",
    });

    try {
      const { projectPath, manager, initLogger } = fixture;

      const workspaceName = "feature-dirty";
      const createResult = await manager.createWorkspace({
        projectPath,
        branchName: workspaceName,
        trunkBranch: "main",
        initLogger,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success || !createResult.workspacePath) {
        throw new Error("Expected workspacePath from createWorkspace");
      }

      await fsPromises.appendFile(path.join(createResult.workspacePath, "README.md"), "dirty\n");

      const deleteResult = await manager.deleteWorkspace(projectPath, workspaceName, false);
      expect(deleteResult).toEqual({ success: false, error: "Workspace has working-copy changes" });
      await fsPromises.access(createResult.workspacePath);

      await fsPromises.writeFile(path.join(createResult.workspacePath, "README.md"), "hello\n");
      const cleanDeleteResult = await manager.deleteWorkspace(projectPath, workspaceName, false);
      expect(cleanDeleteResult.success).toBe(true);
      const workspaceStillExists = await fsPromises
        .access(createResult.workspacePath)
        .then(() => true)
        .catch(() => false);
      expect(workspaceStillExists).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});

describe("WorktreeManager.forkWorkspace", () => {
  it("forks from the source jj change id without invoking git commands", async () => {
    const rootDir = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(os.tmpdir(), "worktree-manager-jj-fork-"))
    );
    const projectPath = path.join(rootDir, "repo");
    const srcBaseDir = path.join(rootDir, "src");
    const sourceWorkspaceName = "source-task";
    const newWorkspaceName = "fork-task";
    const sourceWorkspacePath = path.join(srcBaseDir, "repo", sourceWorkspaceName);
    const newWorkspacePath = path.join(srcBaseDir, "repo", newWorkspaceName);

    await fsPromises.mkdir(path.join(projectPath, ".jj", "repo"), { recursive: true });
    await fsPromises.mkdir(sourceWorkspacePath, { recursive: true });

    const execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation(
      (file, args) => {
        if (file === "git") {
          return createMockExecResult(
            Promise.reject(new Error(`unexpected git command: ${(args ?? []).join(" ")}`))
          );
        }

        expect(file).toBe("jj");
        const commandArgs = args ?? [];
        if (
          commandArgs.includes("bookmark") &&
          commandArgs.includes("list") &&
          commandArgs.includes(sourceWorkspacePath)
        ) {
          return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
        }

        if (commandArgs.includes("log") && commandArgs.includes(sourceWorkspacePath)) {
          return createMockExecResult(Promise.resolve({ stdout: "kqpnwost\n", stderr: "" }));
        }

        if (commandArgs.includes("bookmark") && commandArgs.includes("list")) {
          return createMockExecResult(Promise.resolve({ stdout: "main\n", stderr: "" }));
        }

        if (commandArgs.includes("workspace") && commandArgs.includes("add")) {
          expect(commandArgs).toEqual([
            "--no-pager",
            "--color",
            "never",
            "--repository",
            projectPath,
            "workspace",
            "add",
            "--name",
            newWorkspaceName,
            "--revision",
            "kqpnwost",
            "--message",
            newWorkspaceName,
            newWorkspacePath,
          ]);
          return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
        }

        return createMockExecResult(
          Promise.reject(new Error(`unexpected jj command: ${commandArgs.join(" ")}`))
        );
      }
    );

    try {
      const manager = new WorktreeManager(srcBaseDir);
      const result = await manager.forkWorkspace({
        projectPath,
        sourceWorkspaceName,
        newWorkspaceName,
        initLogger: createNullInitLogger(),
        trusted: true,
      });

      expect(result.success).toBe(true);
      expect(result.workspacePath).toBe(newWorkspacePath);
      expect(result.sourceBranch).toBe("kqpnwost");

      for (const [file] of execFileAsyncSpy.mock.calls) {
        expect(file).toBe("jj");
      }
    } finally {
      execFileAsyncSpy.mockRestore();
      await fsPromises.rm(rootDir, { recursive: true, force: true });
    }
  });
});
