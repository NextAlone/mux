import { afterEach, describe, expect, test } from "bun:test";
import { CodeStructureService } from "./codeStructureService";

describe("CodeStructureService", () => {
  let service: CodeStructureService | undefined;

  afterEach(async () => {
    if (service) await service.dispose();
  });

  test("runs concurrent language requests through the worker", async () => {
    service = new CodeStructureService();

    const [python, go] = await Promise.all([
      service.analyze("service.py", "def run():\n    return 1\n"),
      service.analyze("service.go", "package service\nfunc Run() {}\n"),
    ]);

    expect(python.symbols[0]).toMatchObject({ name: "run", kind: "function" });
    expect(go.symbols[0]).toMatchObject({ name: "Run", kind: "function", exported: true });
  });

  test("rejects requests after disposal", async () => {
    service = new CodeStructureService();
    await service.dispose();

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun assertions are thenable at runtime.
    await expect(service.analyze("service.py", "def run(): pass\n")).rejects.toThrow("disposed");
  });
});
