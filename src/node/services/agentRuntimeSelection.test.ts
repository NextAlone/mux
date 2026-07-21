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
    expect(shouldUsePiAgentRuntime({ piAgentRuntime: true }, { type: "workspace-turn-task" })).toBe(
      false
    );
    expect(shouldUsePiAgentRuntime({ piAgentRuntime: true }, { type: "agent-skill" })).toBe(false);
    expect(
      shouldUsePiAgentRuntime({ piAgentRuntime: true }, undefined, { type: "heartbeat-request" })
    ).toBe(false);
  });

  test("routes only ordinary user turns to Pi", () => {
    expect(shouldUsePiAgentRuntime({ piAgentRuntime: true }, undefined, undefined, "exec")).toBe(
      true
    );
    expect(
      shouldUsePiAgentRuntime({ piAgentRuntime: true }, { type: "normal" }, undefined, "exec")
    ).toBe(true);
    expect(shouldUsePiAgentRuntime({ piAgentRuntime: false }, undefined, undefined, "exec")).toBe(
      false
    );
  });

  test("keeps plan, explore, and custom agents on Mux", () => {
    expect(shouldUsePiAgentRuntime({ piAgentRuntime: true }, undefined, undefined, "plan")).toBe(
      false
    );
    expect(shouldUsePiAgentRuntime({ piAgentRuntime: true }, undefined, undefined, "explore")).toBe(
      false
    );
    expect(shouldUsePiAgentRuntime({ piAgentRuntime: true }, undefined, undefined, "review")).toBe(
      false
    );
  });

  test("falls back to Mux for unsupported workspace and compaction boundaries", () => {
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
