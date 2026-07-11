import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Ok } from "@/common/types/result";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { log } from "@/node/services/log";
import * as managedWorktree from "@/node/worktree/removeManagedGitWorktree";
import { createWorktreeArchiveHook } from "./worktreeLifecycleHooks";

function createWorkspaceMetadata(
  overrides?: Partial<FrontendWorkspaceMetadata>
): FrontendWorkspaceMetadata {
  const runtimeConfig = overrides?.runtimeConfig ?? {
    type: "worktree" as const,
    srcBaseDir: "/tmp/src",
  };
  const name = overrides?.name ?? "workspace-name";
  const defaultNamedWorkspacePath =
    runtimeConfig.type === "worktree"
      ? path.join(runtimeConfig.srcBaseDir, "_workspaces", name)
      : path.join("/tmp", name);

  return {
    id: "ws",
    name,
    projectName: "project-name",
    projectPath: "/tmp/project-name",
    runtimeConfig,
    namedWorkspacePath: overrides?.namedWorkspacePath ?? defaultNamedWorkspacePath,
    ...overrides,
  };
}

function getManagedPath(workspaceMetadata: FrontendWorkspaceMetadata): string {
  return workspaceMetadata.namedWorkspacePath;
}

async function pathExists(targetPath: string): Promise<boolean> {
  return fs.promises
    .access(targetPath)
    .then(() => true)
    .catch(() => false);
}

describe("createWorktreeArchiveHook", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    mock.restore();

    await Promise.all(
      tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true }))
    );
  });

  async function createTempRoot(): Promise<string> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mux-worktree-archive-"));
    tempDirs.push(tempRoot);
    return tempRoot;
  }

  it("skips deletion when worktree archive behavior keeps the checkout", async () => {
    const srcBaseDir = await createTempRoot();
    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "worktree", srcBaseDir },
    });
    const managedPath = getManagedPath(workspaceMetadata);
    await mkdir(managedPath, { recursive: true });

    const hook = createWorktreeArchiveHook({
      getWorktreeArchiveBehavior: () => "keep",
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(await pathExists(managedPath)).toBe(true);
  });

  it("delegates managed workspace cleanup when deletion is enabled", async () => {
    const srcBaseDir = await createTempRoot();
    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "worktree", srcBaseDir },
    });
    const managedPath = getManagedPath(workspaceMetadata);
    await mkdir(managedPath, { recursive: true });

    const removeSpy = spyOn(managedWorktree, "removeManagedGitWorktree").mockImplementation(
      async (_projectPath, workspacePath) => {
        await rm(workspacePath, { recursive: true, force: true });
      }
    );

    const hook = createWorktreeArchiveHook({
      getWorktreeArchiveBehavior: () => "delete",
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(removeSpy).toHaveBeenCalledWith(workspaceMetadata.projectPath, managedPath);
    expect(await pathExists(managedPath)).toBe(false);
  });

  it("skips snapshot cleanup for multi-project workspaces so restore can rehydrate safely", async () => {
    const srcBaseDir = await createTempRoot();
    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "worktree", srcBaseDir },
      projects: [
        { projectPath: "/tmp/project-a", projectName: "project-a" },
        { projectPath: "/tmp/project-b", projectName: "project-b" },
      ],
    });
    const managedPath = getManagedPath(workspaceMetadata);
    await mkdir(managedPath, { recursive: true });
    const debugSpy = spyOn(log, "debug").mockImplementation(() => undefined);

    const hook = createWorktreeArchiveHook({
      getWorktreeArchiveBehavior: () => "snapshot",
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(await pathExists(managedPath)).toBe(true);
    expect(debugSpy).toHaveBeenCalledWith(
      "Skipping snapshot checkout cleanup for multi-project archive",
      { workspaceId: workspaceMetadata.id }
    );
  });

  it("skips cleanup for non-worktree runtimes even when cleanup is enabled", async () => {
    const tempRoot = await createTempRoot();
    const untouchedPath = path.join(tempRoot, "project-name", "workspace-name");
    await mkdir(untouchedPath, { recursive: true });

    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "local" },
    });

    const hook = createWorktreeArchiveHook({
      getWorktreeArchiveBehavior: () => "snapshot",
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(await pathExists(untouchedPath)).toBe(true);
  });

  it("forgets a missing managed workspace when deletion is enabled", async () => {
    const srcBaseDir = await createTempRoot();
    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "worktree", srcBaseDir },
    });
    const managedPath = getManagedPath(workspaceMetadata);
    const removeSpy = spyOn(managedWorktree, "removeManagedGitWorktree").mockResolvedValue(
      undefined
    );

    const hook = createWorktreeArchiveHook({
      getWorktreeArchiveBehavior: () => "delete",
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(removeSpy).toHaveBeenCalledWith(workspaceMetadata.projectPath, managedPath);
  });

  it("keeps archiving non-blocking when managed workspace cleanup fails", async () => {
    const srcBaseDir = await createTempRoot();
    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "worktree", srcBaseDir },
    });
    const managedPath = getManagedPath(workspaceMetadata);
    const cleanupError = new Error("cleanup failed");
    spyOn(managedWorktree, "removeManagedGitWorktree").mockRejectedValue(cleanupError);
    const debugSpy = spyOn(log, "debug").mockImplementation(() => undefined);
    const hook = createWorktreeArchiveHook({
      getWorktreeArchiveBehavior: () => "delete",
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(debugSpy).toHaveBeenCalledWith("Failed to delete managed checkout during archive", {
      managedPath,
      error: cleanupError,
    });
  });
});
