import ignore from "ignore";
import * as fs from "fs/promises";
import * as path from "path";
import { log } from "@/node/services/log";

const MUXIGNORE_FILENAME = ".muxignore";
const SKIPPED_METADATA_DIRS = new Set([".git", ".jj"]);

/**
 * Parse .muxignore and return negation patterns (without the ! prefix).
 * Only !-prefixed lines are actionable — they identify gitignored files
 * that should be copied into worktree workspaces.
 */
export function parseMuxignorePatterns(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("!") && line.length > 1)
    .map((line) => line.slice(1));
}

async function listProjectFiles(projectPath: string, currentPath = projectPath): Promise<string[]> {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && SKIPPED_METADATA_DIRS.has(entry.name)) {
      continue;
    }

    const entryPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listProjectFiles(projectPath, entryPath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    files.push(path.relative(projectPath, entryPath).split(path.sep).join("/"));
  }

  return files;
}

/** Get list of files in the project that match .muxignore patterns. */
async function getFilesToSync(projectPath: string, patterns: string[]): Promise<string[]> {
  if (patterns.every((pattern) => pattern.startsWith("!"))) return [];

  const ig = ignore().add(patterns);
  return (await listProjectFiles(projectPath)).filter((file) => ig.ignores(file));
}

/**
 * Sync gitignored files from project root to worktree based on .muxignore.
 * Runs after workspace creation so that files like `.env` are available
 * before `.mux/init` hooks execute.
 *
 * Best-effort: logs debug details but never throws.
 */
export async function syncMuxignoreFiles(
  projectPath: string,
  workspacePath: string
): Promise<void> {
  try {
    // Read .muxignore — bail silently if missing (most projects won't have one)
    const muxignorePath = path.join(projectPath, MUXIGNORE_FILENAME);
    let content: string;
    try {
      content = await fs.readFile(muxignorePath, "utf-8");
    } catch {
      return;
    }

    const patterns = parseMuxignorePatterns(content);
    if (patterns.length === 0) return;

    const filesToSync = await getFilesToSync(projectPath, patterns);
    let copied = 0;

    for (const relPath of filesToSync) {
      const src = path.join(projectPath, relPath);
      const dest = path.join(workspacePath, relPath);

      // Don't overwrite files that already exist in the worktree
      try {
        await fs.access(dest);
        continue;
      } catch {
        // Doesn't exist — copy it
      }

      try {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(src, dest);
        copied++;
      } catch (err) {
        log.debug(`muxignore: failed to copy ${relPath}`, { error: String(err) });
      }
    }

    if (copied > 0) {
      log.debug(`muxignore: synced ${copied} file(s) to worktree`);
    }
  } catch (err) {
    // Best-effort — never let .muxignore sync break workspace creation
    log.debug("muxignore: sync failed", { error: String(err) });
  }
}
