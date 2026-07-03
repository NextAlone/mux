export interface BookmarkSelectorJjCommand {
  command: "jj";
  args: string[];
}

export function buildSwitchBookmarkCommand(bookmarkTarget: string): BookmarkSelectorJjCommand {
  // SECURITY: bookmark names are attacker-controlled repository metadata.
  // Build argv for backend execution so the bookmark name remains an opaque argument,
  // not interpolated shell text.
  return {
    command: "jj",
    args: ["--no-pager", "--color", "never", "new", bookmarkTarget],
  };
}

export function buildRemoteBookmarkListCommand(
  remote: string,
  maxRemoteBookmarks: number
): BookmarkSelectorJjCommand {
  void maxRemoteBookmarks;
  // SECURITY: remote names are untrusted repository metadata. Keep the remote as a single argv
  // element and let jj parse it as a remote bookmark namespace.
  return {
    command: "jj",
    args: [
      "--no-pager",
      "--color",
      "never",
      "bookmark",
      "list",
      "--remote",
      remote,
      "--sort",
      "committer-date-",
      "--template",
      'name ++ "\\n"',
    ],
  };
}
