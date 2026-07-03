#!/usr/bin/env bash
# Shared bookmark-sync guard for wait_pr_*.sh scripts.
# Resolves the current jj bookmark, fetches its remote counterpart,
# and optionally bootstraps a first push when no remote bookmark exists.
#
# Usage: source this file, then call assert_branch_synced.
# Returns 0 if local @- matches remote; non-zero otherwise.
# Callers can read CURRENT_BOOKMARK and REMOTE_BOOKMARK after it runs.

set -euo pipefail

JJ=${JJ:-jj}
REMOTE_NAME=${REMOTE_NAME:-origin}
export JJ_CONFIG_TOML=${JJ_CONFIG_TOML:-$'ui.paginate="never"\nui.color="never"'}

assert_jj_clean_working_copy() {
  local diff_summary

  if ! diff_summary=$("$JJ" diff --summary 2>&1); then
    echo "❌ Error: Failed to inspect jj working copy." >&2
    echo "$diff_summary" >&2
    return 1
  fi

  if [[ -n "$diff_summary" ]]; then
    echo "❌ Error: You have uncommitted working-copy changes." >&2
    echo "" >&2
    echo "$diff_summary" >&2
    echo "" >&2
    echo "Run 'jj commit -m <message>' or move the changes to another jj revision before checking PR status." >&2
    return 1
  fi
}

# Resolve which remote bookmark to compare @- against.
# Sets two variables in the caller's scope:
#   CURRENT_BOOKMARK  — local bookmark pointing at @-
#   REMOTE_BOOKMARK   — remote bookmark to compare against (e.g. feature@origin)
resolve_branch_sync_target() {
  CURRENT_BOOKMARK=$("$JJ" bookmark list -r @- -T 'name ++ "\n"' | head -n 1)

  if [[ -z "$CURRENT_BOOKMARK" ]]; then
    echo "❌ Error: No local jj bookmark points at @-." >&2
    echo "Run 'jj tug' or 'jj bookmark create <name> -r @-' before checking PR status." >&2
    return 1
  fi

  REMOTE_BOOKMARK="${CURRENT_BOOKMARK}@${REMOTE_NAME}"
}

# Fetch the resolved remote bookmark. If it does not exist, bootstrap with jj git push.
fetch_or_bootstrap() {
  if "$JJ" git fetch --remote "$REMOTE_NAME" >/dev/null 2>&1 \
    && "$JJ" log -r "$REMOTE_BOOKMARK" --no-graph -T 'commit_id' >/dev/null 2>&1; then
    return 0
  fi

  echo "⚠️  Bookmark '$CURRENT_BOOKMARK' does not exist on $REMOTE_NAME." >&2
  echo "Pushing to ${REMOTE_BOOKMARK}..." >&2

  if "$JJ" git push --remote "$REMOTE_NAME" -b "$CURRENT_BOOKMARK" 2>&1; then
    echo "✅ Pushed bookmark successfully!" >&2
    REMOTE_BOOKMARK="${CURRENT_BOOKMARK}@${REMOTE_NAME}"
  else
    echo "❌ Error: Failed to push bookmark." >&2
    echo "You may need to push manually: jj git push --remote $REMOTE_NAME -b $CURRENT_BOOKMARK" >&2
    return 1
  fi
}

# Full sync assertion: resolve target, fetch, compare hashes.
# Returns 0 if in sync, 1 otherwise (with diagnostic messages).
assert_branch_synced() {
  local local_hash
  local remote_hash

  resolve_branch_sync_target
  fetch_or_bootstrap || return 1

  local_hash=$("$JJ" log -r @- --no-graph -T 'commit_id')
  remote_hash=$("$JJ" log -r "$REMOTE_BOOKMARK" --no-graph -T 'commit_id')

  if [[ "$local_hash" != "$remote_hash" ]]; then
    echo "❌ Error: Local bookmark is not in sync with remote." >&2
    echo "" >&2
    echo "Local:  $local_hash" >&2
    echo "Remote: $remote_hash" >&2
    echo "" >&2
    echo "Run 'jj git fetch --remote $REMOTE_NAME', reconcile with 'jj retrunk' or 'jj rebase -b @ -d $REMOTE_BOOKMARK', then 'jj tug' and 'jj git push --remote $REMOTE_NAME -b $CURRENT_BOOKMARK'." >&2

    return 1
  fi
}
