import { afterEach, describe, expect, spyOn, test } from "bun:test";

import * as disposableExec from "@/node/utils/disposableExec";

import {
  buildJjGitCloneArgs,
  createJjWorkspace,
  createJjBookmark,
  describeJjRevision,
  detectDefaultJjBookmark,
  forgetJjWorkspace,
  getCurrentJjChangeId,
  getJjRoot,
  hasJjWorkspaceChanges,
  initJjGitRepository,
  isInsideJjRepository,
  parseJjBookmarkNames,
  parseJjFileListOutput,
  renameJjWorkspace,
} from "./jj";

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

describe("jj bookmark helpers", () => {
  let execFileAsyncSpy: ReturnType<typeof spyOn<typeof disposableExec, "execFileAsync">> | null =
    null;

  afterEach(() => {
    execFileAsyncSpy?.mockRestore();
    execFileAsyncSpy = null;
  });

  test("parses sorted non-empty bookmark names from jj template output", () => {
    const bookmarks = parseJjBookmarkNames("feature/z\n\nmain\ntrunk\nfeature/a\n");

    expect(bookmarks).toEqual(["feature/a", "feature/z", "main", "trunk"]);
  });

  test("parses jj file list output without sorting paths", () => {
    const files = parseJjFileListOutput("src/main.ts\nREADME.md\n\nspace name.txt\n");

    expect(files).toEqual(["src/main.ts", "README.md", "space name.txt"]);
  });

  test("prefers a bookmark pointing at the current change when detecting the default", () => {
    const bookmark = detectDefaultJjBookmark({
      bookmarks: ["feature/alpha", "main", "trunk"],
      currentBookmarks: ["feature/alpha"],
    });

    expect(bookmark).toBe("feature/alpha");
  });

  test("falls back to conventional trunk bookmark names when current change is anonymous", () => {
    const bookmark = detectDefaultJjBookmark({
      bookmarks: ["release", "master", "zz"],
      currentBookmarks: [],
    });

    expect(bookmark).toBe("master");
  });

  test("detects a jj repository via jj root", async () => {
    execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation((file, args) => {
      expect(file).toBe("jj");
      expect(args).toEqual([
        "--no-pager",
        "--color",
        "never",
        "--repository",
        "/repo",
        "--ignore-working-copy",
        "root",
      ]);
      return createMockExecResult(Promise.resolve({ stdout: "/repo\n", stderr: "" }));
    });

    await expect(isInsideJjRepository("/repo")).resolves.toBe(true);
  });

  test("returns the normalized jj root path", async () => {
    execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation((file, args) => {
      expect(file).toBe("jj");
      expect(args).toEqual([
        "--no-pager",
        "--color",
        "never",
        "--repository",
        "/repo/subdir",
        "--ignore-working-copy",
        "root",
      ]);
      return createMockExecResult(Promise.resolve({ stdout: "/repo\n", stderr: "" }));
    });

    await expect(getJjRoot("/repo/subdir")).resolves.toBe("/repo");
  });

  test("creates a jj workspace at an explicit base revision", async () => {
    execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation((file, args) => {
      expect(file).toBe("jj");
      expect(args).toEqual([
        "--no-pager",
        "--color",
        "never",
        "--repository",
        "/repo",
        "workspace",
        "add",
        "--name",
        "agent-task",
        "--revision",
        "main",
        "--message",
        "agent-task",
        "/mux/src/repo/agent-task",
      ]);
      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    await createJjWorkspace({
      projectPath: "/repo",
      workspacePath: "/mux/src/repo/agent-task",
      workspaceName: "agent-task",
      revision: "main",
      message: "agent-task",
    });
  });

  test("forgets a named jj workspace without touching its files", async () => {
    execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation((file, args) => {
      expect(file).toBe("jj");
      expect(args).toEqual([
        "--no-pager",
        "--color",
        "never",
        "--repository",
        "/repo",
        "--ignore-working-copy",
        "workspace",
        "forget",
        "agent-task",
      ]);
      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    await forgetJjWorkspace({
      projectPath: "/repo",
      workspaceName: "agent-task",
    });
  });

  test("renames the current jj workspace from its checkout path", async () => {
    execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation((file, args) => {
      expect(file).toBe("jj");
      expect(args).toEqual([
        "--no-pager",
        "--color",
        "never",
        "--repository",
        "/mux/src/repo/old-name",
        "workspace",
        "rename",
        "new-name",
      ]);
      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    await renameJjWorkspace({
      workspacePath: "/mux/src/repo/old-name",
      newWorkspaceName: "new-name",
    });
  });

  test("detects dirty jj workspaces from diff summary output", async () => {
    execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation((file, args) => {
      expect(file).toBe("jj");
      expect(args).toEqual([
        "--no-pager",
        "--color",
        "never",
        "--repository",
        "/mux/src/repo/agent-task",
        "diff",
        "--summary",
      ]);
      return createMockExecResult(Promise.resolve({ stdout: "M src/main.ts\n", stderr: "" }));
    });

    await expect(hasJjWorkspaceChanges("/mux/src/repo/agent-task")).resolves.toBe(true);
  });

  test("returns the current jj change id from a workspace checkout", async () => {
    execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation((file, args) => {
      expect(file).toBe("jj");
      expect(args).toEqual([
        "--no-pager",
        "--color",
        "never",
        "--repository",
        "/mux/src/repo/source-task",
        "log",
        "--no-graph",
        "-r",
        "@",
        "-T",
        'change_id.shortest() ++ "\\n"',
        "-n",
        "1",
      ]);
      return createMockExecResult(Promise.resolve({ stdout: "kqpnwost\n", stderr: "" }));
    });

    await expect(getCurrentJjChangeId("/mux/src/repo/source-task")).resolves.toBe("kqpnwost");
  });

  test("builds colocated jj git clone arguments", () => {
    expect(buildJjGitCloneArgs("git@example.com:owner/repo.git", "/tmp/repo")).toEqual([
      "--no-pager",
      "--color",
      "never",
      "git",
      "clone",
      "--colocate",
      "git@example.com:owner/repo.git",
      "/tmp/repo",
    ]);
  });

  test("initializes a colocated jj git repository", async () => {
    execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation((file, args) => {
      expect(file).toBe("jj");
      expect(args).toEqual([
        "--no-pager",
        "--color",
        "never",
        "git",
        "init",
        "--colocate",
        "/repo",
      ]);
      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    await initJjGitRepository("/repo");
  });

  test("describes a jj revision without opening an editor", async () => {
    execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation((file, args) => {
      expect(file).toBe("jj");
      expect(args).toEqual([
        "--no-pager",
        "--color",
        "never",
        "--repository",
        "/repo",
        "describe",
        "-m",
        "Initial commit",
        "@",
      ]);
      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    await describeJjRevision({
      projectPath: "/repo",
      revision: "@",
      message: "Initial commit",
    });
  });

  test("creates a jj bookmark at a revision", async () => {
    execFileAsyncSpy = spyOn(disposableExec, "execFileAsync").mockImplementation((file, args) => {
      expect(file).toBe("jj");
      expect(args).toEqual([
        "--no-pager",
        "--color",
        "never",
        "--repository",
        "/repo",
        "bookmark",
        "create",
        "-r",
        "@",
        "main",
      ]);
      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    await createJjBookmark({ projectPath: "/repo", name: "main", revision: "@" });
  });
});
