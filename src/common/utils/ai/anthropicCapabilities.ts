import { isCustomAnthropicCompatibleProviderConfig } from "@/common/utils/providers/customProviders";
import {
  resolveModelForMetadata,
  type ProviderModelEntriesConfig,
} from "@/common/utils/providers/modelEntries";
import { normalizeToCanonical } from "./models";

function parseProvider(modelString: string): string | null {
  const separatorIndex = modelString.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= modelString.length - 1) {
    return null;
  }

  return modelString.slice(0, separatorIndex);
}

export function resolveAnthropicCapabilityModel(
  modelString: string,
  providersConfig?: ProviderModelEntriesConfig | null
): string {
  return resolveModelForMetadata(normalizeToCanonical(modelString), providersConfig ?? null);
}

export function hasAnthropicClaudeCapabilities(
  modelString: string,
  providersConfig?: ProviderModelEntriesConfig | null
): boolean {
  return resolveAnthropicCapabilityModel(modelString, providersConfig).startsWith("anthropic:");
}

export function usesAnthropicMessagesWireFormat(
  modelString: string,
  providersConfig?: ProviderModelEntriesConfig | null
): boolean {
  const normalizedProvider = parseProvider(normalizeToCanonical(modelString));
  if (normalizedProvider === "anthropic") {
    return true;
  }

  const rawProvider = parseProvider(modelString);
  if (!rawProvider) {
    return false;
  }

  // Custom Anthropic-compatible means the request shape is Anthropic Messages.
  // It says nothing about whether the upstream model is Claude.
  return isCustomAnthropicCompatibleProviderConfig(providersConfig?.[rawProvider]);
}
