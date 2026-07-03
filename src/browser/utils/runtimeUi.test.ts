import { describe, expect, test } from "bun:test";

import {
  getRuntimeChoiceDescription,
  getWorktreeRuntimeDescription,
} from "@/browser/utils/runtimeUi";

describe("runtime UI descriptions", () => {
  test("describes the configured jj workspace checkout location", () => {
    expect(getWorktreeRuntimeDescription({ mode: "muxPublic" })).toContain("~/.mux/src");
    expect(getWorktreeRuntimeDescription({ mode: "projectWorktrees" })).toContain(".worktrees");
    const projectWorkspacesDescription = getWorktreeRuntimeDescription({
      mode: "projectWorkspaces",
    });
    expect(projectWorkspacesDescription).toContain(".workspaces");
    expect(projectWorkspacesDescription).not.toContain("~/.mux/src");
    expect(
      getWorktreeRuntimeDescription({ mode: "customPublic", customPath: "~/mux-src" })
    ).toContain("~/mux-src");
    expect(getWorktreeRuntimeDescription({ mode: "customPublic" })).toContain("not configured");
  });

  test("only varies the jj workspace runtime description", () => {
    expect(getRuntimeChoiceDescription("worktree", { mode: "projectWorkspaces" })).toContain(
      ".workspaces"
    );
    expect(getRuntimeChoiceDescription("local", { mode: "projectWorkspaces" })).toBe(
      "Work directly in project directory (no isolation)"
    );
  });
});
