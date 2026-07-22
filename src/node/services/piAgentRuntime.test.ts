import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import {
  assertPiRuntimeCompatibility,
  buildPiTurnInput,
  createPiToolDefinitions,
  createPiCodexCredentialStore,
  createEmbeddedPiResourceLoader,
  PiAgentRuntimeService,
  type PiSessionAdapter,
  partitionPiCompatibleMuxTools,
  resolvePiBuiltInTools,
  resolvePiCodexModelId,
  rewritePiPayloadForRemoteCompaction,
} from "./piAgentRuntime";
import { jsonSchema, tool } from "ai";
import { z } from "zod";
import { createMuxMessage } from "@/common/types/message";
import { createTestHistoryService } from "./testHistoryService";
import type { HistoryService } from "./historyService";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai/compat";
import { createOpenAIResponsesCompactionBoundaryMarker } from "./openaiResponsesCompactionReplay";
import { DisposableTempDir } from "./tempDir";
import type { CodexOauthAuth } from "@/node/utils/codexOauthAuth";

function validPiAuth(): CodexOauthAuth {
  return {
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires: Date.now() + 60_000,
  };
}

function getTestCodexAuth(): Promise<CodexOauthAuth> {
  return Promise.resolve(validPiAuth());
}

describe("Pi agent runtime compatibility", () => {
  test("bridges Mux tools into Pi while preserving schema, cancellation, and call identity", async () => {
    let received:
      | { input: unknown; toolCallId: string; abortSignal: AbortSignal | undefined }
      | undefined;
    const muxTool = tool({
      description: "Echo one value",
      inputSchema: z.object({ value: z.string() }),
      execute: (input, options) => {
        received = {
          input,
          toolCallId: options.toolCallId,
          abortSignal: options.abortSignal,
        };
        return { echoed: input.value };
      },
    });
    const [definition] = await createPiToolDefinitions({ echo: muxTool });
    const abortController = new AbortController();
    const longCallId = `${"call_"}${"x".repeat(80)}|item`;

    expect(definition?.name).toBe("echo");
    expect(definition?.description).toBe("Echo one value");
    expect(definition?.parameters).toMatchObject({
      type: "object",
      required: ["value"],
    });
    const result = await definition?.execute(
      longCallId,
      { value: "hello" },
      abortController.signal,
      undefined,
      {} as never
    );

    expect(received?.input).toEqual({ value: "hello" });
    expect(received?.toolCallId).toMatch(/^pi_[a-f0-9]{61}$/);
    expect(received?.abortSignal).toBe(abortController.signal);
    expect(result?.content).toEqual([{ type: "text", text: '{"echoed":"hello"}' }]);
  });

  test("forwards streaming Mux tool snapshots through Pi and returns the latest result", async () => {
    const streamingTool = tool({
      description: "Stream progress",
      inputSchema: z.object({}),
      async *execute() {
        await Promise.resolve();
        yield { progress: 1, success: false };
        yield { progress: 2, success: true };
      },
    });
    const [definition] = await createPiToolDefinitions(
      { agent_report: streamingTool },
      { toolPolicy: [{ regex_match: "^agent_report$", action: "require" }] }
    );
    const updates: unknown[] = [];

    const result = await definition?.execute(
      "call-1",
      {},
      new AbortController().signal,
      (update) => updates.push(update),
      {} as never
    );

    expect(updates).toEqual([
      {
        content: [{ type: "text", text: '{"progress":1,"success":false}' }],
        details: { output: { progress: 1, success: false } },
        terminate: false,
      },
      {
        content: [{ type: "text", text: '{"progress":2,"success":true}' }],
        details: { output: { progress: 2, success: true } },
        terminate: false,
      },
    ]);
    expect(result).toEqual({
      content: [{ type: "text", text: '{"progress":2,"success":true}' }],
      details: { output: { progress: 2, success: true } },
      terminate: true,
    });
  });

  test("refreshes Pi active tools after a Mux catalog tool changes activation state", async () => {
    let refreshCount = 0;
    const catalogTool = tool({
      description: "Activate a deferred tool",
      inputSchema: z.object({ query: z.string() }),
      execute: () => ({ activated: ["deferred_tool"] }),
    });
    const [definition] = await createPiToolDefinitions(
      { tool_catalog_search: catalogTool },
      { onAfterExecute: () => refreshCount++ }
    );

    await definition?.execute(
      "call-1",
      { query: "deferred" },
      new AbortController().signal,
      undefined,
      {} as never
    );

    expect(refreshCount).toBe(1);
  });

  test("preserves Mux required-tool stop and sequential execution semantics", async () => {
    let succeeds = true;
    const reportTool = tool({
      description: "Submit the child report",
      inputSchema: z.object({ reportMarkdown: z.string() }),
      execute: () => (succeeds ? { success: true } : { success: false, error: "retry" }),
    });
    const [definition] = await createPiToolDefinitions(
      { agent_report: reportTool },
      { toolPolicy: [{ regex_match: "^agent_report$", action: "require" }] }
    );

    expect(definition?.executionMode).toBe("sequential");
    const successResult = await definition?.execute(
      "call-1",
      { reportMarkdown: "done" },
      new AbortController().signal,
      undefined,
      {} as never
    );
    expect(successResult?.terminate).toBe(true);

    succeeds = false;
    const failedResult = await definition?.execute(
      "call-2",
      { reportMarkdown: "retry" },
      new AbortController().signal,
      undefined,
      {} as never
    );
    expect(failedResult?.terminate).toBe(false);
  });

  test("wraps OpenAI custom string tools in an object schema for Pi function calling", async () => {
    let receivedSource: unknown;
    const execTool = tool({
      description: "Execute source",
      inputSchema: jsonSchema<string>({ type: "string" }),
      execute: (source) => {
        receivedSource = source;
        return "ok";
      },
    });
    const [definition] = await createPiToolDefinitions({ exec: execTool });

    expect(definition?.parameters).toMatchObject({
      type: "object",
      required: ["source"],
      properties: { source: { type: "string" } },
    });
    await definition?.execute(
      "call-1",
      { source: "return 1;" },
      new AbortController().signal,
      undefined,
      {} as never
    );
    expect(receivedSource).toBe("return 1;");
  });

  test("rejects tools that Pi cannot execute instead of advertising a broken capability", async () => {
    const muxTool = tool({
      description: "Provider-only tool",
      inputSchema: z.object({}),
    });

    let errorMessage = "";
    try {
      await createPiToolDefinitions({ provider_only: muxTool });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    expect(errorMessage).toContain("provider_only");
  });

  test("partitions provider-native tools before constructing a Pi session", () => {
    const executable = tool({
      description: "Executable",
      inputSchema: z.object({}),
      execute: () => "ok",
    });
    const providerOnly = tool({
      description: "Provider-only",
      inputSchema: z.object({}),
    });

    expect(partitionPiCompatibleMuxTools({ executable, web_search: providerOnly })).toEqual({
      tools: { executable },
      unsupportedToolNames: ["web_search"],
    });
  });

  test("persists OAuth credentials rotated by Pi without rewriting the initial seed", async () => {
    const persisted: Array<{ expectedRefresh: string; auth: ReturnType<typeof validPiAuth> }> = [];
    const auth = validPiAuth();
    const store = await createPiCodexCredentialStore(auth, (expectedRefresh, nextAuth) => {
      persisted.push({ expectedRefresh, auth: nextAuth });
      return Promise.resolve();
    });

    expect(persisted).toEqual([]);
    await store.modify("openai-codex", () =>
      Promise.resolve({
        type: "oauth",
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: auth.expires + 60_000,
        accountId: "account-1",
      })
    );

    expect(persisted).toEqual([
      {
        expectedRefresh: "refresh",
        auth: {
          type: "oauth",
          access: "rotated-access",
          refresh: "rotated-refresh",
          expires: auth.expires + 60_000,
          accountId: "account-1",
        },
      },
    ]);
  });

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

  test.each([
    {
      name: "PDF data URL",
      file: {
        type: "file" as const,
        mediaType: "application/pdf",
        url: "data:application/pdf;base64,JVBERi0xLjQ=",
      },
    },
    {
      name: "hosted image URL",
      file: {
        type: "file" as const,
        mediaType: "image/png",
        url: "https://example.com/image.png",
      },
    },
  ])("rejects an unsupported $name instead of silently dropping it", ({ file }) => {
    const message = createMuxMessage("latest", "user", "inspect this attachment");
    message.parts.push(file);

    expect(() => buildPiTurnInput([message], "gpt-5.6-sol")).toThrow(/image attachment/i);
  });

  test("excludes side questions and history before the latest context boundary", () => {
    const history = [
      createMuxMessage("old", "user", "obsolete context", { timestamp: 1 }),
      createMuxMessage("summary", "assistant", "compacted context", {
        timestamp: 2,
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      createMuxMessage("aside-user", "user", "private aside", {
        timestamp: 3,
        muxMetadata: { type: "side-question", rawCommand: "/btw private aside" },
      }),
      createMuxMessage("aside-answer", "assistant", "aside answer", {
        timestamp: 4,
        muxMetadata: { type: "side-question-answer", questionMessageId: "aside-user" },
      }),
      createMuxMessage("latest", "user", "continue", { timestamp: 5 }),
    ];

    const input = buildPiTurnInput(history, "gpt-5.6-sol");
    const serializedContext = JSON.stringify(input.context);

    expect(input.prompt).toBe("continue");
    expect(serializedContext).toContain("compacted context");
    expect(serializedContext).not.toContain("obsolete context");
    expect(serializedContext).not.toContain("private aside");
    expect(serializedContext).not.toContain("aside answer");
  });

  test("keeps Pi plan and explore agents read-only", () => {
    expect(resolvePiBuiltInTools("plan")).not.toContain("edit");
    expect(resolvePiBuiltInTools("explore")).not.toContain("bash");
    expect(resolvePiBuiltInTools("exec")).toEqual(["read", "bash", "edit", "write"]);
  });

  test("maps Mux caller tool policy onto Pi built-in tools", () => {
    expect(
      resolvePiBuiltInTools("exec", [
        { regex_match: ".*", action: "disable" },
        { regex_match: "file_read", action: "enable" },
      ])
    ).toEqual(["read"]);
  });

  test("does not execute project-local Pi extensions", async () => {
    using cwd = new DisposableTempDir("pi-runtime-untrusted-extension");
    using agentDir = new DisposableTempDir("pi-runtime-agent-dir");
    const markerPath = path.join(cwd.path, "extension-loaded");
    const extensionDir = path.join(cwd.path, ".pi", "extensions");
    await fs.mkdir(extensionDir, { recursive: true });
    await fs.writeFile(
      path.join(extensionDir, "untrusted.ts"),
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(markerPath)}, "loaded"); export default () => {};`
    );

    const loader = await createEmbeddedPiResourceLoader({
      cwd: cwd.path,
      agentDir: agentDir.path,
    });

    expect(loader.getExtensions().extensions).toHaveLength(0);
    expect(Bun.file(markerPath).exists()).resolves.toBe(false);
  });

  test("does not merge Pi skills, prompts, themes, or context files into Mux-owned agents", async () => {
    using cwd = new DisposableTempDir("pi-runtime-mux-owned-resources");
    using agentDir = new DisposableTempDir("pi-runtime-agent-resources");
    await fs.mkdir(path.join(agentDir.path, "skills", "foreign"), { recursive: true });
    await fs.writeFile(
      path.join(agentDir.path, "skills", "foreign", "SKILL.md"),
      "---\nname: foreign\ndescription: foreign\n---\nForeign skill"
    );
    await fs.writeFile(path.join(cwd.path, "AGENTS.md"), "Foreign context");

    const loader = await createEmbeddedPiResourceLoader({
      cwd: cwd.path,
      agentDir: agentDir.path,
      systemPrompt: "Mux system prompt",
    });

    expect(loader.getSkills().skills).toHaveLength(0);
    expect(loader.getPrompts().prompts).toHaveLength(0);
    expect(loader.getThemes().themes).toHaveLength(0);
    expect(loader.getAgentsFiles().agentsFiles).toHaveLength(0);
    expect(loader.getSystemPrompt()).toBe("Mux system prompt");
  });

  test("injects Mux instructions through Pi's resource loader", async () => {
    using cwd = new DisposableTempDir("pi-runtime-system-prompt");
    using agentDir = new DisposableTempDir("pi-runtime-agent-dir");

    const loader = await createEmbeddedPiResourceLoader({
      cwd: cwd.path,
      agentDir: agentDir.path,
      additionalSystemInstructions: "Mux-owned instruction",
    });

    expect(loader.getAppendSystemPrompt()).toContain("Mux-owned instruction");
  });

  test("fails closed when a remote compaction marker cannot be replayed", () => {
    const replays = {
      resp_compacted: {
        type: "openai-responses-compact" as const,
        responseId: "resp_compacted",
        route: "codex-oauth" as const,
        output: [{ type: "compaction", encrypted_content: "opaque-context" }],
      },
    };

    expect(() => rewritePiPayloadForRemoteCompaction({ input: [] }, replays)).toThrow(
      "did not contain its boundary marker"
    );

    const circular: Record<string, unknown> = { input: [] };
    circular.self = circular;
    expect(() => rewritePiPayloadForRemoteCompaction(circular, replays)).toThrow(
      "could not be serialized"
    );
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

  test("runs a resolved Mux agent configuration inside the Pi harness", async () => {
    const workspaceId = "pi-runtime-resolved-agent";
    const user = createMuxMessage("user-1", "user", "make a plan", { timestamp: 1 });
    await historyService.appendToHistory(workspaceId, user);
    const listeners = new Set<(event: AgentSessionEvent) => void>();
    const assistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "planned" }],
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
            message: assistant,
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "planned",
              partial: assistant,
            },
          });
          listener({ type: "message_end", message: assistant });
        }
        return Promise.resolve();
      },
      abort: () => Promise.resolve(),
      dispose: () => undefined,
    };
    const proposePlan = tool({
      description: "Persist the plan",
      inputSchema: z.object({ plan: z.string() }),
      execute: ({ plan }) => ({ plan }),
    });
    let receivedSystemPrompt: string | undefined;
    let receivedToolNames: string[] | undefined;
    const service = new PiAgentRuntimeService({
      historyService,
      getCodexAuth: getTestCodexAuth,
      createSession: (options) => {
        receivedSystemPrompt = options.systemPrompt;
        receivedToolNames = Object.keys(options.muxTools ?? {});
        return Promise.resolve(session);
      },
      emit: () => undefined,
    });

    const result = await service.stream({
      workspaceId,
      cwd: "/workspace",
      runtimeType: "worktree",
      messages: [user],
      modelString: "openai:gpt-5.6-sol",
      agentId: "plan",
      mode: "plan",
      messageId: "assistant-fixed",
      systemPrompt: "Resolved Mux Plan prompt",
      systemMessageTokens: 123,
      muxTools: { propose_plan: proposePlan },
    });

    expect(result.success).toBe(true);
    expect(receivedSystemPrompt).toBe("Resolved Mux Plan prompt");
    expect(receivedToolNames).toEqual(["propose_plan"]);
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (!history.success) return;
    const persisted = history.data.find((message) => message.id === "assistant-fixed");
    expect(persisted?.metadata).toMatchObject({
      agentId: "plan",
      mode: "plan",
      systemMessageTokens: 123,
    });
  });

  test("starts Pi in the background so delegated task launch is not blocked by child completion", async () => {
    const workspaceId = "pi-runtime-background-start";
    const user = createMuxMessage("user-1", "user", "work", { timestamp: 1 });
    await historyService.appendToHistory(workspaceId, user);
    let finishPrompt: (() => void) | undefined;
    const promptGate = new Promise<void>((resolve) => {
      finishPrompt = resolve;
    });
    const session: PiSessionAdapter = {
      agent: { state: { messages: [] } },
      subscribe: () => () => undefined,
      prompt: () => promptGate,
      abort: () => Promise.resolve(),
      dispose: () => undefined,
    };
    let settled = false;
    let rejectedTurnSettled = false;
    let createSessionCalls = 0;
    const service = new PiAgentRuntimeService({
      historyService,
      getCodexAuth: getTestCodexAuth,
      createSession: () => {
        createSessionCalls += 1;
        return Promise.resolve(session);
      },
      emit: () => undefined,
    });

    const result = await service.startStream(
      {
        workspaceId,
        cwd: "/workspace",
        runtimeType: "worktree",
        messages: [user],
        modelString: "openai:gpt-5.6-sol",
      },
      () => {
        settled = true;
      }
    );

    expect(result.success).toBe(true);
    expect(service.isStreaming(workspaceId)).toBe(true);
    expect(settled).toBe(false);
    const rejectedResult = await service.startStream(
      {
        workspaceId,
        cwd: "/workspace",
        runtimeType: "worktree",
        messages: [user],
        modelString: "openai:gpt-5.6-sol",
      },
      () => {
        rejectedTurnSettled = true;
      }
    );
    expect(rejectedResult).toEqual({
      success: false,
      error: { type: "unknown", raw: "Pi agent runtime is already streaming in this workspace" },
    });
    expect(rejectedTurnSettled).toBe(true);
    expect(createSessionCalls).toBe(1);
    finishPrompt?.();
    await service.waitForIdle(workspaceId);
    expect(settled).toBe(true);
  });

  test("reports missing Codex OAuth as non-retryable before starting Pi", async () => {
    const workspaceId = "pi-runtime-missing-oauth";
    const user = createMuxMessage("user-1", "user", "work", { timestamp: 1 });
    await historyService.appendToHistory(workspaceId, user);
    let createSessionCalls = 0;
    let settledCalls = 0;
    const service = new PiAgentRuntimeService({
      historyService,
      getCodexAuth: () => Promise.reject(new Error("Codex OAuth is not configured")),
      createSession: () => {
        createSessionCalls += 1;
        throw new Error("Pi session must not start without OAuth");
      },
      emit: () => undefined,
    });

    const result = await service.startStream(
      {
        workspaceId,
        cwd: "/workspace",
        runtimeType: "worktree",
        messages: [user],
        modelString: "openai:gpt-5.6-sol",
      },
      () => {
        settledCalls += 1;
      }
    );

    expect(result).toEqual({
      success: false,
      error: { type: "oauth_not_connected", provider: "openai" },
    });
    expect(createSessionCalls).toBe(0);
    expect(settledCalls).toBe(1);
    expect(service.isStreaming(workspaceId)).toBe(false);
  });

  test("surfaces a Pi provider error instead of committing an empty successful turn", async () => {
    const workspaceId = "pi-runtime-provider-error";
    const user = createMuxMessage("user-1", "user", "work", { timestamp: 1 });
    await historyService.appendToHistory(workspaceId, user);
    const listeners = new Set<(event: AgentSessionEvent) => void>();
    const failedAssistant: AssistantMessage = {
      role: "assistant",
      content: [],
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
      errorMessage: "Codex rejected the request",
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
          listener({ type: "message_end", message: failedAssistant });
        }
        return Promise.resolve();
      },
      abort: () => Promise.resolve(),
      dispose: () => undefined,
    };
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    const service = new PiAgentRuntimeService({
      historyService,
      getCodexAuth: getTestCodexAuth,
      createSession: () => Promise.resolve(session),
      emit: (_eventName, event) => events.push(event),
    });

    const result = await service.stream({
      workspaceId,
      cwd: "/workspace",
      runtimeType: "worktree",
      messages: [user],
      modelString: "openai:gpt-5.6-sol",
    });

    expect(result.success).toBe(false);
    if (!result.success && result.error.type === "unknown") {
      expect(result.error.raw).toContain("Codex rejected the request");
    }
    expect(events.some((event) => event.type === "error")).toBe(true);
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (history.success) {
      expect(history.data.some((message) => message.role === "assistant")).toBe(false);
    }
  });

  test("persists streamed output before the Pi turn finishes", async () => {
    const workspaceId = "pi-runtime-live-partial";
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
      content: [{ type: "text", text: "durable" }],
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
              delta: "durable",
              partial: partialAssistant,
            },
          });
        }
        promptStarted?.();
        await promptBlocked;
        for (const listener of listeners) {
          listener({ type: "message_end", message: partialAssistant });
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

    const streamResult = service.stream({
      workspaceId,
      cwd: "/workspace",
      runtimeType: "worktree",
      messages: [user],
      modelString: "openai:gpt-5.6-sol",
    });
    await didStartPrompt;

    let partial = await historyService.readPartial(workspaceId);
    for (let attempt = 0; partial == null && attempt < 100; attempt += 1) {
      await Bun.sleep(1);
      partial = await historyService.readPartial(workspaceId);
    }
    expect(partial?.parts.some((part) => part.type === "text" && part.text === "durable")).toBe(
      true
    );

    releasePrompt?.();
    expect((await streamResult).success).toBe(true);
  });

  test("replays text deltas produced after the reconnect cursor", async () => {
    const workspaceId = "pi-runtime-reconnect";
    const user = createMuxMessage("user-1", "user", "stream", { timestamp: 1 });
    await historyService.appendToHistory(workspaceId, user);
    const listeners = new Set<(event: AgentSessionEvent) => void>();
    const assistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "firstsecond" }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 3,
    };
    const now = 1_000;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
    const replayDeltas: Array<{ delta: string; tokens: unknown }> = [];
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
            message: assistant,
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "first",
              partial: assistant,
            },
          });
        }
        const cursor = service.getStreamInfo(workspaceId)?.parts.at(-1)?.timestamp;
        expect(cursor).toBeDefined();
        for (const listener of listeners) {
          listener({
            type: "message_update",
            message: assistant,
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "second",
              partial: assistant,
            },
          });
        }
        await service.replayStream(workspaceId, { afterTimestamp: cursor });
        for (const listener of listeners) listener({ type: "message_end", message: assistant });
      },
      abort: () => Promise.resolve(),
      dispose: () => undefined,
    };
    const service = new PiAgentRuntimeService({
      historyService,
      getCodexAuth: getTestCodexAuth,
      createSession: () => Promise.resolve(session),
      emit: (_name, event) => {
        if (event.type === "stream-delta" && event.replay === true) {
          replayDeltas.push({ delta: String(event.delta), tokens: event.tokens });
        }
      },
    });

    try {
      const result = await service.stream({
        workspaceId,
        cwd: "/workspace",
        runtimeType: "worktree",
        messages: [user],
        modelString: "openai:gpt-5.6-sol",
      });
      expect(result.success).toBe(true);
      expect(replayDeltas).toEqual([{ delta: "second", tokens: 2 }]);
    } finally {
      nowSpy.mockRestore();
    }
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
        cacheWrite: 2,
        totalTokens: 21,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    };
    const toolStepAssistant: AssistantMessage = {
      ...finalAssistant,
      content: [],
      usage: {
        ...finalAssistant.usage,
        input: 7,
        output: 1,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 11,
      },
      stopReason: "toolUse",
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
          listener({ type: "message_end", message: toolStepAssistant });
          listener({
            type: "tool_execution_start",
            toolCallId: piToolCallId,
            toolName: "bash",
            args: { command: "pwd" },
          });
          listener({
            type: "tool_execution_update",
            toolCallId: piToolCallId,
            toolName: "bash",
            args: { command: "pwd" },
            partialResult: {
              content: [{ type: "text", text: '{"progress":"running"}' }],
              details: { output: { progress: "running" } },
            },
          });
          listener({
            type: "tool_execution_end",
            toolCallId: piToolCallId,
            toolName: "bash",
            result: {
              content: [{ type: "text", text: '{"success":true,"path":"/workspace"}' }],
              details: { output: { success: true, path: "/workspace" } },
            },
            isError: false,
          });
          listener({
            type: "message_end",
            message: {
              role: "toolResult",
              toolCallId: piToolCallId,
              toolName: "bash",
              content: [{ type: "text", text: '{"success":true,"path":"/workspace"}' }],
              isError: false,
              timestamp: 2,
            },
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
    let recordedProviderMetadata: Record<string, unknown> | undefined;
    const service = new PiAgentRuntimeService({
      historyService,
      getCodexAuth: getTestCodexAuth,
      createSession: (options) => {
        receivedModelId = options.modelId;
        receivedAccessToken = options.auth.access;
        return Promise.resolve(session);
      },
      recordUsage: (...args: unknown[]) => {
        recordedInputTokens = (args[2] as { inputTokens?: number }).inputTokens;
        recordedProviderMetadata = args[3] as Record<string, unknown> | undefined;
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
    expect(events.find((event) => event.type === "stream-delta")?.tokens).toBeGreaterThan(0);
    expect(events.map((event) => event.type)).toContain("tool-call-end");
    expect(events.find((event) => event.type === "tool-call-end")?.result).toEqual({
      success: true,
      path: "/workspace",
    });
    expect(events.find((event) => event.type === "tool-call-output-delta")?.output).toEqual({
      progress: "running",
    });
    const emittedToolCallIds = events
      .filter((event) => event.type.startsWith("tool-call"))
      .map((event) => event.toolCallId);
    expect(emittedToolCallIds).toHaveLength(7);
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
    expect(recordedInputTokens).toBe(28);
    expect(recordedProviderMetadata).toEqual({
      anthropic: { cacheCreationInputTokens: 3 },
      mux: { costsIncluded: true },
    });
    const usageDeltas = events.filter((event) => event.type === "usage-delta");
    expect(usageDeltas).toHaveLength(2);
    expect(usageDeltas.at(-1)?.usage).toMatchObject({
      inputTokens: 18,
      outputTokens: 3,
      totalTokens: 21,
      cachedInputTokens: 4,
    });
    expect(usageDeltas.at(-1)?.cumulativeUsage).toMatchObject({
      inputTokens: 28,
      outputTokens: 4,
      totalTokens: 32,
      cachedInputTokens: 6,
    });
    expect(usageDeltas.at(-1)?.cumulativeProviderMetadata).toEqual({
      anthropic: { cacheCreationInputTokens: 3 },
      mux: { costsIncluded: true },
    });

    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (!history.success) return;
    const assistant = history.data.find((message) => message.role === "assistant");
    expect(assistant?.metadata?.partial).toBe(false);
    expect(assistant?.metadata?.usage?.inputTokens).toBe(28);
    expect(assistant?.metadata?.usage?.totalTokens).toBe(32);
    expect(assistant?.metadata?.contextUsage?.inputTokens).toBe(18);
    expect(assistant?.metadata?.contextUsage?.totalTokens).toBe(21);
    expect(assistant?.metadata?.providerMetadata).toEqual({
      anthropic: { cacheCreationInputTokens: 3 },
      mux: { costsIncluded: true },
    });
    expect(assistant?.parts.some((part) => part.type === "text" && part.text === "done")).toBe(
      true
    );
    expect(
      assistant?.parts.some(
        (part) =>
          part.type === "dynamic-tool" &&
          part.toolCallId === "call_QIwSEaOnQppSthHiNLB14rIQ" &&
          part.state === "output-available" &&
          JSON.stringify(part.output) === '{"success":true,"path":"/workspace"}'
      )
    ).toBe(true);
  });

  test("does not turn a finalized Pi turn into an error when partial cleanup fails", async () => {
    const workspaceId = "pi-runtime-final-partial-cleanup";
    const user = createMuxMessage("user-1", "user", "finish normally", { timestamp: 1 });
    await historyService.appendToHistory(workspaceId, user);
    const listeners = new Set<(event: AgentSessionEvent) => void>();
    const finalAssistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
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
            message: finalAssistant,
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "done",
              partial: finalAssistant,
            },
          });
          listener({ type: "message_end", message: finalAssistant });
        }
        return Promise.resolve();
      },
      abort: () => Promise.resolve(),
      dispose: () => undefined,
    };
    const deletePartial = spyOn(historyService, "deletePartial").mockResolvedValue({
      success: false,
      error: "simulated cleanup failure",
    });
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
    });

    expect(result.success).toBe(true);
    expect(deletePartial).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toContain("stream-end");
    expect(events.map((event) => event.type)).not.toContain("error");
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (history.success) {
      expect(history.data.at(-1)?.metadata?.partial).toBe(false);
      expect(history.data.at(-1)?.parts).toMatchObject([{ type: "text", text: "done" }]);
    }
  });

  test("writes a Pi tool progress snapshot while it remains pending", async () => {
    const workspaceId = "pi-runtime-tool-progress-abort";
    const user = createMuxMessage("user-1", "user", "run a long tool", { timestamp: 1 });
    await historyService.appendToHistory(workspaceId, user);
    const abortController = new AbortController();
    const writePartial = spyOn(historyService, "writePartial");
    const listeners = new Set<(event: AgentSessionEvent) => void>();
    const session: PiSessionAdapter = {
      agent: { state: { messages: [] } },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      prompt() {
        for (const listener of listeners) {
          listener({
            type: "tool_execution_start",
            toolCallId: "call-progress",
            toolName: "bash",
            args: { command: "sleep 10" },
          });
          listener({
            type: "tool_execution_update",
            toolCallId: "call-progress",
            toolName: "bash",
            args: { command: "sleep 10" },
            partialResult: {
              content: [{ type: "text", text: '{"progress":"halfway"}' }],
              details: { output: { progress: "halfway" } },
            },
          });
        }
        abortController.abort();
        return Promise.resolve();
      },
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

    expect(result.success).toBe(true);
    expect(events.find((event) => event.type === "tool-call-output-delta")?.output).toEqual({
      progress: "halfway",
    });
    const progressSnapshot = writePartial.mock.calls.find(([, message]) =>
      message.parts.some(
        (part) =>
          part.type === "dynamic-tool" &&
          part.toolCallId === "call-progress" &&
          part.partialOutput !== undefined
      )
    )?.[1];
    const progressToolPart = progressSnapshot?.parts.find(
      (part) => part.type === "dynamic-tool" && part.toolCallId === "call-progress"
    );
    expect(progressToolPart).toMatchObject({
      type: "dynamic-tool",
      toolCallId: "call-progress",
      toolName: "bash",
      input: { command: "sleep 10" },
      state: "input-available",
      partialOutput: { progress: "halfway" },
    });
    // History intentionally drops tool-only incomplete partials after abort so they
    // cannot be replayed to a provider as a completed tool result.
    expect(await historyService.readPartial(workspaceId)).toBeNull();
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (history.success) {
      expect(history.data.map((message) => message.id)).toEqual([user.id]);
    }
  });

  test("leaves an already-aborted turn with the Mux startup control plane", async () => {
    const workspaceId = "pi-runtime-aborted";
    const user = createMuxMessage("user-1", "user", "do not run", { timestamp: 1 });
    await historyService.appendToHistory(workspaceId, user);
    const abortController = new AbortController();
    abortController.abort();
    let createSessionCalls = 0;
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
      createSession: () => {
        createSessionCalls += 1;
        return Promise.resolve(session);
      },
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
    expect(createSessionCalls).toBe(0);
    expect(promptCalls).toBe(0);
    expect(abortCalls).toBe(0);
    expect(events).toEqual([]);
  });

  test("does not enter streaming when Mux aborts while Pi creates its session", async () => {
    const workspaceId = "pi-runtime-aborted-during-session-start";
    const user = createMuxMessage("user-1", "user", "do not start", { timestamp: 1 });
    await historyService.appendToHistory(workspaceId, user);
    const abortController = new AbortController();
    let sessionCreationStarted: (() => void) | undefined;
    const didStartSessionCreation = new Promise<void>((resolve) => {
      sessionCreationStarted = resolve;
    });
    let releaseSessionCreation: (() => void) | undefined;
    const sessionCreationBlocked = new Promise<void>((resolve) => {
      releaseSessionCreation = resolve;
    });
    let promptCalls = 0;
    let abortCalls = 0;
    let disposeCalls = 0;
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
      dispose() {
        disposeCalls += 1;
      },
    };
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    let settledCalls = 0;
    const service = new PiAgentRuntimeService({
      historyService,
      getCodexAuth: getTestCodexAuth,
      async createSession() {
        sessionCreationStarted?.();
        await sessionCreationBlocked;
        return session;
      },
      emit: (_name, event) => events.push(event),
    });

    const startResultPromise = service.startStream(
      {
        workspaceId,
        cwd: "/workspace",
        runtimeType: "worktree",
        messages: [user],
        modelString: "openai:gpt-5.6-sol",
        abortSignal: abortController.signal,
      },
      () => {
        settledCalls += 1;
      }
    );
    await didStartSessionCreation;
    abortController.abort();
    releaseSessionCreation?.();

    expect((await startResultPromise).success).toBe(true);
    await service.waitForIdle(workspaceId);
    expect(promptCalls).toBe(0);
    expect(abortCalls).toBe(0);
    expect(disposeCalls).toBe(1);
    expect(settledCalls).toBe(1);
    expect(events).toEqual([]);
    expect(service.isStreaming(workspaceId)).toBe(false);
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (history.success) {
      expect(history.data.map((message) => message.id)).toEqual([user.id]);
    }
  });

  test("reports an abort cleanup failure without retrying destructive history work", async () => {
    const workspaceId = "pi-runtime-abort-cleanup-error";
    const user = createMuxMessage("user-1", "user", "do not run", { timestamp: 1 });
    await historyService.appendToHistory(workspaceId, user);
    const abortController = new AbortController();
    const deleteMessage = spyOn(historyService, "deleteMessage").mockResolvedValueOnce({
      success: false,
      error: "disk unavailable",
    });
    let promptStarted: (() => void) | undefined;
    const didStartPrompt = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    let releasePrompt: (() => void) | undefined;
    const promptBlocked = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const session: PiSessionAdapter = {
      agent: { state: { messages: [] } },
      subscribe: () => () => undefined,
      async prompt() {
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

    const resultPromise = service.stream({
      workspaceId,
      cwd: "/workspace",
      runtimeType: "worktree",
      messages: [user],
      modelString: "openai:gpt-5.6-sol",
      abortSignal: abortController.signal,
    });
    await didStartPrompt;
    abortController.abort();
    const result = await resultPromise;

    expect(result).toEqual({ success: false, error: { type: "unknown", raw: "disk unavailable" } });
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: "error", error: "disk unavailable" });
  });

  test("replays Mux Codex remote compaction into every Pi tool-loop request", async () => {
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
    const rewrittenPayloads: unknown[] = [];
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
        for (const text of ["continue", "after tool result"]) {
          rewrittenPayloads.push(
            await session.agent.onPayload?.(
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
                  { role: "user", content: [{ type: "input_text", text }] },
                ],
              },
              finalAssistant as never
            )
          );
        }
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
    expect(rewrittenPayloads).toEqual([
      {
        input: [
          ...compactedOutput,
          { role: "user", content: [{ type: "input_text", text: "continue" }] },
        ],
      },
      {
        input: [
          ...compactedOutput,
          { role: "user", content: [{ type: "input_text", text: "after tool result" }] },
        ],
      },
    ]);
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
        input: 5,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 6,
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
          listener({ type: "message_end", message: partialAssistant });
        }
        return Promise.reject(new Error("provider disconnected"));
      },
      abort: () => Promise.resolve(),
      dispose: () => undefined,
    };
    let recordedInputTokens: number | undefined;
    const service = new PiAgentRuntimeService({
      historyService,
      getCodexAuth: getTestCodexAuth,
      createSession: () => Promise.resolve(session),
      recordUsage: (_workspaceId, _model, usage) => {
        recordedInputTokens = usage.inputTokens;
        return Promise.resolve();
      },
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
    expect(partial?.metadata?.usage?.inputTokens).toBe(5);
    expect(partial?.metadata?.contextUsage?.inputTokens).toBe(5);
    expect(recordedInputTokens).toBe(5);
  });

  test("isolates concurrent streams and cleanup across Mux workspaces", async () => {
    const workspaceIds = Array.from({ length: 8 }, (_, index) => `pi-runtime-workspace-${index}`);
    for (const workspaceId of workspaceIds) {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage(`user-${workspaceId}`, "user", "run", { timestamp: 1 })
      );
    }
    const promptStarted = new Map<string, Promise<void>>();
    const sessions = new Map<string, PiSessionAdapter>();
    const abortCalls = new Map<string, number>();
    const disposeCalls = new Map<string, number>();
    for (const workspaceId of workspaceIds) {
      let releasePrompt: (() => void) | undefined;
      const promptBlocked = new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      let markPromptStarted: (() => void) | undefined;
      promptStarted.set(
        workspaceId,
        new Promise<void>((resolve) => {
          markPromptStarted = resolve;
        })
      );
      sessions.set(workspaceId, {
        agent: { state: { messages: [] as Message[] } },
        subscribe: () => () => undefined,
        prompt: () => {
          markPromptStarted?.();
          return promptBlocked;
        },
        abort: () => {
          abortCalls.set(workspaceId, (abortCalls.get(workspaceId) ?? 0) + 1);
          releasePrompt?.();
          return Promise.resolve();
        },
        dispose: () => {
          disposeCalls.set(workspaceId, (disposeCalls.get(workspaceId) ?? 0) + 1);
        },
      });
    }
    const service = new PiAgentRuntimeService({
      historyService,
      getCodexAuth: getTestCodexAuth,
      createSession: (options) => {
        const workspaceId = path.basename(options.cwd);
        const session = sessions.get(workspaceId);
        if (!session) throw new Error(`Missing session for ${workspaceId}`);
        return Promise.resolve(session);
      },
      emit: () => undefined,
    });
    const streams = workspaceIds.map((workspaceId) =>
      service.stream({
        workspaceId,
        cwd: `/workspace/${workspaceId}`,
        runtimeType: "worktree",
        messages: [createMuxMessage(`user-${workspaceId}`, "user", "run", { timestamp: 1 })],
        modelString: "openai:gpt-5.6-sol",
      })
    );
    await Promise.all(promptStarted.values());

    const firstHalf = workspaceIds.slice(0, 4);
    const secondHalf = workspaceIds.slice(4);
    await Promise.all(firstHalf.map((workspaceId) => service.stop(workspaceId)));
    expect(firstHalf.every((workspaceId) => !service.isStreaming(workspaceId))).toBe(true);
    expect(secondHalf.every((workspaceId) => service.isStreaming(workspaceId))).toBe(true);
    await Promise.all(secondHalf.map((workspaceId) => service.stop(workspaceId)));

    expect((await Promise.all(streams)).every((result) => result.success)).toBe(true);
    expect([...abortCalls.values()]).toEqual(workspaceIds.map(() => 1));
    expect([...disposeCalls.values()]).toEqual(workspaceIds.map(() => 1));
  });

  test("defers a soft interrupt until the next output block boundary", async () => {
    const workspaceId = "pi-runtime-soft-interrupt";
    const user = createMuxMessage("user-1", "user", "stop after this block", { timestamp: 1 });
    await historyService.appendToHistory(workspaceId, user);
    const listeners = new Set<(event: AgentSessionEvent) => void>();
    const partialAssistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "block" }],
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
    let resolvePrompt: (() => void) | undefined;
    const promptBlocked = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    let abortCalls = 0;
    const session: PiSessionAdapter = {
      agent: { state: { messages: [] } },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      prompt: () => promptBlocked,
      abort: () => {
        abortCalls += 1;
        resolvePrompt?.();
        return Promise.resolve();
      },
      dispose: () => undefined,
    };
    const service = new PiAgentRuntimeService({
      historyService,
      getCodexAuth: getTestCodexAuth,
      createSession: () => Promise.resolve(session),
      emit: () => undefined,
    });
    const streamResult = service.stream({
      workspaceId,
      cwd: "/workspace",
      runtimeType: "worktree",
      messages: [user],
      modelString: "openai:gpt-5.6-sol",
    });
    while (!service.isStreaming(workspaceId)) await Bun.sleep(1);

    await service.stop(workspaceId, { soft: true, abortReason: "system" });
    expect(abortCalls).toBe(0);
    for (const listener of listeners) {
      listener({
        type: "message_update",
        message: partialAssistant,
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "block",
          partial: partialAssistant,
        },
      });
    }

    expect((await streamResult).success).toBe(true);
    expect(abortCalls).toBe(1);
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
        input: 5,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 6,
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
          listener({ type: "message_end", message: partialAssistant });
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
    let recordedInputTokens: number | undefined;
    const service = new PiAgentRuntimeService({
      historyService,
      getCodexAuth: getTestCodexAuth,
      createSession: () => Promise.resolve(session),
      recordUsage: (_workspaceId, _model, usage) => {
        recordedInputTokens = usage.inputTokens;
        return Promise.resolve();
      },
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
    expect(recordedInputTokens).toBe(5);
  });
});
