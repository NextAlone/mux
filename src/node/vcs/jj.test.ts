import { afterEach, describe, expect, spyOn, test } from "bun:test";

import * as disposableExec from "@/node/utils/disposableExec";

import {
  createJjWorkspace,
  detectDefaultJjBookmark,
  forgetJjWorkspace,
  isInsideJjRepository,
  parseJjBookmarkNames,
  parseJjFileListOutput,
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
});
