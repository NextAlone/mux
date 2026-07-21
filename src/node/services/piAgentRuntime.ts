import type {
  OpenAIResponsesCompactionRoute,
  OpenAIResponsesRemoteCompactionState,
} from "@/common/utils/compaction/remotePolicy";
import type { RuntimeMode } from "@/common/types/runtime";
import type {
  MuxFilePart,
  MuxMessage,
  MuxReasoningPart,
  MuxTextPart,
  MuxToolPart,
} from "@/common/types/message";
import { createMuxMessage } from "@/common/types/message";
import {
  applyOpenAIResponsesCompactionReplayToBody,
  collectOpenAIResponsesCompactionReplays,
  getLatestOpenAIResponsesRemoteCompaction,
  markOpenAIResponsesCompactionBoundaries,
} from "./openaiResponsesCompactionReplay";
import {
  InMemoryCredentialStore,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type OAuthCredential,
} from "@earendil-works/pi-ai";
import type { Agent as PiAgent } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { CodexOauthAuth } from "@/node/utils/codexOauthAuth";
import type { HistoryService } from "./historyService";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { getErrorMessage } from "@/common/utils/errors";
import { createAssistantMessageId } from "./utils/messageIds";
import type { StreamAbortReason } from "@/common/types/stream";
import { createHash } from "node:crypto";
import { applyToolPolicyToNames, type ToolPolicy } from "@/common/utils/tools/toolPolicy";
import { filterSideQuestionMessages } from "@/common/utils/messages/sideQuestion";
import { filterWorkflowDisplayOnlyMessages } from "@/common/utils/workflowRunMessages";
import { sliceMessagesForProviderFromLatestContextBoundary } from "@/common/utils/messages/compactionBoundary";

export function resolvePiCodexModelId(modelString: string): string {
  const prefix = "openai:";
  const trimmed = modelString.trim();
  if (!trimmed.startsWith(prefix) || trimmed.length === prefix.length) {
    throw new Error("Pi agent runtime currently requires an openai:* Codex OAuth model");
  }
  return trimmed.slice(prefix.length);
}

export function resolvePiBuiltInTools(
  agentId: string | undefined,
  toolPolicy?: ToolPolicy
): string[] {
  if (agentId === "plan" || agentId === "explore") {
    return ["read", "grep", "find", "ls"];
  }

  const allowedMuxTools = new Set(
    applyToolPolicyToNames(
      ["file_read", "bash", "file_edit_replace_string", "file_edit_insert"],
      toolPolicy
    )
  );
  return [
    ...(allowedMuxTools.has("file_read") ? ["read"] : []),
    ...(allowedMuxTools.has("bash") ? ["bash"] : []),
    ...(allowedMuxTools.has("file_edit_replace_string") ? ["edit"] : []),
    ...(allowedMuxTools.has("file_edit_insert") ? ["write"] : []),
  ];
}

export function assertPiRuntimeCompatibility(params: {
  runtimeType: RuntimeMode;
  remoteCompactionRoute: OpenAIResponsesCompactionRoute | null;
}): void {
  if (params.runtimeType !== "local" && params.runtimeType !== "worktree") {
    throw new Error(
      "Pi agent runtime currently supports local and worktree workspaces; use the Mux runtime for SSH, Docker, or devcontainer workspaces"
    );
  }

  if (params.remoteCompactionRoute === "openai-api-key") {
    throw new Error(
      "This workspace context was compacted with direct OpenAI API-key routing. Reset context before using the Pi Codex OAuth runtime."
    );
  }
}

function stringifyToolValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatToolPart(part: MuxToolPart): string {
  const input = stringifyToolValue(part.input);
  if (part.state === "output-available") {
    return `[Tool ${part.toolName}]\nInput: ${input}\nResult: ${stringifyToolValue(part.output)}`;
  }
  if (part.state === "output-redacted") {
    return `[Tool ${part.toolName}]\nInput: ${input}\nResult: [redacted]`;
  }
  return `[Tool ${part.toolName}]\nInput: ${input}\nResult: [interrupted]`;
}

function decodeDataUrl(part: MuxFilePart): ImageContent | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(part.url);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    type: "image",
    mimeType: match[1],
    data: match[2],
  };
}

function getMessageTimestamp(message: MuxMessage): number {
  return message.metadata?.timestamp ?? 0;
}

function convertMuxMessageToPi(message: MuxMessage, modelId: string): Message | null {
  if (message.role === "system") {
    return null;
  }

  if (message.role === "user") {
    const content: Array<TextContent | ImageContent> = [];
    for (const part of message.parts) {
      if (part.type === "text" && part.text.length > 0) {
        content.push({ type: "text", text: part.text });
      } else if (part.type === "file") {
        const image = decodeDataUrl(part);
        if (image) content.push(image);
      }
    }
    if (content.length === 0) {
      return null;
    }
    return {
      role: "user",
      content: content.length === 1 && content[0]?.type === "text" ? content[0].text : content,
      timestamp: getMessageTimestamp(message),
    };
  }

  const content: TextContent[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && part.text.length > 0) {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "reasoning" && part.text.length > 0) {
      content.push({ type: "text", text: `[Reasoning]\n${part.text}` });
    } else if (part.type === "dynamic-tool") {
      content.push({ type: "text", text: formatToolPart(part) });
    }
  }
  if (content.length === 0) {
    return null;
  }
  return {
    role: "assistant",
    content,
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: modelId,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: getMessageTimestamp(message),
  };
}

export interface PiTurnInput {
  context: Message[];
  prompt: string;
  images: ImageContent[];
}

export function buildPiTurnInput(messages: readonly MuxMessage[], modelId: string): PiTurnInput {
  const preparedMessages = sliceMessagesForProviderFromLatestContextBoundary(
    filterWorkflowDisplayOnlyMessages(filterSideQuestionMessages([...messages]))
  );
  const latestUserIndex = preparedMessages.findLastIndex((message) => message.role === "user");
  const latestUser = preparedMessages[latestUserIndex];
  if (!latestUser) {
    throw new Error("Pi agent runtime requires a user message at the end of the active context");
  }

  const prompt = latestUser.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const images = latestUser.parts.flatMap((part) => {
    if (part.type !== "file") return [];
    const image = decodeDataUrl(part);
    return image ? [image] : [];
  });
  if (prompt.length === 0 && images.length === 0) {
    throw new Error("Pi agent runtime cannot send an empty user message");
  }

  const markedHistory = markOpenAIResponsesCompactionBoundaries(
    preparedMessages.slice(0, latestUserIndex)
  );
  const context = markedHistory.flatMap((message) => {
    const converted = convertMuxMessageToPi(message, modelId);
    return converted ? [converted] : [];
  });

  return { context, prompt, images };
}

interface PiAgentStateAdapter {
  messages: unknown[];
  systemPrompt?: string;
}

export interface PiSessionAdapter {
  agent: {
    state: PiAgentStateAdapter;
    onPayload?: PiAgent["onPayload"];
  };
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string, options?: { images?: ImageContent[] }): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

interface CreatePiSessionOptions {
  cwd: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  auth: CodexOauthAuth;
  agentId?: string;
  toolPolicy?: ToolPolicy;
  additionalSystemInstructions?: string;
  persistCodexAuth?: (expectedRefresh: string, auth: CodexOauthAuth) => Promise<void>;
}

function toCodexOauthAuth(credential: OAuthCredential): CodexOauthAuth {
  const accountId = credential.accountId;
  return {
    type: "oauth",
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    ...(typeof accountId === "string" && accountId.length > 0 ? { accountId } : {}),
  };
}

function isOAuthCredential(credential: Credential | undefined): credential is OAuthCredential {
  return credential?.type === "oauth";
}

export async function createPiCodexCredentialStore(
  auth: CodexOauthAuth,
  persistCodexAuth?: (expectedRefresh: string, auth: CodexOauthAuth) => Promise<void>
): Promise<CredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.modify("openai-codex", () => Promise.resolve({ ...auth }));

  return {
    read: (providerId: string): Promise<Credential | undefined> => store.read(providerId),
    list: (): Promise<readonly CredentialInfo[]> => store.list(),
    modify: async (
      providerId: string,
      fn: (current: Credential | undefined) => Promise<Credential | undefined>
    ): Promise<Credential | undefined> => {
      let previous: Credential | undefined;
      const next = await store.modify(providerId, async (current) => {
        previous = current;
        return await fn(current);
      });
      if (
        providerId === "openai-codex" &&
        persistCodexAuth &&
        isOAuthCredential(previous) &&
        isOAuthCredential(next) &&
        (next.access !== previous.access ||
          next.refresh !== previous.refresh ||
          next.expires !== previous.expires)
      ) {
        await persistCodexAuth(previous.refresh, toCodexOauthAuth(next));
      }
      return next;
    },
    delete: (providerId: string): Promise<void> => store.delete(providerId),
  };
}

export async function createEmbeddedPiResourceLoader(options: {
  cwd: string;
  agentDir?: string;
  additionalSystemInstructions?: string;
}): Promise<DefaultResourceLoader> {
  const settingsManager = SettingsManager.inMemory(
    { compaction: { enabled: false } },
    { projectTrusted: false }
  );
  const instruction = options.additionalSystemInstructions?.trim();
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir ?? getAgentDir(),
    settingsManager,
    // Mux owns project trust and extensions. Loading repository code here would
    // bypass that boundary before the agent turn starts.
    noExtensions: true,
    ...(instruction ? { appendSystemPrompt: [instruction] } : {}),
  });
  await loader.reload();
  return loader;
}

export interface PiAgentRuntimeDependencies {
  historyService: HistoryService;
  getCodexAuth: () => Promise<CodexOauthAuth>;
  emit: (eventName: string, event: { type: string; [key: string]: unknown }) => void;
  recordUsage?: (
    workspaceId: string,
    modelString: string,
    usage: LanguageModelV2Usage
  ) => Promise<void>;
  persistCodexAuth?: (expectedRefresh: string, auth: CodexOauthAuth) => Promise<void>;
  createSession?: (options: CreatePiSessionOptions) => Promise<PiSessionAdapter>;
}

export interface PiAgentRuntimeStreamOptions {
  workspaceId: string;
  cwd: string;
  runtimeType: RuntimeMode;
  messages: MuxMessage[];
  modelString: string;
  thinkingLevel?: ThinkingLevel;
  agentId?: string;
  toolPolicy?: ToolPolicy;
  acpPromptId?: string;
  additionalSystemInstructions?: string;
  abortSignal?: AbortSignal;
}

interface ActivePiTurn {
  session: PiSessionAdapter;
  messageId: string;
  model: string;
  historySequence: number;
  startTime: number;
  agentId?: string;
  thinkingLevel?: ThinkingLevel;
  parts: StreamPart[];
  textDeltaChunks: Map<TextualStreamPart, TextDeltaChunk[]>;
  toolCompletionTimestamps: Map<string, number>;
  requestAbort: (options?: PiAbortOptions) => Promise<void>;
}

type StreamPart = MuxTextPart | MuxReasoningPart | MuxToolPart;
type TextualStreamPart = MuxTextPart | MuxReasoningPart;
interface TextDeltaChunk {
  delta: string;
  timestamp: number;
}

interface PiAbortOptions {
  soft?: boolean;
  abandonPartial?: boolean;
  abortReason?: StreamAbortReason;
}

interface PiAbortState {
  abandonPartial: boolean;
  abortReason: StreamAbortReason;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function rewritePiPayloadForRemoteCompaction(
  payload: unknown,
  replays: Record<string, OpenAIResponsesRemoteCompactionState>
): unknown {
  let serialized: string;
  try {
    const candidate = JSON.stringify(payload);
    if (candidate == null) {
      throw new Error("empty serialization result");
    }
    serialized = candidate;
  } catch {
    throw new Error("Pi remote compaction payload could not be serialized");
  }

  const rewritten = applyOpenAIResponsesCompactionReplayToBody(serialized, replays);
  if (rewritten === serialized) {
    throw new Error("Pi remote compaction payload did not contain its boundary marker");
  }

  try {
    return JSON.parse(rewritten) as unknown;
  } catch {
    throw new Error("Pi remote compaction replay produced an invalid request payload");
  }
}

function getPiToolResultOutput(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return result;
  }
  return result.content
    .map((part) => {
      if (!isRecord(part)) return stringifyToolValue(part);
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "image") {
        const mimeType = typeof part.mimeType === "string" ? part.mimeType : "unknown";
        return `[image:${mimeType}]`;
      }
      return stringifyToolValue(part);
    })
    .join("\n");
}

function normalizePiToolCallId(toolCallId: string): string {
  const providerCallId = toolCallId.split("|", 1)[0] ?? toolCallId;
  if (providerCallId.length <= 64) {
    return providerCallId;
  }

  // Pi may combine the Responses call_id and item id. Mux later replays this value as
  // call_id, whose OpenAI boundary is 64 characters, so keep one stable bounded id.
  return `pi_${createHash("sha256").update(toolCallId).digest("hex").slice(0, 61)}`;
}

function addTextDelta(
  parts: StreamPart[],
  type: "text" | "reasoning",
  delta: string,
  timestamp: number
): TextualStreamPart | undefined {
  if (delta.length === 0) return undefined;
  const last = parts.at(-1);
  if (last?.type === type) {
    last.text += delta;
    return last;
  }
  const part: TextualStreamPart = { type, text: delta, timestamp };
  parts.push(part);
  return part;
}

function getPiLegacyMode(agentId: string | undefined): "plan" | "exec" | undefined {
  return agentId === "plan" || agentId === "exec" ? agentId : undefined;
}

function sumPiUsage(events: readonly AgentSessionEvent[]): {
  usage: LanguageModelV2Usage | undefined;
  contextUsage: LanguageModelV2Usage | undefined;
  finishReason: string | undefined;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let reasoningTokens = 0;
  let sawUsage = false;
  let contextUsage: LanguageModelV2Usage | undefined;
  let finishReason: string | undefined;
  for (const event of events) {
    if (event.type !== "message_end" || !isRecord(event.message)) continue;
    const message = event.message;
    if (message.role !== "assistant" || !isRecord(message.usage)) continue;
    const usage = message.usage;
    inputTokens += typeof usage.input === "number" ? usage.input : 0;
    outputTokens += typeof usage.output === "number" ? usage.output : 0;
    cachedInputTokens += typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
    reasoningTokens += typeof usage.reasoning === "number" ? usage.reasoning : 0;
    const stepInputTokens = typeof usage.input === "number" ? usage.input : 0;
    const stepOutputTokens = typeof usage.output === "number" ? usage.output : 0;
    const stepCachedInputTokens = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
    const stepReasoningTokens = typeof usage.reasoning === "number" ? usage.reasoning : 0;
    contextUsage = {
      inputTokens: stepInputTokens,
      outputTokens: stepOutputTokens,
      totalTokens: stepInputTokens + stepOutputTokens,
      ...(stepCachedInputTokens > 0 ? { cachedInputTokens: stepCachedInputTokens } : {}),
      ...(stepReasoningTokens > 0 ? { reasoningTokens: stepReasoningTokens } : {}),
    };
    finishReason = typeof message.stopReason === "string" ? message.stopReason : finishReason;
    sawUsage = true;
  }
  return {
    usage: sawUsage
      ? {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
          ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
        }
      : undefined,
    contextUsage,
    finishReason,
  };
}

async function createDefaultPiSession(options: CreatePiSessionOptions): Promise<PiSessionAdapter> {
  const credentials = await createPiCodexCredentialStore(options.auth, options.persistCodexAuth);
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const model = modelRuntime.getModel("openai-codex", options.modelId);
  if (!model) {
    throw new Error(`Pi does not provide the Codex OAuth model ${options.modelId}`);
  }

  const resourceLoader = await createEmbeddedPiResourceLoader({
    cwd: options.cwd,
    additionalSystemInstructions: options.additionalSystemInstructions,
  });

  const { session } = await createAgentSession({
    cwd: options.cwd,
    modelRuntime,
    model,
    thinkingLevel: options.thinkingLevel,
    tools: resolvePiBuiltInTools(options.agentId, options.toolPolicy),
    resourceLoader,
    sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager: SettingsManager.inMemory(
      { compaction: { enabled: false } },
      { projectTrusted: false }
    ),
  });

  return {
    agent: session.agent,
    subscribe: (listener) => session.subscribe(listener),
    prompt: (text, promptOptions) => session.prompt(text, promptOptions),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
  };
}

export class PiAgentRuntimeService {
  private readonly activeTurns = new Map<string, ActivePiTurn>();
  private readonly createSession: NonNullable<PiAgentRuntimeDependencies["createSession"]>;

  constructor(private readonly dependencies: PiAgentRuntimeDependencies) {
    this.createSession = dependencies.createSession ?? createDefaultPiSession;
  }

  isStreaming(workspaceId: string): boolean {
    return this.activeTurns.has(workspaceId);
  }

  getStreamInfo(workspaceId: string):
    | {
        messageId: string;
        model: string;
        historySequence: number;
        startTime: number;
        parts: StreamPart[];
        toolCompletionTimestamps: Map<string, number>;
      }
    | undefined {
    const turn = this.activeTurns.get(workspaceId);
    if (!turn) return undefined;
    return {
      messageId: turn.messageId,
      model: turn.model,
      historySequence: turn.historySequence,
      startTime: turn.startTime,
      parts: turn.parts,
      toolCompletionTimestamps: turn.toolCompletionTimestamps,
    };
  }

  async stop(workspaceId: string, options?: PiAbortOptions): Promise<void> {
    await this.activeTurns.get(workspaceId)?.requestAbort(options);
  }

  replayStream(workspaceId: string, options?: { afterTimestamp?: number }): Promise<void> {
    const turn = this.activeTurns.get(workspaceId);
    if (!turn) return Promise.resolve();

    this.dependencies.emit("stream-start", {
      type: "stream-start",
      workspaceId,
      messageId: turn.messageId,
      model: turn.model,
      historySequence: turn.historySequence,
      startTime: turn.startTime,
      replay: true,
      agentId: turn.agentId,
      mode: getPiLegacyMode(turn.agentId),
      thinkingLevel: turn.thinkingLevel,
    });

    const parts = turn.parts.slice();
    for (const part of parts) {
      if (part.type === "text" || part.type === "reasoning") {
        const chunks = turn.textDeltaChunks.get(part) ?? [
          { delta: part.text, timestamp: part.timestamp ?? turn.startTime },
        ];
        const replayChunks = chunks.filter(
          (chunk) => options?.afterTimestamp == null || chunk.timestamp > options.afterTimestamp
        );
        for (const chunk of replayChunks) {
          this.dependencies.emit(part.type === "text" ? "stream-delta" : "reasoning-delta", {
            type: part.type === "text" ? "stream-delta" : "reasoning-delta",
            workspaceId,
            messageId: turn.messageId,
            delta: chunk.delta,
            tokens: 0,
            timestamp: chunk.timestamp,
            replay: true,
          });
        }
        if (part.type === "reasoning" && replayChunks.length > 0) {
          this.dependencies.emit("reasoning-end", {
            type: "reasoning-end",
            workspaceId,
            messageId: turn.messageId,
            replay: true,
          });
        }
        continue;
      }

      const completionTimestamp = turn.toolCompletionTimestamps.get(part.toolCallId);
      if (
        options?.afterTimestamp != null &&
        (part.timestamp ?? completionTimestamp ?? 0) <= options.afterTimestamp &&
        (completionTimestamp ?? 0) <= options.afterTimestamp
      ) {
        continue;
      }

      this.dependencies.emit("tool-call-start", {
        type: "tool-call-start",
        workspaceId,
        messageId: turn.messageId,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: part.input,
        tokens: 0,
        timestamp: part.timestamp ?? Date.now(),
        executionStartedAt: part.executionStartedAt,
        replay: true,
      });
      if (part.executionStartedAt != null) {
        this.dependencies.emit("tool-call-execution-start", {
          type: "tool-call-execution-start",
          workspaceId,
          messageId: turn.messageId,
          toolCallId: part.toolCallId,
          timestamp: part.executionStartedAt,
        });
      }
      if (part.state !== "input-available") {
        this.dependencies.emit("tool-call-end", {
          type: "tool-call-end",
          workspaceId,
          messageId: turn.messageId,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: part.state === "output-available" ? part.output : "[redacted]",
          timestamp: completionTimestamp ?? part.timestamp ?? Date.now(),
          replay: true,
        });
      }
    }
    return Promise.resolve();
  }

  async stream(options: PiAgentRuntimeStreamOptions): Promise<Result<void, SendMessageError>> {
    if (this.activeTurns.has(options.workspaceId)) {
      return Err({
        type: "unknown",
        raw: "Pi agent runtime is already streaming in this workspace",
      });
    }

    const modelId = resolvePiCodexModelId(options.modelString);
    const remoteCompaction = getLatestOpenAIResponsesRemoteCompaction(options.messages);
    assertPiRuntimeCompatibility({
      runtimeType: options.runtimeType,
      remoteCompactionRoute: remoteCompaction?.route ?? null,
    });
    const turnInput = buildPiTurnInput(options.messages, modelId);
    const auth = await this.dependencies.getCodexAuth();
    const session = await this.createSession({
      cwd: options.cwd,
      modelId,
      thinkingLevel: options.thinkingLevel ?? "medium",
      auth,
      persistCodexAuth: this.dependencies.persistCodexAuth,
      agentId: options.agentId,
      toolPolicy: options.toolPolicy,
      additionalSystemInstructions: options.additionalSystemInstructions,
    });
    session.agent.state.messages = turnInput.context;

    const replays = collectOpenAIResponsesCompactionReplays(options.messages);
    if (Object.keys(replays).length > 0) {
      const previousOnPayload = session.agent.onPayload;
      session.agent.onPayload = async (payload, model) => {
        const preparedPayload = (await previousOnPayload?.(payload, model)) ?? payload;
        return rewritePiPayloadForRemoteCompaction(preparedPayload, replays);
      };
    }

    const messageId = createAssistantMessageId();
    const startTime = Date.now();
    let latestEventTimestamp = startTime;
    const nextEventTimestamp = (): number => {
      latestEventTimestamp = Math.max(Date.now(), latestEventTimestamp + 1);
      return latestEventTimestamp;
    };
    const assistant = createMuxMessage(messageId, "assistant", "", {
      timestamp: startTime,
      model: options.modelString,
      agentId: options.agentId,
      mode: getPiLegacyMode(options.agentId),
    });
    const appendResult = await this.dependencies.historyService.appendToHistory(
      options.workspaceId,
      assistant
    );
    if (!appendResult.success) {
      session.dispose();
      return Err({ type: "unknown", raw: appendResult.error });
    }
    const historySequence = assistant.metadata?.historySequence ?? 0;
    const parts: StreamPart[] = [];
    const textDeltaChunks = new Map<TextualStreamPart, TextDeltaChunk[]>();
    const toolCompletionTimestamps = new Map<string, number>();
    const sessionEvents: AgentSessionEvent[] = [];
    let pendingPartialSnapshot: MuxMessage | undefined;
    let partialWriterRunning = false;
    let partialWriteError: Error | undefined;
    let partialWriterPromise = Promise.resolve();
    let aborted = false;
    let softAbortPending = false;
    let abortPromise: Promise<void> | undefined;
    const abortState: PiAbortState = {
      abandonPartial: false,
      abortReason: "user",
    };

    const emit = (event: { type: string; [key: string]: unknown }): void => {
      this.dependencies.emit(event.type, event);
    };
    const schedulePartialWrite = (): void => {
      if (partialWriteError) return;
      pendingPartialSnapshot = {
        ...assistant,
        parts: parts.map((part) => ({ ...part })),
        metadata: {
          ...assistant.metadata,
          partial: true,
          duration: Date.now() - startTime,
        },
      };
      if (partialWriterRunning) return;

      partialWriterRunning = true;
      partialWriterPromise = (async () => {
        while (pendingPartialSnapshot) {
          const snapshot = pendingPartialSnapshot;
          pendingPartialSnapshot = undefined;
          const result = await this.dependencies.historyService.writePartial(
            options.workspaceId,
            snapshot
          );
          if (!result.success) {
            throw new Error(result.error);
          }
        }
      })()
        .catch((error: unknown) => {
          partialWriteError = new Error(getErrorMessage(error));
          pendingPartialSnapshot = undefined;
        })
        .finally(() => {
          partialWriterRunning = false;
          if (pendingPartialSnapshot && !partialWriteError) {
            schedulePartialWrite();
          }
        });
    };
    const flushPartialWrites = async (): Promise<void> => {
      while (partialWriterRunning || pendingPartialSnapshot) {
        await partialWriterPromise;
      }
      if (partialWriteError) {
        throw partialWriteError;
      }
    };
    const beginAbort = (): Promise<void> => {
      aborted = true;
      softAbortPending = false;
      abortPromise ??= session.abort().catch(() => undefined);
      return abortPromise;
    };
    const requestAbort = (abortOptions?: PiAbortOptions): Promise<void> => {
      if (abortOptions?.abandonPartial != null) {
        abortState.abandonPartial = abortOptions.abandonPartial;
      }
      if (abortOptions?.abortReason != null) {
        abortState.abortReason = abortOptions.abortReason;
      }
      if (abortOptions?.soft && !aborted) {
        softAbortPending = true;
        return Promise.resolve();
      }
      return beginAbort();
    };
    const checkSoftAbortBoundary = (): void => {
      if (!softAbortPending) return;
      abortPromise = beginAbort();
    };
    const unsubscribe = session.subscribe((event) => {
      sessionEvents.push(event);
      const timestamp = nextEventTimestamp();
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          const part = addTextDelta(parts, "text", update.delta, timestamp);
          if (part) {
            const chunks = textDeltaChunks.get(part) ?? [];
            chunks.push({ delta: update.delta, timestamp });
            textDeltaChunks.set(part, chunks);
          }
          schedulePartialWrite();
          emit({
            type: "stream-delta",
            workspaceId: options.workspaceId,
            messageId,
            delta: update.delta,
            tokens: 0,
            timestamp,
          });
        } else if (update.type === "thinking_delta") {
          const part = addTextDelta(parts, "reasoning", update.delta, timestamp);
          if (part) {
            const chunks = textDeltaChunks.get(part) ?? [];
            chunks.push({ delta: update.delta, timestamp });
            textDeltaChunks.set(part, chunks);
          }
          schedulePartialWrite();
          emit({
            type: "reasoning-delta",
            workspaceId: options.workspaceId,
            messageId,
            delta: update.delta,
            tokens: 0,
            timestamp,
          });
        } else if (update.type === "thinking_end") {
          emit({ type: "reasoning-end", workspaceId: options.workspaceId, messageId });
          checkSoftAbortBoundary();
        } else if (update.type === "text_end") {
          checkSoftAbortBoundary();
        }
        return;
      }
      if (event.type === "message_end") {
        checkSoftAbortBoundary();
        return;
      }
      if (event.type === "tool_execution_start") {
        const toolCallId = normalizePiToolCallId(event.toolCallId);
        parts.push({
          type: "dynamic-tool",
          toolCallId,
          toolName: event.toolName,
          input: event.args,
          state: "input-available",
          timestamp,
          executionStartedAt: timestamp,
        });
        schedulePartialWrite();
        emit({
          type: "tool-call-start",
          workspaceId: options.workspaceId,
          messageId,
          toolCallId,
          toolName: event.toolName,
          args: event.args,
          tokens: 0,
          timestamp,
          executionStartedAt: timestamp,
        });
        emit({
          type: "tool-call-execution-start",
          workspaceId: options.workspaceId,
          messageId,
          toolCallId,
          timestamp,
        });
        return;
      }
      if (event.type === "tool_execution_update") {
        const toolCallId = normalizePiToolCallId(event.toolCallId);
        emit({
          type: "tool-call-delta",
          workspaceId: options.workspaceId,
          messageId,
          toolCallId,
          toolName: event.toolName,
          delta: getPiToolResultOutput(event.partialResult),
          tokens: 0,
          timestamp,
        });
        return;
      }
      if (event.type === "tool_execution_end") {
        const toolCallId = normalizePiToolCallId(event.toolCallId);
        toolCompletionTimestamps.set(toolCallId, timestamp);
        const index = parts.findIndex(
          (part) => part.type === "dynamic-tool" && part.toolCallId === toolCallId
        );
        const pending = index >= 0 ? parts[index] : undefined;
        const completed: MuxToolPart = {
          type: "dynamic-tool",
          toolCallId,
          toolName: event.toolName,
          input: pending?.type === "dynamic-tool" ? pending.input : {},
          output: getPiToolResultOutput(event.result),
          state: "output-available",
          ...(event.isError ? { failed: true } : {}),
          timestamp: pending?.timestamp ?? timestamp,
          executionStartedAt:
            pending?.type === "dynamic-tool" ? pending.executionStartedAt : timestamp,
        };
        if (index >= 0) parts[index] = completed;
        else parts.push(completed);
        schedulePartialWrite();
        emit({
          type: "tool-call-end",
          workspaceId: options.workspaceId,
          messageId,
          toolCallId,
          toolName: event.toolName,
          result: completed.output,
          timestamp,
        });
        checkSoftAbortBoundary();
      }
    });
    const abortListener = (): void => {
      abortPromise = requestAbort();
    };
    options.abortSignal?.addEventListener("abort", abortListener, { once: true });
    if (options.abortSignal?.aborted) {
      abortListener();
    }
    this.activeTurns.set(options.workspaceId, {
      session,
      messageId,
      model: options.modelString,
      historySequence,
      startTime,
      agentId: options.agentId,
      thinkingLevel: options.thinkingLevel,
      parts,
      textDeltaChunks,
      toolCompletionTimestamps,
      requestAbort,
    });
    let turnCleanedUp = false;
    const cleanupTurn = (): void => {
      if (turnCleanedUp) return;
      turnCleanedUp = true;
      options.abortSignal?.removeEventListener("abort", abortListener);
      unsubscribe();
      session.dispose();
      this.activeTurns.delete(options.workspaceId);
    };
    const completeAbort = async (): Promise<Result<void, SendMessageError>> => {
      try {
        await flushPartialWrites();
        const usageResult = sumPiUsage(sessionEvents);
        if (usageResult.usage) {
          await this.dependencies.recordUsage?.(
            options.workspaceId,
            options.modelString,
            usageResult.usage
          );
        }
        cleanupTurn();
        await this.finishAbort(options, assistant, parts, startTime, abortState, usageResult);
        return Ok(undefined);
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        emit({
          type: "error",
          workspaceId: options.workspaceId,
          messageId,
          error: errorMessage,
          errorType: "unknown",
          acpPromptId: options.acpPromptId,
        });
        return Err({ type: "unknown", raw: errorMessage });
      }
    };
    emit({
      type: "stream-start",
      workspaceId: options.workspaceId,
      messageId,
      model: options.modelString,
      historySequence,
      startTime,
      agentId: options.agentId,
      mode: getPiLegacyMode(options.agentId),
      thinkingLevel: options.thinkingLevel,
      acpPromptId: options.acpPromptId,
    });

    try {
      if (!aborted) {
        await session.prompt(turnInput.prompt, {
          ...(turnInput.images.length > 0 ? { images: turnInput.images } : {}),
        });
      }
      await abortPromise;
      if (aborted) {
        return await completeAbort();
      }

      await flushPartialWrites();
      const usageResult = sumPiUsage(sessionEvents);
      const finalMessage: MuxMessage = {
        ...assistant,
        parts,
        metadata: {
          ...assistant.metadata,
          model: options.modelString,
          agentId: options.agentId,
          mode: getPiLegacyMode(options.agentId),
          usage: usageResult.usage,
          contextUsage: usageResult.contextUsage,
          finishReason: usageResult.finishReason,
          duration: Date.now() - startTime,
          ttftMs: undefined,
          partial: false,
        },
      };
      const writeResult = await this.dependencies.historyService.writePartial(
        options.workspaceId,
        finalMessage
      );
      if (!writeResult.success) {
        throw new Error(writeResult.error);
      }
      // Keep a crash-recovery snapshot until the durable history row is finalized. commitPartial()
      // intentionally preserves partial:true, so successful streams must update the placeholder
      // directly before removing the recovery file.
      const updateResult = await this.dependencies.historyService.updateHistory(
        options.workspaceId,
        finalMessage
      );
      if (!updateResult.success) {
        throw new Error(updateResult.error);
      }
      const deletePartialResult = await this.dependencies.historyService.deletePartial(
        options.workspaceId
      );
      if (!deletePartialResult.success) {
        throw new Error(deletePartialResult.error);
      }
      if (usageResult.usage) {
        await this.dependencies.recordUsage?.(
          options.workspaceId,
          options.modelString,
          usageResult.usage
        );
      }
      cleanupTurn();
      emit({
        type: "stream-end",
        workspaceId: options.workspaceId,
        messageId,
        acpPromptId: options.acpPromptId,
        metadata: finalMessage.metadata ?? {},
        parts,
      });
      return Ok(undefined);
    } catch (error) {
      if (aborted) {
        return await completeAbort();
      }
      let errorMessage = getErrorMessage(error);
      const usageResult = sumPiUsage(sessionEvents);
      if (usageResult.usage) {
        await this.dependencies.recordUsage?.(
          options.workspaceId,
          options.modelString,
          usageResult.usage
        );
      }
      if (parts.length === 0) {
        const deleteResult = await this.dependencies.historyService.deleteMessage(
          options.workspaceId,
          messageId
        );
        if (!deleteResult.success) {
          errorMessage = `${errorMessage}; failed to remove empty assistant placeholder: ${deleteResult.error}`;
        }
      } else {
        const writeResult = await this.dependencies.historyService.writePartial(
          options.workspaceId,
          {
            ...assistant,
            parts,
            metadata: {
              ...assistant.metadata,
              partial: true,
              error: errorMessage,
              errorType: "unknown",
              usage: usageResult.usage,
              contextUsage: usageResult.contextUsage,
              finishReason: usageResult.finishReason,
              duration: Date.now() - startTime,
            },
          }
        );
        if (!writeResult.success) {
          errorMessage = `${errorMessage}; failed to persist partial response: ${writeResult.error}`;
        }
      }
      cleanupTurn();
      emit({
        type: "error",
        workspaceId: options.workspaceId,
        messageId,
        error: errorMessage,
        errorType: "unknown",
        acpPromptId: options.acpPromptId,
      });
      return Err({ type: "unknown", raw: errorMessage });
    } finally {
      cleanupTurn();
    }
  }

  private async finishAbort(
    options: PiAgentRuntimeStreamOptions,
    assistant: MuxMessage,
    parts: StreamPart[],
    startTime: number,
    abortState: PiAbortState,
    usageResult: ReturnType<typeof sumPiUsage>
  ): Promise<void> {
    if (abortState.abandonPartial) {
      const deletePartialResult = await this.dependencies.historyService.deletePartial(
        options.workspaceId
      );
      if (!deletePartialResult.success) {
        throw new Error(deletePartialResult.error);
      }
      const deleteMessageResult = await this.dependencies.historyService.deleteMessage(
        options.workspaceId,
        assistant.id
      );
      if (!deleteMessageResult.success) {
        throw new Error(deleteMessageResult.error);
      }
    } else if (parts.length > 0) {
      const writeResult = await this.dependencies.historyService.writePartial(options.workspaceId, {
        ...assistant,
        parts,
        metadata: {
          ...assistant.metadata,
          partial: true,
          usage: usageResult.usage,
          contextUsage: usageResult.contextUsage,
          finishReason: usageResult.finishReason,
          duration: Date.now() - startTime,
        },
      });
      if (!writeResult.success) {
        throw new Error(writeResult.error);
      }
      const commitResult = await this.dependencies.historyService.commitPartial(
        options.workspaceId
      );
      if (!commitResult.success) {
        throw new Error(commitResult.error);
      }
    } else {
      const deleteMessageResult = await this.dependencies.historyService.deleteMessage(
        options.workspaceId,
        assistant.id
      );
      if (!deleteMessageResult.success) {
        throw new Error(deleteMessageResult.error);
      }
    }
    this.dependencies.emit("stream-abort", {
      type: "stream-abort",
      workspaceId: options.workspaceId,
      messageId: assistant.id,
      abortReason: abortState.abortReason,
      metadata: {
        duration: Date.now() - startTime,
        usage: usageResult.usage,
        contextUsage: usageResult.contextUsage,
        finishReason: usageResult.finishReason,
      },
      abandonPartial: abortState.abandonPartial,
      acpPromptId: options.acpPromptId,
    });
  }
}
