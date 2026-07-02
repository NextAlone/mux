import { describe, expect, test } from "bun:test";

import { generateGitStatusScript } from "./gitStatus";

describe("generateGitStatusScript", () => {
  test("single-quotes preferred branch to prevent shell interpolation", () => {
    const script = generateGitStatusScript("origin/$(touch /tmp/pwned)\"'branch");

    expect(script).toContain("PREFERRED_BRANCH='$(touch /tmp/pwned)\"'\\''branch'");
    expect(script).not.toContain('PREFERRED_BRANCH="$(touch /tmp/pwned)');
  });

  test("uses jj commands for status collection", () => {
    const script = generateGitStatusScript("origin/main");

    expect(script).toContain("jj --no-pager --color never");
    expect(script).not.toMatch(/\bgit\s+(rev-parse|status|diff|fetch|branch|remote)\b/);
  });
});
