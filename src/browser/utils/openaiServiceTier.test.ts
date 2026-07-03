import { describe, expect, test } from "bun:test";

import {
  getOpenAIFastServiceTier,
  getOpenAIServiceTierOptions,
  getOpenAIServiceTierSelectValue,
  isOpenAIFastServiceTier,
  OPENAI_SERVICE_TIER_UNSET,
  shouldShowOpenAIFastModeToggle,
} from "./openaiServiceTier";

describe("openaiServiceTier", () => {
  test("uses priority for the fast toggle", () => {
    expect(getOpenAIFastServiceTier()).toBe("priority");
    expect(isOpenAIFastServiceTier("priority")).toBe(true);
    expect(isOpenAIFastServiceTier("fast")).toBe(true);
    expect(isOpenAIFastServiceTier("flex")).toBe(false);
  });

  test("shows Codex OAuth as normal or fast while writing priority", () => {
    expect(getOpenAIServiceTierOptions("codexOauth")).toEqual([
      { value: OPENAI_SERVICE_TIER_UNSET, label: "Normal" },
      { value: "priority", label: "Fast" },
    ]);
    expect(getOpenAIServiceTierSelectValue("priority", "codexOauth")).toBe("priority");
    expect(getOpenAIServiceTierSelectValue("fast", "codexOauth")).toBe("priority");
    expect(getOpenAIServiceTierSelectValue("flex", "codexOauth")).toBe(OPENAI_SERVICE_TIER_UNSET);
  });

  test("keeps OpenAI API tier options separate", () => {
    expect(getOpenAIServiceTierOptions("api")).toEqual([
      { value: OPENAI_SERVICE_TIER_UNSET, label: "Auto" },
      { value: "priority", label: "Fast" },
      { value: "flex", label: "Slow" },
    ]);
    expect(getOpenAIServiceTierSelectValue("fast", "api")).toBe(OPENAI_SERVICE_TIER_UNSET);
  });

  test("only shows the composer fast toggle for OpenAI models", () => {
    expect(shouldShowOpenAIFastModeToggle("openai:gpt-5.5")).toBe(true);
    expect(shouldShowOpenAIFastModeToggle("mux-gateway:openai/gpt-5.5")).toBe(true);
    expect(shouldShowOpenAIFastModeToggle("anthropic:claude-sonnet-4-5")).toBe(false);
  });
});
