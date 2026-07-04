import { describe, expect, test } from "bun:test";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";

import {
  buildLocalCompactionPlan,
  createRetainedRecentContextMessages,
  truncateToolResultsForSummary,
} from "./piLocal";

const createToolMessage = (id: string, output: unknown): MuxMessage => ({
  id,
  role: "assistant",
  parts: [
    {
      type: "dynamic-tool",
      toolCallId: `tool-${id}`,
      toolName: "read_file",
      state: "output-available",
      input: { path: "large.txt" },
      output,
    },
  ],
});

describe("pi-local compaction planning", () => {
  test("keeps the most recent messages within the token budget and summarizes the older prefix", () => {
    const messages = [
      createMuxMessage("old-user", "user", "old"),
      createMuxMessage("old-assistant", "assistant", "old reply"),
      createMuxMessage("recent-user", "user", "recent"),
      createMuxMessage("recent-assistant", "assistant", "recent reply"),
    ];

    const plan = buildLocalCompactionPlan({
      messages,
      keepRecentTokens: 7,
      estimateTokens: (message) => {
        const weights: Record<string, number> = {
          "old-user": 5,
          "old-assistant": 5,
          "recent-user": 4,
          "recent-assistant": 3,
        };
        return weights[message.id] ?? 1;
      },
    });

    expect(plan.summarizeMessages.map((message) => message.id)).toEqual([
      "old-user",
      "old-assistant",
    ]);
    expect(plan.recentMessages.map((message) => message.id)).toEqual([
      "recent-user",
      "recent-assistant",
    ]);
  });

  test("truncates tool results before old messages are sent to the summary model", () => {
    const oversizedOutput = { stdout: "abcdefghijklmnopqrstuvwxyz", exitCode: 0 };
    const toolMessage = createToolMessage("tool-result", oversizedOutput);

    const sanitized = truncateToolResultsForSummary([toolMessage], {
      toolResultMaxChars: 12,
    });

    const toolPart = sanitized[0]?.parts[0];
    expect(toolPart?.type).toBe("dynamic-tool");
    if (toolPart?.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("expected completed dynamic tool part");
    }

    expect(toolPart.output).toEqual({
      truncated: true,
      originalChars: JSON.stringify(oversizedOutput).length,
      preview: '{"stdout":"a',
    });
  });

  test("creates provider-visible UI-hidden clones for retained recent messages", () => {
    const recent = createMuxMessage("recent-user", "user", "recent context", {
      historySequence: 42,
      timestamp: 123,
    });

    const retained = createRetainedRecentContextMessages({
      messages: [recent],
      createId: (message) => `retained-${message.id}`,
    });

    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      id: "retained-recent-user",
      role: "user",
      parts: recent.parts,
      metadata: {
        timestamp: 123,
        synthetic: true,
        uiVisible: false,
      },
    });
    expect(retained[0]?.metadata?.historySequence).toBeUndefined();
  });
});
