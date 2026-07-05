import { describe, expect, test } from "bun:test";

import { createMuxMessage } from "@/common/types/message";
import {
  applyOpenAIResponsesCompactionReplayToBody,
  collectOpenAIResponsesCompactionReplays,
  createOpenAIResponsesCompactionBoundaryMarker,
  getLatestOpenAIResponsesRemoteCompaction,
  markOpenAIResponsesCompactionBoundaries,
} from "./openaiResponsesCompactionReplay";

const remoteCompaction = {
  type: "openai-responses-compact" as const,
  responseId: "resp_compact_1",
  output: [
    {
      id: "ci_1",
      type: "compaction",
      encrypted_content: "opaque-ciphertext",
    },
  ],
};

describe("OpenAI Responses compaction replay", () => {
  test("replaces the marker prefix with the canonical compacted output", () => {
    const body = JSON.stringify({
      model: "gpt-5.5",
      input: [
        { role: "user", content: [{ type: "input_text", text: "before compact" }] },
        {
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: createOpenAIResponsesCompactionBoundaryMarker("resp_compact_1"),
            },
          ],
        },
        { role: "user", content: [{ type: "input_text", text: "after compact" }] },
      ],
    });

    const rewritten = JSON.parse(
      applyOpenAIResponsesCompactionReplayToBody(body, {
        resp_compact_1: remoteCompaction,
      })
    ) as { input: unknown[] };

    expect(rewritten.input).toEqual([
      ...remoteCompaction.output,
      { role: "user", content: [{ type: "input_text", text: "after compact" }] },
    ]);
  });

  test("marks persisted remote compaction summaries only for provider requests", () => {
    const messages = [
      createMuxMessage("summary", "assistant", "OpenAI Responses compacted context installed.", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
        muxMetadata: {
          type: "compaction-summary",
          remoteCompaction,
        },
      }),
      createMuxMessage("u1", "user", "continue"),
    ];

    const replays = collectOpenAIResponsesCompactionReplays(messages);
    const marked = markOpenAIResponsesCompactionBoundaries(messages);

    expect(replays.resp_compact_1).toEqual(remoteCompaction);
    expect(getLatestOpenAIResponsesRemoteCompaction(messages)).toEqual(remoteCompaction);
    expect(marked[0]?.parts).toEqual([
      {
        type: "text",
        text: createOpenAIResponsesCompactionBoundaryMarker("resp_compact_1"),
      },
    ]);
    expect(messages[0]?.parts[0]).toMatchObject({
      type: "text",
      text: "OpenAI Responses compacted context installed.",
    });
  });

  test("leaves the request body unchanged when no matching replay exists", () => {
    const body = JSON.stringify({
      input: [
        {
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: createOpenAIResponsesCompactionBoundaryMarker("missing"),
            },
          ],
        },
      ],
    });

    expect(applyOpenAIResponsesCompactionReplayToBody(body, {})).toBe(body);
  });
});
