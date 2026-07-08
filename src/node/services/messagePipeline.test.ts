import { describe, expect, it } from "bun:test";
import type { AssistantModelMessage, ModelMessage } from "ai";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { transformModelMessages } from "@/browser/utils/messages/modelMessageTransform";
import { prepareMessagesForProvider, sanitizeAssistantModelMessages } from "./messagePipeline";

function isAssistantMessage(message: ModelMessage | undefined): message is AssistantModelMessage {
  return message?.role === "assistant";
}

describe("sanitizeAssistantModelMessages", () => {
  it("preserves whitespace-only separators before later text coalescing", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "## Verdict" },
          { type: "text", text: "\n\n" },
          { type: "text", text: "This is now **strong evidence**." },
        ],
      },
    ];

    const sanitized = sanitizeAssistantModelMessages(messages);
    const transformed = transformModelMessages(sanitized, "openai");

    expect(isAssistantMessage(sanitized[0])).toBe(true);
    if (isAssistantMessage(sanitized[0])) {
      expect(sanitized[0].content).toEqual([
        { type: "text", text: "## Verdict\n\nThis is now **strong evidence**." },
      ]);
    }

    expect(isAssistantMessage(transformed[0])).toBe(true);
    if (isAssistantMessage(transformed[0])) {
      expect(transformed[0].content).toEqual([
        { type: "text", text: "## Verdict\n\nThis is now **strong evidence**." },
      ]);
    }
  });

  it("still filters assistant messages that contain only whitespace text", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "\n" },
          { type: "text", text: "\t " },
        ],
      },
    ];

    expect(sanitizeAssistantModelMessages(messages)).toEqual([]);
  });
});

describe("prepareMessagesForProvider", () => {
  it("applies Anthropic wire-format transforms for non-Claude compatible providers", async () => {
    const reasoningOnlyAssistant: MuxMessage = {
      id: "assistant-reasoning-only",
      role: "assistant",
      parts: [{ type: "reasoning", text: "scratchpad" }],
      metadata: { timestamp: 1 },
    };

    const prepared = await prepareMessagesForProvider({
      messagesWithSentinel: [
        createMuxMessage("user-1", "user", "hello"),
        reasoningOnlyAssistant,
        createMuxMessage("user-2", "user", "continue"),
      ],
      effectiveAgentId: "exec",
      toolNamesForSentinel: [],
      runtime: new LocalRuntime("/tmp/mux-test"),
      workspacePath: "/tmp/mux-test",
      abortSignal: new AbortController().signal,
      providerForMessages: "minimax",
      usesAnthropicMessagesApi: true,
      anthropicThinkingEnabled: false,
      effectiveThinkingLevel: "medium",
      modelString: "minimax:abab6.5-chat",
      workspaceId: "workspace-test",
    });

    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.role).toBe("user");
    expect(prepared[0]?.content).toEqual([{ type: "text", text: "hello\ncontinue" }]);
  });
});
