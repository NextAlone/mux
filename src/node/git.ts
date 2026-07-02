import {
  detectDefaultJjTrunkBookmark,
  getCurrentBookmark,
  listLocalBookmarks,
} from "@/node/vcs/jj";

export async function listLocalBranches(projectPath: string): Promise<string[]> {
  return listLocalBookmarks(projectPath);
}

export async function getCurrentBranch(projectPath: string): Promise<string | null> {
  return getCurrentBookmark(projectPath);
}

export async function detectDefaultTrunkBranch(
  projectPath: string,
  branches?: string[]
): Promise<string> {
  return detectDefaultJjTrunkBookmark(projectPath, branches);
}
