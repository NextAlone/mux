import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";

export type CodeStructureLanguage = "python" | "typescript" | "tsx" | "javascript" | "go" | "rust";

export type CodeSymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "trait"
  | "impl"
  | "module"
  | "namespace"
  | "constant"
  | "property"
  | "constructor";

export interface CodeSymbol {
  name: string;
  qualifiedName: string;
  kind: CodeSymbolKind;
  startLine: number;
  endLine: number;
  signature?: string;
  documentation?: string;
  modifiers?: string[];
  exported?: boolean;
  visibility?: "public" | "protected" | "private";
  convention?: "public" | "private";
  members?: CodeSymbol[];
}

export interface CodeModuleReport {
  path: string;
  language: CodeStructureLanguage;
  lineCount: number;
  complete: boolean;
  warnings: string[];
  symbols: CodeSymbol[];
}

export interface ReadSymbolSelector {
  symbol: string;
  kind?: CodeSymbolKind;
  startLine?: number;
}

export interface CodeStructureAnalysisOptions {
  deadlineMs?: number;
}

export interface CodeStructureAnalyzerOptions {
  /** Explicit packaged asset directory. When set, development fallbacks are disabled. */
  assetDirectory?: string;
}

export type ReadCodeResult =
  | (CodeSymbol & { found: true; path: string; language: CodeStructureLanguage; source: string })
  | {
      found: false;
      reason: "not_found" | "ambiguous" | "no_enclosing_symbol";
      candidates: CodeSymbol[];
    };

interface LanguageConfig {
  language: CodeStructureLanguage;
  grammar: string;
}

interface InternalSymbol {
  symbol: CodeSymbol;
  source: string;
  members: InternalSymbol[];
}

interface InternalReport {
  report: CodeModuleReport;
  symbols: InternalSymbol[];
}

interface CollectContext {
  language: CodeStructureLanguage;
  source: string;
  qualifier?: string;
  separator: "." | "::";
  containerKind?: CodeSymbolKind;
  exported?: boolean;
  wrapper?: SyntaxNode;
  modifiers?: string[];
}

const resolver = createRequire(__filename);

const LANGUAGE_CONFIG: Record<string, LanguageConfig> = {
  ".py": { language: "python", grammar: "python" },
  ".pyi": { language: "python", grammar: "python" },
  ".ts": { language: "typescript", grammar: "typescript" },
  ".tsx": { language: "tsx", grammar: "tsx" },
  ".js": { language: "javascript", grammar: "javascript" },
  ".mjs": { language: "javascript", grammar: "javascript" },
  ".cjs": { language: "javascript", grammar: "javascript" },
  ".jsx": { language: "tsx", grammar: "tsx" },
  ".go": { language: "go", grammar: "go" },
  ".rs": { language: "rust", grammar: "rust" },
};

let parserInitPromise: Promise<void> | undefined;

async function resolveBundledAsset(fileName: string): Promise<string | null> {
  const bundledPath = path.join(__dirname, "assets", fileName);
  try {
    await fs.access(bundledPath);
    return bundledPath;
  } catch {
    return null;
  }
}

async function resolveCoreWasm(assetDirectory?: string): Promise<string> {
  if (assetDirectory) return path.join(assetDirectory, "tree-sitter.wasm");
  return (
    (await resolveBundledAsset("tree-sitter.wasm")) ??
    resolver.resolve("web-tree-sitter/tree-sitter.wasm")
  );
}

async function resolveGrammar(grammar: string, assetDirectory?: string): Promise<string> {
  const fileName = `tree-sitter-${grammar}.wasm`;
  if (assetDirectory) return path.join(assetDirectory, fileName);
  const bundledPath = await resolveBundledAsset(fileName);
  if (bundledPath) return bundledPath;

  const packageDir = path.dirname(resolver.resolve("tree-sitter-wasms/package.json"));
  return path.join(packageDir, "out", fileName);
}

async function initializeParser(assetDirectory?: string): Promise<void> {
  const coreWasm = await resolveCoreWasm(assetDirectory);
  try {
    await fs.access(coreWasm);
  } catch {
    throw new Error(`Code structure asset not found: ${coreWasm}`);
  }
  parserInitPromise ??= Parser.init({
    wasmBinary: await fs.readFile(coreWasm),
  });
  return parserInitPromise;
}

function lineCount(source: string): number {
  return source === "" ? 0 : source.split("\n").length;
}

function sourceLinesForNode(source: string, node: SyntaxNode): string {
  return source
    .split("\n")
    .slice(node.startPosition.row, node.endPosition.row + 1)
    .join("\n");
}

function qualifiedName(name: string, context: CollectContext): string {
  return context.qualifier ? `${context.qualifier}${context.separator}${name}` : name;
}

function compactSignature(node: SyntaxNode, body?: SyntaxNode | null): string {
  let header = node.text;
  if (body) {
    const bodyIndex = header.lastIndexOf(body.text);
    if (bodyIndex >= 0) header = header.slice(0, bodyIndex);
  }
  return header.replace(/\s+/g, " ").trim().slice(0, 500);
}

function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child): child is SyntaxNode => child != null);
}

function firstDescendant(node: SyntaxNode | null, type: string): SyntaxNode | null {
  if (!node) return null;
  if (node.type === type) return node;
  for (const child of namedChildren(node)) {
    const match = firstDescendant(child, type);
    if (match) return match;
  }
  return null;
}

function pythonDocumentation(body: SyntaxNode | null): string | undefined {
  const statement = body ? namedChildren(body)[0] : undefined;
  if (statement?.type !== "expression_statement") return undefined;
  const stringNode = namedChildren(statement)[0];
  if (stringNode?.type !== "string") return undefined;

  const value = stringNode.text
    .replace(/^(?:[rubfRUBF]*)(?:'''|""")/, "")
    .replace(/(?:'''|""")$/, "")
    .trim();
  const firstParagraph = value
    .split(/\n\s*\n/, 1)[0]
    ?.replace(/\s+/g, " ")
    .trim();
  return firstParagraph || undefined;
}

function syntaxVisibility(node: SyntaxNode): CodeSymbol["visibility"] {
  const modifier = namedChildren(node).find((child) => child.type === "accessibility_modifier");
  if (
    modifier?.text === "public" ||
    modifier?.text === "protected" ||
    modifier?.text === "private"
  ) {
    return modifier.text;
  }
  return undefined;
}

function directModifiers(node: SyntaxNode): string[] {
  const modifiers: string[] = [];
  const source = node.text.trimStart();
  for (const modifier of ["async", "static", "abstract", "readonly", "unsafe"] as const) {
    if (new RegExp(`\\b${modifier}\\b`).test(source.slice(0, 120))) modifiers.push(modifier);
  }
  return modifiers;
}

function publicSymbol(symbol: InternalSymbol): CodeSymbol {
  return {
    ...symbol.symbol,
    ...(symbol.members.length > 0 ? { members: symbol.members.map(publicSymbol) } : {}),
  };
}

function flattenSymbols(symbols: InternalSymbol[]): InternalSymbol[] {
  const result: InternalSymbol[] = [];
  const visit = (symbol: InternalSymbol) => {
    result.push(symbol);
    symbol.members.forEach(visit);
  };
  symbols.forEach(visit);
  return result;
}

function makeInternalSymbol(
  node: SyntaxNode,
  name: string,
  kind: CodeSymbolKind,
  context: CollectContext,
  options?: {
    body?: SyntaxNode | null;
    documentation?: string;
    exported?: boolean;
    visibility?: CodeSymbol["visibility"];
    convention?: CodeSymbol["convention"];
    modifiers?: string[];
    explicitQualifiedName?: string;
  }
): InternalSymbol {
  const modifiers = [...(context.modifiers ?? []), ...(options?.modifiers ?? [])];
  return {
    symbol: {
      name,
      qualifiedName: options?.explicitQualifiedName ?? qualifiedName(name, context),
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: compactSignature(node, options?.body),
      ...(options?.documentation ? { documentation: options.documentation } : {}),
      ...(modifiers.length > 0 ? { modifiers: [...new Set(modifiers)] } : {}),
      ...(options?.exported != null || context.exported != null
        ? { exported: options?.exported ?? context.exported }
        : {}),
      ...(options?.visibility ? { visibility: options.visibility } : {}),
      ...(options?.convention ? { convention: options.convention } : {}),
    },
    source: sourceLinesForNode(context.source, node),
    members: [],
  };
}

function collectPython(node: SyntaxNode, context: CollectContext): InternalSymbol[] {
  if (node.type === "decorated_definition") {
    const definition = node.childForFieldName("definition") ?? namedChildren(node).at(-1) ?? null;
    if (!definition) return [];
    const decoratorModifiers = namedChildren(node)
      .filter((child) => child.type === "decorator")
      .map((child) => child.text.replace(/^@/, "").replace(/\(.*/, ""));
    return collectPython(definition, {
      ...context,
      wrapper: node,
      modifiers: [...(context.modifiers ?? []), ...decoratorModifiers],
    });
  }

  if (node.type === "class_definition") {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return [];
    const body = node.childForFieldName("body");
    const rangeNode = context.wrapper ?? node;
    const name = nameNode.text;
    const symbol = makeInternalSymbol(rangeNode, name, "class", context, {
      body,
      documentation: pythonDocumentation(body),
      convention: name.startsWith("_") ? "private" : "public",
      modifiers: directModifiers(node),
    });
    if (body) {
      symbol.members = collectContainer(body, {
        language: "python",
        source: context.source,
        qualifier: symbol.symbol.qualifiedName,
        separator: ".",
        containerKind: "class",
      });
    }
    return [symbol];
  }

  if (node.type === "function_definition") {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return [];
    const body = node.childForFieldName("body");
    const rangeNode = context.wrapper ?? node;
    const name = nameNode.text;
    const kind = context.containerKind === "class" ? "method" : "function";
    const symbol = makeInternalSymbol(rangeNode, name, kind, context, {
      body,
      documentation: pythonDocumentation(body),
      convention: name.startsWith("_") ? "private" : "public",
      modifiers: directModifiers(node),
    });
    if (body) {
      symbol.members = collectContainer(body, {
        language: "python",
        source: context.source,
        qualifier: symbol.symbol.qualifiedName,
        separator: ".",
        containerKind: kind,
      });
    }
    return [symbol];
  }

  return [];
}

function collectTypeScript(node: SyntaxNode, context: CollectContext): InternalSymbol[] {
  if (node.type === "export_statement") {
    const declaration = node.childForFieldName("declaration");
    return declaration
      ? collectTypeScript(declaration, { ...context, exported: true, wrapper: node })
      : [];
  }

  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    const result: InternalSymbol[] = [];
    for (const declarator of namedChildren(node).filter(
      (child) => child.type === "variable_declarator"
    )) {
      const value = declarator.childForFieldName("value");
      if (value?.type !== "arrow_function" && value?.type !== "function_expression") continue;
      const nameNode = declarator.childForFieldName("name");
      if (!nameNode) continue;
      const rangeNode = context.wrapper ?? node;
      result.push(
        makeInternalSymbol(rangeNode, nameNode.text, "function", context, {
          body: value.childForFieldName("body"),
          modifiers: directModifiers(value),
        })
      );
    }
    return result;
  }

  const declarationKinds: Partial<Record<string, CodeSymbolKind>> = {
    function_declaration: "function",
    class_declaration: "class",
    abstract_class_declaration: "class",
    interface_declaration: "interface",
    type_alias_declaration: "type",
    enum_declaration: "enum",
    internal_module: "namespace",
    method_definition: "method",
    method_signature: "method",
    abstract_method_signature: "method",
    public_field_definition: "property",
    property_signature: "property",
  };
  let kind = declarationKinds[node.type];
  if (!kind) return [];

  const nameNode = node.childForFieldName("name");
  if (!nameNode) return [];
  if (nameNode.text === "constructor") kind = "constructor";
  const body = node.childForFieldName("body");
  const rangeNode = context.wrapper ?? node;
  const name = nameNode.text;
  const symbol = makeInternalSymbol(rangeNode, name, kind, context, {
    body,
    visibility: syntaxVisibility(node),
    modifiers: directModifiers(node),
  });

  const memberContainer = body ?? namedChildren(node).find((child) => child.type === "object_type");
  if (memberContainer && ["class", "interface", "namespace"].includes(kind)) {
    symbol.members = collectContainer(memberContainer, {
      language: context.language,
      source: context.source,
      qualifier: symbol.symbol.qualifiedName,
      separator: ".",
      containerKind: kind,
    });
  }
  return [symbol];
}

function collectGo(node: SyntaxNode, context: CollectContext): InternalSymbol[] {
  if (node.type === "type_declaration") {
    const children = namedChildren(node);
    return children.flatMap((child) =>
      child.type === "type_spec" || child.type === "type_alias"
        ? collectGo(child, { ...context, wrapper: children.length === 1 ? node : undefined })
        : []
    );
  }

  if (node.type === "type_spec" || node.type === "type_alias") {
    const nameNode = node.childForFieldName("name");
    const typeNode = node.childForFieldName("type");
    if (!nameNode) return [];
    const kind: CodeSymbolKind =
      typeNode?.type === "struct_type"
        ? "struct"
        : typeNode?.type === "interface_type"
          ? "interface"
          : "type";
    const name = nameNode.text;
    const rangeNode = context.wrapper ?? node;
    const symbol = makeInternalSymbol(rangeNode, name, kind, context, {
      exported: /^\p{Lu}/u.test(name),
    });
    if (typeNode?.type === "interface_type") {
      symbol.members = collectContainer(typeNode, {
        language: "go",
        source: context.source,
        qualifier: symbol.symbol.qualifiedName,
        separator: ".",
        containerKind: "interface",
      });
    }
    return [symbol];
  }

  if (node.type === "method_spec") {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return [];
    const name = nameNode.text;
    return [
      makeInternalSymbol(node, name, "method", context, {
        exported: /^\p{Lu}/u.test(name),
      }),
    ];
  }

  if (node.type === "function_declaration" || node.type === "method_declaration") {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return [];
    const body = node.childForFieldName("body");
    const name = nameNode.text;
    if (node.type === "method_declaration") {
      const receiver = node.childForFieldName("receiver");
      const receiverType = firstDescendant(receiver, "type_identifier")?.text;
      if (!receiverType) return [];
      return [
        makeInternalSymbol(node, name, "method", context, {
          body,
          exported: /^\p{Lu}/u.test(name),
          explicitQualifiedName: `${receiverType}.${name}`,
        }),
      ];
    }
    return [
      makeInternalSymbol(node, name, "function", context, {
        body,
        exported: /^\p{Lu}/u.test(name),
      }),
    ];
  }

  return [];
}

function rustTypeName(node: SyntaxNode | null): string | null {
  return firstDescendant(node, "type_identifier")?.text ?? null;
}

function collectRust(node: SyntaxNode, context: CollectContext): InternalSymbol[] {
  const namedKinds: Partial<Record<string, CodeSymbolKind>> = {
    struct_item: "struct",
    enum_item: "enum",
    trait_item: "trait",
    type_item: "type",
    const_item: "constant",
    mod_item: "module",
  };

  if (node.type === "impl_item") {
    const typeName = rustTypeName(node.childForFieldName("type"));
    if (!typeName) return [];
    const body = node.childForFieldName("body");
    const symbol = makeInternalSymbol(node, `impl ${typeName}`, "impl", context, { body });
    if (body) {
      symbol.members = collectContainer(body, {
        language: "rust",
        source: context.source,
        qualifier: typeName,
        separator: "::",
        containerKind: "impl",
      });
    }
    return [symbol];
  }

  if (node.type === "function_item" || node.type === "function_signature_item") {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return [];
    const body = node.childForFieldName("body");
    const parameters = node.childForFieldName("parameters");
    const hasSelf = firstDescendant(parameters, "self_parameter") != null;
    const kind =
      (context.containerKind === "impl" || context.containerKind === "trait") && hasSelf
        ? "method"
        : "function";
    const isPublic = namedChildren(node).some((child) => child.type === "visibility_modifier");
    return [
      makeInternalSymbol(node, nameNode.text, kind, context, {
        body,
        exported: isPublic,
        visibility: isPublic ? "public" : undefined,
        modifiers: directModifiers(node),
      }),
    ];
  }

  const kind = namedKinds[node.type];
  if (!kind) return [];
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return [];
  const body = node.childForFieldName("body");
  const isPublic = namedChildren(node).some((child) => child.type === "visibility_modifier");
  const symbol = makeInternalSymbol(node, nameNode.text, kind, context, {
    body,
    exported: isPublic,
    visibility: isPublic ? "public" : undefined,
  });
  if (body && ["trait", "module"].includes(kind)) {
    symbol.members = collectContainer(body, {
      language: "rust",
      source: context.source,
      qualifier: symbol.symbol.qualifiedName,
      separator: "::",
      containerKind: kind,
    });
  }
  return [symbol];
}

function collectNode(node: SyntaxNode, context: CollectContext): InternalSymbol[] {
  switch (context.language) {
    case "python":
      return collectPython(node, context);
    case "typescript":
    case "tsx":
    case "javascript":
      return collectTypeScript(node, context);
    case "go":
      return collectGo(node, context);
    case "rust":
      return collectRust(node, context);
  }
}

function collectContainer(node: SyntaxNode, context: CollectContext): InternalSymbol[] {
  const symbols: InternalSymbol[] = [];
  for (const child of namedChildren(node)) {
    symbols.push(...collectNode(child, context));
  }
  return symbols;
}

export class CodeStructureAnalyzer {
  private readonly languages = new Map<string, Language>();
  private disposed = false;

  private constructor(private readonly assetDirectory?: string) {}

  static async create(options?: CodeStructureAnalyzerOptions): Promise<CodeStructureAnalyzer> {
    await initializeParser(options?.assetDirectory);
    return new CodeStructureAnalyzer(options?.assetDirectory);
  }

  static detectLanguage(filePath: string): CodeStructureLanguage | null {
    return LANGUAGE_CONFIG[path.extname(filePath).toLowerCase()]?.language ?? null;
  }

  dispose(): void {
    this.disposed = true;
    this.languages.clear();
  }

  async analyze(
    filePath: string,
    source: string,
    options?: CodeStructureAnalysisOptions
  ): Promise<CodeModuleReport> {
    return (await this.analyzeInternal(filePath, source, options)).report;
  }

  async readSymbol(
    filePath: string,
    source: string,
    selector: ReadSymbolSelector,
    options?: CodeStructureAnalysisOptions
  ): Promise<ReadCodeResult> {
    const analysis = await this.analyzeInternal(filePath, source, options);
    const candidates = flattenSymbols(analysis.symbols).filter(({ symbol }) => {
      const matchesName =
        symbol.qualifiedName === selector.symbol || symbol.name === selector.symbol;
      return (
        matchesName &&
        (selector.kind == null || symbol.kind === selector.kind) &&
        (selector.startLine == null || symbol.startLine === selector.startLine)
      );
    });

    if (candidates.length === 0) {
      return { found: false, reason: "not_found", candidates: [] };
    }
    if (candidates.length > 1) {
      return {
        found: false,
        reason: "ambiguous",
        candidates: candidates.map(publicSymbol),
      };
    }

    return this.toReadResult(analysis.report, candidates[0]);
  }

  async readEnclosing(
    filePath: string,
    source: string,
    line: number,
    options?: CodeStructureAnalysisOptions
  ): Promise<ReadCodeResult> {
    const analysis = await this.analyzeInternal(filePath, source, options);
    const candidates = flattenSymbols(analysis.symbols)
      .filter(({ symbol }) => symbol.startLine <= line && symbol.endLine >= line)
      .sort((left, right) => {
        const leftSpan = left.symbol.endLine - left.symbol.startLine;
        const rightSpan = right.symbol.endLine - right.symbol.startLine;
        return (
          leftSpan - rightSpan ||
          right.symbol.qualifiedName.length - left.symbol.qualifiedName.length
        );
      });

    if (candidates.length === 0) {
      return { found: false, reason: "no_enclosing_symbol", candidates: [] };
    }
    return this.toReadResult(analysis.report, candidates[0]);
  }

  private toReadResult(report: CodeModuleReport, internal: InternalSymbol): ReadCodeResult {
    return {
      ...publicSymbol(internal),
      found: true,
      path: report.path,
      language: report.language,
      source: internal.source,
    };
  }

  private async analyzeInternal(
    filePath: string,
    source: string,
    options?: CodeStructureAnalysisOptions
  ): Promise<InternalReport> {
    if (this.disposed) throw new Error("CodeStructureAnalyzer has been disposed");
    const config = LANGUAGE_CONFIG[path.extname(filePath).toLowerCase()];
    if (!config) throw new Error(`Unsupported code structure language for '${filePath}'`);

    let language = this.languages.get(config.grammar);
    if (!language) {
      language = await Language.load(await resolveGrammar(config.grammar, this.assetDirectory));
      this.languages.set(config.grammar, language);
    }

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source, null, {
      progressCallback: () => options?.deadlineMs != null && Date.now() >= options.deadlineMs,
    });
    if (!tree) {
      parser.delete();
      throw new Error(`Tree-sitter could not parse '${filePath}'`);
    }

    try {
      const complete = !tree.rootNode.hasError;
      const symbols = collectContainer(tree.rootNode, {
        language: config.language,
        source,
        separator: config.language === "rust" ? "::" : ".",
      });
      return {
        report: {
          path: filePath,
          language: config.language,
          lineCount: lineCount(source),
          complete,
          warnings: complete
            ? []
            : ["Tree-sitter recovered from syntax errors; results may be partial."],
          symbols: symbols.map(publicSymbol),
        },
        symbols,
      };
    } finally {
      tree.delete();
      parser.delete();
    }
  }
}
