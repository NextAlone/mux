import { describe, expect, test } from "bun:test";

import { resolveAgentRuntimeKind, shouldUsePiAgentRuntime } from "./agentRuntimeSelection";

describe("resolveAgentRuntimeKind", () => {
  test("keeps the existing Mux runtime when the experiment is absent or disabled", () => {
    expect(resolveAgentRuntimeKind(undefined)).toBe("mux");
    expect(resolveAgentRuntimeKind({ piAgentRuntime: false })).toBe("mux");
  });

  test("selects Pi only from the accepted turn snapshot", () => {
    expect(resolveAgentRuntimeKind({ piAgentRuntime: true })).toBe("pi");
  });

  test("keeps compaction requests on Mux so Codex remote compaction remains authoritative", () => {
    expect(shouldUsePiAgentRuntime({ piAgentRuntime: true }, { type: "compaction-request" })).toBe(
      false
    );
    expect(shouldUsePiAgentRuntime({ piAgentRuntime: true }, undefined)).toBe(true);
    expect(
      shouldUsePiAgentRuntime({ piAgentRuntime: true }, undefined, { type: "compaction-request" })
    ).toBe(false);
  });
});
