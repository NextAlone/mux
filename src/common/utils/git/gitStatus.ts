/** Jujutsu status script and parsing utilities. Frontend-safe (no Node.js imports). */

/**
 * Generate bash script to get jj status for a workspace.
 * Returns structured output compatible with the existing git-status UI model.
 *
 * @param baseRef - The ref to compare against (e.g., "main", "main@origin").
 *                  If not provided or not branch-like, auto-detects.
 */
export function generateGitStatusScript(baseRef?: string): string {
  const preferredBranch = getPreferredBookmarkFromBaseRef(baseRef);
  // Security rationale: baseRef is client-controlled in some IPC paths, so quote as a single-quoted
  // shell literal to prevent command substitution / quote-breaking injection when embedding in bash.
  const shellSafePreferredBranch = `'${preferredBranch.replace(/'/g, `'\\''`)}'`;

  return `
# Determine primary bookmark to compare against
JJ="jj --no-pager --color never"
PRIMARY_BRANCH=""
PREFERRED_BRANCH=${shellSafePreferredBranch}

BOOKMARKS=$($JJ bookmark list -T 'name ++ "\\n"' 2>/dev/null || true)

# Try preferred bookmark first if specified
if [ -n "$PREFERRED_BRANCH" ]; then
  if printf '%s\\n' "$BOOKMARKS" | grep -Fxq "$PREFERRED_BRANCH"; then
    PRIMARY_BRANCH="$PREFERRED_BRANCH"
  fi
fi

# Fall back to auto-detection
if [ -z "$PRIMARY_BRANCH" ]; then
  for candidate in main master trunk develop default; do
    if printf '%s\\n' "$BOOKMARKS" | grep -Fxq "$candidate"; then
      PRIMARY_BRANCH="$candidate"
      break
    fi
  done
fi

if [ -z "$PRIMARY_BRANCH" ]; then
  PRIMARY_BRANCH=$(printf '%s\\n' "$BOOKMARKS" | sed '/^[[:space:]]*$/d' | head -1)
fi

# Exit if we can't determine primary bookmark
if [ -z "$PRIMARY_BRANCH" ]; then
  echo "ERROR: Could not determine primary bookmark"
  exit 1
fi

# Best-effort ahead/behind using jj revsets when a remote bookmark is present.
AHEAD=0
BEHIND=0
REMOTE_BOOKMARK="$PRIMARY_BRANCH@origin"
if $JJ log -r "$REMOTE_BOOKMARK" --no-graph -T 'commit_id.short() ++ "\\n"' -n 1 >/dev/null 2>&1; then
  AHEAD=$($JJ log -r "$REMOTE_BOOKMARK..@" --no-graph -T 'commit_id ++ "\\n"' 2>/dev/null | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')
  BEHIND=$($JJ log -r "@..$REMOTE_BOOKMARK" --no-graph -T 'commit_id ++ "\\n"' 2>/dev/null | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')
  if [ -z "$AHEAD" ]; then
    AHEAD=0
  fi
  if [ -z "$BEHIND" ]; then
    BEHIND=0
  fi
fi
AHEAD_BEHIND="$AHEAD $BEHIND"

# Check for dirty changes in the working-copy commit.
DIRTY_COUNT=$($JJ diff --summary 2>/dev/null | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')
if [ -z "$DIRTY_COUNT" ]; then
  DIRTY_COUNT=0
fi

# Line deltas are optional in the UI. Keep output stable until the jj numstat path lands.
OUTGOING_STATS="0 0"
INCOMING_STATS="0 0"

# Detect the nearest bookmark behind the working-copy change; jj workspaces normally keep @
# anonymous, so checking only bookmarks at @ would show a change id for ordinary workspaces.
HEAD_BRANCH=$($JJ log --no-graph -r 'latest(::@ & bookmarks())' -T 'bookmarks.join("\\n") ++ "\\n"' -n 1 2>/dev/null | head -1)
if [ -z "$HEAD_BRANCH" ]; then
  HEAD_BRANCH=$($JJ log --no-graph -r @ -T 'change_id.shortest() ++ "\\n"' -n 1 2>/dev/null || echo "")
fi

# Output sections
echo "---HEAD_BRANCH---"
echo "$HEAD_BRANCH"
echo "---PRIMARY---"
echo "$PRIMARY_BRANCH"
echo "---AHEAD_BEHIND---"
echo "$AHEAD_BEHIND"
echo "---DIRTY---"
echo "$DIRTY_COUNT"
echo "---LINE_DELTA---"
echo "$OUTGOING_STATS $INCOMING_STATS"
`;
}

/**
 * Bash script to get jj status for a workspace (auto-detects primary bookmark).
 */
export const GIT_STATUS_SCRIPT = generateGitStatusScript();

/**
 * Parse the output from GIT_STATUS_SCRIPT.
 * Frontend-safe parsing function.
 */
export interface ParsedGitStatusOutput {
  /** The current HEAD branch (empty string if detached HEAD) */
  headBranch: string;
  primaryBranch: string;
  ahead: number;
  behind: number;
  dirtyCount: number;
  outgoingAdditions: number;
  outgoingDeletions: number;
  incomingAdditions: number;
  incomingDeletions: number;
}

export function parseGitStatusScriptOutput(output: string): ParsedGitStatusOutput | null {
  // Split by section markers using regex to get content between markers
  const headBranchRegex = /---HEAD_BRANCH---\s*([\s\S]*?)---PRIMARY---/;
  const primaryRegex = /---PRIMARY---\s*([\s\S]*?)---AHEAD_BEHIND---/;
  const aheadBehindRegex = /---AHEAD_BEHIND---\s*(\d+)\s+(\d+)/;
  const dirtyRegex = /---DIRTY---\s*(\d+)/;
  const lineDeltaRegex = /---LINE_DELTA---\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/;

  const headBranchMatch = headBranchRegex.exec(output);
  const primaryMatch = primaryRegex.exec(output);
  const aheadBehindMatch = aheadBehindRegex.exec(output);
  const dirtyMatch = dirtyRegex.exec(output);
  const lineDeltaMatch = lineDeltaRegex.exec(output);

  if (!primaryMatch || !aheadBehindMatch || !dirtyMatch) {
    return null;
  }

  const ahead = parseInt(aheadBehindMatch[1], 10);
  const behind = parseInt(aheadBehindMatch[2], 10);

  if (Number.isNaN(ahead) || Number.isNaN(behind)) {
    return null;
  }

  const outgoingAdditions = lineDeltaMatch ? parseInt(lineDeltaMatch[1], 10) : 0;
  const outgoingDeletions = lineDeltaMatch ? parseInt(lineDeltaMatch[2], 10) : 0;
  const incomingAdditions = lineDeltaMatch ? parseInt(lineDeltaMatch[3], 10) : 0;
  const incomingDeletions = lineDeltaMatch ? parseInt(lineDeltaMatch[4], 10) : 0;

  return {
    headBranch: headBranchMatch ? headBranchMatch[1].trim() : "",
    primaryBranch: primaryMatch[1].trim(),
    ahead,
    behind,
    dirtyCount: parseInt(dirtyMatch[1], 10),
    outgoingAdditions,
    outgoingDeletions,
    incomingAdditions,
    incomingDeletions,
  };
}

/**
 * Smart jj fetch script. Kept under the existing constant name until the UI store is renamed.
 */
export const GIT_FETCH_SCRIPT = `
# Disable ALL prompts
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=echo
export SSH_ASKPASS=echo
export GIT_SSH_COMMAND="\${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

jj --no-pager --color never git fetch --remote origin 2>&1 || true
`;

export function getPreferredBookmarkFromBaseRef(baseRef?: string): string {
  if (!baseRef) {
    return "";
  }

  const trimmed = baseRef.trim();
  if (trimmed.length === 0 || trimmed.startsWith("@") || trimmed === "trunk()") {
    return "";
  }

  if (trimmed.endsWith("@origin")) {
    return trimmed.slice(0, -"@origin".length);
  }

  const refsRemotesOriginPrefix = "refs/remotes/origin/";
  if (trimmed.startsWith(refsRemotesOriginPrefix)) {
    return trimmed.slice(refsRemotesOriginPrefix.length);
  }

  const originPrefix = "origin/";
  if (trimmed.startsWith(originPrefix)) {
    return trimmed.slice(originPrefix.length);
  }

  const refsHeadsPrefix = "refs/heads/";
  if (trimmed.startsWith(refsHeadsPrefix)) {
    return trimmed.slice(refsHeadsPrefix.length);
  }

  return trimmed;
}
