import * as disposableExec from "@/node/utils/disposableExec";

const FALLBACK_TRUNK_BOOKMARKS = ["main", "master", "trunk", "develop", "default"];
const JJ_MACHINE_ARGS = ["--no-pager", "--color", "never"] as const;
const JJ_BOOKMARK_NAME_TEMPLATE = 'name ++ "\\n"';
const JJ_FILE_PATH_TEMPLATE = 'path ++ "\\n"';
const JJ_CHANGE_ID_TEMPLATE = 'change_id.shortest() ++ "\\n"';

function createUniqueSortedNames(names: Iterable<string>): string[] {
  return Array.from(
    new Set(
      Array.from(names)
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
    )
  ).sort((a, b) => a.localeCompare(b));
}

export function parseJjBookmarkNames(output: string): string[] {
  return createUniqueSortedNames(output.split("\n"));
}

export function parseJjFileListOutput(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function buildJjGitCloneArgs(source: string, destination: string): string[] {
  return [...JJ_MACHINE_ARGS, "git", "clone", "--colocate", source, destination];
}

export function detectDefaultJjBookmark(args: {
  bookmarks: string[];
  currentBookmarks: string[];
}): string {
  const bookmarks = createUniqueSortedNames(args.bookmarks);
  if (bookmarks.length === 0) {
    throw new Error("No bookmarks available in repository");
  }

  const currentBookmarkSet = new Set(createUniqueSortedNames(args.currentBookmarks));
  for (const bookmark of bookmarks) {
    if (currentBookmarkSet.has(bookmark)) {
      return bookmark;
    }
  }

  const bookmarkSet = new Set(bookmarks);
  for (const candidate of FALLBACK_TRUNK_BOOKMARKS) {
    if (bookmarkSet.has(candidate)) {
      return candidate;
    }
  }

  return bookmarks[0];
}

async function listBookmarksForRevision(projectPath: string, revision?: string): Promise<string[]> {
  const args = [
    ...JJ_MACHINE_ARGS,
    "--repository",
    projectPath,
    "--ignore-working-copy",
    "bookmark",
    "list",
    "--template",
    JJ_BOOKMARK_NAME_TEMPLATE,
  ];

  if (revision != null) {
    args.push("--revision", revision);
  }

  using proc = disposableExec.execFileAsync("jj", args);
  const { stdout } = await proc.result;
  return parseJjBookmarkNames(stdout);
}

export async function isInsideJjRepository(projectPath: string): Promise<boolean> {
  try {
    using proc = disposableExec.execFileAsync(
      "jj",
      [...JJ_MACHINE_ARGS, "--ignore-working-copy", "root"],
      { cwd: projectPath }
    );
    await proc.result;
    return true;
  } catch {
    return false;
  }
}

export async function getJjRoot(projectPath: string): Promise<string | null> {
  try {
    using proc = disposableExec.execFileAsync(
      "jj",
      [...JJ_MACHINE_ARGS, "--ignore-working-copy", "root"],
      { cwd: projectPath }
    );
    const { stdout } = await proc.result;
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function listJjFiles(projectPath: string): Promise<string[]> {
  using proc = disposableExec.execFileAsync(
    "jj",
    [...JJ_MACHINE_ARGS, "file", "list", "--template", JJ_FILE_PATH_TEMPLATE],
    { cwd: projectPath }
  );
  const { stdout } = await proc.result;
  return parseJjFileListOutput(stdout);
}

export async function createJjWorkspace(args: {
  projectPath: string;
  workspacePath: string;
  workspaceName: string;
  revision: string;
  message: string;
}): Promise<void> {
  using proc = disposableExec.execFileAsync("jj", [
    ...JJ_MACHINE_ARGS,
    "--repository",
    args.projectPath,
    "workspace",
    "add",
    "--name",
    args.workspaceName,
    "--revision",
    args.revision,
    "--message",
    args.message,
    args.workspacePath,
  ]);
  await proc.result;
}

export async function initJjGitRepository(projectPath: string): Promise<void> {
  using proc = disposableExec.execFileAsync("jj", [
    ...JJ_MACHINE_ARGS,
    "git",
    "init",
    "--colocate",
    projectPath,
  ]);
  await proc.result;
}

export async function describeJjRevision(args: {
  projectPath: string;
  revision: string;
  message: string;
}): Promise<void> {
  using proc = disposableExec.execFileAsync("jj", [
    ...JJ_MACHINE_ARGS,
    "--repository",
    args.projectPath,
    "describe",
    "-m",
    args.message,
    args.revision,
  ]);
  await proc.result;
}

export async function createJjBookmark(args: {
  projectPath: string;
  name: string;
  revision: string;
}): Promise<void> {
  using proc = disposableExec.execFileAsync("jj", [
    ...JJ_MACHINE_ARGS,
    "--repository",
    args.projectPath,
    "bookmark",
    "create",
    "-r",
    args.revision,
    args.name,
  ]);
  await proc.result;
}

export async function forgetJjWorkspace(args: {
  projectPath: string;
  workspaceName: string;
}): Promise<void> {
  using proc = disposableExec.execFileAsync("jj", [
    ...JJ_MACHINE_ARGS,
    "--repository",
    args.projectPath,
    "--ignore-working-copy",
    "workspace",
    "forget",
    args.workspaceName,
  ]);
  await proc.result;
}

export async function renameJjWorkspace(args: {
  workspacePath: string;
  newWorkspaceName: string;
}): Promise<void> {
  using proc = disposableExec.execFileAsync("jj", [
    ...JJ_MACHINE_ARGS,
    "--repository",
    args.workspacePath,
    "workspace",
    "rename",
    args.newWorkspaceName,
  ]);
  await proc.result;
}

export async function hasJjWorkspaceChanges(workspacePath: string): Promise<boolean> {
  using proc = disposableExec.execFileAsync("jj", [
    ...JJ_MACHINE_ARGS,
    "--repository",
    workspacePath,
    "diff",
    "--summary",
  ]);
  const { stdout } = await proc.result;
  return stdout.trim().length > 0;
}

export async function getCurrentJjChangeId(workspacePath: string): Promise<string | null> {
  return resolveJjRevisionChangeId(workspacePath, "@");
}

export async function resolveJjRevisionChangeId(
  workspacePath: string,
  revision: string
): Promise<string | null> {
  using proc = disposableExec.execFileAsync("jj", [
    ...JJ_MACHINE_ARGS,
    "--repository",
    workspacePath,
    "log",
    "--no-graph",
    "-r",
    revision,
    "-T",
    JJ_CHANGE_ID_TEMPLATE,
    "-n",
    "1",
  ]);
  const { stdout } = await proc.result;
  return stdout.trim() || null;
}

export async function listLocalBookmarks(projectPath: string): Promise<string[]> {
  // User goal: manage even colocated repositories through jj-native semantics, so repository refs
  // are read from jj bookmarks instead of Git branches.
  return listBookmarksForRevision(projectPath);
}

export async function getCurrentBookmark(projectPath: string): Promise<string | null> {
  try {
    const bookmarks = await listBookmarksForRevision(projectPath, "@");
    return bookmarks[0] ?? null;
  } catch {
    return null;
  }
}

export async function detectDefaultJjTrunkBookmark(
  projectPath: string,
  bookmarks?: string[]
): Promise<string> {
  const bookmarkList = bookmarks ?? (await listLocalBookmarks(projectPath));
  const currentBookmarks = await listBookmarksForRevision(projectPath, "@");
  try {
    return detectDefaultJjBookmark({ bookmarks: bookmarkList, currentBookmarks });
  } catch (error) {
    if (error instanceof Error && error.message === "No bookmarks available in repository") {
      throw new Error(`No bookmarks available in repository ${projectPath}`);
    }
    throw error;
  }
}
