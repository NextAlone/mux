import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TestTempDir } from "@/node/services/tools/testHelpers";
import {
  CODE_STRUCTURE_ASSET_FILES,
  copyCodeStructureAssets,
} from "./copy-code-structure-assets";
import { CodeStructureAnalyzer } from "@/node/services/codeStructure/codeStructureAnalysis";

describe("copyCodeStructureAssets", () => {
  test("treats an explicit asset directory as authoritative", async () => {
    using tempDir = new TestTempDir("missing-code-structure-assets");
    const missingDirectory = path.join(tempDir.path, "missing");
    await expect(
      CodeStructureAnalyzer.create({ assetDirectory: missingDirectory })
    ).rejects.toThrow("tree-sitter.wasm");
  });

  test("copies the selected grammars and writes a hash manifest", async () => {
    using tempDir = new TestTempDir("code-structure-assets");

    const manifest = await copyCodeStructureAssets(tempDir.path);

    expect(Object.keys(manifest.files).sort()).toEqual([...CODE_STRUCTURE_ASSET_FILES].sort());
    for (const fileName of CODE_STRUCTURE_ASSET_FILES) {
      const stats = await fs.stat(path.join(tempDir.path, fileName));
      expect(stats.size).toBeGreaterThan(0);
      expect(manifest.files[fileName]).toMatch(/^[a-f0-9]{64}$/);
    }

    const persisted = JSON.parse(
      await fs.readFile(path.join(tempDir.path, "manifest.json"), "utf8")
    ) as typeof manifest;
    expect(persisted).toEqual(manifest);

    const analyzer = await CodeStructureAnalyzer.create({ assetDirectory: tempDir.path });
    try {
      const report = await analyzer.analyze("standalone.py", "def standalone(): pass\n");
      expect(report.symbols[0]?.name).toBe("standalone");
    } finally {
      analyzer.dispose();
    }
  });
});
