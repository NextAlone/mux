import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";

import {
  assertPiRuntimeCompatibility,
  buildPiTurnInput,
  PiAgentRuntimeService,
  type PiSessionAdapter,
  resolvePiBuiltInTools,
  resolvePiCodexModelId,
} from "./piAgentRuntime";
import { createMuxMessage } from "@/common/types/message";
import { createTestHistoryService } from "./testHistoryService";
import type { HistoryService } from "./historyService";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai/compat";
import { createOpenAIResponsesCompactionBoundaryMarker } from "./openaiResponsesCompactionReplay";

function getTestCodexAuth() {
  return Promise.resolve({
    type: "oauth" as const,
    access: "access",
    refresh: "refresh",
    expires: Date.now() + 60_000,
  });
}

describe("Pi agent runtime compatibility", () => {
  test("loads Pi runtime dependencies from the CommonJS backend", () => {
    const result = spawnSync(
      "node",
      ["-e", "require('@earendil-works/pi-ai'); require('@earendil-works/pi-coding-agent')"],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  test("maps direct OpenAI model strings to Pi's Codex provider model ids", () => {
    expect(resolvePiCodexModelId("openai:gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  test("rejects providers that cannot use the required Codex OAuth route", () => {
    expect(() => resolvePiCodexModelId("anthropic:claude-opus-4-6")).toThrow(
      "Pi agent runtime currently requires an openai:* Codex OAuth model"
    );
  });

  test("rejects an API-key remote compaction boundary before starting Pi", () => {
    expect(() =>
      assertPiRuntimeCompatibility({
        runtimeType: "worktree",
        remoteCompactionRoute: "openai-api-key",
      })
    ).toThrow("compacted with direct OpenAI API-key routing");
  });

  test("rejects runtimes whose filesystem is not local to the Pi worker", () => {
    expect(() =>
      assertPiRuntimeCompatibility({ runtimeType: "ssh", remoteCompactionRoute: null })
    ).toThrow("supports local and worktree workspaces");
  });

  test("uses the latest user message as the prompt and preserves earlier tool context", () => {
    const history = [
      createMuxMessage("u1", "user", "inspect the repo", { timestamp: 1 }),
      {
        ...createMuxMessage("a1", "assistant", "", { timestamp: 2, model: "openai:gpt-5.6-sol" }),
        parts: [
          {
            type: "dynamic-tool" as const,
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "pwd" },
            output: { text: "/workspace" },
            state: "output-available" as const,
          },
        ],
      },
      createMuxMessage("u2", "user", "continue", { timestamp: 3 }),
    ];

    const input = buildPiTurnInput(history, "gpt-5.6-sol");

    expect(input.prompt).toBe("continue");
    expect(input.context).toHaveLength(2);
    expect(JSON.stringify(input.context[1])).toContain("/workspace");
  });

  test("keeps Pi plan and explore agents read-only", () => {
    expect(resolvePiBuiltInTools("plan")).not.toContain("edit");
    expect(resolvePiBuiltInTools("explore")).not.toContain("bash");
    expect(resolvePiBuiltInTools("exec")).toBeUndefined();
  });
});

describe("PiAgentRuntimeService", () => {
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanup();
  });

  test("streams Pi text and tools through Mux events and commits one assistant row", async () => {
    const workspaceId = "pi-runtime-workspace";
    const user = createMuxMessage("user-1", "user", "run pwd", { timestamp: 1 });
    await historyService.appendToHistory(workspaceId, user);

    const listeners = new Set<(event: AgentSessionEvent) => void>();
    const state = { messages: [] as Message[] };
    const piToolCallId =
      "call_QIwSEaOnQppSthHiNLB14rIQ|fc_01665a15a5435180016a5f7a1ac3388191b02c21440319a755";
    let streamInfoDuringPrompt: ReturnType<PiAgentRuntimeService["getStreamInfo"]>;
    const finalAssistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      usage: {
        input: 12,
        output: 3,
        cacheRead: 4,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    };
    const session: PiSessionAdapter = {
      agent: { state, onPayload: undefined },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt() {
        for (const listener of listeners) {
          listener({
            type: "message_update",
            message: finalAssistant,
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "done",
              partial: finalAssistant,
            },
          });
          listener({
            type: "tool_execution_start",
            toolCallId: piToolCallId,
            toolName: "bash",
            args: { command: "pwd" },
          });
          listener({
            type: "tool_execution_end",
            toolCallId: piToolCallId,
            toolName: "bash",
            result: { content: [{ type: "text", text: "/workspace" }], details: {} },
            isError: false,
          });
          listener({ type: "message_end", message: finalAssistant });
        }
        streamInfoDuringPrompt = service.getStreamInfo(workspaceId);
        await service.replayStream(workspaceId);
      },
      abort: () => Promise.resolve(),
      dispose: () => undefined,
    };
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    let streamingAtEnd: boolean | undefined;
    let receivedModelId: string | undefined;
    let receivedAccessToken: string | undefined;
    let recordedInputTokens: number | undefined;
    const service = new PiAgentRuntimeService({
      historyService,
      getCodexAuth: getTestCodexAuth,
      createSession: (options) => {
        receivedModelId = options.modelId;
        receivedAccessToken = options.auth.access;
        return Promise.resolve(session);
      },
      recordUsage: (_workspaceId, _model, usage) => {
        recordedInputTokens = usage.inputTokens;
        return Promise.resolve();
      },
      emit: (_name, event) => {
        events.push(event);
        if (event.type === "stream-end") {
          streamingAtEnd = service.isStreaming(workspaceId);
        }
      },
    });

    const result = await service.stream({
      workspaceId,
      cwd: "/workspace",
      runtimeType: "worktree",
      messages: [user],
      modelString: "openai:gpt-5.6-sol",
      thinkingLevel: "high",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(events.map((event) => event.type)).toContain("stream-start");
    expect(events.map((event) => event.type)).toContain("stream-delta");
    expect(events.map((event) => event.type)).toContain("tool-call-end");
    const emittedToolCallIds = events
      .filter((event) => event.type.startsWith("tool-call"))
      .map((event) => event.toolCallId);
    expect(emittedToolCallIds).toHaveLength(6);
    expect(
      emittedToolCallIds.every((toolCallId) => toolCallId === "call_QIwSEaOnQppSthHiNLB14rIQ")
    ).toBe(true);
    expect(events.some((event) => event.type === "stream-start" && event.replay === true)).toBe(
      true
    );
    expect(events.at(-1)?.type).toBe("stream-end");
    expect(streamingAtEnd).toBe(false);
    expect(streamInfoDuringPrompt?.model).toBe("openai:gpt-5.6-sol");
    expect(
      streamInfoDuringPrompt?.parts.some((part) => part.type === "text" && part.text === "done")
    ).toBe(true);
    expect(receivedModelId).toBe("gpt-5.6-sol");
    expect(receivedAccessToken).toBe("access");
    expect(recordedInputTokens).toBe(12);

    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (!history.success) return;
    const assistant = history.data.find((message) => message.role === "assistant");
    expect(assistant?.metadata?.partial).toBe(false);
    expect(assistant?.parts.some((part) => part.type === "text" && part.text === "done")).toBe(
      true
    );
    expect(
      assistant?.parts.some(
        (part) =>
          part.type === "dynamic-tool" &&
          part.toolCallId === "call_QIwSEaOnQppSthHiNLB14rIQ" &&
          part.state === "output-available" &&
          JSON.stringify(part.output).includes("/workspace")
      )
    ).toBe(true);
  });

  test("honors an already-aborted turn without prompting Pi", async () => {
    const workspaceId = "pi-runtime-aborted";
    const user = createMuxMessage("user-1", "user", "do not run", { timestamp: 1 });
    await historyService.appendToHistory(workspaceId, user);
    const abortController = new AbortController();
    abortController.abort();
    let promptCalls = 0;
    let abortCalls = 0;
    const session: PiSessionAdapter = {
      agent: { state: { messages: [] } },
      subscribe: () => () => undefined,
      prompt() {
        promptCalls += 1;
        return Promise.resolve();
      },
      abort() {
        abortCalls += 1;
        return Promise.resolve();
      },
      dispose: () => undefined,
    };
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    const service = new PiAgentRuntimeService({
      historyService,
      getCodexAuth: getTestCodexAuth,
      createSession: () => Promise.resolve(session),
      emit: (_name, event) => events.push(event),
    });

    const result = await service.stream({
      workspaceId,
      cwd: "/workspace",
      runtimeType: "worktree",
      messages: [user],
      modelString: "openai:gpt-5.6-sol",
      abortSignal: abortController.signal,
    });

    expect(result.success).toBe(true);
    expect(promptCalls).toBe(0);
    expect(abortCalls).toBe(1);
    expect(events.at(-1)?.type).toBe("stream-abort");
  });

  test("reports an abort cleanup failure without retrying destructive history work", async () => {
    const workspaceId = "pi-runtime-abort-cleanup-error";
    const user = createMuxMessage("user-1", "user", "do not run", { timestamp: 1 });
    await historyService.appendToHistory(workspaceId, user);
    const abortController = new AbortController();
    abortController.abort();
    const deleteMessage = spyOn(historyService, "deleteMessage").mockResolvedValueOnce({
      success: false,
      error: "disk unavailable",
    });
    const session: PiSessionAdapter = {
      agent: { state: { messages: [] } },
      subscribe: () => () => undefined,
      prompt: () => Promise.resolve(),
      abort: () => Promise.resolve(),
      dispose: () => undefined,
    };
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    const service = new PiAgentRuntimeService({
      historyService,
      getCodexAuth: getTestCodexAuth,
      createSession: () => Promise.resolve(session),
      emit: (_name, event) => events.push(event),
    });

    const result = await service.stream({
      workspaceId,
      cwd: "/workspace",
      runtimeType: "worktree",
      messages: [user],
      modelString: "openai:gpt-5.6-sol",
      abortSignal: abortController.signal,
    });

    expect(result).toEqual({ success: false, error: { type: "unknown", raw: "disk unavailable" } });
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: "error", error: "disk unavailable" });
  });

  test("replays Mux Codex remote compaction into Pi's request payload", async () => {
    const workspaceId = "pi-runtime-compacted";
    const responseId = "resp_compacted";
    const compactedOutput = [
      { type: "compaction", id: "ci-1", encrypted_content: "opaque-context" },
    ];
    const summary = createMuxMessage("summary", "assistant", "context compacted", {
      timestamp: 1,
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
      muxMetadata: {
        type: "compaction-summary",
        remoteCompaction: {
          type: "openai-responses-compact",
          responseId,
          route: "codex-oauth",
          output: compactedOutput,
        },
      },
    });
    const user = createMuxMessage("user-1", "user", "continue", { timestamp: 2 });
    await historyService.appendToHistory(workspaceId, summary);
    await historyService.appendToHistory(workspaceId, user);

    const listeners = new Set<(event: AgentSessionEvent) => void>();
    const state = { messages: [] as Message[] };
    let rewrittenPayload: unknown;
    const finalAssistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "continued" }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 3,
    };
    const session: PiSessionAdapter = {
      agent: { state },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt() {
        rewrittenPayload = await session.agent.onPayload?.(
          {
            input: [
              {
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: createOpenAIResponsesCompactionBoundaryMarker(responseId),
                  },
                ],
              },
              { role: "user", content: [{ type: "input_text", text: "continue" }] },
            ],
          },
          finalAssistant as never
        );
        for (const listener of listeners) {
          listener({
            type: "message_update",
            message: finalAssistant,
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "continued",
              partial: finalAssistant,
            },
          });
          listener({ type: "message_end", message: finalAssistant });
        }
      },
      abort: () => Promise.resolve(),
      dispose: () => undefined,
    };
    const service = new PiAgentRuntimeService({
      historyService,
      getCodexAuth: getTestCodexAuth,
      createSession: () => Promise.resolve(session),
      emit: () => undefined,
    });

    const result = await service.stream({
      workspaceId,
      cwd: "/workspace",
      runtimeType: "worktree",
      messages: [summary, user],
      modelString: "openai:gpt-5.6-sol",
    });

    expect(result.success).toBe(true);
    expect(rewrittenPayload).toEqual({
      input: [
        ...compactedOutput,
        { role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    });
  });

  test("keeps streamed text as a recoverable partial when Pi fails", async () => {
    const workspaceId = "pi-runtime-error-partial";
    const user = createMuxMessage("user-1", "user", "start", { timestamp: 1 });
    await historyService.appendToHistory(workspaceId, user);
    const listeners = new Set<(event: AgentSessionEvent) => void>();
    const partialAssistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "provider disconnected",
      timestamp: 2,
    };
    const session: PiSessionAdapter = {
      agent: { state: { messages: [] } },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      prompt() {
        for (const listener of listeners) {
          listener({
            type: "message_update",
            message: partialAssistant,
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "partial",
              partial: partialAssistant,
            },
          });
        }
        return Promise.reject(new Error("provider disconnected"));
      },
      abort: () => Promise.resolve(),
      dispose: () => undefined,
    };
    const service = new PiAgentRuntimeService({
      historyService,
      getCodexAuth: getTestCodexAuth,
      createSession: () => Promise.resolve(session),
      emit: () => undefined,
    });

    const result = await service.stream({
      workspaceId,
      cwd: "/workspace",
      runtimeType: "worktree",
      messages: [user],
      modelString: "openai:gpt-5.6-sol",
    });

    expect(result.success).toBe(false);
    const partial = await historyService.readPartial(workspaceId);
    expect(partial?.parts.some((part) => part.type === "text" && part.text === "partial")).toBe(
      true
    );
    expect(partial?.metadata?.partial).toBe(true);
  });

  test("discards partial output when Mux stops Pi with abandonPartial", async () => {
    const workspaceId = "pi-runtime-abandon";
    const user = createMuxMessage("user-1", "user", "start", { timestamp: 1 });
    await historyService.appendToHistory(workspaceId, user);
    const listeners = new Set<(event: AgentSessionEvent) => void>();
    let releasePrompt: (() => void) | undefined;
    const promptBlocked = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    let promptStarted: (() => void) | undefined;
    const didStartPrompt = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    const partialAssistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "discard me" }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "aborted",
      timestamp: 2,
    };
    const session: PiSessionAdapter = {
      agent: { state: { messages: [] } },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt() {
        for (const listener of listeners) {
          listener({
            type: "message_update",
            message: partialAssistant,
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "discard me",
              partial: partialAssistant,
            },
          });
        }
        promptStarted?.();
        await promptBlocked;
      },
      abort() {
        releasePrompt?.();
        return Promise.resolve();
      },
      dispose: () => undefined,
    };
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    const service = new PiAgentRuntimeService({
      historyService,
      getCodexAuth: getTestCodexAuth,
      createSession: () => Promise.resolve(session),
      emit: (_name, event) => events.push(event),
    });

    const streamResultPromise = service.stream({
      workspaceId,
      cwd: "/workspace",
      runtimeType: "worktree",
      messages: [user],
      modelString: "openai:gpt-5.6-sol",
    });
    await didStartPrompt;
    await service.stop(workspaceId, { abandonPartial: true, abortReason: "system" });
    const streamResult = await streamResultPromise;

    expect(streamResult.success).toBe(true);
    expect(await historyService.readPartial(workspaceId)).toBeNull();
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (history.success) {
      expect(history.data.map((message) => message.id)).toEqual([user.id]);
    }
    expect(events.at(-1)).toMatchObject({
      type: "stream-abort",
      abortReason: "system",
      abandonPartial: true,
    });
  });
});
