import type { MuxMessage } from "@/common/types/message";
import {
  isOpenAIResponsesRemoteCompactionState,
  type OpenAIResponsesRemoteCompactionState,
} from "@/common/utils/compaction/remotePolicy";

const MARKER_PREFIX = "__MUX_OPENAI_RESPONSES_COMPACTION_BOUNDARY__:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createOpenAIResponsesCompactionBoundaryMarker(responseId: string): string {
  return `${MARKER_PREFIX}${responseId}`;
}

function parseOpenAIResponsesCompactionBoundaryMarker(text: string): string | null {
  if (!text.startsWith(MARKER_PREFIX)) {
    return null;
  }

  const responseId = text.slice(MARKER_PREFIX.length).trim();
  return responseId.length > 0 ? responseId : null;
}

function getRemoteCompactionState(
  message: MuxMessage
): OpenAIResponsesRemoteCompactionState | null {
  const muxMetadata = message.metadata?.muxMetadata;
  if (muxMetadata?.type !== "compaction-summary") {
    return null;
  }

  const remoteCompaction = muxMetadata.remoteCompaction;
  return isOpenAIResponsesRemoteCompactionState(remoteCompaction) ? remoteCompaction : null;
}

export function collectOpenAIResponsesCompactionReplays(
  messages: readonly MuxMessage[]
): Record<string, OpenAIResponsesRemoteCompactionState> {
  const replays: Record<string, OpenAIResponsesRemoteCompactionState> = {};
  for (const message of messages) {
    const remoteCompaction = getRemoteCompactionState(message);
    if (!remoteCompaction) {
      continue;
    }
    replays[remoteCompaction.responseId] = remoteCompaction;
  }
  return replays;
}

export function getLatestOpenAIResponsesRemoteCompaction(
  messages: readonly MuxMessage[]
): OpenAIResponsesRemoteCompactionState | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    const remoteCompaction = getRemoteCompactionState(message);
    if (remoteCompaction) {
      return remoteCompaction;
    }
  }
  return null;
}

export function markOpenAIResponsesCompactionBoundaries(
  messages: readonly MuxMessage[]
): MuxMessage[] {
  return messages.map((message) => {
    const remoteCompaction = getRemoteCompactionState(message);
    if (!remoteCompaction) {
      return message;
    }

    return {
      ...message,
      parts: [
        {
          type: "text",
          text: createOpenAIResponsesCompactionBoundaryMarker(remoteCompaction.responseId),
        },
      ],
    };
  });
}

function extractResponseInputText(item: unknown): string[] {
  if (!isRecord(item)) {
    return [];
  }

  const content = item.content;
  if (typeof content === "string") {
    return [content];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const texts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) {
      continue;
    }
    const text = part.text;
    if (typeof text === "string") {
      texts.push(text);
    }
  }
  return texts;
}

export function applyOpenAIResponsesCompactionReplayToBody(
  body: string,
  replays: Record<string, OpenAIResponsesRemoteCompactionState> | undefined
): string {
  if (!replays || Object.keys(replays).length === 0) {
    return body;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.input)) {
    return body;
  }

  const input: unknown[] = parsed.input;
  for (let index = 0; index < input.length; index += 1) {
    for (const text of extractResponseInputText(input[index])) {
      const responseId = parseOpenAIResponsesCompactionBoundaryMarker(text);
      if (!responseId) {
        continue;
      }

      const replay = replays[responseId];
      if (!replay) {
        return body;
      }

      return JSON.stringify({
        ...parsed,
        input: [...replay.output, ...input.slice(index + 1)],
      });
    }
  }

  return body;
}
