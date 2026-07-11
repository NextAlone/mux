import { describe, expect, test } from "bun:test";

import type { FusionConfig } from "@/common/config/schemas/appConfigOnDisk";
import { resolveFusionArgs } from "./fusion";

const savedConfig: FusionConfig = {
  panel: [
    { modelString: "anthropic:claude-sonnet-4-6", thinkingLevel: "high" },
    { modelString: "openai:gpt-5.4", thinkingLevel: "medium" },
  ],
  judge: { modelString: "anthropic:claude-opus-4-6", thinkingLevel: "xhigh" },
};

describe("Fusion one-shot overrides", () => {
  test("requires saved defaults even when temporary models are provided", () => {
    expect(() =>
      resolveFusionArgs(undefined, {
        prompt: "review this",
        panelOverride: { mode: "replace", models: ["gemini", "sonnet"] },
        run_in_background: false,
      })
    ).toThrow("Fusion is not configured");
  });

  test("replaces only the current panel and keeps the configured judge", () => {
    const result = resolveFusionArgs(
      savedConfig,
      {
        prompt: "review this",
        panelOverride: { mode: "replace", models: ["mimo", "gemini"] },
        run_in_background: false,
      },
      ["mimo:mimo-v2.5-pro"]
    );

    expect(result).toEqual({
      prompt: "review this",
      panel: [{ model: "mimo:mimo-v2.5-pro" }, { model: "google:gemini-3.1-pro-preview" }],
      judge: { model: "anthropic:claude-opus-4-6", thinking: "xhigh" },
    });
    expect(savedConfig.panel.map((entry) => entry.modelString)).toEqual([
      "anthropic:claude-sonnet-4-6",
      "openai:gpt-5.4",
    ]);
  });

  test("appends without duplicates and supports a temporary judge", () => {
    const result = resolveFusionArgs(savedConfig, {
      prompt: "review this",
      panelOverride: {
        mode: "append",
        models: ["openai:gpt-5.4", "gemini"],
        thinking: "low",
      },
      judgeOverride: { model: "gpt", thinking: "high" },
      run_in_background: false,
    });

    expect(result.panel).toEqual([
      { model: "anthropic:claude-sonnet-4-6", thinking: "high" },
      { model: "openai:gpt-5.4", thinking: "medium" },
      { model: "google:gemini-3.1-pro-preview", thinking: "low" },
    ]);
    expect(result.judge).toEqual({ model: "openai:gpt-5.6-sol", thinking: "high" });
  });
});
