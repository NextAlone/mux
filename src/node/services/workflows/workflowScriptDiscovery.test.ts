import { describe, expect, test } from "bun:test";

import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { TestTempDir, writeProjectSkill } from "@/node/services/tools/testHelpers";
import { discoverWorkflowScripts } from "./workflowScriptDiscovery";

function workflowTemplate(name: string, description: string): string {
  return `---
version: 1
name: ${name}
description: ${description}
steps:
  - id: run
result:
  report_markdown: \${{ steps.run.output }}
---
## run
Complete the workflow task.`;
}

describe("discoverWorkflowScripts", () => {
  test("discovers workflow.md and prefers it over a legacy workflow.js", async () => {
    using tempDir = new TestTempDir("workflow-template-discovery");
    await writeProjectSkill(tempDir.path, "template-only", {
      files: {
        "workflow.md": workflowTemplate("template-only", "Declarative template"),
      },
    });
    await writeProjectSkill(tempDir.path, "template-wins", {
      files: {
        "workflow.md": workflowTemplate("template-wins", "Markdown wins"),
        "workflow.js": `export const meta = { name: "script-loses", description: "JS loses" };
export default function workflow() { return "legacy"; }`,
      },
    });
    await writeProjectSkill(tempDir.path, "script-only", {
      files: {
        "workflow.js": `export const meta = { name: "script-only", description: "Legacy script" };
export default function workflow() { return "legacy"; }`,
      },
    });

    const runtime = new LocalRuntime(tempDir.path);
    const discovered = await discoverWorkflowScripts({
      runtime,
      workspacePath: tempDir.path,
      projectTrusted: true,
      roots: {
        projectRoot: runtime.normalizePath(".mux/skills", tempDir.path),
        globalRoot: runtime.normalizePath("isolated-global-skills", tempDir.path),
      },
    });

    expect(discovered.find((entry) => entry.descriptor.name === "template-only")?.scriptPath).toBe(
      "skill://template-only/workflow.md"
    );
    expect(discovered.find((entry) => entry.descriptor.name === "template-wins")).toMatchObject({
      scriptPath: "skill://template-wins/workflow.md",
      descriptor: { description: "Markdown wins" },
    });
    expect(discovered.find((entry) => entry.descriptor.name === "script-only")?.scriptPath).toBe(
      "skill://script-only/workflow.js"
    );
    expect(discovered.some((entry) => entry.descriptor.name === "script-loses")).toBe(false);
  }, 15_000);
});
