import assert from "node:assert/strict";
import path from "node:path";

import type { Runtime } from "@/node/runtime/Runtime";
import { execBuffered, readFileString, writeFileString } from "@/node/utils/runtime/helpers";

export type EnsureGitInfoExcludeResult =
  | { status: "notGit" }
  | { status: "ensured"; pattern: string; excludePath: string }
  | { status: "failed"; error: string };

export async function ensureGitInfoExclude(input: {
  runtime: Runtime;
  workspacePath: string;
  relativeDir: string;
}): Promise<EnsureGitInfoExcludeResult> {
  const { runtime, workspacePath, relativeDir } = input;
  assert(workspacePath.trim().length > 0, "workspacePath is required");
  assert(relativeDir.trim().length > 0, "relativeDir is required");

  const repoRootResult = await execBuffered(runtime, "jj --no-pager --color never root", {
    cwd: workspacePath,
    timeout: 5,
  });
  if (repoRootResult.exitCode !== 0) {
    const message = `${repoRootResult.stderr}\n${repoRootResult.stdout}`;
    if (/not a jj repo|not a git repository|no jj repo/i.test(message)) {
      return { status: "notGit" };
    }
    return { status: "failed", error: message.trim() || "Could not determine jj workspace" };
  }

  const gitRootResult = await execBuffered(runtime, "jj --no-pager --color never git root", {
    cwd: workspacePath,
    timeout: 5,
  });
  if (gitRootResult.exitCode !== 0) {
    return {
      status: "failed",
      error: gitRootResult.stderr.trim() || "Could not resolve jj Git backend path",
    };
  }

  const repoRoot = repoRootResult.stdout.trim();
  const gitRoot = gitRootResult.stdout.trim();
  if (!repoRoot || !gitRoot) {
    return { status: "failed", error: "Could not resolve jj repository paths" };
  }

  let resolvedWorkspacePath = workspacePath;
  try {
    resolvedWorkspacePath = await runtime.resolvePath(workspacePath);
  } catch {
    resolvedWorkspacePath = workspacePath;
  }

  const prefix = relativeRuntimePath(repoRoot, resolvedWorkspacePath);
  const relative = relativeDir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const pattern = `/${[prefix, relative].filter(Boolean).join("/")}/`;
  const excludePath = resolveRuntimePath(workspacePath, `${gitRoot}/info/exclude`);

  let existing = "";
  try {
    existing = await readFileString(runtime, excludePath);
  } catch {
    existing = "";
  }

  const existingLines = existing
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (!existingLines.includes(pattern)) {
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    await writeFileString(runtime, excludePath, `${existing}${separator}${pattern}\n`);
  }

  return { status: "ensured", pattern, excludePath };
}

function resolveRuntimePath(workspacePath: string, gitPath: string): string {
  assert(gitPath.trim().length > 0, "git exclude path is required");
  if (path.isAbsolute(gitPath) || /^[/~]/u.test(gitPath) || /^[A-Za-z]:[\\/]/u.test(gitPath)) {
    return gitPath;
  }
  return `${workspacePath.replace(/[\\/]+$/u, "")}/${gitPath}`;
}

function relativeRuntimePath(rootPath: string, childPath: string): string {
  const normalizedRoot = canonicalizeRuntimePath(rootPath);
  const normalizedChild = canonicalizeRuntimePath(childPath);
  if (normalizedChild === normalizedRoot) {
    return "";
  }
  if (normalizedChild.startsWith(`${normalizedRoot}/`)) {
    return normalizedChild.slice(normalizedRoot.length + 1).replace(/^\/+|\/+$/g, "");
  }
  return "";
}

function canonicalizeRuntimePath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/^\/private(?=\/var\/)/, "")
    .replace(/\/+$/g, "");
}
