import { describe, expect, test } from "bun:test";

import { getBuiltInSkillDefinitions, readBuiltInSkillFile } from "./builtInSkillDefinitions";

function hasPackagedWorkflow(name: string): boolean {
  for (const entry of ["workflow.md", "workflow.js"]) {
    try {
      readBuiltInSkillFile(name, entry);
      return true;
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith("Built-in skill file not found:")) {
        throw err;
      }
    }
  }
  return false;
}

describe("built-in workflow skill descriptions", () => {
  test("prefixes skills that ship a workflow definition", () => {
    const workflowSkills = getBuiltInSkillDefinitions().filter((pkg) =>
      hasPackagedWorkflow(pkg.frontmatter.name)
    );

    expect(workflowSkills.length).toBeGreaterThan(0);
    expect(
      workflowSkills
        .filter((pkg) => !pkg.frontmatter.description.startsWith("[Workflow]"))
        .map((pkg) => pkg.frontmatter.name)
    ).toEqual([]);
  });
});
