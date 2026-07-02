import { describe, expect, test } from "bun:test";

import { generateGitStatusScript, getPreferredBookmarkFromBaseRef } from "./gitStatus";

describe("generateGitStatusScript", () => {
  test("single-quotes preferred branch to prevent shell interpolation", () => {
    const script = generateGitStatusScript("origin/$(touch /tmp/pwned)\"'branch");

    expect(script).toContain("PREFERRED_BRANCH='$(touch /tmp/pwned)\"'\\''branch'");
    expect(script).not.toContain('PREFERRED_BRANCH="$(touch /tmp/pwned)');
  });

  test("uses jj commands for status collection", () => {
    const script = generateGitStatusScript("main@origin");

    expect(script).toContain("jj --no-pager --color never");
    expect(script).not.toMatch(/\bgit\s+(rev-parse|status|diff|fetch|branch|remote)\b/);
  });

  test.each([
    ["main@origin", "main"],
    ["origin/main", "main"],
    ["refs/remotes/origin/develop", "develop"],
    ["refs/heads/main", "main"],
    ["main", "main"],
    ["@-", ""],
    ["trunk()", ""],
  ])("extracts preferred bookmark from %s", (baseRef, expected) => {
    expect(getPreferredBookmarkFromBaseRef(baseRef)).toBe(expected);
  });
});
