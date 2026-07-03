import type { ServiceTier } from "@/common/config/schemas/providersConfig";

export const OPENAI_SERVICE_TIER_UNSET = "unset";
export const OPENAI_FAST_SERVICE_TIER = "priority" satisfies ServiceTier;

export type OpenAIServiceTier = ServiceTier;
export type OpenAIServiceTierSelectValue = typeof OPENAI_SERVICE_TIER_UNSET | OpenAIServiceTier;
export type OpenAIServiceTierMode = "api" | "codexOauth";

const OPENAI_API_SERVICE_TIER_OPTIONS = [
  { value: OPENAI_SERVICE_TIER_UNSET, label: "Auto" },
  { value: OPENAI_FAST_SERVICE_TIER, label: "Fast" },
  { value: "flex", label: "Slow" },
] satisfies Array<{ value: OpenAIServiceTierSelectValue; label: string }>;

const CODEX_OAUTH_SERVICE_TIER_OPTIONS = [
  { value: OPENAI_SERVICE_TIER_UNSET, label: "Normal" },
  { value: OPENAI_FAST_SERVICE_TIER, label: "Fast" },
] satisfies Array<{ value: OpenAIServiceTierSelectValue; label: string }>;

export function getOpenAIServiceTierMode(
  codexOauthIsConnected: boolean,
  codexOauthDefaultAuth: "oauth" | "apiKey"
): OpenAIServiceTierMode {
  return codexOauthIsConnected && codexOauthDefaultAuth === "oauth" ? "codexOauth" : "api";
}

export function getOpenAIServiceTierOptions(mode: OpenAIServiceTierMode) {
  return mode === "codexOauth" ? CODEX_OAUTH_SERVICE_TIER_OPTIONS : OPENAI_API_SERVICE_TIER_OPTIONS;
}

export function getOpenAIServiceTierSelectValue(
  value: OpenAIServiceTier | undefined,
  mode: OpenAIServiceTierMode
): OpenAIServiceTierSelectValue {
  if (mode === "codexOauth") {
    return isOpenAIFastServiceTier(value) ? OPENAI_FAST_SERVICE_TIER : OPENAI_SERVICE_TIER_UNSET;
  }

  return value === OPENAI_FAST_SERVICE_TIER || value === "flex" ? value : OPENAI_SERVICE_TIER_UNSET;
}

export function isOpenAIServiceTierSelectable(
  value: string,
  mode: OpenAIServiceTierMode
): value is OpenAIServiceTier {
  return mode === "codexOauth"
    ? value === OPENAI_FAST_SERVICE_TIER
    : value === OPENAI_FAST_SERVICE_TIER || value === "flex";
}

export function getOpenAIFastServiceTier(): OpenAIServiceTier {
  return OPENAI_FAST_SERVICE_TIER;
}

export function isOpenAIFastServiceTier(
  value: OpenAIServiceTier | undefined
): value is OpenAIServiceTier {
  // Older builds wrote `fast`; pi-codex-fast shows the effective Codex wire tier
  // is `priority`, so keep reading legacy configs while writing the current value.
  return value === OPENAI_FAST_SERVICE_TIER || value === "fast";
}

export function shouldShowOpenAIFastModeToggle(modelString: string): boolean {
  return modelString.startsWith("openai:") || modelString.startsWith("mux-gateway:openai/");
}
