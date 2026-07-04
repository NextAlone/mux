import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import type { CodexUsageSnapshot } from "@/common/orpc/schemas/api";
import type { WorkspaceStatsSnapshot } from "@/common/orpc/schemas/workspaceStats";

let currentSnapshot: WorkspaceStatsSnapshot | null = null;
let currentCodexUsageSnapshot: CodexUsageSnapshot | null = null;

void mock.module("@/browser/stores/WorkspaceStore", () => ({
  useWorkspaceStatsSnapshot: () => currentSnapshot,
}));

void mock.module("@/browser/stores/CodexUsageStore", () => ({
  useCodexUsageSnapshot: () => currentCodexUsageSnapshot,
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
    currentCodexUsageSnapshot = null;
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

    expect(view.getByText("Response rate")).toBeTruthy();
    expect(view.getByTestId("last-response-stats").textContent).toContain("~100 tokens");
    expect(view.getByTestId("last-response-stats").textContent).toContain("25");
    expect(view.getByTestId("last-response-stats").textContent).toContain("t/s");
  });

  test("renders Codex remaining usage summary and details when quota is known", () => {
    currentSnapshot = completedSnapshot();
    currentCodexUsageSnapshot = {
      source: "headers",
      updatedAt: new Date(2026, 6, 4, 1, 0, 0).getTime(),
      remainingPercent: 8,
      windows: {
        fiveHour: {
          label: "5h",
          usedPercent: 75,
          remainingPercent: 25,
          resetAt: new Date(2026, 6, 4, 1, 26, 0).getTime(),
        },
        weekly: {
          label: "1w",
          usedPercent: 92,
          remainingPercent: 8,
          resetAt: new Date(2026, 6, 7, 0, 0, 0).getTime(),
        },
      },
    };

    const view = render(<LastResponseStatsBarrier workspaceId="ws-1" />);

    const toggle = view.getByRole("button", { name: /Codex 剩余用量 8%/ });
    expect(toggle.textContent).toContain("5h");
    expect(toggle.textContent).toContain("25%");
    expect(toggle.textContent).toContain("1w");
    expect(toggle.textContent).toContain("8%");

    fireEvent.click(toggle);

    expect(view.getAllByText("剩余用量").length).toBeGreaterThan(0);
    expect(view.getByText("5 小时")).toBeTruthy();
    expect(view.getByText("1 周")).toBeTruthy();
    expect(view.getByText("Jul 7")).toBeTruthy();
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
