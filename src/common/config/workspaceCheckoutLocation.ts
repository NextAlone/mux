export const WORKSPACE_CHECKOUT_LOCATION_MODES = [
  "muxPublic",
  "projectWorktrees",
  "projectWorkspaces",
  "customPublic",
] as const;

export type WorkspaceCheckoutLocationMode = (typeof WORKSPACE_CHECKOUT_LOCATION_MODES)[number];

export interface WorkspaceCheckoutLocationConfig {
  mode: WorkspaceCheckoutLocationMode;
  customPath?: string;
}

export const DEFAULT_WORKSPACE_CHECKOUT_LOCATION: WorkspaceCheckoutLocationConfig = {
  mode: "muxPublic",
};

export function isWorkspaceCheckoutLocationMode(
  value: unknown
): value is WorkspaceCheckoutLocationMode {
  return (
    typeof value === "string" &&
    WORKSPACE_CHECKOUT_LOCATION_MODES.includes(value as WorkspaceCheckoutLocationMode)
  );
}

export function normalizeWorkspaceCheckoutLocationConfig(
  value: unknown
): WorkspaceCheckoutLocationConfig {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_WORKSPACE_CHECKOUT_LOCATION;
  }

  const record = value as Record<string, unknown>;
  const mode = isWorkspaceCheckoutLocationMode(record.mode)
    ? record.mode
    : DEFAULT_WORKSPACE_CHECKOUT_LOCATION.mode;
  const customPath =
    typeof record.customPath === "string" && record.customPath.trim().length > 0
      ? record.customPath.trim()
      : undefined;

  return customPath ? { mode, customPath } : { mode };
}

export function isDefaultWorkspaceCheckoutLocationConfig(
  value: WorkspaceCheckoutLocationConfig | undefined
): boolean {
  return value == null || value.mode === DEFAULT_WORKSPACE_CHECKOUT_LOCATION.mode;
}
