import { afterEach, describe, expect, it } from "bun:test";
import type { LanguageModelV2CallOptions, LanguageModelV2StreamPart } from "@ai-sdk/provider";

import { KiroLanguageModel } from "./kiroLanguageModel";

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    value: Object.assign(handler, { preconnect: () => undefined }) as typeof globalThis.fetch,
    configurable: true,
    writable: true,
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      value: originalFetch,
      configurable: true,
      writable: true,
    });
  };
}

function createKiroStreamResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/vnd.amazon.eventstream" },
    }
  );
}

async function collectStreamParts(stream: ReadableStream<LanguageModelV2StreamPart>) {
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

function getJsonBody(init: RequestInit) {
  if (typeof init.body !== "string") {
    throw new Error("Expected JSON string request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function createOptions(): LanguageModelV2CallOptions {
  return {
    prompt: [
      { role: "system", content: "Follow project rules." },
      { role: "user", content: [{ type: "text", text: "Hello Kiro" }] },
    ],
    tools: [
      {
        type: "function",
        name: "lookup",
        description: "Look up a value",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ],
    toolChoice: { type: "auto" },
    maxOutputTokens: 1024,
    headers: { "x-mux-devtools-step-id": "step-1" },
  };
}

describe("KiroLanguageModel", () => {
  const restoreFetchers: Array<() => void> = [];

  afterEach(() => {
    while (restoreFetchers.length > 0) {
      restoreFetchers.pop()?.();
    }
  });

  it("sends Kiro runtime requests with OAuth bearer auth and Kiro payload shape", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedHeaders: Headers | undefined;

    restoreFetchers.push(
      mockFetch((url, init) => {
        expect(url).toBe("https://runtime.us-east-1.kiro.dev/generateAssistantResponse");
        expect(init.method).toBe("POST");
        capturedHeaders = new Headers(init.headers);
        capturedBody = getJsonBody(init);
        return Promise.resolve(
          createKiroStreamResponse([
            'prefix{"content":"Hel"}',
            '{"content":"lo"}',
            '{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}',
          ])
        );
      })
    );

    const model = new KiroLanguageModel({
      modelId: "claude-sonnet-4-5",
      credentials: {
        accessToken: "kiro-access-token",
        profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/test",
        region: "us-east-1",
      },
      fetch: globalThis.fetch,
    });

    const result = await model.doStream(createOptions());
    const parts = await collectStreamParts(result.stream);

    expect(capturedHeaders?.get("authorization")).toBe("Bearer kiro-access-token");
    expect(capturedHeaders?.get("x-amz-target")).toBe(
      "AmazonCodeWhispererStreamingService.GenerateAssistantResponse"
    );
    expect(capturedHeaders?.get("x-mux-devtools-step-id")).toBeNull();

    const conversationState = capturedBody?.conversationState as Record<string, unknown>;
    const currentMessage = conversationState.currentMessage as Record<string, unknown>;
    const userInputMessage = currentMessage.userInputMessage as Record<string, unknown>;
    expect(userInputMessage.content).toBe("Follow project rules.\n\nHello Kiro");
    expect(userInputMessage.modelId).toBe("claude-sonnet-4.5");
    expect(capturedBody?.profileArn).toBe(
      "arn:aws:codewhisperer:us-east-1:123456789012:profile/test"
    );

    const context = userInputMessage.userInputMessageContext as Record<string, unknown>;
    expect(context.tools).toEqual([
      {
        toolSpecification: {
          name: "lookup",
          description: "Look up a value",
          inputSchema: {
            json: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        },
      },
    ]);

    expect(parts).toEqual([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "text-0" },
      { type: "text-delta", id: "text-0", delta: "Hel" },
      { type: "text-delta", id: "text-0", delta: "lo" },
      { type: "text-end", id: "text-0" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      },
    ]);
  });

  it("normalizes user-facing Kiro model aliases before sending runtime requests", async () => {
    const capturedModelIds: unknown[] = [];

    restoreFetchers.push(
      mockFetch((_url, init) => {
        const body = getJsonBody(init);
        const conversationState = body.conversationState as Record<string, unknown>;
        const currentMessage = conversationState.currentMessage as Record<string, unknown>;
        const userInputMessage = currentMessage.userInputMessage as Record<string, unknown>;
        capturedModelIds.push(userInputMessage.modelId);
        return Promise.resolve(createKiroStreamResponse(['{"content":"ok"}']));
      })
    );

    for (const modelId of [
      "auto-kiro",
      "kiro-auto",
      "kiro/claude-opus-4.8-xhigh",
      "kiro/MiniMax-M2.5",
      "claude-sonnet-4.0",
      "claude-4.5-sonnet",
      "claude-sonnet-4-5-20251001",
    ] as const) {
      const model = new KiroLanguageModel({
        modelId,
        credentials: {
          accessToken: "kiro-access-token",
          region: "us-east-1",
        },
        fetch: globalThis.fetch,
      });
      const result = await model.doStream(createOptions());
      await collectStreamParts(result.stream);
    }

    expect(capturedModelIds).toEqual([
      "auto",
      "auto",
      "claude-opus-4.8",
      "minimax-m2.5",
      "claude-sonnet-4",
      "claude-sonnet-4.5",
      "claude-sonnet-4.5",
    ]);
  });

  it("injects Kiro thinking instructions when a thinking level is selected", async () => {
    let capturedContent = "";

    restoreFetchers.push(
      mockFetch((_url, init) => {
        const body = getJsonBody(init);
        const conversationState = body.conversationState as Record<string, unknown>;
        const currentMessage = conversationState.currentMessage as Record<string, unknown>;
        const userInputMessage = currentMessage.userInputMessage as Record<string, unknown>;
        capturedContent = String(userInputMessage.content);
        return Promise.resolve(createKiroStreamResponse(['{"content":"ok"}']));
      })
    );

    const model = new KiroLanguageModel({
      modelId: "claude-sonnet-5",
      credentials: {
        accessToken: "kiro-access-token",
        region: "us-east-1",
      },
      fetch: globalThis.fetch,
    });
    const result = await model.doStream({
      ...createOptions(),
      providerOptions: { kiro: { thinkingLevel: "high" } },
    });
    await collectStreamParts(result.stream);

    expect(capturedContent).toContain("<thinking_mode>enabled</thinking_mode>");
    expect(capturedContent).toContain("<max_thinking_length>819</max_thinking_length>");
    expect(capturedContent).toContain("After thinking, respond in the user's language.");
    expect(capturedContent).toEndWith("Hello Kiro");
  });

  it("maps Kiro tool events to AI SDK tool-call stream parts", async () => {
    restoreFetchers.push(
      mockFetch(() =>
        Promise.resolve(
          createKiroStreamResponse([
            '{"name":"lookup","toolUseId":"tool-1","input":{}}',
            '{"input":"{\\"query\\":"}',
            '{"input":"\\"mux\\"}"}',
            '{"stop":true}',
          ])
        )
      )
    );

    const model = new KiroLanguageModel({
      modelId: "claude-sonnet-4-5",
      credentials: {
        accessToken: "kiro-access-token",
        region: "us-east-1",
      },
      fetch: globalThis.fetch,
    });

    const result = await model.doStream(createOptions());
    const parts = await collectStreamParts(result.stream);

    expect(parts).toContainEqual({
      type: "tool-call",
      toolCallId: "tool-1",
      toolName: "lookup",
      input: '{"query":"mux"}',
    });
    expect(parts.at(-1)).toEqual({
      type: "finish",
      finishReason: "tool-calls",
      usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
    });
  });

  it("refreshes OAuth credentials and retries once after a Kiro 403", async () => {
    const runtimeAuthorizations: Array<string | null> = [];

    restoreFetchers.push(
      mockFetch((url, init) => {
        if (url.includes("auth.desktop.kiro.dev")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                accessToken: "refreshed-access-token",
                expiresIn: 3600,
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            )
          );
        }

        runtimeAuthorizations.push(new Headers(init.headers).get("authorization"));
        if (runtimeAuthorizations.length === 1) {
          return Promise.resolve(new Response("expired", { status: 403, statusText: "Forbidden" }));
        }
        return Promise.resolve(createKiroStreamResponse(['{"content":"ok"}']));
      })
    );

    const model = new KiroLanguageModel({
      modelId: "claude-sonnet-4.5",
      credentials: {
        accessToken: "expired-access-token",
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
        region: "us-east-1",
      },
      fetch: globalThis.fetch,
    });

    const result = await model.doStream(createOptions());
    const parts = await collectStreamParts(result.stream);

    expect(runtimeAuthorizations).toEqual([
      "Bearer expired-access-token",
      "Bearer refreshed-access-token",
    ]);
    expect(parts).toContainEqual({ type: "text-delta", id: "text-0", delta: "ok" });
  });

  it("refreshes refresh-token-only credentials before sending a Kiro request", async () => {
    const runtimeAuthorizations: Array<string | null> = [];

    restoreFetchers.push(
      mockFetch((url, init) => {
        if (url.includes("auth.desktop.kiro.dev")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                accessToken: "fresh-access-token",
                expiresIn: 3600,
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            )
          );
        }

        runtimeAuthorizations.push(new Headers(init.headers).get("authorization"));
        return Promise.resolve(createKiroStreamResponse(['{"content":"ok"}']));
      })
    );

    const model = new KiroLanguageModel({
      modelId: "claude-sonnet-4.5",
      credentials: {
        refreshToken: "refresh-token",
        region: "us-east-1",
      },
      fetch: globalThis.fetch,
    });

    const result = await model.doStream(createOptions());
    const parts = await collectStreamParts(result.stream);

    expect(runtimeAuthorizations).toEqual(["Bearer fresh-access-token"]);
    expect(parts).toContainEqual({ type: "text-delta", id: "text-0", delta: "ok" });
  });
});
