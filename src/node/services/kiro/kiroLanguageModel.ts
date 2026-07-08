import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2FunctionTool,
  LanguageModelV2StreamPart,
  LanguageModelV2ToolResultOutput,
  LanguageModelV2Usage,
} from "@ai-sdk/provider";

import {
  isKiroOauthCredentialExpired,
  isKiroOauthCredentialExpiring,
  refreshKiroOauthCredentials,
  type KiroOauthCredentials,
} from "@/node/services/kiro/kiroAuth";

type JsonRecord = Record<string, unknown>;
type KiroRuntimeCredentials = KiroOauthCredentials & { accessToken: string };

export interface KiroLanguageModelConfig {
  modelId: string;
  credentials?: KiroOauthCredentials;
  credentialsProvider?: () => Promise<KiroOauthCredentials | null>;
  fetch: typeof globalThis.fetch;
  baseUrl?: string;
}

interface UnifiedMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  toolResults?: Array<{ id: string; name: string; output: LanguageModelV2ToolResultOutput }>;
}

interface ParsedKiroEvent {
  type: "content" | "usage" | "tool-call";
  content?: string;
  usage?: LanguageModelV2Usage;
  toolCall?: { toolCallId: string; toolName: string; input: string };
}

const DEFAULT_REGION = "us-east-1";
const KIRO_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";

export class KiroLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const;
  readonly provider = "kiro.runtime";
  readonly modelId: string;
  readonly supportedUrls = {};

  private readonly fetchFn: typeof globalThis.fetch;
  private readonly credentials?: KiroOauthCredentials;
  private readonly credentialsProvider?: () => Promise<KiroOauthCredentials | null>;
  private readonly baseUrl?: string;
  private refreshedCredentials?: KiroOauthCredentials;

  constructor(config: KiroLanguageModelConfig) {
    this.modelId = config.modelId;
    this.fetchFn = config.fetch;
    this.credentials = config.credentials;
    this.credentialsProvider = config.credentialsProvider;
    this.baseUrl = config.baseUrl?.replace(/\/+$/, "");
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    const streamResult = await this.doStream(options);
    const parts = await collectStream(streamResult.stream);
    const content: LanguageModelV2Content[] = [];
    let finishReason: LanguageModelV2FinishReason = "other";
    let usage = emptyUsage();

    let text = "";
    for (const part of parts) {
      if (part.type === "text-delta") {
        text += part.delta;
      } else if (part.type === "tool-call") {
        content.push(part);
      } else if (part.type === "finish") {
        finishReason = part.finishReason;
        usage = part.usage;
      }
    }
    if (text.length > 0) {
      content.unshift({ type: "text", text });
    }

    return {
      content,
      finishReason,
      usage,
      warnings: [],
      request: streamResult.request,
      response: streamResult.response,
    };
  }

  async doStream(options: LanguageModelV2CallOptions) {
    const credentials = await this.resolveCredentials();
    const body = buildKiroPayload({
      modelId: this.modelId,
      options,
      profileArn: credentials.profileArn,
    });
    const response = await this.post(credentials, body, options);
    if (response.body == null) {
      throw new Error("Kiro runtime returned no response body");
    }

    const stream = response.body;
    return {
      stream: new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          return consumeKiroStream(stream, options.includeRawChunks === true, controller);
        },
      }),
      request: { body },
      response: { headers: headersToRecord(response.headers) },
    };
  }

  private async resolveCredentials(): Promise<KiroRuntimeCredentials> {
    const credentials =
      this.refreshedCredentials ?? this.credentials ?? (await this.credentialsProvider?.());
    if (!credentials || (!credentials.accessToken && !credentials.refreshToken)) {
      throw new Error("Kiro OAuth credentials were not found. Run Kiro login and configure Kiro.");
    }
    if (
      credentials.refreshToken &&
      (!credentials.accessToken || isKiroOauthCredentialExpiring(credentials))
    ) {
      try {
        const refreshed = await refreshKiroOauthCredentials(credentials, { fetch: this.fetchFn });
        this.refreshedCredentials = refreshed;
        return requireAccessToken(refreshed);
      } catch (error) {
        if (credentials.accessToken && !isKiroOauthCredentialExpired(credentials)) {
          return requireAccessToken(credentials);
        }
        throw error;
      }
    }
    return requireAccessToken(credentials);
  }

  private async post(
    credentials: KiroRuntimeCredentials,
    body: JsonRecord,
    options: LanguageModelV2CallOptions
  ) {
    const region = credentials.region ?? DEFAULT_REGION;
    const baseUrl = this.baseUrl ?? `https://runtime.${region}.kiro.dev`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      if (value !== undefined) {
        headers.set(key, value);
      }
    }
    headers.delete("x-mux-devtools-step-id");
    headers.set("content-type", "application/x-amz-json-1.0");
    headers.set("x-amz-target", KIRO_TARGET);
    headers.set("x-amzn-codewhisperer-optout", "true");
    headers.set("x-amzn-kiro-agent-mode", "vibe");
    headers.set("x-amz-user-agent", "mux-kiro-provider");

    const send = (requestCredentials: KiroRuntimeCredentials) => {
      headers.set("authorization", `Bearer ${requestCredentials.accessToken}`);
      return this.fetchFn(`${baseUrl}/generateAssistantResponse`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });
    };

    let response = await send(credentials);
    if (response.status === 403 && credentials.refreshToken) {
      const refreshed = await refreshKiroOauthCredentials(credentials, { fetch: this.fetchFn });
      this.refreshedCredentials = refreshed;
      response = await send(requireAccessToken(refreshed));
    }

    if (response.ok) {
      return response;
    }

    const responseText = await response.text().catch(() => "");
    const snippet = responseText.replace(/\s+/g, " ").trim().slice(0, 240);
    throw new Error(
      `Kiro runtime request failed with status ${response.status}: ${
        snippet || response.statusText
      }`
    );
  }
}

function buildKiroPayload(input: {
  modelId: string;
  options: LanguageModelV2CallOptions;
  profileArn?: string;
}): JsonRecord {
  const systemPrompt = input.options.prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  let messages = normalizePromptMessages(input.options);
  if (messages.length === 0) {
    messages = [{ role: "user", content: "(empty placeholder)" }];
  }
  if (messages[0]?.role !== "user") {
    messages.unshift({ role: "user", content: "(empty placeholder)" });
  }

  const historyMessages = messages.slice(0, -1);
  const currentMessage = messages.at(-1) ?? { role: "user", content: "(empty placeholder)" };
  const history = historyMessages.map((message) => toKiroHistoryMessage(message, input.modelId));
  let currentContent = currentMessage.content || "(empty placeholder)";

  if (systemPrompt.length > 0) {
    if (history.length === 0) {
      currentContent = `${systemPrompt}\n\n${currentContent}`;
    } else {
      const firstHistory = history[0] as { userInputMessage?: { content?: string } };
      if (firstHistory.userInputMessage) {
        firstHistory.userInputMessage.content = `${systemPrompt}\n\n${
          firstHistory.userInputMessage.content ?? ""
        }`;
      }
    }
  }

  const userInputMessage: JsonRecord = {
    content: currentContent,
    modelId: input.modelId,
    origin: "AI_EDITOR",
  };

  const context: JsonRecord = {};
  const tools = convertTools(input.options.tools);
  if (tools.length > 0) {
    context.tools = tools;
  }
  if (currentMessage.toolResults && currentMessage.toolResults.length > 0) {
    context.toolResults = currentMessage.toolResults.map(toKiroToolResult);
  }
  if (Object.keys(context).length > 0) {
    userInputMessage.userInputMessageContext = context;
  }

  const payload: JsonRecord = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: "mux-kiro",
      currentMessage: {
        userInputMessage,
      },
      ...(history.length > 0 ? { history } : {}),
    },
  };
  if (input.profileArn) {
    payload.profileArn = input.profileArn;
  }
  return payload;
}

function normalizePromptMessages(options: LanguageModelV2CallOptions): UnifiedMessage[] {
  const messages: UnifiedMessage[] = [];

  for (const message of options.prompt) {
    switch (message.role) {
      case "system":
        break;
      case "user":
        messages.push({ role: "user", content: message.content.map(textFromPart).join("") });
        break;
      case "assistant": {
        const toolCalls = message.content.flatMap((part) =>
          part.type === "tool-call"
            ? [{ id: part.toolCallId, name: part.toolName, input: part.input }]
            : []
        );
        messages.push({
          role: "assistant",
          content: message.content
            .filter((part) => part.type === "text" || part.type === "reasoning")
            .map((part) => part.text)
            .join(""),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        });
        break;
      }
      case "tool":
        messages.push({
          role: "user",
          content: "",
          toolResults: message.content.map((part) => ({
            id: part.toolCallId,
            name: part.toolName,
            output: part.output,
          })),
        });
        break;
    }
  }

  return mergeAdjacentMessages(messages);
}

function mergeAdjacentMessages(messages: UnifiedMessage[]): UnifiedMessage[] {
  const merged: UnifiedMessage[] = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous?.role !== message.role) {
      merged.push({ ...message });
      continue;
    }

    previous.content = [previous.content, message.content].filter(Boolean).join("\n");
    previous.toolCalls = [...(previous.toolCalls ?? []), ...(message.toolCalls ?? [])];
    previous.toolResults = [...(previous.toolResults ?? []), ...(message.toolResults ?? [])];
  }
  return merged;
}

function textFromPart(
  part: Extract<LanguageModelV2CallOptions["prompt"][number], { role: "user" }>["content"][number]
): string {
  if (part.type === "text") {
    return part.text;
  }
  return "";
}

function toKiroHistoryMessage(message: UnifiedMessage, modelId: string): JsonRecord {
  if (message.role === "assistant") {
    const assistantResponseMessage: JsonRecord = {
      content: message.content || "(empty placeholder)",
    };
    if (message.toolCalls && message.toolCalls.length > 0) {
      assistantResponseMessage.toolUses = message.toolCalls.map((toolCall) => ({
        name: toolCall.name,
        input: toolCall.input,
        toolUseId: toolCall.id,
      }));
    }
    return { assistantResponseMessage };
  }

  const userInputMessage: JsonRecord = {
    content: message.content || "(empty placeholder)",
    modelId,
    origin: "AI_EDITOR",
  };
  if (message.toolResults && message.toolResults.length > 0) {
    userInputMessage.userInputMessageContext = {
      toolResults: message.toolResults.map(toKiroToolResult),
    };
  }
  return { userInputMessage };
}

function toKiroToolResult(toolResult: NonNullable<UnifiedMessage["toolResults"]>[number]) {
  return {
    content: [{ text: serializeToolResultOutput(toolResult.output) }],
    status: toolResult.output.type.startsWith("error") ? "error" : "success",
    toolUseId: toolResult.id,
  };
}

function convertTools(tools: LanguageModelV2CallOptions["tools"]) {
  return (tools ?? []).flatMap((tool) => {
    if (!isFunctionTool(tool)) {
      return [];
    }

    const description = tool.description?.trim();
    return [
      {
        toolSpecification: {
          name: tool.name,
          description:
            description == null || description === "" ? `Tool: ${tool.name}` : description,
          inputSchema: { json: sanitizeJsonSchema(tool.inputSchema) },
        },
      },
    ];
  });
}

function isFunctionTool(tool: unknown): tool is LanguageModelV2FunctionTool {
  return (
    typeof tool === "object" &&
    tool !== null &&
    "type" in tool &&
    tool.type === "function" &&
    "name" in tool &&
    "inputSchema" in tool
  );
}

function sanitizeJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeJsonSchema);
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const result: JsonRecord = {};
  for (const [key, value] of Object.entries(schema as JsonRecord)) {
    if (key === "additionalProperties") {
      continue;
    }
    if (key === "required" && Array.isArray(value) && value.length === 0) {
      continue;
    }
    result[key] = sanitizeJsonSchema(value);
  }
  return result;
}

function serializeToolResultOutput(output: LanguageModelV2ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    case "content":
      return output.value
        .map((item) => (item.type === "text" ? item.text : `[${item.mediaType} media]`))
        .join("\n");
  }
}

async function consumeKiroStream(
  source: ReadableStream<Uint8Array>,
  includeRawChunks: boolean,
  controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>
) {
  const parser = new KiroStreamParser();
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let textStarted = false;
  let sawToolCall = false;
  let usage = emptyUsage();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      const chunkText = value ? decoder.decode(value, { stream: !done }) : decoder.decode();
      if (includeRawChunks && value) {
        controller.enqueue({ type: "raw", rawValue: chunkText });
      }

      for (const event of parser.feed(chunkText)) {
        if (event.type === "content") {
          if (!textStarted) {
            controller.enqueue({ type: "text-start", id: "text-0" });
            textStarted = true;
          }
          if (event.content) {
            controller.enqueue({ type: "text-delta", id: "text-0", delta: event.content });
          }
        } else if (event.type === "tool-call" && event.toolCall) {
          sawToolCall = true;
          controller.enqueue({ type: "tool-call", ...event.toolCall });
        } else if (event.type === "usage" && event.usage) {
          usage = event.usage;
        }
      }

      if (done) {
        break;
      }
    }

    if (textStarted) {
      controller.enqueue({ type: "text-end", id: "text-0" });
    }
    for (const toolCall of parser.finishToolCalls()) {
      sawToolCall = true;
      controller.enqueue({ type: "tool-call", ...toolCall });
    }
    controller.enqueue({
      type: "finish",
      finishReason: sawToolCall ? "tool-calls" : "stop",
      usage,
    });
  } catch (error) {
    controller.enqueue({ type: "error", error });
  } finally {
    controller.close();
    reader.releaseLock();
  }
}

class KiroStreamParser {
  private buffer = "";
  private currentToolCall: { toolCallId: string; toolName: string; input: string } | undefined;
  private readonly completedToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: string;
  }> = [];

  feed(chunkText: string): ParsedKiroEvent[] {
    this.buffer += chunkText;
    const events: ParsedKiroEvent[] = [];

    for (;;) {
      const start = this.findNextJsonStart();
      if (start < 0) {
        this.buffer = this.buffer.slice(Math.max(0, this.buffer.length - 128));
        return events;
      }

      const end = findMatchingBrace(this.buffer, start);
      if (end < 0) {
        this.buffer = this.buffer.slice(start);
        return events;
      }

      const rawJson = this.buffer.slice(start, end + 1);
      this.buffer = this.buffer.slice(end + 1);
      const event = this.parseJsonEvent(rawJson);
      if (event) {
        events.push(event);
      }
    }
  }

  finishToolCalls(): Array<{ toolCallId: string; toolName: string; input: string }> {
    this.finalizeToolCall();
    return this.completedToolCalls.splice(0);
  }

  private findNextJsonStart(): number {
    const patterns = ['{"content":', '{"usage":', '{"name":', '{"input":', '{"stop":'];
    return patterns.reduce((nearest, pattern) => {
      const index = this.buffer.indexOf(pattern);
      if (index < 0) {
        return nearest;
      }
      return nearest < 0 || index < nearest ? index : nearest;
    }, -1);
  }

  private parseJsonEvent(rawJson: string): ParsedKiroEvent | null {
    const value = JSON.parse(rawJson) as JsonRecord;
    if (typeof value.content === "string" && value.followupPrompt !== true) {
      return { type: "content", content: value.content };
    }
    if (isRecord(value.usage)) {
      return { type: "usage", usage: mapUsage(value.usage) };
    }
    if (typeof value.name === "string") {
      this.finalizeToolCall();
      this.currentToolCall = {
        toolCallId: typeof value.toolUseId === "string" ? value.toolUseId : `tool-${Date.now()}`,
        toolName: value.name,
        input: initialToolInput(value.input),
      };
      if (value.stop === true) {
        this.finalizeToolCall();
      }
      return null;
    }
    if (Object.hasOwn(value, "input")) {
      if (this.currentToolCall) {
        this.currentToolCall.input +=
          typeof value.input === "string" ? value.input : JSON.stringify(value.input ?? {});
      }
      return null;
    }
    if (value.stop === true) {
      this.finalizeToolCall();
      return null;
    }
    return null;
  }

  private finalizeToolCall() {
    const toolCall = this.currentToolCall;
    if (!toolCall) {
      return null;
    }
    this.currentToolCall = undefined;
    const normalized = {
      ...toolCall,
      input: normalizeToolInput(toolCall.input),
    };
    this.completedToolCalls.push(normalized);
    return normalized;
  }
}

function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\" && inString) {
      escaping = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function normalizeToolInput(input: string): string {
  if (!input.trim()) {
    return "{}";
  }
  try {
    return JSON.stringify(JSON.parse(input));
  } catch {
    return "{}";
  }
}

function initialToolInput(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  if (isRecord(input) && Object.keys(input).length === 0) {
    return "";
  }
  return JSON.stringify(input ?? {});
}

function mapUsage(usage: JsonRecord): LanguageModelV2Usage {
  const inputTokens = getNumber(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = getNumber(usage.output_tokens ?? usage.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      getNumber(usage.total_tokens ?? usage.totalTokens) ?? sumUsage(inputTokens, outputTokens),
  };
}

function emptyUsage(): LanguageModelV2Usage {
  return {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
  };
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sumUsage(inputTokens: number | undefined, outputTokens: number | undefined) {
  return inputTokens !== undefined || outputTokens !== undefined
    ? (inputTokens ?? 0) + (outputTokens ?? 0)
    : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

async function collectStream(stream: ReadableStream<LanguageModelV2StreamPart>) {
  const reader = stream.getReader();
  const parts: LanguageModelV2StreamPart[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return parts;
    }
    parts.push(value);
  }
}

function headersToRecord(headers: Headers) {
  return Object.fromEntries(headers.entries());
}

function requireAccessToken(credentials: KiroOauthCredentials): KiroRuntimeCredentials {
  if (!credentials.accessToken) {
    throw new Error("Kiro OAuth refresh response did not include an access token.");
  }
  return credentials as KiroRuntimeCredentials;
}
