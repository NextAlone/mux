import type {
  CompactedResponse,
  ResponseCompactParams,
  ResponseInputItem,
  ResponseOutputItem,
} from "openai/resources/responses/responses";

import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import {
  isOpenAIResponsesCompactionItem,
  type OpenAIResponsesCompactionItem,
} from "@/common/utils/compaction/remotePolicy";

interface OpenAIResponsesCompactClient {
  responses: {
    compact: (params: ResponseCompactParams) => Promise<CompactedResponse>;
  };
}

export interface ExecuteOpenAIResponsesCompactOptions {
  client: OpenAIResponsesCompactClient;
  model: string;
  input?: string | ResponseInputItem[] | null;
  instructions?: string | null;
}

export interface OpenAIResponsesCompactResult {
  responseId: string;
  compactionItem: OpenAIResponsesCompactionItem;
  output: ResponseInputItem[];
  usage: CompactedResponse["usage"];
}

function parseDirectOpenAIModelName(model: string): string | null {
  const trimmed = model.trim();
  const prefix = "openai:";
  if (!trimmed.startsWith(prefix)) {
    return null;
  }

  const modelName = trimmed.slice(prefix.length).trim();
  return modelName.length > 0 ? modelName : null;
}

export async function executeOpenAIResponsesCompact(
  options: ExecuteOpenAIResponsesCompactOptions
): Promise<Result<OpenAIResponsesCompactResult, string>> {
  const model = parseDirectOpenAIModelName(options.model);
  if (!model) {
    return Err("OpenAI Responses compact requires a direct openai:* model");
  }

  const response = await options.client.responses.compact({
    model,
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
  });
  let compactionItem: OpenAIResponsesCompactionItem | undefined;
  for (const item of response.output) {
    if (isOpenAIResponsesCompactionItem(item)) {
      compactionItem = item;
      break;
    }
  }

  if (!compactionItem) {
    return Err("OpenAI Responses compact did not return a compaction item");
  }

  // The compact endpoint returns the canonical next context window. The OpenAI
  // SDK types it as output items, while the next /responses call accepts those
  // same item shapes as input. Keep the full opaque output unchanged.
  const output = response.output as Array<ResponseOutputItem & ResponseInputItem>;

  return Ok({
    responseId: response.id,
    compactionItem,
    output,
    usage: response.usage,
  });
}
