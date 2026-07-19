export const ANALYTICS_COST_STATUSES = ["priced", "included", "unknown"] as const;
export type AnalyticsCostStatus = (typeof ANALYTICS_COST_STATUSES)[number];

export const ANALYTICS_BILLING_ROUTES = [
  "codex-oauth",
  "openai-api-key",
  "mux-gateway",
  "provider-direct",
  "unknown",
] as const;
export type AnalyticsBillingRoute = (typeof ANALYTICS_BILLING_ROUTES)[number];

export const PROVIDER_QUOTA_WINDOW_KINDS = ["five-hour", "weekly"] as const;
export type ProviderQuotaWindowKind = (typeof PROVIDER_QUOTA_WINDOW_KINDS)[number];
