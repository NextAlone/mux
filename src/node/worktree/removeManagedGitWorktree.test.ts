import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as jjVcs from "@/node/vcs/jj";
import { removeManagedGitWorktree } from "./removeManagedGitWorktree";

async function pathExists(targetPath: string): Promise<boolean> {
  return fs.promises
    .access(targetPath)
    .then(() => true)
    .catch(() => false);
}

describe("removeManagedGitWorktree", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    mock.restore();

    await Promise.all(
      tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true }))
    );
  });

  async function createTempRoot(): Promise<string> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mux-remove-managed-worktree-"));
    tempDirs.push(tempRoot);
    return tempRoot;
  }

  it("forgets the jj workspace and recursively removes a multi-project container path", async () => {
    const tempRoot = await createTempRoot();
    const projectPath = path.join(tempRoot, "project");
    const worktreePath = path.join(tempRoot, "_workspaces", "workspace-name");
    const nestedCheckoutPath = path.join(worktreePath, "project-a");
    await mkdir(nestedCheckoutPath, { recursive: true });
    await writeFile(path.join(nestedCheckoutPath, "README.md"), "nested checkout");

    const forgetSpy = spyOn(jjVcs, "forgetJjWorkspace").mockImplementation(() => Promise.resolve());

    await removeManagedGitWorktree(projectPath, worktreePath);

    expect(forgetSpy).toHaveBeenCalledWith({ projectPath, workspaceName: "workspace-name" });
    expect(await pathExists(worktreePath)).toBe(false);
  });

  it("still removes the directory when the jj workspace was already forgotten", async () => {
    const tempRoot = await createTempRoot();
    const projectPath = path.join(tempRoot, "project");
    const worktreePath = path.join(tempRoot, "workspace-name");
    await mkdir(worktreePath, { recursive: true });

    spyOn(jjVcs, "forgetJjWorkspace").mockImplementation(() =>
      Promise.reject(new Error("Workspace not found"))
    );

    await removeManagedGitWorktree(projectPath, worktreePath);

    expect(await pathExists(worktreePath)).toBe(false);
  });

  it("refuses to delete the project checkout itself", async () => {
    const tempRoot = await createTempRoot();
    const projectPath = path.join(tempRoot, "project");
    await mkdir(projectPath, { recursive: true });
    spyOn(jjVcs, "forgetJjWorkspace").mockImplementation(() => Promise.resolve());

    let errorMessage = "";
    try {
      await removeManagedGitWorktree(projectPath, projectPath);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    expect(errorMessage).toBe("Refusing to delete the project checkout as a managed workspace");
    expect(await pathExists(projectPath)).toBe(true);
  });
});
