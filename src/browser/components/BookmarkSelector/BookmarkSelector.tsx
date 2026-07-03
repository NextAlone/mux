import React, { useState, useCallback, useEffect, useRef } from "react";
import { Bookmark, Loader2, Check, Copy, Globe, ChevronRight } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { useAPI } from "@/browser/contexts/API";
import { Popover, PopoverContent, PopoverTrigger } from "../Popover/Popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { clearGitStatus, invalidateGitStatus, useGitStatus } from "@/browser/stores/GitStatusStore";
import { createLRUCache } from "@/browser/utils/lruCache";
import { buildSwitchBookmarkCommand, buildRemoteBookmarkListCommand } from "./bookmarkCommands";
import { repoRootBashOptions } from "@/browser/utils/executeBash";

// LRU cache for persisting bookmark names across app restarts.
const bookmarkCache = createLRUCache<string>({
  entryPrefix: "bookmark:",
  indexKey: "bookmarkIndex",
  maxEntries: 100,
  // No TTL - cached bookmark info seeds the selector until passive repository status refreshes.
});

interface BookmarkSelectorProps {
  workspaceId: string;
  /** Fallback name to display if not in a jj repo (workspace name). */
  workspaceName: string;
  className?: string;
}

// Max bookmarks to fetch.
const MAX_LOCAL_BOOKMARKS = 100;
const MAX_REMOTE_BOOKMARKS = 50;

interface RemoteState {
  bookmarks: string[];
  isLoading: boolean;
  fetched: boolean;
  truncated: boolean;
}

/**
 * Displays the current jj bookmark with a searchable popover for switching.
 * If not in a jj repo, shows the workspace name without interactive features.
 * Remotes appear as expandable groups that lazy-load their bookmarks.
 */
export function BookmarkSelector({ workspaceId, workspaceName, className }: BookmarkSelectorProps) {
  const { api } = useAPI();
  // null = bookmark is not known yet (for example a stopped runtime with no passive git data),
  // false = explicitly confirmed not a jj repo, string = current bookmark.
  // Initialize from localStorage cache for instant display on app restart.
  const [currentBookmark, setCurrentBookmark] = useState<string | null | false>(() =>
    bookmarkCache.get(workspaceId)
  );
  const [localBookmarks, setLocalBookmarks] = useState<string[]>([]);
  const [localBookmarksTruncated, setLocalBookmarksTruncated] = useState(false);
  const [remotes, setRemotes] = useState<string[]>([]);
  const [remoteStates, setRemoteStates] = useState<Record<string, RemoteState>>({});
  const [expandedRemotes, setExpandedRemotes] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copied, copyToClipboard } = useCopyToClipboard();

  // Subscribe to GitStatusStore for bookmark changes detected during periodic refresh
  // (e.g., focus events, file-modifying tools). This keeps the selector in sync
  // when the user or mux changes the bookmark outside of this UI.
  const gitStatus = useGitStatus(workspaceId);
  const gitStatusBookmark = gitStatus?.branch;
  useEffect(() => {
    if (!gitStatusBookmark) return;
    setCurrentBookmark((prev) => {
      if (prev === gitStatusBookmark) return prev;
      bookmarkCache.set(workspaceId, gitStatusBookmark);
      return gitStatusBookmark;
    });
  }, [gitStatusBookmark, workspaceId]);

  // Track if we're refreshing with a cached value (for optimistic UI pulse effect)
  const isRefreshing = currentBookmark !== null && currentBookmark !== false && isSwitching;

  const fetchLocalBookmarks = useCallback(async () => {
    if (!api || currentBookmark === false) return;

    setIsLoading(true);

    try {
      // Explicit opens are allowed to wake the runtime, so determine whether the
      // workspace is a jj repo first and only then load bookmark/remotes data.
      const repoProbeResult = await api.workspace.executeBash({
        workspaceId,
        // Keep stderr intact here so explicit opens can distinguish a definitive
        // "not a jj repository" result from transient runtime/IPC failures.
        script: `jj --no-pager --color never root >/dev/null && echo true`,
        options: repoRootBashOptions(5),
      });
      const repoProbeOutput =
        repoProbeResult.success && repoProbeResult.data.success
          ? (repoProbeResult.data.output?.trim() ?? "")
          : "";
      let repoProbeError = "";
      if (!repoProbeResult.success) {
        repoProbeError = repoProbeResult.error ?? "";
      } else if (!repoProbeResult.data.success) {
        repoProbeError = `${repoProbeResult.data.error ?? ""}\n${repoProbeResult.data.output ?? ""}`;
      }
      const repoState =
        repoProbeOutput === "true"
          ? "jj"
          : /not a jj repository|no jj repo/i.test(repoProbeError)
            ? "non-jj"
            : "unknown";
      if (repoState === "non-jj") {
        bookmarkCache.remove(workspaceId);
        clearGitStatus(workspaceId);
        setCurrentBookmark(false);
        setLocalBookmarks([]);
        setLocalBookmarksTruncated(false);
        setRemotes([]);
        return;
      }
      if (repoState !== "jj") {
        return;
      }

      // Once we know the repo exists, resolve the active bookmark with an untruncated
      // command and keep the bookmark list separately capped for the popover.
      const [currentBookmarkResult, bookmarkResult, remoteResult] = await Promise.all([
        api.workspace.executeBash({
          workspaceId,
          script: `jj --no-pager --color never log --no-graph -r 'latest(::@ & bookmarks())' -T 'bookmarks.join("\\n") ++ "\\n"' -n 1 2>/dev/null | head -1`,
          options: repoRootBashOptions(5),
        }),
        api.workspace.executeBash({
          workspaceId,
          script: `jj --no-pager --color never bookmark list --sort committer-date- -T 'name ++ "\\n"' 2>/dev/null | head -${MAX_LOCAL_BOOKMARKS + 1}`,
          options: repoRootBashOptions(5),
        }),
        api.workspace.executeBash({
          workspaceId,
          script: `jj --no-pager --color never git remote list 2>/dev/null | awk '{ print $1 }'`,
          options: repoRootBashOptions(5),
        }),
      ]);

      const currentBookmarkCommandSucceeded =
        currentBookmarkResult.success && currentBookmarkResult.data.success;
      const bookmarkCommandSucceeded = bookmarkResult.success && bookmarkResult.data.success;
      const remoteCommandSucceeded = remoteResult.success && remoteResult.data.success;
      const fetchedCurrentBookmark =
        currentBookmarkCommandSucceeded && currentBookmarkResult.data.output
          ? currentBookmarkResult.data.output.trim() || null
          : null;
      const bookmarkList =
        bookmarkCommandSucceeded && bookmarkResult.data.output
          ? bookmarkResult.data.output
              .split("\n")
              .map((bookmarkLine) => bookmarkLine.trim())
              .filter((bookmarkLine) => bookmarkLine.length > 0)
          : [];
      const displayBookmarkList =
        fetchedCurrentBookmark && !bookmarkList.includes(fetchedCurrentBookmark)
          ? [fetchedCurrentBookmark, ...bookmarkList]
          : bookmarkList;
      if (displayBookmarkList.length > 0) {
        const truncated = displayBookmarkList.length > MAX_LOCAL_BOOKMARKS;
        setLocalBookmarks(
          truncated ? displayBookmarkList.slice(0, MAX_LOCAL_BOOKMARKS) : displayBookmarkList
        );
        setLocalBookmarksTruncated(truncated);
      }
      if (fetchedCurrentBookmark) {
        setCurrentBookmark((prev) => {
          if (prev === fetchedCurrentBookmark) return prev;
          bookmarkCache.set(workspaceId, fetchedCurrentBookmark);
          return fetchedCurrentBookmark;
        });
      }

      const remoteList =
        remoteCommandSucceeded && remoteResult.data.output
          ? remoteResult.data.output
              .split("\n")
              .map((remote) => remote.trim())
              .filter((remote) => remote.length > 0)
          : [];
      setRemotes(remoteList);

      if (
        currentBookmarkCommandSucceeded &&
        bookmarkCommandSucceeded &&
        remoteCommandSucceeded &&
        !fetchedCurrentBookmark &&
        bookmarkList.length === 0 &&
        remoteList.length === 0
      ) {
        setCurrentBookmark(false);
      }
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [api, workspaceId, currentBookmark]);

  const fetchRemoteBookmarks = useCallback(
    async (remote: string) => {
      if (!api || remoteStates[remote]?.fetched) return;

      setRemoteStates((prev) => ({
        ...prev,
        [remote]: { bookmarks: [], isLoading: true, fetched: false, truncated: false },
      }));

      try {
        // Fetch one extra to detect truncation
        const { command, args } = buildRemoteBookmarkListCommand(remote, MAX_REMOTE_BOOKMARKS);
        const result = await api.workspace.executeBash({
          workspaceId,
          script: "",
          command,
          args,
          options: { timeout_secs: 5 },
        });

        if (result.success && result.data.success && result.data.output) {
          // jj prints remote bookmark names without the remote suffix. Keep the remote in the
          // revision we pass back to `jj new`, otherwise slash-containing bookmark names would be
          // truncated by the legacy bookmark stripping logic.
          const bookmarks = result.data.output
            .split("\n")
            .map((b) => b.trim())
            .filter((b) => b.length > 0)
            .map((b) => `${b}@${remote}`);
          const truncated = bookmarks.length > MAX_REMOTE_BOOKMARKS;
          setRemoteStates((prev) => ({
            ...prev,
            [remote]: {
              bookmarks: truncated ? bookmarks.slice(0, MAX_REMOTE_BOOKMARKS) : bookmarks,
              isLoading: false,
              fetched: true,
              truncated,
            },
          }));
        } else {
          setRemoteStates((prev) => ({
            ...prev,
            [remote]: { bookmarks: [], isLoading: false, fetched: true, truncated: false },
          }));
        }
      } catch {
        setRemoteStates((prev) => ({
          ...prev,
          [remote]: { bookmarks: [], isLoading: false, fetched: true, truncated: false },
        }));
      }
    },
    [api, workspaceId, remoteStates]
  );

  const switchBookmark = useCallback(
    async (targetBookmark: string, isRemote = false) => {
      if (!api) return;

      const switchTarget = targetBookmark;
      const displayBookmark = isRemote ? targetBookmark.replace(/@[^@]+$/, "") : targetBookmark;

      if (displayBookmark === currentBookmark) {
        setIsOpen(false);
        return;
      }

      setIsSwitching(true);
      setError(null);
      setIsOpen(false);
      // Invalidate repository status immediately to prevent stale data flash.
      invalidateGitStatus(workspaceId);

      try {
        const { command, args } = buildSwitchBookmarkCommand(switchTarget);
        const result = await api.workspace.executeBash({
          workspaceId,
          script: "",
          command,
          args,
          options: { timeout_secs: 30 },
        });

        if (!result.success) {
          setError(result.error ?? "Switch failed");
          // Re-fetch status since switching failed (restore accurate state)
          invalidateGitStatus(workspaceId);
        } else if (!result.data.success) {
          const errorMsg = result.data.output?.trim() ?? result.data.error ?? "Switch failed";
          setError(errorMsg);
          // Re-fetch status since switching failed.
          invalidateGitStatus(workspaceId);
        } else {
          // Update current bookmark after jj creates the new working-copy commit.
          setCurrentBookmark(displayBookmark);
          // Persist to localStorage for instant display on app restart
          bookmarkCache.set(workspaceId, displayBookmark);
          // Refresh repository status with the new bookmark state.
          invalidateGitStatus(workspaceId);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Switch failed");
      } finally {
        setIsSwitching(false);
      }
    },
    [api, workspaceId, currentBookmark]
  );

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  useEffect(() => {
    if (isOpen) {
      void fetchLocalBookmarks();
    }
  }, [isOpen, fetchLocalBookmarks]);

  useEffect(() => {
    if (!isOpen) {
      setRemoteStates({});
      setExpandedRemotes(new Set());
      setSearch("");
    }
  }, [isOpen]);

  const inputRef = useRef<HTMLInputElement>(null);

  // Focus search input when popover opens
  useEffect(() => {
    if (isOpen) {
      // Small delay to ensure popover is rendered
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (typeof currentBookmark === "string") {
      void copyToClipboard(currentBookmark);
    }
  };

  // Display name: active jj bookmark if available, otherwise workspace name.
  const displayName = typeof currentBookmark === "string" ? currentBookmark : workspaceName;

  const toggleRemote = (remote: string) => {
    setExpandedRemotes((prev) => {
      const next = new Set(prev);
      if (next.has(remote)) {
        next.delete(remote);
      } else {
        next.add(remote);
        // Fetch bookmarks when expanding.
        void fetchRemoteBookmarks(remote);
      }
      return next;
    });
  };

  // Filter bookmarks by search.
  const searchLower = search.toLowerCase();
  const filteredLocalBookmarks = localBookmarks.filter((b) =>
    b.toLowerCase().includes(searchLower)
  );

  // For remotes, filter bookmarks within each remote.
  const getFilteredRemoteBookmarks = (remote: string) => {
    const state = remoteStates[remote];
    if (!state?.bookmarks) return [];
    return state.bookmarks.filter((b) => b.toLowerCase().includes(searchLower));
  };

  // Check if any remote has matching bookmarks (for showing remotes section).
  const hasMatchingRemoteBookmarks = remotes.some((remote) => {
    const state = remoteStates[remote];
    if (!state?.fetched) return true; // Show unfetched remotes
    return getFilteredRemoteBookmarks(remote).length > 0;
  });

  // Non-jj repo: just show workspace name, no interactive features.
  if (currentBookmark === false) {
    return (
      <div className={cn("group flex items-center gap-0.5", className)}>
        <div className="text-muted-light flex max-w-[180px] min-w-0 items-center gap-1 px-1 py-0.5 font-mono text-[11px]">
          <span className="truncate">{workspaceName}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("group flex items-center gap-0.5", className)}>
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <button
            disabled={isSwitching}
            className={cn(
              "text-muted-light hover:bg-hover hover:text-foreground flex min-w-0 max-w-[180px] items-center gap-1 rounded-sm px-1 py-0.5 font-mono text-[11px] transition-colors",
              isRefreshing && "animate-pulse" // Show pulse during switch instead of replacing content
            )}
          >
            <Bookmark className="h-3 w-3 shrink-0 opacity-70" />
            <span className="truncate">{displayName}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[220px] p-0">
          {/* Search input */}
          <div className="border-border border-b px-2 py-1.5">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search bookmarks..."
              className="text-foreground placeholder:text-muted w-full bg-transparent font-mono text-[11px] outline-none"
            />
          </div>

          <div className="max-h-[280px] overflow-y-auto p-1">
            {/* Remotes as expandable groups */}
            {remotes.length > 0 && hasMatchingRemoteBookmarks && (
              <>
                {remotes.map((remote) => {
                  const state = remoteStates[remote];
                  const isExpanded = expandedRemotes.has(remote);
                  const isRemoteLoading = state?.isLoading ?? false;
                  const remoteBookmarks = getFilteredRemoteBookmarks(remote);

                  // Hide remote if fetched and no matching bookmarks.
                  if (state?.fetched && remoteBookmarks.length === 0 && search) {
                    return null;
                  }

                  return (
                    <div key={remote}>
                      <button
                        onClick={() => toggleRemote(remote)}
                        className="hover:bg-hover flex w-full items-center gap-1.5 rounded-sm px-2 py-1 font-mono text-[11px]"
                      >
                        <ChevronRight
                          className={cn(
                            "text-muted h-3 w-3 shrink-0 transition-transform",
                            isExpanded && "rotate-90"
                          )}
                        />
                        <Globe className="text-muted h-3 w-3 shrink-0" />
                        <span>{remote}</span>
                      </button>

                      {isExpanded && (
                        <div className="ml-3">
                          {isRemoteLoading ? (
                            <div className="text-muted flex items-center justify-center py-2">
                              <Loader2 className="h-3 w-3 animate-spin" />
                            </div>
                          ) : remoteBookmarks.length === 0 ? (
                            <div className="text-muted py-1.5 pl-2 text-[10px]">No bookmarks</div>
                          ) : (
                            <>
                              {remoteBookmarks.map((bookmark) => {
                                const displayName = bookmark.replace(/@[^@]+$/, "");
                                return (
                                  <button
                                    key={bookmark}
                                    onClick={() => void switchBookmark(bookmark, true)}
                                    className="hover:bg-hover flex w-full items-center gap-1.5 rounded-sm px-2 py-1 font-mono text-[11px]"
                                  >
                                    <Check
                                      className={cn(
                                        "h-3 w-3 shrink-0",
                                        displayName === currentBookmark
                                          ? "opacity-100"
                                          : "opacity-0"
                                      )}
                                    />
                                    <span className="truncate">{displayName}</span>
                                  </button>
                                );
                              })}
                              {state?.truncated && !search && (
                                <div className="text-muted px-2 py-1 text-[10px] italic">
                                  +more bookmarks (use search)
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {filteredLocalBookmarks.length > 0 && <div className="bg-border my-1 h-px" />}
              </>
            )}

            {/* Local bookmarks */}
            {isLoading && localBookmarks.length <= 1 ? (
              <div className="text-muted flex items-center justify-center py-2">
                <Loader2 className="h-3 w-3 animate-spin" />
              </div>
            ) : filteredLocalBookmarks.length === 0 ? (
              <div className="text-muted py-2 text-center text-[10px]">No matching bookmarks</div>
            ) : (
              <>
                {filteredLocalBookmarks.map((bookmark) => (
                  <button
                    key={bookmark}
                    onClick={() => void switchBookmark(bookmark)}
                    className="hover:bg-hover flex w-full items-center gap-1.5 rounded-sm px-2 py-1 font-mono text-[11px]"
                  >
                    <Check
                      className={cn(
                        "h-3 w-3 shrink-0",
                        bookmark === currentBookmark ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="truncate">{bookmark}</span>
                  </button>
                ))}
                {localBookmarksTruncated && !search && (
                  <div className="text-muted px-2 py-1 text-[10px] italic">
                    +more bookmarks (use search)
                  </div>
                )}
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* Copy button - only show on hover once the real bookmark name is known. */}
      {typeof currentBookmark === "string" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleCopy}
              className="text-muted hover:text-foreground flex h-3.5 w-3.5 shrink-0 items-center justify-center opacity-0 transition-opacity group-hover:opacity-100"
              aria-label="Copy bookmark name"
            >
              {copied ? <Check className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{copied ? "Copied!" : "Copy bookmark name"}</TooltipContent>
        </Tooltip>
      )}

      {error && <span className="text-danger-soft truncate text-[10px]">{error}</span>}
    </div>
  );
}
