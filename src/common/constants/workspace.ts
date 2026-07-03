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
