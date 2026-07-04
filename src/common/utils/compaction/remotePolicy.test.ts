import { describe, expect, test } from "bun:test";

import {
  canReplayRemoteCompactionItemForModel,
  isOpenAIResponsesCompactionItem,
  resolveRemoteCompactionPolicy,
} from "./remotePolicy";
import { normalizeCompactionSettings } from "./strategyConfig";

describe("remote compaction policy", () => {
  test("resolves OpenAI Responses compact only for direct OpenAI models", () => {
    const settings = normalizeCompactionSettings({
      remotePolicy: "openai-responses-compact",
    });

    expect(resolveRemoteCompactionPolicy({ settings, model: "openai:gpt-5.5" })).toEqual({
      type: "openai-responses-compact",
      provider: "openai",
      contextLane: "openai-responses",
      opaque: true,
    });
    expect(
      resolveRemoteCompactionPolicy({ settings, model: "anthropic:claude-sonnet-4-5" })
    ).toEqual({
      type: "off",
    });
    expect(resolveRemoteCompactionPolicy({ settings, model: "openrouter:openai/gpt-5.5" })).toEqual(
      {
        type: "off",
      }
    );
  });

  test("treats OpenAI compaction output as opaque and replayable only to direct OpenAI", () => {
    const item = {
      type: "compaction",
      encrypted_content: "opaque-ciphertext",
    };

    expect(isOpenAIResponsesCompactionItem(item)).toBe(true);
    expect(canReplayRemoteCompactionItemForModel(item, "openai:gpt-5.5")).toBe(true);
    expect(canReplayRemoteCompactionItemForModel(item, "anthropic:claude-sonnet-4-5")).toBe(false);
    expect(canReplayRemoteCompactionItemForModel(item, "google:gemini-3-pro")).toBe(false);
  });
});
