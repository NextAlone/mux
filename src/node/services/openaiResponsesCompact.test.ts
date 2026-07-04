import { describe, expect, mock, test } from "bun:test";
import type {
  CompactedResponse,
  ResponseCompactParams,
} from "openai/resources/responses/responses";

import { executeOpenAIResponsesCompact } from "./openaiResponsesCompact";

const usage: CompactedResponse["usage"] = {
  input_tokens: 10,
  input_tokens_details: { cached_tokens: 2 },
  output_tokens: 3,
  output_tokens_details: { reasoning_tokens: 1 },
  total_tokens: 13,
};

describe("executeOpenAIResponsesCompact", () => {
  test("calls OpenAI Responses compact and returns the opaque compaction item", async () => {
    const compact = mock(async (_params: ResponseCompactParams): Promise<CompactedResponse> => {
      return {
        id: "resp_compact_1",
        created_at: 123,
        object: "response.compaction",
        output: [
          {
            id: "ci_1",
            type: "compaction",
            encrypted_content: "opaque-ciphertext",
            created_by: "system",
          },
        ],
        usage,
      };
    });

    const result = await executeOpenAIResponsesCompact({
      client: { responses: { compact } },
      model: "openai:gpt-5.5",
      input: [{ role: "user", content: "hello" }],
      instructions: "compact this conversation",
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(result.error);
    }
    expect(compact).toHaveBeenCalledWith({
      model: "gpt-5.5",
      input: [{ role: "user", content: "hello" }],
      instructions: "compact this conversation",
    });
    expect(result.data.compactionItem).toMatchObject({
      id: "ci_1",
      type: "compaction",
      encrypted_content: "opaque-ciphertext",
    });
    expect(result.data.responseId).toBe("resp_compact_1");
    expect(result.data.usage).toBe(usage);
  });

  test("rejects non-direct OpenAI models and responses without compaction items", async () => {
    const compact = mock(async (_params: ResponseCompactParams): Promise<CompactedResponse> => {
      return {
        id: "resp_compact_2",
        created_at: 123,
        object: "response.compaction",
        output: [],
        usage,
      };
    });

    const wrongProvider = await executeOpenAIResponsesCompact({
      client: { responses: { compact } },
      model: "anthropic:claude-sonnet-4-5",
      input: "hello",
    });
    expect(wrongProvider).toEqual({
      success: false,
      error: "OpenAI Responses compact requires a direct openai:* model",
    });
    expect(compact).not.toHaveBeenCalled();

    const missingItem = await executeOpenAIResponsesCompact({
      client: { responses: { compact } },
      model: "openai:gpt-5.5",
      input: "hello",
    });
    expect(missingItem).toEqual({
      success: false,
      error: "OpenAI Responses compact did not return a compaction item",
    });
  });
});
