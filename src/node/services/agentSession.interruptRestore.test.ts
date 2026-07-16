import { describe, expect, mock, test } from "bun:test";

import type { SendMessageOptions } from "@/common/orpc/types";
import { Ok } from "@/common/types/result";
import { createAgentSessionHarness } from "./agentSession.testHarness";

const TEST_MODEL = "anthropic:claude-sonnet-4-5";

async function waitForCondition(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("AgentSession pending-turn restore on interrupt", () => {
  test("restores and removes a user turn when only reasoning has streamed", async () => {
    const workspaceId = "interrupt-restore-reasoning-only";
    let finishStream: (() => void) | undefined;
    const streamMessage = mock(
      () =>
        new Promise((resolve) => {
          finishStream = () => resolve(Ok(undefined));
        })
    );
    const { session, historyService, aiEmitter, events, cleanup } = await createAgentSessionHarness(
      {
        workspaceId,
        captureEvents: true,
        aiServiceOverrides: { streamMessage: streamMessage as never },
      }
    );
    const options: SendMessageOptions = { model: TEST_MODEL, agentId: "exec" };
    const sendPromise = session.sendMessage("put me back", options);

    try {
      await waitForCondition(() => streamMessage.mock.calls.length === 1);
      aiEmitter.emit("stream-start", {
        type: "stream-start",
        workspaceId,
        messageId: "assistant-1",
        model: TEST_MODEL,
        startTime: Date.now(),
      });
      aiEmitter.emit("reasoning-delta", {
        type: "reasoning-delta",
        workspaceId,
        messageId: "assistant-1",
        delta: "thinking",
        tokens: 1,
        timestamp: Date.now(),
      });

      const interruptResult = await session.interruptStream({ restorePendingTurn: true });
      expect(interruptResult.success).toBe(true);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data).toEqual([]);
      }
      const restoreEvent = events.find((event) => event.type === "restore-to-input");
      expect(restoreEvent?.workspaceId).toBe(workspaceId);
      expect(restoreEvent?.text).toBe("put me back");
      const deleteEvent = events.find((event) => event.type === "delete");
      expect(deleteEvent?.historySequences).toEqual([0]);
    } finally {
      finishStream?.();
      await sendPromise;
      session.dispose();
      await cleanup();
    }
  });

  test("keeps the user turn after assistant text starts streaming", async () => {
    const workspaceId = "interrupt-keep-after-text";
    let finishStream: (() => void) | undefined;
    const streamMessage = mock(
      () =>
        new Promise((resolve) => {
          finishStream = () => resolve(Ok(undefined));
        })
    );
    const { session, historyService, aiEmitter, events, cleanup } = await createAgentSessionHarness(
      {
        workspaceId,
        captureEvents: true,
        aiServiceOverrides: { streamMessage: streamMessage as never },
      }
    );
    const options: SendMessageOptions = { model: TEST_MODEL, agentId: "exec" };
    const sendPromise = session.sendMessage("keep me", options);

    try {
      await waitForCondition(() => streamMessage.mock.calls.length === 1);
      aiEmitter.emit("stream-start", {
        type: "stream-start",
        workspaceId,
        messageId: "assistant-1",
        model: TEST_MODEL,
        startTime: Date.now(),
      });
      aiEmitter.emit("stream-delta", {
        type: "stream-delta",
        workspaceId,
        messageId: "assistant-1",
        delta: "visible text",
        tokens: 2,
        timestamp: Date.now(),
      });

      const interruptResult = await session.interruptStream({ restorePendingTurn: true });
      expect(interruptResult.success).toBe(true);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data.map((message) => message.id)).toHaveLength(1);
        expect(
          history.data[0]?.parts.some((part) => part.type === "text" && part.text === "keep me")
        ).toBe(true);
      }
      expect(events.some((event) => event.type === "restore-to-input")).toBe(false);
      expect(events.some((event) => event.type === "delete")).toBe(false);
    } finally {
      finishStream?.();
      await sendPromise;
      session.dispose();
      await cleanup();
    }
  });

  test("keeps the user turn after tool execution starts", async () => {
    const workspaceId = "interrupt-keep-after-tool";
    let finishStream: (() => void) | undefined;
    const streamMessage = mock(
      () =>
        new Promise((resolve) => {
          finishStream = () => resolve(Ok(undefined));
        })
    );
    const { session, historyService, aiEmitter, events, cleanup } = await createAgentSessionHarness(
      {
        workspaceId,
        captureEvents: true,
        aiServiceOverrides: { streamMessage: streamMessage as never },
      }
    );
    const options: SendMessageOptions = { model: TEST_MODEL, agentId: "exec" };
    const sendPromise = session.sendMessage("run something", options);

    try {
      await waitForCondition(() => streamMessage.mock.calls.length === 1);
      aiEmitter.emit("stream-start", {
        type: "stream-start",
        workspaceId,
        messageId: "assistant-1",
        model: TEST_MODEL,
        startTime: Date.now(),
      });
      aiEmitter.emit("tool-call-start", {
        type: "tool-call-start",
        workspaceId,
        messageId: "assistant-1",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "pwd" },
        tokens: 1,
        timestamp: Date.now(),
      });

      const interruptResult = await session.interruptStream({ restorePendingTurn: true });
      expect(interruptResult.success).toBe(true);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data).toHaveLength(1);
      }
      expect(events.some((event) => event.type === "restore-to-input")).toBe(false);
      expect(events.some((event) => event.type === "delete")).toBe(false);
    } finally {
      finishStream?.();
      await sendPromise;
      session.dispose();
      await cleanup();
    }
  });
});
