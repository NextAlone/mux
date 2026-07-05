import { canUseRemoteCompactionPolicy, type CompactionStrategySettings } from "./strategyConfig";

export interface OpenAIResponsesCompactionItem {
  type: "compaction" | "compaction_summary";
  encrypted_content: string;
  id?: string | null;
  created_by?: string;
}

export type OpenAIResponsesCompactionOutput = Array<Record<string, unknown>>;
export type OpenAIResponsesCompactionRoute = "openai-api-key" | "codex-oauth";

export interface OpenAIResponsesRemoteCompactionState {
  type: "openai-responses-compact";
  responseId: string;
  route?: OpenAIResponsesCompactionRoute;
  output: OpenAIResponsesCompactionOutput;
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
  return (
    (record.type === "compaction" || record.type === "compaction_summary") &&
    typeof record.encrypted_content === "string"
  );
}

export function isOpenAIResponsesCompactionOutput(
  value: unknown
): value is OpenAIResponsesCompactionOutput {
  return Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null);
}

export function isOpenAIResponsesRemoteCompactionState(
  value: unknown
): value is OpenAIResponsesRemoteCompactionState {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const route = record.route;
  return (
    record.type === "openai-responses-compact" &&
    typeof record.responseId === "string" &&
    record.responseId.trim().length > 0 &&
    (route === undefined || route === "openai-api-key" || route === "codex-oauth") &&
    isOpenAIResponsesCompactionOutput(record.output) &&
    record.output.some(isOpenAIResponsesCompactionItem)
  );
}

export function canReplayRemoteCompactionItemForModel(item: unknown, model: string): boolean {
  return isOpenAIResponsesCompactionItem(item) && model.trim().startsWith("openai:");
}
