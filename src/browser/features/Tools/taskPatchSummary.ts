import type { SubagentGitPatchArtifact } from "@/common/utils/tools/toolDefinitions";

interface LegacyGitPatchArtifactLike {
  status?: string;
  projectArtifacts?: Array<{ status?: string; error?: string }>;
  readyProjectCount?: number;
  skippedProjectCount?: number;
  failedProjectCount?: number;
  totalCommitCount?: number;
  commitCount?: number;
  error?: string;
}

function getProjectSummaryCount(count: number | undefined): string | undefined {
  return typeof count === "number" && count > 0 ? String(count) : undefined;
}

function getFailedPatchError(gitPatchArtifact: LegacyGitPatchArtifactLike): string | undefined {
  const failedProject = Array.isArray(gitPatchArtifact.projectArtifacts)
    ? gitPatchArtifact.projectArtifacts.find(
        (projectArtifact) => projectArtifact.status === "failed"
      )
    : undefined;
  const error = failedProject?.error?.trim() ?? gitPatchArtifact.error?.trim();
  return error && error.length > 80 ? `${error.slice(0, 77)}…` : (error ?? undefined);
}

export function formatGitPatchArtifactSummary(
  gitPatchArtifact: SubagentGitPatchArtifact | LegacyGitPatchArtifactLike | undefined
): string | null {
  if (!gitPatchArtifact) return null;

  const legacyCompatibleArtifact = gitPatchArtifact as LegacyGitPatchArtifactLike;
  const readyCount = getProjectSummaryCount(legacyCompatibleArtifact.readyProjectCount);
  const skippedCount = getProjectSummaryCount(legacyCompatibleArtifact.skippedProjectCount);
  const failedCount = getProjectSummaryCount(legacyCompatibleArtifact.failedProjectCount);
  const readySummary = readyCount ? `${readyCount} ready` : undefined;
  const skippedSummary = skippedCount ? `${skippedCount} skipped` : undefined;
  const failedSummary = failedCount ? `${failedCount} failed` : undefined;
  const projectSummary = [readySummary, skippedSummary, failedSummary]
    .filter((summary): summary is string => typeof summary === "string")
    .join(", ");
  const totalCommitCount =
    typeof legacyCompatibleArtifact.totalCommitCount === "number"
      ? legacyCompatibleArtifact.totalCommitCount
      : (legacyCompatibleArtifact.commitCount ?? 0);
  const commitLabel = totalCommitCount === 1 ? "commit" : "commits";

  switch (gitPatchArtifact.status) {
    case "pending":
      return projectSummary.length > 0
        ? `Task change: pending (${projectSummary})`
        : "Task change: pending";
    case "skipped":
      return projectSummary.length > 0
        ? `Task change: skipped (${projectSummary})`
        : "Task change: skipped (no commits)";
    case "ready":
      return projectSummary.length > 0
        ? `Task change: ready (${projectSummary}; ${totalCommitCount} ${commitLabel})`
        : `Task change: ready (${totalCommitCount} ${commitLabel})`;
    case "failed": {
      const shortError = getFailedPatchError(legacyCompatibleArtifact);
      if (projectSummary.length > 0) {
        return shortError
          ? `Task change: failed (${projectSummary}; ${shortError})`
          : `Task change: failed (${projectSummary})`;
      }
      return shortError ? `Task change: failed (${shortError})` : "Task change: failed";
    }
    default:
      return `Task change: ${String(gitPatchArtifact.status)}`;
  }
}
