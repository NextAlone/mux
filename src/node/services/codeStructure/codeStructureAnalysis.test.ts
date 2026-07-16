import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CodeStructureAnalyzer, type CodeStructureLanguage } from "./codeStructureAnalysis";

describe("CodeStructureAnalyzer", () => {
  let analyzer: CodeStructureAnalyzer;

  beforeAll(async () => {
    analyzer = await CodeStructureAnalyzer.create();
  });

  afterAll(() => {
    analyzer.dispose();
  });

  test.each([
    ["example.py", "python"],
    ["example.pyi", "python"],
    ["example.ts", "typescript"],
    ["example.tsx", "tsx"],
    ["example.js", "javascript"],
    ["example.jsx", "tsx"],
    ["example.go", "go"],
    ["example.rs", "rust"],
  ] as const)("detects %s as %s", (path, language) => {
    expect(CodeStructureAnalyzer.detectLanguage(path)).toBe(language as CodeStructureLanguage);
  });

  test("extracts decorated Python symbols and reads an exact method body", async () => {
    const source = [
      '"""Module documentation."""',
      "",
      "class Greeter:",
      '    """Greets people."""',
      "",
      "    @classmethod",
      "    async def greet(cls, name: str) -> str:",
      '        """Return a greeting."""',
      '        return f"你好, {name} 👋"',
      "",
      "def outer(value: int):",
      "    def nested() -> int:",
      "        return value",
      "    return nested()",
    ].join("\n");

    const report = await analyzer.analyze("example.py", source);

    expect(report.language).toBe("python");
    expect(report.complete).toBe(true);
    expect(report.symbols.map((symbol) => symbol.qualifiedName)).toEqual(["Greeter", "outer"]);
    expect(report.symbols[0]?.documentation).toBe("Greets people.");
    expect(report.symbols[0]?.members?.[0]).toMatchObject({
      name: "greet",
      qualifiedName: "Greeter.greet",
      kind: "method",
      modifiers: ["classmethod", "async"],
      startLine: 6,
      endLine: 9,
    });
    expect(report.symbols[1]?.members?.[0]?.qualifiedName).toBe("outer.nested");

    const read = await analyzer.readSymbol("example.py", source, {
      symbol: "Greeter.greet",
    });
    expect(read).toMatchObject({
      found: true,
      name: "greet",
      qualifiedName: "Greeter.greet",
      startLine: 6,
      endLine: 9,
    });
    if (read.found) {
      expect(read.source).toBe(
        [
          "    @classmethod",
          "    async def greet(cls, name: str) -> str:",
          '        """Return a greeting."""',
          '        return f"你好, {name} 👋"',
        ].join("\n")
      );
    }
  });

  test("extracts TypeScript exports, class members, and arrow functions", async () => {
    const source = [
      "export interface User { id: string }",
      "export class Store {",
      "  private users = new Map<string, User>();",
      "  get(id: string): User | undefined {",
      "    return this.users.get(id);",
      "  }",
      "}",
      "export const makeStore = () => new Store();",
    ].join("\n");

    const report = await analyzer.analyze("store.ts", source);

    expect(report.symbols.map((symbol) => [symbol.name, symbol.kind, symbol.exported])).toEqual([
      ["User", "interface", true],
      ["Store", "class", true],
      ["makeStore", "function", true],
    ]);
    expect(report.symbols[1]?.members?.map((symbol) => symbol.qualifiedName)).toContain(
      "Store.get"
    );

    const enclosing = await analyzer.readEnclosing("store.ts", source, 5);
    expect(enclosing).toMatchObject({
      found: true,
      qualifiedName: "Store.get",
      startLine: 4,
      endLine: 6,
    });
  });

  test("extracts Go receiver methods and generic types", async () => {
    const source = [
      "package cache",
      "",
      "type Cache[T any] struct { value T }",
      "type Reader interface { Read() string }",
      "",
      "func New[T any](value T) *Cache[T] { return &Cache[T]{value: value} }",
      "func (c *Cache[T]) Get() T { return c.value }",
    ].join("\n");

    const report = await analyzer.analyze("cache.go", source);

    expect(report.symbols.map((symbol) => [symbol.qualifiedName, symbol.kind])).toEqual([
      ["Cache", "struct"],
      ["Reader", "interface"],
      ["New", "function"],
      ["Cache.Get", "method"],
    ]);
    expect(report.symbols[0]?.exported).toBe(true);
    expect(report.symbols[1]?.members?.[0]).toMatchObject({
      qualifiedName: "Reader.Read",
      kind: "method",
    });
  });

  test("extracts Rust traits and impl members with unambiguous qualified names", async () => {
    const source = [
      "pub struct Cache<T> { value: T }",
      "pub trait Readable { fn read(&self) -> String; }",
      "impl<T> Cache<T> {",
      "    pub fn new(value: T) -> Self { Self { value } }",
      "    pub async fn get(&self) -> &T { &self.value }",
      "}",
    ].join("\n");

    const report = await analyzer.analyze("cache.rs", source);

    expect(report.symbols.map((symbol) => [symbol.name, symbol.kind])).toEqual([
      ["Cache", "struct"],
      ["Readable", "trait"],
      ["impl Cache", "impl"],
    ]);
    expect(report.symbols[2]?.members?.map((symbol) => symbol.qualifiedName)).toEqual([
      "Cache::new",
      "Cache::get",
    ]);
    expect(report.symbols[1]?.members?.[0]).toMatchObject({
      qualifiedName: "Readable::read",
      kind: "method",
    });

    const read = await analyzer.readSymbol("cache.rs", source, {
      symbol: "Cache::get",
    });
    expect(read).toMatchObject({ found: true, kind: "method", startLine: 5, endLine: 5 });
  });

  test("marks error-recovered syntax trees as incomplete", async () => {
    const report = await analyzer.analyze("broken.py", "def broken(:\n    return 1\n");

    expect(report.complete).toBe(false);
    expect(report.warnings.length).toBeGreaterThan(0);
  });

  test("returns candidates instead of choosing an ambiguous symbol", async () => {
    const source = [
      "def duplicate():",
      "    return 1",
      "",
      "def duplicate():",
      "    return 2",
    ].join("\n");

    const read = await analyzer.readSymbol("duplicate.py", source, { symbol: "duplicate" });

    expect(read).toMatchObject({ found: false, reason: "ambiguous" });
    if (!read.found && read.reason === "ambiguous") {
      expect(read.candidates.map((candidate) => candidate.startLine)).toEqual([1, 4]);
    }
  });
});
