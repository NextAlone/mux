import { canUseRemoteCompactionPolicy, type CompactionStrategySettings } from "./strategyConfig";

export interface OpenAIResponsesCompactionItem {
  type: "compaction";
  encrypted_content: string;
}

export type ResolvedRemoteCompactionPolicy =
  | {
      type: "off";
    }
  | {
      type: "openai-responses-compact";
      provider: "openai";
      contextLane: "openai-responses";
      opaque: true;
    };

export function resolveRemoteCompactionPolicy(params: {
  settings: CompactionStrategySettings;
  model: string;
}): ResolvedRemoteCompactionPolicy {
  if (
    !canUseRemoteCompactionPolicy({
      policy: params.settings.remotePolicy,
      model: params.model,
    })
  ) {
    return { type: "off" };
  }

  return {
    type: "openai-responses-compact",
    provider: "openai",
    contextLane: "openai-responses",
    opaque: true,
  };
}

export function isOpenAIResponsesCompactionItem(
  value: unknown
): value is OpenAIResponsesCompactionItem {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.type === "compaction" && typeof record.encrypted_content === "string";
}

export function canReplayRemoteCompactionItemForModel(item: unknown, model: string): boolean {
  return isOpenAIResponsesCompactionItem(item) && model.trim().startsWith("openai:");
}
