import { describe, expect, test } from "bun:test";

import {
  canUseRemoteCompactionPolicy,
  normalizeCompactionSettings,
  resolveLocalCompactionStrategyChain,
} from "./strategyConfig";

describe("compaction strategy config", () => {
  test("defaults to the current local strategy and disables remote compaction", () => {
    expect(normalizeCompactionSettings(undefined)).toEqual({
      localStrategy: "mux-current",
      fallbackLocalStrategies: [],
      remotePolicy: "off",
      piLocal: {
        keepRecentTokens: 16_000,
        toolResultMaxChars: 4_000,
      },
      hybridLocal: {
        keepRecentTokens: 16_000,
        toolResultMaxChars: 4_000,
      },
    });
    expect(resolveLocalCompactionStrategyChain(undefined)).toEqual(["mux-current"]);
  });

  test("sanitizes fallback strategies and keeps mux-current as the final local fallback", () => {
    const settings = normalizeCompactionSettings({
      localStrategy: "hybrid-local",
      fallbackLocalStrategies: ["hybrid-local", "pi-local", "unknown", "pi-local", "mux-current"],
      remotePolicy: "openai-responses-compact",
    });

    expect(settings).toEqual({
      localStrategy: "hybrid-local",
      fallbackLocalStrategies: ["pi-local", "mux-current"],
      remotePolicy: "openai-responses-compact",
      piLocal: {
        keepRecentTokens: 16_000,
        toolResultMaxChars: 4_000,
      },
      hybridLocal: {
        keepRecentTokens: 16_000,
        toolResultMaxChars: 4_000,
      },
    });
    expect(resolveLocalCompactionStrategyChain(settings)).toEqual([
      "hybrid-local",
      "pi-local",
      "mux-current",
    ]);
  });

  test("only allows OpenAI Responses remote compaction on direct OpenAI model strings", () => {
    expect(
      canUseRemoteCompactionPolicy({
        policy: "openai-responses-compact",
        model: "openai:gpt-5.5",
      })
    ).toBe(true);

    expect(
      canUseRemoteCompactionPolicy({
        policy: "openai-responses-compact",
        model: "anthropic:claude-sonnet-4-5",
      })
    ).toBe(false);
    expect(
      canUseRemoteCompactionPolicy({
        policy: "openai-responses-compact",
        model: "openrouter:openai/gpt-5.5",
      })
    ).toBe(false);
    expect(
      canUseRemoteCompactionPolicy({
        policy: "off",
        model: "openai:gpt-5.5",
      })
    ).toBe(false);
  });

  test("normalizes per-strategy local token and truncation settings", () => {
    expect(
      normalizeCompactionSettings({
        piLocal: {
          keepRecentTokens: 8_000,
          toolResultMaxChars: 2_000,
        },
        hybridLocal: {
          keepRecentTokens: -1,
          toolResultMaxChars: 0,
        },
      })
    ).toMatchObject({
      piLocal: {
        keepRecentTokens: 8_000,
        toolResultMaxChars: 2_000,
      },
      hybridLocal: {
        keepRecentTokens: 16_000,
        toolResultMaxChars: 4_000,
      },
    });
  });
});
