import type { MuxMessage } from "@/common/types/message";

const DEFAULT_TOOL_RESULT_MAX_CHARS = 4_000;

export function estimateMuxMessageTokensByChars(message: MuxMessage): number {
  const serialized = JSON.stringify(message);
  return Math.max(1, Math.ceil(serialized.length / 4));
}

export interface LocalCompactionPlan {
  summarizeMessages: MuxMessage[];
  recentMessages: MuxMessage[];
}

export interface BuildLocalCompactionPlanOptions {
  messages: MuxMessage[];
  keepRecentTokens: number;
  estimateTokens: (message: MuxMessage) => number;
  toolResultMaxChars?: number;
}

export interface ToolResultTruncationOptions {
  toolResultMaxChars?: number;
}

export interface CreateRetainedRecentContextMessagesOptions {
  messages: readonly MuxMessage[];
  createId: (message: MuxMessage, index: number) => string;
}

function normalizeCharLimit(value: number | undefined): number {
  if (value == null || !Number.isInteger(value) || value < 0) {
    return DEFAULT_TOOL_RESULT_MAX_CHARS;
  }
  return value;
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }

  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function truncateToolOutput(output: unknown, maxChars: number): unknown {
  const serialized = stringifyToolOutput(output);
  if (serialized.length <= maxChars) {
    return output;
  }

  return {
    truncated: true,
    originalChars: serialized.length,
    preview: serialized.slice(0, maxChars),
  };
}

export function truncateToolResultsForSummary(
  messages: readonly MuxMessage[],
  options: ToolResultTruncationOptions = {}
): MuxMessage[] {
  const toolResultMaxChars = normalizeCharLimit(options.toolResultMaxChars);

  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "dynamic-tool" || part.state !== "output-available") {
        return part;
      }

      return {
        ...part,
        output: truncateToolOutput(part.output, toolResultMaxChars),
      };
    }),
  }));
}

export function buildLocalCompactionPlan(
  options: BuildLocalCompactionPlanOptions
): LocalCompactionPlan {
  const keepRecentTokens = Math.max(0, options.keepRecentTokens);
  let tokens = 0;
  let recentStartIndex = options.messages.length;

  for (let index = options.messages.length - 1; index >= 0; index -= 1) {
    const message = options.messages[index];
    if (!message) {
      continue;
    }
    const messageTokens = Math.max(0, options.estimateTokens(message));
    if (tokens + messageTokens > keepRecentTokens) {
      break;
    }
    tokens += messageTokens;
    recentStartIndex = index;
  }

  const summarizeMessages = truncateToolResultsForSummary(
    options.messages.slice(0, recentStartIndex),
    { toolResultMaxChars: options.toolResultMaxChars }
  );

  return {
    summarizeMessages,
    recentMessages: options.messages.slice(recentStartIndex),
  };
}

export function createRetainedRecentContextMessages(
  options: CreateRetainedRecentContextMessagesOptions
): MuxMessage[] {
  return options.messages.map((message, index) => {
    const {
      historySequence: _historySequence,
      compacted: _compacted,
      compactionBoundary: _compactionBoundary,
      compactionEpoch: _compactionEpoch,
      ...metadataWithoutHistoryAndBoundary
    } = message.metadata ?? {};
    void _historySequence;
    void _compacted;
    void _compactionBoundary;
    void _compactionEpoch;

    return {
      ...message,
      id: options.createId(message, index),
      metadata: {
        ...metadataWithoutHistoryAndBoundary,
        synthetic: true,
        uiVisible: false,
      },
      parts: message.parts.map((part) => ({ ...part })),
    };
  });
}
