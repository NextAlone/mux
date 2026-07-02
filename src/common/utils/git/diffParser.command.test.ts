import { describe, expect, test } from "bun:test";

import { buildGitDiffCommand, normalizeJjDiffBase } from "./diffParser";

describe("normalizeJjDiffBase", () => {
  test.each([
    ["", "@-"],
    ["HEAD", "@-"],
    ["--staged", "@-"],
    ["HEAD~1", "@-"],
    ["HEAD~2", "@--"],
    ["origin/main", "main@origin"],
    ["refs/remotes/origin/develop", "develop@origin"],
    ["main", "main"],
    ["main@origin", "main@origin"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeJjDiffBase(input)).toBe(expected);
  });
});

describe("buildGitDiffCommand", () => {
  test("uses jj remote bookmark syntax", () => {
    const command = buildGitDiffCommand("origin/main", false, "", "diff");

    expect(command).toContain("jj --no-pager --color never diff --from 'main@origin' --to @ --git");
    expect(command).not.toContain("origin/main");
  });

  test("shell-quotes diffBase to prevent command injection", () => {
    const command = buildGitDiffCommand("main;touch /tmp/pwned", false, "", "diff");

    expect(command).toContain("jj --no-pager --color never diff --from 'main;touch /tmp/pwned'");
    expect(command).not.toContain("diff --from main;touch /tmp/pwned");
  });
});
