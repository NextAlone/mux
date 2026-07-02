import { useState, useRef, useEffect, useCallback } from "react";
import { z } from "zod";
import type { GitStatus } from "@/common/types/workspace";
import {
  parseGitShowBranch,
  type GitCommit,
  type GitBranchHeader,
} from "@/common/utils/git/parseGitLog";
import { useAPI } from "@/browser/contexts/API";
import { getErrorMessage } from "@/common/utils/errors";
import { repoRootBashOptions } from "@/browser/utils/executeBash";

const GitBranchDataSchema = z.object({
  showBranch: z.string(),
  dates: z.array(
    z.object({
      hash: z.string().min(1, "commit hash must not be empty"),
      date: z.string().min(1, "commit date must not be empty"),
    })
  ),
  dirtyFiles: z.array(z.string()),
});

type GitBranchData = z.infer<typeof GitBranchDataSchema>;

const SECTION_MARKERS = {
  showBranchStart: "__MUX_BRANCH_DATA__BEGIN_SHOW_BRANCH__",
  showBranchEnd: "__MUX_BRANCH_DATA__END_SHOW_BRANCH__",
  datesStart: "__MUX_BRANCH_DATA__BEGIN_DATES__",
  datesEnd: "__MUX_BRANCH_DATA__END_DATES__",
  dirtyStart: "__MUX_BRANCH_DATA__BEGIN_DIRTY_FILES__",
  dirtyEnd: "__MUX_BRANCH_DATA__END_DIRTY_FILES__",
} as const;
// eslint-disable-next-line no-restricted-globals, no-restricted-syntax
const isDevelopment = process.env.NODE_ENV !== "production";

function debugAssert(condition: unknown, message: string): void {
  if (!condition && isDevelopment) {
    console.assert(Boolean(condition), message);
  }
}

function extractSection(output: string, startMarker: string, endMarker: string): string | null {
  const startIndex = output.indexOf(startMarker);
  const endIndex = output.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    debugAssert(
      false,
      `Expected script output to contain markers ${startMarker} and ${endMarker}, but it did not.`
    );
    return null;
  }

  const rawSection = output.slice(startIndex + startMarker.length, endIndex);
  const sectionWithoutLeadingNewline = rawSection.replace(/^\r?\n/, "");
  return sectionWithoutLeadingNewline.replace(/\r?\n$/, "");
}

interface ParsedScriptResultSuccess {
  success: true;
  data: GitBranchData;
}

interface ParsedScriptResultFailure {
  success: false;
  error: string;
}

type ParsedScriptResult = ParsedScriptResultSuccess | ParsedScriptResultFailure;

function parseGitBranchScriptOutput(rawOutput: string): ParsedScriptResult {
  const normalizedOutput = rawOutput.replace(/\r\n/g, "\n");

  const showBranch = extractSection(
    normalizedOutput,
    SECTION_MARKERS.showBranchStart,
    SECTION_MARKERS.showBranchEnd
  );
  if (showBranch === null) {
    return { success: false, error: "Missing branch details from git script output." };
  }

  const datesRaw = extractSection(
    normalizedOutput,
    SECTION_MARKERS.datesStart,
    SECTION_MARKERS.datesEnd
  );
  if (datesRaw === null) {
    return { success: false, error: "Missing commit dates from git script output." };
  }

  const dirtyRaw = extractSection(
    normalizedOutput,
    SECTION_MARKERS.dirtyStart,
    SECTION_MARKERS.dirtyEnd
  );
  if (dirtyRaw === null) {
    return { success: false, error: "Missing dirty file list from git script output." };
  }

  const dates = datesRaw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hash, ...dateParts] = line.split("|");
      const date = dateParts.join("|").trim();
      debugAssert(hash.length > 0, "Expected git log output to provide a commit hash.");
      debugAssert(date.length > 0, "Expected git log output to provide a commit date.");
      return { hash, date };
    });

  const dirtyFiles = dirtyRaw
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0);

  const parsedDataResult = GitBranchDataSchema.safeParse({
    showBranch,
    dates,
    dirtyFiles,
  });

  if (!parsedDataResult.success) {
    debugAssert(false, parsedDataResult.error.message);
    const errorMessage = parsedDataResult.error.issues.map((issue) => issue.message).join(", ");
    return { success: false, error: `Invalid data format from git script: ${errorMessage}` };
  }

  return { success: true, data: parsedDataResult.data };
}

export interface GitBranchDetailsResult {
  branchHeaders: GitBranchHeader[] | null;
  commits: GitCommit[] | null;
  dirtyFiles: string[] | null;
  isLoading: boolean;
  errorMessage: string | null;
}

/**
 * Hook for fetching jj change details (dirty files for now).
 * Implements caching (5s TTL) and debouncing (200ms) to avoid excessive IPC calls.
 *
 * @param workspaceId - Workspace to fetch git details for
 * @param gitStatus - Current git status (used to determine if dirty files should be fetched)
 * @param enabled - Whether to fetch data (typically when tooltip should be shown)
 */
export function useGitBranchDetails(
  workspaceId: string,
  gitStatus: GitStatus | null,
  enabled: boolean
): GitBranchDetailsResult {
  debugAssert(
    workspaceId.trim().length > 0,
    "useGitBranchDetails expects a non-empty workspaceId argument."
  );

  const { api } = useAPI();
  const [branchHeaders, setBranchHeaders] = useState<GitBranchHeader[] | null>(null);
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [dirtyFiles, setDirtyFiles] = useState<string[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const fetchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const cacheRef = useRef<{
    headers: GitBranchHeader[];
    commits: GitCommit[];
    dirtyFiles: string[];
    timestamp: number;
  } | null>(null);

  const fetchShowBranch = useCallback(async () => {
    if (!api) return;
    setIsLoading(true);

    try {
      // Consolidated bash script that gets jj info and outputs the legacy sections.
      const getDirtyFiles = gitStatus?.dirty
        ? "DIRTY_FILES=$(jj --no-pager --color never diff --summary 2>/dev/null | head -20)"
        : "DIRTY_FILES=''";

      const script = `
SHOW_BRANCH=""
DATES_OUTPUT=""

# Get dirty files if requested
${getDirtyFiles}

printf '__MUX_BRANCH_DATA__BEGIN_SHOW_BRANCH__\\n%s\\n__MUX_BRANCH_DATA__END_SHOW_BRANCH__\\n' "$SHOW_BRANCH"
printf '__MUX_BRANCH_DATA__BEGIN_DATES__\\n%s\\n__MUX_BRANCH_DATA__END_DATES__\\n' "$DATES_OUTPUT"
printf '__MUX_BRANCH_DATA__BEGIN_DIRTY_FILES__\\n%s\\n__MUX_BRANCH_DATA__END_DIRTY_FILES__\\n' "$DIRTY_FILES"
`;

      const result = await api.workspace.executeBash({
        workspaceId,
        script,
        options: repoRootBashOptions(5),
      });

      if (!result.success) {
        setErrorMessage(`Branch info unavailable: ${result.error}`);
        setCommits(null);
        return;
      }

      if (!result.data.success) {
        const errorMsg = result.data.output
          ? result.data.output.trim()
          : (result.data.error ?? "Unknown error");
        setErrorMessage(`Branch info unavailable: ${errorMsg}`);
        setCommits(null);
        return;
      }

      const parseResult = parseGitBranchScriptOutput(result.data.output ?? "");
      if (!parseResult.success) {
        setErrorMessage(`Branch info unavailable: ${parseResult.error}`);
        setBranchHeaders(null);
        setCommits(null);
        setDirtyFiles(null);
        return;
      }

      const gitData = parseResult.data;

      // Build date map from validated data
      const dateMap = new Map<string, string>(gitData.dates.map((d) => [d.hash, d.date]));

      // Parse show-branch output
      const parsed = parseGitShowBranch(gitData.showBranch, dateMap);
      if (parsed.commits.length === 0) {
        setBranchHeaders([]);
        setCommits([]);
        setDirtyFiles(gitData.dirtyFiles);
        setErrorMessage(null);
        cacheRef.current = {
          headers: [],
          commits: [],
          dirtyFiles: gitData.dirtyFiles,
          timestamp: Date.now(),
        };
        return;
      }

      setBranchHeaders(parsed.headers);
      setCommits(parsed.commits);
      setDirtyFiles(gitData.dirtyFiles);
      setErrorMessage(null);
      cacheRef.current = {
        headers: parsed.headers,
        commits: parsed.commits,
        dirtyFiles: gitData.dirtyFiles,
        timestamp: Date.now(),
      };
    } catch (error) {
      setErrorMessage(`Failed to fetch branch info: ${getErrorMessage(error)}`);
      setCommits(null);
    } finally {
      setIsLoading(false);
    }
  }, [api, workspaceId, gitStatus]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    // Check cache (5 second TTL)
    const now = Date.now();
    if (cacheRef.current && now - cacheRef.current.timestamp < 5000) {
      setBranchHeaders(cacheRef.current.headers);
      setCommits(cacheRef.current.commits);
      setDirtyFiles(cacheRef.current.dirtyFiles);
      setErrorMessage(null);
      return;
    }

    // Set loading state immediately so tooltip shows "Loading..." instead of "No commits to display"
    setIsLoading(true);

    // Debounce the fetch by 200ms to avoid rapid re-fetches
    if (fetchTimeoutRef.current) {
      clearTimeout(fetchTimeoutRef.current);
    }

    fetchTimeoutRef.current = setTimeout(() => {
      void fetchShowBranch();
    }, 200);

    // Cleanup function
    return () => {
      if (fetchTimeoutRef.current) {
        clearTimeout(fetchTimeoutRef.current);
        fetchTimeoutRef.current = null;
      }
    };
  }, [enabled, workspaceId, gitStatus?.dirty, fetchShowBranch]);

  return {
    branchHeaders,
    commits,
    dirtyFiles,
    isLoading,
    errorMessage,
  };
}
