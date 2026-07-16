import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import type { ToolExecutionOptions } from "ai";
import type {
  ModuleReportToolResult,
  ReadEnclosingToolResult,
  ReadSymbolToolResult,
} from "@/common/types/tools";
import {
  CODE_STRUCTURE_MAX_SOURCE_BYTES,
  CODE_STRUCTURE_MAX_SYMBOLS,
} from "@/common/constants/toolLimits";
import { CodeStructureService } from "@/node/services/codeStructure/codeStructureService";
import { TestTempDir, TrueRemotePathMappedRuntime, createTestToolConfig } from "./testHelpers";
import { createModuleReportTool } from "./module_report";
import { createReadEnclosingTool } from "./read_enclosing";
import { createReadSymbolTool } from "./read_symbol";

const toolOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "code-structure-test",
  messages: [],
  context: undefined,
};

describe("code structure tools", () => {
  let service: CodeStructureService | undefined;

  afterEach(async () => {
    await service?.dispose();
  });

  test("reports structure and reads exact source through a remote Runtime", async () => {
    using tempDir = new TestTempDir("code-structure-tools");
    const source = [
      "class Greeter:",
      "    @classmethod",
      "    async def greet(cls, name: str) -> str:",
      '        return f"hello {name}"',
      "",
      "def helper():",
      '    return "BODY_SENTINEL"',
    ].join("\n");
    await fs.writeFile(`${tempDir.path}/service.py`, source);

    const remoteRoot = "/remote/workspace";
    const runtime = new TrueRemotePathMappedRuntime(tempDir.path, remoteRoot);
    const config = createTestToolConfig(remoteRoot, { runtime });
    service = new CodeStructureService();

    const moduleReportTool = createModuleReportTool(config, service);
    const readSymbolTool = createReadSymbolTool(config, service);
    const readEnclosingTool = createReadEnclosingTool(config, service);

    const report = (await moduleReportTool.execute!(
      { path: "service.py" },
      toolOptions
    )) as ModuleReportToolResult;
    expect(report.success).toBe(true);
    if (report.success) {
      expect(report.path).toBe("service.py");
      expect(report.symbols.map((symbol) => symbol.qualifiedName)).toEqual(["Greeter", "helper"]);
      expect(JSON.stringify(report)).not.toContain("BODY_SENTINEL");
    }

    const symbol = (await readSymbolTool.execute!(
      { path: "service.py", symbol: "Greeter.greet" },
      toolOptions
    )) as ReadSymbolToolResult;
    expect(symbol).toMatchObject({
      success: true,
      qualifiedName: "Greeter.greet",
      startLine: 2,
      endLine: 4,
    });
    if (symbol.success) {
      expect(symbol.source).toContain("    @classmethod");
      expect(symbol.source).toContain('return f"hello {name}"');
    }

    const enclosing = (await readEnclosingTool.execute!(
      { path: "service.py", line: 4 },
      toolOptions
    )) as ReadEnclosingToolResult;
    expect(enclosing).toMatchObject({
      success: true,
      qualifiedName: "Greeter.greet",
    });
  });

  test("returns candidates for ambiguous symbols", async () => {
    using tempDir = new TestTempDir("code-structure-ambiguous");
    await fs.writeFile(
      `${tempDir.path}/duplicate.py`,
      "def run():\n    return 1\n\ndef run():\n    return 2\n"
    );
    const config = createTestToolConfig(tempDir.path);
    service = new CodeStructureService();
    const tool = createReadSymbolTool(config, service);

    const result = (await tool.execute!(
      { path: "duplicate.py", symbol: "run" },
      toolOptions
    )) as ReadSymbolToolResult;

    expect(result).toMatchObject({ success: false, reason: "ambiguous" });
    if (!result.success && result.reason === "ambiguous") {
      expect(result.candidates.map((candidate) => candidate.startLine)).toEqual([1, 4]);
    }
  });

  test("bounds outline and exact-source responses", async () => {
    using tempDir = new TestTempDir("code-structure-limits");
    const manyFunctions = Array.from(
      { length: CODE_STRUCTURE_MAX_SYMBOLS + 1 },
      (_, index) => `def function_${index}(): pass`
    ).join("\n");
    const largeFunction = `def large():\n    value = "${"x".repeat(CODE_STRUCTURE_MAX_SOURCE_BYTES)}"\n`;
    await Promise.all([
      fs.writeFile(`${tempDir.path}/many.py`, manyFunctions),
      fs.writeFile(`${tempDir.path}/large.py`, largeFunction),
    ]);

    const config = createTestToolConfig(tempDir.path);
    service = new CodeStructureService();

    const report = (await createModuleReportTool(config, service).execute!(
      { path: "many.py" },
      toolOptions
    )) as ModuleReportToolResult;
    expect(report).toMatchObject({ success: true, truncated: true });
    if (report.success) expect(report.symbols).toHaveLength(CODE_STRUCTURE_MAX_SYMBOLS);

    const symbol = (await createReadSymbolTool(config, service).execute!(
      { path: "large.py", symbol: "large" },
      toolOptions
    )) as ReadSymbolToolResult;
    expect(symbol).toMatchObject({ success: false, reason: "too_large" });
  });
});
