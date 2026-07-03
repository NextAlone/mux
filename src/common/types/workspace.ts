/**
 * Unified workspace metadata type used throughout the application.
 * This is the single source of truth for workspace information.
 *
 * ID vs Name:
 * - `id`: Stable unique identifier (10 hex chars for new workspaces, legacy format for old)
 *   Generated once at creation, never changes
 * - `name`: User-facing mutable workspace/bookmark name (e.g., "feature-branch")
 *   Can be changed via rename operation
 *
 * For legacy workspaces created before stable IDs:
 * - id and name are the same (e.g., "mux-stable-ids")
 * For new workspaces:
 * - id is a random 10 hex char string (e.g., "a1b2c3d4e5")
 * - name is the workspace/bookmark name (e.g., "feature-branch")
 *
 * Path handling:
 * - Managed checkout paths are computed on-demand via config.getWorkspacePath(projectPath, name)
 * - Directory name uses workspace.name
 * - This avoids storing redundant derived data
 */
import type { z } from "zod";
import type {
  FrontendWorkspaceMetadataSchema,
  GitStatusSchema,
  ProjectRefSchema,
  WorkspaceActivitySnapshotSchema,
  WorkspaceMetadataSchema,
} from "../orpc/schemas";

export type WorkspaceMetadata = z.infer<typeof WorkspaceMetadataSchema>;

export type ProjectRef = z.infer<typeof ProjectRefSchema>;

/**
 * Repository status for a workspace (ahead/behind relative to the remote trunk bookmark)
 */
export type GitStatus = z.infer<typeof GitStatusSchema>;

/**
 * Frontend workspace metadata enriched with computed paths.
 * Backend computes these paths to avoid duplication of path construction logic.
 * Follows naming convention: Backend types vs Frontend types.
 */
export type FrontendWorkspaceMetadata = z.infer<typeof FrontendWorkspaceMetadataSchema>;

export type WorkspaceActivitySnapshot = z.infer<typeof WorkspaceActivitySnapshotSchema>;
