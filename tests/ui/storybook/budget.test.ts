import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STORY_DIR = "src/browser/stories";
const COLOCATED_STORY_DIRS = ["src/browser/components", "src/browser/features"];
const MAX_SNAPSHOT_ENABLED_FILES = 80;
// Exact current retained snapshot baseline. Keep this no-headroom guardrail tight:
// future growth should exclude, consolidate, or intentionally rebalance snapshots
// rather than silently increasing Pixel load.
const MAX_ESTIMATED_SNAPSHOTS = 312;
const DUAL_THEME_PATTERN = /matrix:\s*PIXEL_DUAL_THEME/g;
const INLINE_MATRIX_OBJECT_PATTERN = /matrix:\s*{/g;

function findColocatedStories(dirs: string[]): string[] {
  return dirs.flatMap((dir: string) =>
    (readdirSync(dir, { recursive: true }) as string[])
      .map((entry) => join(dir, entry))
      .filter((file: string) => file.endsWith(".stories.tsx"))
  );
}

function hasSnapshotDisable(content: string): boolean {
  return content.includes("pixel: PIXEL_DISABLED") || /exclude:\s*true/.test(content);
}

function splitStorySections(content: string): {
  metaSection: string;
  storySections: string[];
} {
  const [metaSection = content, ...storySections] = content.split(/(?=^export const \w+)/m);
  return { metaSection, storySections };
}

function hasMetaDisable(content: string): boolean {
  return hasSnapshotDisable(splitStorySections(content).metaSection);
}

function findClosingBrace(content: string, openingBraceIndex: number): number {
  let depth = 0;
  for (let index = openingBraceIndex; index < content.length; index += 1) {
    const char = content[index];
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function countArrayEntries(arrayLiteral: string): number {
  const source = arrayLiteral.trim();
  if (source.length === 0) {
    return 0;
  }
  return source.split(",").filter((entry) => entry.trim().length > 0).length;
}

// Pixel expands every configured matrix axis as a cross-product.
function estimateMatrixVariants(matrixLiteral: string): number {
  const inner = matrixLiteral.slice(1, -1);

  let variants = 1;
  for (const axis of ["browsers", "viewports", "themes", "colorSchemes"]) {
    const axisMatch = new RegExp(`${axis}:\\s*\\[([^\\]]*)\\]`).exec(inner);
    if (axisMatch?.[1] != null) {
      variants *= Math.max(1, countArrayEntries(axisMatch[1]));
    }
  }

  return variants;
}

function estimateInlineMatrixExtras(content: string): number {
  let extraSnapshots = 0;

  for (const match of content.matchAll(INLINE_MATRIX_OBJECT_PATTERN)) {
    if (match.index == null) {
      continue;
    }

    const openingBraceIndex = match.index + match[0].length - 1;
    const closingBraceIndex = findClosingBrace(content, openingBraceIndex);
    if (closingBraceIndex === -1) {
      continue;
    }

    const variantCount = estimateMatrixVariants(
      content.slice(openingBraceIndex, closingBraceIndex + 1)
    );
    extraSnapshots += Math.max(0, variantCount - 1);
  }

  return extraSnapshots;
}

describe("Storybook snapshot budget", () => {
  // Track snapshot budget across both legacy app-level stories and colocated stories.
  const appStoryFiles = readdirSync(STORY_DIR)
    .filter((f: string) => f.endsWith(".stories.tsx"))
    .map((f: string) => `${STORY_DIR}/${f}`);
  const colocatedStoryFiles = findColocatedStories(COLOCATED_STORY_DIRS);
  const allStoryFiles = [...appStoryFiles, ...colocatedStoryFiles];

  test(`story files with snapshots enabled ≤ ${MAX_SNAPSHOT_ENABLED_FILES}`, () => {
    const filesWithSnapshots = allStoryFiles.filter((file: string) => {
      const content = readFileSync(file, "utf-8");
      return !hasMetaDisable(content);
    });

    expect(filesWithSnapshots.length).toBeLessThanOrEqual(MAX_SNAPSHOT_ENABLED_FILES);
  });

  test(`estimated total snapshots ≤ ${MAX_ESTIMATED_SNAPSHOTS}`, () => {
    let totalSnapshots = 0;

    for (const file of allStoryFiles) {
      const content = readFileSync(file, "utf-8");
      if (hasMetaDisable(content)) {
        continue;
      }

      const { metaSection, storySections } = splitStorySections(content);
      const enabledStorySections = storySections.filter((section) => !hasSnapshotDisable(section));
      const storyCount = enabledStorySections.length;
      if (storyCount === 0) {
        continue;
      }

      const snapshotContent = [metaSection, ...enabledStorySections].join("\n");
      const dualThemeStories = (snapshotContent.match(DUAL_THEME_PATTERN) ?? []).length;
      const inlineMatrixExtras = estimateInlineMatrixExtras(snapshotContent);
      totalSnapshots += storyCount + dualThemeStories + inlineMatrixExtras;
    }

    expect(totalSnapshots).toBeLessThanOrEqual(MAX_ESTIMATED_SNAPSHOTS);
  });
});
