import { describe, expect, test } from "bun:test";

import {
  isPiAgentRuntimeWorkspaceCompatible,
  resolveAgentRuntimeKind,
  shouldUsePiAgentRuntime,
} from "./agentRuntimeSelection";

describe("resolveAgentRuntimeKind", () => {
  test("keeps the existing Mux runtime when the experiment is absent or disabled", () => {
    expect(resolveAgentRuntimeKind(undefined)).toBe("mux");
    expect(resolveAgentRuntimeKind({ piAgentRuntime: false })).toBe("mux");
  });

  test("selects Pi only from the accepted turn snapshot", () => {
    expect(resolveAgentRuntimeKind({ piAgentRuntime: true })).toBe("pi");
  });

  test("keeps Mux-owned control turns on Mux", () => {
    expect(shouldUsePiAgentRuntime({ piAgentRuntime: true }, { type: "compaction-request" })).toBe(
      false
    );
    expect(shouldUsePiAgentRuntime({ piAgentRuntime: true }, { type: "agent-skill" })).toBe(false);
    expect(
      shouldUsePiAgentRuntime({ piAgentRuntime: true }, undefined, { type: "heartbeat-request" })
    ).toBe(false);
    expect(shouldUsePiAgentRuntime({ piAgentRuntime: true }, undefined, undefined, true)).toBe(
      false
    );
    expect(
      shouldUsePiAgentRuntime(
        { piAgentRuntime: true },
        { type: "compaction-request" },
        undefined,
        true,
        true
      )
    ).toBe(false);
  });

  test("routes delegated workspace turns to Pi", () => {
    expect(shouldUsePiAgentRuntime({ piAgentRuntime: true }, { type: "workspace-turn-task" })).toBe(
      true
    );
  });

  test("routes a synthetic delegated executable turn to Pi", () => {
    expect(
      shouldUsePiAgentRuntime({ piAgentRuntime: true }, undefined, undefined, true, true)
    ).toBe(true);
  });

  test("routes only ordinary user turns to Pi", () => {
    expect(shouldUsePiAgentRuntime({ piAgentRuntime: true }, undefined, undefined)).toBe(true);
    expect(shouldUsePiAgentRuntime({ piAgentRuntime: true }, { type: "normal" }, undefined)).toBe(
      true
    );
    expect(shouldUsePiAgentRuntime({ piAgentRuntime: false }, undefined, undefined)).toBe(false);
  });

  test("identifies unsupported Pi workspace and compaction boundaries", () => {
    const compatible = {
      modelString: "openai:gpt-5.6-sol",
      runtimeType: "worktree" as const,
      multiProject: false,
      remoteCompactionRoute: "codex-oauth" as const,
    };
    expect(isPiAgentRuntimeWorkspaceCompatible(compatible)).toBe(true);
    expect(isPiAgentRuntimeWorkspaceCompatible({ ...compatible, runtimeType: "ssh" })).toBe(false);
    expect(isPiAgentRuntimeWorkspaceCompatible({ ...compatible, multiProject: true })).toBe(false);
    expect(
      isPiAgentRuntimeWorkspaceCompatible({
        ...compatible,
        remoteCompactionRoute: "openai-api-key",
      })
    ).toBe(false);
    expect(
      isPiAgentRuntimeWorkspaceCompatible({ ...compatible, modelString: "anthropic:claude-opus" })
    ).toBe(false);
  });
});
