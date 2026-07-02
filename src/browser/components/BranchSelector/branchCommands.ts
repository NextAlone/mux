export interface BranchSelectorJjCommand {
  command: "jj";
  args: string[];
}

export function buildCheckoutCommand(checkoutTarget: string): BranchSelectorJjCommand {
  // SECURITY: branch names are attacker-controlled repository metadata.
  // Build argv for backend execution so the branch name remains an opaque argument,
  // not interpolated shell text.
  return {
    command: "jj",
    args: ["--no-pager", "--color", "never", "new", checkoutTarget],
  };
}

export function buildRemoteBranchListCommand(
  remote: string,
  maxRemoteBranches: number
): BranchSelectorJjCommand {
  void maxRemoteBranches;
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
