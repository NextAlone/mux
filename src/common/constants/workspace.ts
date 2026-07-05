import type { RuntimeConfig } from "@/common/types/runtime";

/**
 * Default runtime configuration for JJ Workspace checkouts.
 * Uses jj workspaces for workspace isolation.
 * Used when no runtime config is specified.
 */
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  type: "worktree",
  srcBaseDir: "~/.mux/src",
} as const;

/**
 * Source revision for creating a jj workspace from the parent of the current checkout.
 * Exposed in creation UI so users can base new work on the last committed change without a bookmark.
 */
export const PARENT_SOURCE_REVISION = "@-" as const;
