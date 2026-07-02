import { describe, expect, test } from "bun:test";
import { buildCheckoutCommand, buildRemoteBranchListCommand } from "./branchCommands";

describe("BranchSelector command builders", () => {
  test("keeps branch names as a single checkout argv element", () => {
    const maliciousBranch = "feature/$(id>/tmp/mux_branch_injection_poc)";

    expect(buildCheckoutCommand(maliciousBranch)).toEqual({
      command: "jj",
      args: [
        "--no-pager",
        "--color",
        "never",
        "new",
        "feature/$(id>/tmp/mux_branch_injection_poc)",
      ],
    });
  });

  test("preserves branch names containing single quotes", () => {
    expect(buildCheckoutCommand("feature/it's")).toEqual({
      command: "jj",
      args: ["--no-pager", "--color", "never", "new", "feature/it's"],
    });
  });

  test("keeps remote names as one ref namespace argument", () => {
    const maliciousRemote = "origin';touch /tmp/mux_remote_injection;#";

    expect(buildRemoteBranchListCommand(maliciousRemote, 50)).toEqual({
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
