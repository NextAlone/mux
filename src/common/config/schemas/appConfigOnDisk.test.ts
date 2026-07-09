import { describe, expect, it } from "bun:test";

import { AppConfigOnDiskSchema } from "./appConfigOnDisk";

describe("AppConfigOnDiskSchema", () => {
  it("validates default model setting", () => {
    const valid = { defaultModel: "anthropic:claude-sonnet-4-20250514" };

    expect(AppConfigOnDiskSchema.safeParse(valid).success).toBe(true);
  });

  it("validates title generation model setting", () => {
    const valid = { titleGenerationModel: "anthropic:claude-3-5-haiku-latest" };

    expect(AppConfigOnDiskSchema.safeParse(valid).success).toBe(true);
  });

  it("validates hiddenModels array", () => {
    const valid = { hiddenModels: ["openai:gpt-4o", "google:gemini-pro"] };

    expect(AppConfigOnDiskSchema.safeParse(valid).success).toBe(true);
  });

  it("validates the full-width chat transcript flag", () => {
    expect(AppConfigOnDiskSchema.safeParse({ chatTranscriptFullWidth: true }).success).toBe(true);
    expect(AppConfigOnDiskSchema.safeParse({ chatTranscriptFullWidth: "true" }).success).toBe(
      false
    );
  });

  it("validates userPreferences", () => {
    const valid = {
      userPreferences: {
        appearance: { theme: "dark" },
      },
    };

    expect(AppConfigOnDiskSchema.safeParse(valid).success).toBe(true);
    expect(
      AppConfigOnDiskSchema.safeParse({ userPreferences: { appearance: { theme: "neon" } } })
        .success
    ).toBe(false);
  });

  it("validates taskSettings with limits", () => {
    const valid = {
      taskSettings: {
        maxParallelAgentTasks: 5,
        maxTaskNestingDepth: 3,
      },
    };

    expect(AppConfigOnDiskSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects taskSettings outside limits", () => {
    const invalid = {
      taskSettings: {
        maxParallelAgentTasks: 999,
      },
    };

    expect(AppConfigOnDiskSchema.safeParse(invalid).success).toBe(false);
  });

  it("validates projects as tuple array", () => {
    const valid = { projects: [["/home/user/project", { workspaces: [] }]] };

    expect(AppConfigOnDiskSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts sparse runtimeEnablement overrides", () => {
    expect(AppConfigOnDiskSchema.safeParse({ runtimeEnablement: { ssh: false } }).success).toBe(
      true
    );
  });

  it("validates compaction strategy settings", () => {
    expect(
      AppConfigOnDiskSchema.safeParse({
        compaction: {
          localStrategy: "hybrid-local",
          fallbackLocalStrategies: ["pi-local", "mux-current"],
          remotePolicy: "openai-responses-compact",
          piLocal: {
            keepRecentTokens: 8_000,
            toolResultMaxChars: 2_000,
          },
        },
      }).success
    ).toBe(true);

    expect(
      AppConfigOnDiskSchema.safeParse({
        compaction: {
          localStrategy: "codex-openai-remote",
        },
      }).success
    ).toBe(false);
    expect(
      AppConfigOnDiskSchema.safeParse({
        compaction: {
          remotePolicy: "anthropic-compact",
        },
      }).success
    ).toBe(false);
    expect(
      AppConfigOnDiskSchema.safeParse({
        compaction: {
          piLocal: { keepRecentTokens: 0 },
        },
      }).success
    ).toBe(false);
  });

  it("rejects runtimeEnablement values other than false", () => {
    expect(AppConfigOnDiskSchema.safeParse({ runtimeEnablement: { ssh: true } }).success).toBe(
      false
    );
  });

  it("preserves unknown future runtimeEnablement keys for forward-compatibility", () => {
    expect(
      AppConfigOnDiskSchema.safeParse({
        runtimeEnablement: { ssh: false, future_runtime: false },
      }).success
    ).toBe(true);
  });

  it("accepts sparse configs", () => {
    expect(AppConfigOnDiskSchema.safeParse({ defaultModel: "openai:gpt-4o" }).success).toBe(true);
  });

  it("preserves unknown fields via passthrough", () => {
    const valid = { futureField: "something" };

    const result = AppConfigOnDiskSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ futureField: "something" });
    }
  });
});
