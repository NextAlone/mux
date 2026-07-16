import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ZH_CN } from "../src/browser/i18n/translations/zh-CN";
import { FEATURES_ZH_CN } from "../src/browser/i18n/translations/zh-CN/features";
import { SETTINGS_ZH_CN } from "../src/browser/i18n/translations/zh-CN/settings";
import { SHELL_ZH_CN } from "../src/browser/i18n/translations/zh-CN/shell";
import { translateDesktopUi } from "../src/common/i18n/uiLanguage";

const BROWSER_SOURCE_ROOT = path.resolve(import.meta.dir, "../src/browser");
const DESKTOP_SOURCE_ROOT = path.resolve(import.meta.dir, "../src/desktop");
const CHART_SERIES_COMPONENTS = new Set(["Area", "Bar", "Line", "Pie", "Radar", "Scatter"]);
const USER_VISIBLE_ATTRIBUTES = new Set([
  "alt",
  "aria-label",
  "ariaLabel",
  "buttonLabel",
  "cancelLabel",
  "confirmLabel",
  "description",
  "dismissLabel",
  "emptyLabel",
  "detail",
  "emptyMessage",
  "helperText",
  "label",
  "message",
  "placeholder",
  "statusText",
  "subtitle",
  "text",
  "title",
  "tooltip",
  "tooltipLabel",
  "warning",
]);

const USER_VISIBLE_OBJECT_PROPERTIES = new Set([
  "buttonLabel",
  "cancelLabel",
  "confirmLabel",
  "description",
  "detail",
  "dismissLabel",
  "emptyLabel",
  "emptyMessage",
  "helperText",
  "label",
  "message",
  "placeholder",
  "statusText",
  "subtitle",
  "title",
  "tooltip",
  "tooltipLabel",
  "warning",
]);

const EXCLUDED_FILE_PARTS = [
  ".test.",
  ".stories.",
  ".ui.test.",
  "/assets/",
  "/i18n/translations/",
  "/stories/",
  "/testUtils.",
];

interface Finding {
  file: string;
  line: number;
  text: string;
}

interface MissingTranslation {
  file: string;
  line: number;
  key: string;
}

interface TranslationConflict {
  key: string;
  values: Array<{ area: string; value: string }>;
}

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(entryPath);
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) return [];
    const normalizedPath = entryPath.replaceAll(path.sep, "/");
    return EXCLUDED_FILE_PARTS.some((part) => normalizedPath.includes(part)) ? [] : [entryPath];
  });
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function containsEnglishWords(text: string): boolean {
  // JSX entity names are markup, not visible English copy.
  const visibleText = normalizeText(text).replace(/&(?:[a-z]+|#\d+|#x[\da-f]+);/gi, "");
  return /[A-Za-z]{2,}/.test(visibleText);
}

function isIgnored(sourceFile: ts.SourceFile, node: ts.Node): boolean {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
  const lines = sourceFile.text.split(/\r?\n/);
  return [lines[line - 1], lines[line]].some((value) => value?.includes("i18n-ignore"));
}

function isInsideTechnicalTextElement(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isJsxElement(current)) {
      const tag = current.openingElement.tagName.getText();
      if (tag === "code" || tag === "pre") return true;
    }
    current = current.parent;
  }
  return false;
}

function collectRenderableStrings(node: ts.Node, output: ts.StringLiteralLike[]): void {
  if (ts.isStringLiteralLike(node)) {
    output.push(node);
    return;
  }
  if (ts.isTemplateExpression(node)) {
    output.push(node.head);
    for (const span of node.templateSpans) output.push(span.literal);
    return;
  }
  if (ts.isConditionalExpression(node)) {
    collectRenderableStrings(node.whenTrue, output);
    collectRenderableStrings(node.whenFalse, output);
    return;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    collectRenderableStrings(node.left, output);
    collectRenderableStrings(node.right, output);
    return;
  }
  if (ts.isParenthesizedExpression(node)) {
    collectRenderableStrings(node.expression, output);
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) collectRenderableStrings(element, output);
  }
}

function getJsxTagName(attribute: ts.JsxAttribute): string | null {
  const parent = attribute.parent.parent;
  if (!ts.isJsxOpeningElement(parent) && !ts.isJsxSelfClosingElement(parent)) return null;
  const tagName = parent.tagName.getText();
  return tagName.split(".").at(-1) ?? null;
}

function auditFile(file: string): {
  findings: Finding[];
  missingTranslations: MissingTranslation[];
} {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const findings: Finding[] = [];
  const missingTranslations: MissingTranslation[] = [];

  const addFinding = (node: ts.Node, text: string) => {
    const normalized = normalizeText(text);
    if (!normalized || !containsEnglishWords(normalized) || isIgnored(sourceFile, node)) return;
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    findings.push({
      file: path.relative(path.resolve(import.meta.dir, ".."), file),
      line,
      text: normalized,
    });
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && !isInsideTechnicalTextElement(node)) {
      addFinding(node, node.text);
    } else if (ts.isJsxAttribute(node)) {
      const attributeName = node.name.getText(sourceFile);
      const chartSeriesName =
        attributeName === "name" && CHART_SERIES_COMPONENTS.has(getJsxTagName(node) ?? "");
      if ((USER_VISIBLE_ATTRIBUTES.has(attributeName) || chartSeriesName) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) {
          addFinding(node.initializer, node.initializer.text);
        } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          const strings: ts.StringLiteralLike[] = [];
          collectRenderableStrings(node.initializer.expression, strings);
          for (const stringNode of strings) addFinding(stringNode, stringNode.text);
        }
      }
    } else if (
      ts.isJsxExpression(node) &&
      node.parent &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) &&
      node.expression
    ) {
      const strings: ts.StringLiteralLike[] = [];
      collectRenderableStrings(node.expression, strings);
      for (const stringNode of strings) addFinding(stringNode, stringNode.text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "t" &&
      node.arguments.length === 1
    ) {
      const keyNode = node.arguments[0];
      if (ts.isStringLiteralLike(keyNode)) {
        const key = keyNode.text;
        if (
          containsEnglishWords(key) &&
          !Object.prototype.hasOwnProperty.call(ZH_CN, key) &&
          !isIgnored(sourceFile, node)
        ) {
          missingTranslations.push({
            file: path.relative(path.resolve(import.meta.dir, ".."), file),
            line: sourceFile.getLineAndCharacterOfPosition(keyNode.getStart(sourceFile)).line + 1,
            key,
          });
        }
      } else if (ts.isTemplateExpression(keyNode)) {
        // Exact-key dictionaries cannot translate a template after runtime values
        // have been interpolated. Translate its static pieces around the values.
        const strings: ts.StringLiteralLike[] = [];
        collectRenderableStrings(keyNode, strings);
        for (const stringNode of strings) addFinding(stringNode, stringNode.text);
      }
    } else if (ts.isPropertyAssignment(node)) {
      const propertyName =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : "";
      if (
        USER_VISIBLE_OBJECT_PROPERTIES.has(propertyName) &&
        ts.isStringLiteralLike(node.initializer) &&
        containsEnglishWords(node.initializer.text) &&
        !node.initializer.text.startsWith("var(") &&
        !Object.prototype.hasOwnProperty.call(ZH_CN, node.initializer.text) &&
        !isIgnored(sourceFile, node)
      ) {
        missingTranslations.push({
          file: path.relative(path.resolve(import.meta.dir, ".."), file),
          line:
            sourceFile.getLineAndCharacterOfPosition(node.initializer.getStart(sourceFile)).line +
            1,
          key: node.initializer.text,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { findings, missingTranslations };
}

function auditDesktopFile(file: string): MissingTranslation[] {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const missingTranslations: MissingTranslation[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "desktopT" &&
      node.arguments.length === 1
    ) {
      const keyNode = node.arguments[0];
      if (
        ts.isStringLiteralLike(keyNode) &&
        containsEnglishWords(keyNode.text) &&
        translateDesktopUi("zh-CN", keyNode.text) === keyNode.text &&
        !isIgnored(sourceFile, node)
      ) {
        missingTranslations.push({
          file: path.relative(path.resolve(import.meta.dir, ".."), file),
          line: sourceFile.getLineAndCharacterOfPosition(keyNode.getStart(sourceFile)).line + 1,
          key: keyNode.text,
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return missingTranslations;
}

const auditResults = listSourceFiles(BROWSER_SOURCE_ROOT).map(auditFile);
const findings = auditResults.flatMap((result) => result.findings);
const missingTranslations = auditResults.flatMap((result) => result.missingTranslations);
const desktopMissingTranslations = listSourceFiles(DESKTOP_SOURCE_ROOT).flatMap(auditDesktopFile);
const translationAreas = [
  ["shell", SHELL_ZH_CN],
  ["features", FEATURES_ZH_CN],
  ["settings", SETTINGS_ZH_CN],
] as const;
const translationKeys = new Set(
  translationAreas.flatMap(([, translations]) => Object.keys(translations))
);
const translationConflicts: TranslationConflict[] = [];

for (const key of translationKeys) {
  const values = translationAreas.flatMap(([area, translations]) =>
    Object.prototype.hasOwnProperty.call(translations, key)
      ? [{ area, value: translations[key] }]
      : []
  );
  if (new Set(values.map(({ value }) => value)).size > 1) {
    translationConflicts.push({ key, values });
  }
}

if (findings.length > 0) {
  console.error("User-visible English bypasses the translation layer:");
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: ${finding.text}`);
  }
  console.error(`\n${findings.length} untranslated UI literal(s) found.`);
}

if (missingTranslations.length > 0) {
  console.error("Translation calls missing a simplified Chinese dictionary entry:");
  for (const finding of missingTranslations) {
    console.error(`${finding.file}:${finding.line}: ${finding.key}`);
  }
  console.error(`\n${missingTranslations.length} missing dictionary entrie(s) found.`);
}

if (desktopMissingTranslations.length > 0) {
  console.error("Desktop translation calls missing a simplified Chinese dictionary entry:");
  for (const finding of desktopMissingTranslations) {
    console.error(`${finding.file}:${finding.line}: ${finding.key}`);
  }
  console.error(
    `\n${desktopMissingTranslations.length} missing desktop dictionary entrie(s) found.`
  );
}

if (translationConflicts.length > 0) {
  console.error("Translation areas define conflicting values for the same source text:");
  for (const conflict of translationConflicts) {
    console.error(
      `${conflict.key}: ${conflict.values.map(({ area, value }) => `${area}=${value}`).join(", ")}`
    );
  }
  console.error(`\n${translationConflicts.length} conflicting translation key(s) found.`);
}

if (
  findings.length > 0 ||
  missingTranslations.length > 0 ||
  desktopMissingTranslations.length > 0 ||
  translationConflicts.length > 0
) {
  process.exit(1);
}

console.log("All audited JSX UI text uses the translation layer.");
