import { describe, expect, test } from "bun:test";
import { buildSwitchBookmarkCommand, buildRemoteBookmarkListCommand } from "./bookmarkCommands";

describe("BookmarkSelector command builders", () => {
  test("keeps bookmark names as a single switch argv element", () => {
    const maliciousBookmark = "feature/$(id>/tmp/mux_bookmark_injection_poc)";

    expect(buildSwitchBookmarkCommand(maliciousBookmark)).toEqual({
      command: "jj",
      args: [
        "--no-pager",
        "--color",
        "never",
        "new",
        "feature/$(id>/tmp/mux_bookmark_injection_poc)",
      ],
    });
  });

  test("preserves bookmark names containing single quotes", () => {
    expect(buildSwitchBookmarkCommand("feature/it's")).toEqual({
      command: "jj",
      args: ["--no-pager", "--color", "never", "new", "feature/it's"],
    });
  });

  test("keeps remote names as one ref namespace argument", () => {
    const maliciousRemote = "origin';touch /tmp/mux_remote_injection;#";

    expect(buildRemoteBookmarkListCommand(maliciousRemote, 50)).toEqual({
      command: "jj",
      args: [
        "--no-pager",
        "--color",
        "never",
        "bookmark",
        "list",
        "--remote",
        "origin';touch /tmp/mux_remote_injection;#",
        "--sort",
        "committer-date-",
        "--template",
        'name ++ "\\n"',
      ],
    });
  });
});
