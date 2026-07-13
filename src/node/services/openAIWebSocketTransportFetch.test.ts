import { describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

import {
  consumeCapturedRequestHeaders,
  DEVTOOLS_RUN_METADATA_ID_HEADER,
  DEVTOOLS_STEP_ID_HEADER,
} from "./devToolsHeaderCapture";
import {
  buildCodexIncrementalWebSocketRequest,
  createCodexOAuthWebSocketTransportFetch,
  createOpenAIWebSocketTransportFetch,
} from "./openAIWebSocketTransportFetch";

function getFetchInputUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "string") {
    return input;
  }
  return input.url;
}

function createTestFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): typeof fetch {
  return Object.assign(handler, { preconnect: fetch.preconnect.bind(fetch) }) as typeof fetch;
}

function createTestWebSocketFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  close: () => void = () => undefined
): typeof fetch & { close: () => void } {
  return Object.assign(createTestFetch(handler), { close });
}

describe("createOpenAIWebSocketTransportFetch", () => {
  test("disabled transport keeps using the base fetch and exposes inactive cleanup", async () => {
    const baseCalls: string[] = [];
    const baseFetch = createTestFetch((input: RequestInfo | URL, _init?: RequestInit) => {
      baseCalls.push(getFetchInputUrl(input));
      return Promise.resolve(new Response("base"));
    });

    const transport = createOpenAIWebSocketTransportFetch({
      enabled: false,
      baseFetch,
      createWebSocketFetch: () => {
        throw new Error("WebSocket fetch should not be created when disabled");
      },
    });

    const response = await transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });

    expect(await response.text()).toBe("base");
    expect(baseCalls).toEqual(["https://api.openai.com/v1/responses"]);
    expect(transport.active).toBe(false);
    expect(() => transport.close()).not.toThrow();
  });

  test("enabled transport creates the WebSocket fetch lazily", async () => {
    let created = false;
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      createWebSocketFetch: () => {
        created = true;
        return createTestWebSocketFetch(() => Promise.resolve(new Response("ws")));
      },
    });

    expect(created).toBe(false);
    await transport.fetch("https://api.openai.com/v1/models", { method: "GET" });
    expect(created).toBe(false);
    await transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });
    expect(created).toBe(true);
  });

  test("enabled transport sends streaming Responses API posts through WebSocket fetch", async () => {
    const wsCalls: string[] = [];
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      createWebSocketFetch: () => {
        return createTestWebSocketFetch((input: RequestInfo | URL, _init?: RequestInit) => {
          wsCalls.push(getFetchInputUrl(input));
          return Promise.resolve(new Response("ws"));
        });
      },
    });

    const response = await transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });

    expect(await response.text()).toBe("ws");
    expect(wsCalls).toEqual(["https://api.openai.com/v1/responses"]);
    expect(transport.active).toBe(true);
  });

  test("passes custom WebSocket endpoint to the WebSocket fetch factory", async () => {
    let capturedOptions: { url?: string } | undefined;
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      webSocketUrl: "wss://proxy.openai.test/v1/responses",
      createWebSocketFetch: (options) => {
        capturedOptions = options;
        return createTestWebSocketFetch(() => Promise.resolve(new Response("ws")));
      },
    });

    await transport.fetch("https://proxy.openai.test/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });

    expect(capturedOptions).toEqual({ url: "wss://proxy.openai.test/v1/responses" });
  });

  test("enabled transport keeps non-eligible requests on the base fetch", async () => {
    const baseCalls: string[] = [];
    const wsCalls: string[] = [];
    const baseFetch = createTestFetch((input: RequestInfo | URL, _init?: RequestInit) => {
      baseCalls.push(getFetchInputUrl(input));
      return Promise.resolve(new Response("base"));
    });

    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch,
      createWebSocketFetch: () => {
        return createTestWebSocketFetch((input: RequestInfo | URL, _init?: RequestInit) => {
          wsCalls.push(getFetchInputUrl(input));
          return Promise.resolve(new Response("ws"));
        });
      },
    });

    const response = await transport.fetch("https://api.openai.com/v1/models", {
      method: "GET",
    });

    expect(await response.text()).toBe("base");
    expect(baseCalls).toEqual(["https://api.openai.com/v1/models"]);
    expect(wsCalls).toEqual([]);
  });

  test("enabled transport strips DevTools headers before WebSocket dispatch", async () => {
    let webSocketHeaders: Headers | undefined;
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      createWebSocketFetch: () =>
        createTestWebSocketFetch((_input: RequestInfo | URL, init?: RequestInit) => {
          webSocketHeaders = new Headers(init?.headers);
          return Promise.resolve(new Response("ws"));
        }),
    });

    await transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        [DEVTOOLS_STEP_ID_HEADER]: "step-ws-1",
        [DEVTOOLS_RUN_METADATA_ID_HEADER]: "run-metadata-1",
      },
      body: JSON.stringify({ stream: true }),
    });

    expect(webSocketHeaders).toBeDefined();
    if (!webSocketHeaders) {
      throw new Error("Expected WebSocket fetch to receive request headers");
    }
    expect(webSocketHeaders.get(DEVTOOLS_STEP_ID_HEADER)).toBeNull();
    expect(webSocketHeaders.get(DEVTOOLS_RUN_METADATA_ID_HEADER)).toBeNull();
    const captured = consumeCapturedRequestHeaders("step-ws-1");
    expect(captured).toEqual({ authorization: "[REDACTED]" });
  });

  test("enabled transport keeps non-streaming Responses posts on the base fetch", async () => {
    const baseBodies: string[] = [];
    const wsCalls: string[] = [];
    const baseFetch = createTestFetch((_input: RequestInfo | URL, init?: RequestInit) => {
      baseBodies.push(typeof init?.body === "string" ? init.body : "");
      return Promise.resolve(new Response("base"));
    });
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch,
      createWebSocketFetch: () =>
        createTestWebSocketFetch((input: RequestInfo | URL) => {
          wsCalls.push(getFetchInputUrl(input));
          return Promise.resolve(new Response("ws"));
        }),
    });

    const streamFalse = await transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: false }),
    });
    const streamAbsent = await transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(await streamFalse.text()).toBe("base");
    expect(await streamAbsent.text()).toBe("base");
    expect(baseBodies).toEqual([JSON.stringify({ stream: false }), JSON.stringify({})]);
    expect(wsCalls).toEqual([]);
  });

  test("enabled transport recognizes streaming Responses Request objects", async () => {
    const wsCalls: string[] = [];
    let webSocketHeaders: Headers | undefined;
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      createWebSocketFetch: () =>
        createTestWebSocketFetch((input: RequestInfo | URL, init?: RequestInit) => {
          wsCalls.push(getFetchInputUrl(input));
          webSocketHeaders = new Headers(init?.headers);
          return Promise.resolve(new Response("ws"));
        }),
    });
    const request = new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer request-key" },
      body: JSON.stringify({ stream: true }),
    });

    const response = await transport.fetch(request);

    expect(await response.text()).toBe("ws");
    expect(wsCalls).toEqual(["https://api.openai.com/v1/responses"]);
    expect(webSocketHeaders?.get("authorization")).toBe("Bearer request-key");
  });

  test("enabled transport recognizes Responses URLs with query parameters", async () => {
    const wsCalls: string[] = [];
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      createWebSocketFetch: () =>
        createTestWebSocketFetch((input: RequestInfo | URL) => {
          wsCalls.push(getFetchInputUrl(input));
          return Promise.resolve(new Response("ws"));
        }),
    });

    const response = await transport.fetch("https://api.openai.com/v1/responses?beta=2", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });

    expect(await response.text()).toBe("ws");
    expect(wsCalls).toEqual(["https://api.openai.com/v1/responses?beta=2"]);
  });

  test("close retries after a connection-establishment race", async () => {
    let closeCalls = 0;
    let resolveWebSocketFetch: ((response: Response) => void) | undefined;
    const webSocketFetchPromise = new Promise<Response>((resolve) => {
      resolveWebSocketFetch = resolve;
    });
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      createWebSocketFetch: () =>
        createTestWebSocketFetch(
          () => webSocketFetchPromise,
          () => {
            closeCalls += 1;
          }
        ),
    });

    const responsePromise = transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });
    await Promise.resolve();
    transport.close();
    if (!resolveWebSocketFetch) {
      throw new Error("Expected test WebSocket fetch resolver to be initialized");
    }
    resolveWebSocketFetch(new Response("ws"));

    expect(await (await responsePromise).text()).toBe("ws");
    expect(closeCalls).toBe(2);
  });

  test("close retry failure does not mask a resolved WebSocket response", async () => {
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      createWebSocketFetch: () =>
        createTestWebSocketFetch(
          () => Promise.resolve(new Response("ws")),
          () => {
            throw new Error("close failed");
          }
        ),
    });

    const responsePromise = transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });
    await Promise.resolve();
    expect(() => transport.close()).toThrow("close failed");

    expect(await (await responsePromise).text()).toBe("ws");
  });

  test("close is idempotent after WebSocket fetch creation", async () => {
    let closeCalls = 0;
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      createWebSocketFetch: () =>
        createTestWebSocketFetch(
          () => Promise.resolve(new Response("ws")),
          () => {
            closeCalls += 1;
          }
        ),
    });

    await transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });
    transport.close();
    transport.close();

    expect(closeCalls).toBe(1);
  });
});

describe("Codex OAuth Responses WebSocket", () => {
  test("only chains an exact extension of the prior request and response", () => {
    const firstRequest = {
      model: "gpt-5.6-terra",
      input: [{ role: "user", content: "Inspect it." }],
      tools: [{ type: "function", name: "exec" }],
    };
    const output = [{ type: "function_call", call_id: "call_1", name: "exec" }];
    const continuation = {
      request: firstRequest,
      responseId: "resp_1",
      output,
    };
    const nextInput = [
      ...firstRequest.input,
      ...output,
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ];

    expect(
      buildCodexIncrementalWebSocketRequest({ ...firstRequest, input: nextInput }, continuation)
    ).toEqual({
      ...firstRequest,
      previous_response_id: "resp_1",
      input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
    });

    const changedTools = { ...firstRequest, input: nextInput, tools: [] };
    expect(buildCodexIncrementalWebSocketRequest(changedTools, continuation)).toBe(changedTools);

    const mismatchedHistory = { ...firstRequest, input: [{ role: "user", content: "Other" }] };
    expect(buildCodexIncrementalWebSocketRequest(mismatchedHistory, continuation)).toBe(
      mismatchedHistory
    );
  });

  test("forwards OAuth headers and reuses the connection with incremental input", async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    const requests: Array<Record<string, unknown>> = [];
    let authorization: string | undefined;
    let accountId: string | undefined;
    let beta: string | undefined;

    server.on("connection", (connection, request) => {
      authorization = request.headers.authorization;
      const rawAccountId = request.headers["chatgpt-account-id"];
      accountId = Array.isArray(rawAccountId) ? rawAccountId[0] : rawAccountId;
      const rawBeta = request.headers["openai-beta"];
      beta = Array.isArray(rawBeta) ? rawBeta[0] : rawBeta;
      connection.on("message", (data) => {
        const body = JSON.parse(
          Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Array.isArray(data)
              ? Buffer.concat(data).toString("utf8")
              : Buffer.from(data).toString("utf8")
        ) as Record<string, unknown>;
        requests.push(body);
        const responseNumber = requests.length;
        connection.send(
          JSON.stringify({
            type: "response.completed",
            response: {
              id: `resp_${responseNumber}`,
              output:
                responseNumber === 1
                  ? [{ type: "function_call", call_id: "call_1", name: "exec" }]
                  : [],
            },
          })
        );
      });
    });

    const baseCalls: string[] = [];
    const transport = createCodexOAuthWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch((input) => {
        baseCalls.push(getFetchInputUrl(input));
        return Promise.resolve(new Response("base"));
      }),
      webSocketUrl: `ws://127.0.0.1:${address.port}/backend-api/codex/responses`,
    });

    try {
      const firstInput = [{ role: "user", content: "Inspect it." }];
      const firstResponse = await transport.fetch(
        "https://chatgpt.com/backend-api/codex/responses",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer oauth-token",
            "ChatGPT-Account-Id": "account-1",
            "x-openai-internal-codex-responses-lite": "true",
          },
          body: JSON.stringify({ model: "gpt-5.6-terra", stream: true, input: firstInput }),
        }
      );
      await firstResponse.text();

      const firstOutput = [{ type: "function_call", call_id: "call_1", name: "exec" }];
      const secondResponse = await transport.fetch(
        "https://chatgpt.com/backend-api/codex/responses",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer oauth-token",
            "ChatGPT-Account-Id": "account-1",
          },
          body: JSON.stringify({
            model: "gpt-5.6-terra",
            stream: true,
            input: [
              ...firstInput,
              ...firstOutput,
              { type: "function_call_output", call_id: "call_1", output: "ok" },
            ],
          }),
        }
      );
      await secondResponse.text();

      expect(baseCalls).toEqual([]);
      expect(authorization).toBe("Bearer oauth-token");
      expect(accountId).toBe("account-1");
      expect(beta).toBe("responses_websockets=2026-02-06");
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        type: "response.create",
        model: "gpt-5.6-terra",
        input: firstInput,
        client_metadata: {
          ws_request_header_x_openai_internal_codex_responses_lite: "true",
        },
      });
      expect(requests[1]).toMatchObject({
        type: "response.create",
        model: "gpt-5.6-terra",
        previous_response_id: "resp_1",
        input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
      });
    } finally {
      transport.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
