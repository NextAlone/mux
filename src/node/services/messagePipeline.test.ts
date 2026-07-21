import { describe, expect, it } from "bun:test";
import type { AssistantModelMessage, ModelMessage } from "ai";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { transformModelMessages } from "@/browser/utils/messages/modelMessageTransform";
import {
  prepareMessagesForProvider,
  prepareMuxMessagesForProvider,
  sanitizeAssistantModelMessages,
} from "./messagePipeline";

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
  it("exposes Mux-level transition context for alternate model runtimes", async () => {
    const prepared = await prepareMuxMessagesForProvider({
      messagesWithSentinel: [
        createMuxMessage("user-1", "user", "make a plan"),
        {
          ...createMuxMessage("assistant-1", "assistant", "the plan"),
          metadata: { timestamp: 2, agentId: "plan" },
        },
        {
          ...createMuxMessage("user-2", "user", "execute it"),
          parts: [
            { type: "text", text: "execute it" },
            { type: "file", mediaType: "image/png", url: "data:image/png;base64,aGVsbG8=" },
          ],
        },
      ],
      effectiveAgentId: "exec",
      toolNamesForSentinel: [],
      planContentForTransition: "# Persisted plan",
      planFilePath: "/tmp/plan.md",
      runtime: new LocalRuntime("/tmp/mux-test"),
      workspacePath: "/tmp/mux-test",
      abortSignal: new AbortController().signal,
      providerForMessages: "openai",
      effectiveThinkingLevel: "medium",
      modelString: "openai:gpt-5.6-sol",
      workspaceId: "workspace-test",
    });

    const transition = prepared.find((message) => message.metadata?.synthetic === true);
    expect(transition?.role).toBe("user");
    const transitionPart = transition?.parts[0];
    expect(transitionPart?.type).toBe("text");
    if (transitionPart?.type === "text") {
      expect(transitionPart.text).toContain("# Persisted plan");
    }
    expect(prepared.at(-1)?.parts).toContainEqual({
      type: "file",
      mediaType: "image/png",
      url: "data:image/png;base64,aGVsbG8=",
    });
  });

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
