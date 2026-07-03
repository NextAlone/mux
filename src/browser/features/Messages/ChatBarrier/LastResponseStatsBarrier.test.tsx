import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import type { WorkspaceStatsSnapshot } from "@/common/orpc/schemas/workspaceStats";

let currentSnapshot: WorkspaceStatsSnapshot | null = null;

void mock.module("@/browser/stores/WorkspaceStore", () => ({
  useWorkspaceStatsSnapshot: () => currentSnapshot,
}));

import { LastResponseStatsBarrier } from "./LastResponseStatsBarrier";

function completedSnapshot(
  overrides: Partial<WorkspaceStatsSnapshot["lastRequest"]> = {}
): WorkspaceStatsSnapshot {
  return {
    workspaceId: "ws-1",
    generatedAt: Date.now(),
    lastRequest: {
      messageId: "assistant-1",
      model: "openai:gpt-5.5",
      totalDurationMs: 5000,
      ttftMs: 800,
      toolExecutionMs: 0,
      modelTimeMs: 5000,
      streamingMs: 4000,
      outputTokens: 80,
      reasoningTokens: 20,
      invalid: false,
      anomalies: [],
      ...overrides,
    },
  };
}

describe("LastResponseStatsBarrier", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    currentSnapshot = null;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("renders the completed response average token speed", () => {
    currentSnapshot = completedSnapshot();

    const view = render(<LastResponseStatsBarrier workspaceId="ws-1" />);

    expect(view.getByText("Last response")).toBeTruthy();
    expect(view.getByTestId("last-response-stats").textContent).toContain("~100 tokens");
    expect(view.getByTestId("last-response-stats").textContent).toContain("25");
    expect(view.getByTestId("last-response-stats").textContent).toContain("t/s");
  });

  test("hides while a stream is active", () => {
    currentSnapshot = {
      ...completedSnapshot(),
      active: {
        messageId: "assistant-2",
        model: "openai:gpt-5.5",
        elapsedMs: 1000,
        ttftMs: 500,
        toolExecutionMs: 0,
        modelTimeMs: 1000,
        streamingMs: 500,
        outputTokens: 5,
        reasoningTokens: 0,
        liveTokenCount: 5,
        liveTPS: 10,
        invalid: false,
        anomalies: [],
      },
    };

    const view = render(<LastResponseStatsBarrier workspaceId="ws-1" />);

    expect(view.container.textContent).toBe("");
  });

  test("hides when no completed token speed can be computed", () => {
    currentSnapshot = completedSnapshot({
      streamingMs: 0,
      modelTimeMs: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    });

    const view = render(<LastResponseStatsBarrier workspaceId="ws-1" />);

    expect(view.container.textContent).toBe("");
  });
});
