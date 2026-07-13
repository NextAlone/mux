import assert from "node:assert";
import { captureAndStripDevToolsHeader } from "./devToolsHeaderCapture";
import { log } from "./log";
import { createWebSocketFetch as createOpenAIWebSocketFetch } from "@vercel/ai-sdk-openai-websocket-fetch";
import WebSocket, { type RawData } from "ws";

type WebSocketFetch = ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) & {
  close: () => void;
};
interface WebSocketFetchOptions {
  url?: string;
}

type WebSocketFetchFactory = (options?: WebSocketFetchOptions) => WebSocketFetch;

interface CreateOpenAIWebSocketTransportFetchOptions {
  enabled: boolean;
  baseFetch: typeof fetch;
  webSocketUrl?: string;
  createWebSocketFetch?: WebSocketFetchFactory;
}

interface CreateCodexOAuthWebSocketTransportFetchOptions {
  enabled: boolean;
  baseFetch: typeof fetch;
  webSocketUrl: string;
}

interface OpenAIWebSocketTransportFetch {
  fetch: typeof fetch;
  close: () => void;
  active: boolean;
}

type JsonRecord = Record<string, unknown>;

const CODEX_RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
const CODEX_WS_RESPONSES_LITE_CLIENT_METADATA_KEY =
  "ws_request_header_x_openai_internal_codex_responses_lite";

interface CodexWebSocketContinuationState {
  request: JsonRecord;
  responseId: string;
  output: unknown[];
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRequestHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requestPropertiesMatch(previous: JsonRecord, current: JsonRecord): boolean {
  const ignored = new Set(["input", "client_metadata", "previous_response_id"]);
  const previousProperties = Object.fromEntries(
    Object.entries(previous).filter(([key]) => !ignored.has(key))
  );
  const currentProperties = Object.fromEntries(
    Object.entries(current).filter(([key]) => !ignored.has(key))
  );
  return equalJson(previousProperties, currentProperties);
}

/**
 * Reuse server-side response state only when the next explicit history is an exact extension of
 * the request and output that produced it. Mux deliberately keeps explicit history as the source
 * of truth; this conservative check makes WebSocket continuation an optimization, never a context
 * change when message transforms differ between steps.
 */
export function buildCodexIncrementalWebSocketRequest(
  request: JsonRecord,
  continuation: CodexWebSocketContinuationState | undefined
): JsonRecord {
  if (!continuation || !requestPropertiesMatch(continuation.request, request)) {
    return request;
  }

  if (!Array.isArray(request.input) || !Array.isArray(continuation.request.input)) {
    return request;
  }
  const currentInput: unknown[] = request.input;
  const previousInput: unknown[] = continuation.request.input;

  const expectedPrefix = [...previousInput, ...continuation.output];
  if (
    currentInput.length < expectedPrefix.length ||
    !expectedPrefix.every((item, index) => equalJson(item, currentInput[index]))
  ) {
    return request;
  }

  return {
    ...request,
    previous_response_id: continuation.responseId,
    input: currentInput.slice(expectedPrefix.length),
  };
}

function responseHeadersFromUpgrade(
  headers: Record<string, string | string[] | undefined>
): Headers {
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      responseHeaders.set(key, value);
    } else if (Array.isArray(value)) {
      for (const entry of value) responseHeaders.append(key, entry);
    }
  }
  return responseHeaders;
}

function decodeWebSocketData(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

/**
 * ChatGPT-authenticated Codex uses the same Responses WebSocket v2 protocol as the public API,
 * but its handshake also requires ChatGPT-Account-Id. The upstream fetch shim only forwards the
 * Authorization header, so keep this small Codex-specific adapter here.
 */
export function createCodexOAuthWebSocketTransportFetch(
  options: CreateCodexOAuthWebSocketTransportFetchOptions
): OpenAIWebSocketTransportFetch {
  if (!options.enabled) {
    return { fetch: options.baseFetch, close: () => undefined, active: false };
  }

  let socket: WebSocket | null = null;
  let connecting: Promise<WebSocket> | null = null;
  let busy = false;
  let disabled = false;
  let closeRequested = false;
  let handshakeHeaders = new Headers();
  let continuation: CodexWebSocketContinuationState | undefined;

  const disableWebSocket = (): void => {
    disabled = true;
    continuation = undefined;
    connecting = null;
    socket?.close();
    socket = null;
  };

  const connect = (headers: Headers): Promise<WebSocket> => {
    if (socket?.readyState === WebSocket.OPEN && !busy) return Promise.resolve(socket);
    if (connecting && !busy) return connecting;

    connecting = new Promise((resolve, reject) => {
      const requestHeaders = normalizeRequestHeaders(headers);
      requestHeaders["openai-beta"] = "responses_websockets=2026-02-06";
      const candidate = new WebSocket(options.webSocketUrl, { headers: requestHeaders });

      candidate.once("upgrade", (response) => {
        handshakeHeaders = responseHeadersFromUpgrade(response.headers);
      });
      candidate.once("open", () => {
        socket = candidate;
        connecting = null;
        resolve(candidate);
      });
      candidate.once("error", (error) => {
        if (connecting) {
          connecting = null;
          reject(error);
        }
      });
      candidate.once("close", () => {
        if (socket === candidate) socket = null;
      });
    });
    return connecting;
  };

  const transportFetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (disabled || !(await isStreamingResponsesRequest(input, init))) {
        return options.baseFetch(input, init);
      }

      const bodyText =
        typeof init?.body === "string"
          ? init.body
          : init?.body == null && input instanceof Request
            ? await input.clone().text()
            : undefined;
      if (bodyText == null) return options.baseFetch(input, init);

      let fullRequest: JsonRecord;
      try {
        const parsed = JSON.parse(bodyText) as unknown;
        if (!isJsonRecord(parsed)) return options.baseFetch(input, init);
        fullRequest = parsed;
      } catch {
        return options.baseFetch(input, init);
      }

      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      );
      captureAndStripDevToolsHeader(headers);

      let connection: WebSocket;
      try {
        connection = await connect(headers);
      } catch (error) {
        log.warn("Codex Responses WebSocket unavailable; falling back to HTTP", { error });
        disableWebSocket();
        return options.baseFetch(input, { ...(init ?? {}), headers });
      }

      busy = true;
      const requestWithoutStream = { ...fullRequest };
      delete requestWithoutStream.stream;
      const incrementalRequest = buildCodexIncrementalWebSocketRequest(
        requestWithoutStream,
        continuation
      );
      // WebSocket frames cannot change HTTP headers after the upgrade. Codex mirrors the
      // per-request compatibility headers into client_metadata for each response.create.
      const clientMetadata = isJsonRecord(incrementalRequest.client_metadata)
        ? { ...incrementalRequest.client_metadata }
        : {};
      if (headers.get(CODEX_RESPONSES_LITE_HEADER) === "true") {
        clientMetadata[CODEX_WS_RESPONSES_LITE_CLIENT_METADATA_KEY] = "true";
      }
      const turnState = headers.get(CODEX_TURN_STATE_HEADER);
      if (turnState) clientMetadata[CODEX_TURN_STATE_HEADER] = turnState;
      const wireRequest = {
        type: "response.create",
        ...incrementalRequest,
        ...(Object.keys(clientMetadata).length > 0 ? { client_metadata: clientMetadata } : {}),
      };
      const encoder = new TextEncoder();

      const responseStream = new ReadableStream<Uint8Array>({
        start(controller) {
          let completed = false;

          const cleanup = (): void => {
            connection.off("message", onMessage);
            connection.off("error", onError);
            connection.off("close", onClose);
            init?.signal?.removeEventListener("abort", onAbort);
            busy = false;
          };
          const onAbort = (): void => {
            cleanup();
            continuation = undefined;
            if (socket === connection) socket = null;
            connection.close();
            try {
              controller.error(init?.signal?.reason ?? new DOMException("Aborted", "AbortError"));
            } catch {
              // The response may have completed while the abort propagated.
            }
          };
          const onError = (error: Error): void => {
            disableWebSocket();
            cleanup();
            controller.error(error);
          };
          const onClose = (): void => {
            cleanup();
            if (!completed && !closeRequested) {
              disableWebSocket();
              controller.error(new Error("Codex Responses WebSocket closed before completion"));
              return;
            }
            try {
              controller.close();
            } catch {
              // A simultaneous abort/error may already have closed the controller.
            }
          };
          const onMessage = (data: RawData): void => {
            const text = decodeWebSocketData(data);
            controller.enqueue(encoder.encode(`data: ${text}\n\n`));
            try {
              const event = JSON.parse(text) as unknown;
              if (!isJsonRecord(event)) return;
              if (event.type === "response.completed") {
                const response = event.response;
                if (isJsonRecord(response) && typeof response.id === "string") {
                  continuation = {
                    request: requestWithoutStream,
                    responseId: response.id,
                    output: Array.isArray(response.output) ? response.output : [],
                  };
                }
                completed = true;
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                cleanup();
                controller.close();
              } else if (event.type === "error") {
                completed = true;
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                cleanup();
                controller.close();
              }
            } catch {
              // Preserve malformed provider frames for the SDK to diagnose.
            }
          };

          connection.on("message", onMessage);
          connection.on("error", onError);
          connection.on("close", onClose);
          if (init?.signal) {
            if (init.signal.aborted) {
              onAbort();
              return;
            }
            init.signal.addEventListener("abort", onAbort, { once: true });
          }
          connection.send(JSON.stringify(wireRequest));
        },
      });

      return new Response(responseStream, {
        status: 200,
        headers: new Headers({
          ...Object.fromEntries(handshakeHeaders),
          "content-type": "text/event-stream",
        }),
      });
    },
    "preconnect" in options.baseFetch && typeof options.baseFetch.preconnect === "function"
      ? { preconnect: options.baseFetch.preconnect.bind(options.baseFetch) }
      : {}
  ) as typeof fetch;

  return {
    fetch: transportFetch,
    close: () => {
      closeRequested = true;
      continuation = undefined;
      socket?.close();
      socket = null;
    },
    active: true,
  };
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "string") {
    return input;
  }
  return input.url;
}

async function isStreamingResponsesRequest(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<boolean> {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method.toUpperCase() !== "POST") {
    return false;
  }

  if (!/\/(?:v1\/)?responses(\?|$)/.test(getRequestUrl(input))) {
    return false;
  }

  const bodyText =
    typeof init?.body === "string"
      ? init.body
      : init?.body == null && input instanceof Request
        ? await input.clone().text()
        : undefined;
  if (bodyText === undefined) {
    return false;
  }

  try {
    const body = JSON.parse(bodyText) as { stream?: unknown };
    return body.stream === true;
  } catch {
    return false;
  }
}

export function createOpenAIWebSocketTransportFetch(
  options: CreateOpenAIWebSocketTransportFetchOptions
): OpenAIWebSocketTransportFetch {
  if (!options.enabled) {
    return {
      fetch: options.baseFetch,
      close: () => undefined,
      active: false,
    };
  }

  const webSocketFetchFactory = options.createWebSocketFetch ?? createOpenAIWebSocketFetch;
  let webSocketFetch: WebSocketFetch | null = null;

  const getWebSocketFetch = (): WebSocketFetch => {
    webSocketFetch ??= webSocketFetchFactory(
      options.webSocketUrl ? { url: options.webSocketUrl } : undefined
    );
    assert(
      typeof webSocketFetch.close === "function",
      "OpenAI WebSocket fetch must expose close()"
    );
    return webSocketFetch;
  };

  let closeRequested = false;
  const close = (): void => {
    if (closeRequested) {
      return;
    }
    closeRequested = true;
    webSocketFetch?.close();
  };

  const baseFetchWithPreconnect = options.baseFetch as typeof fetch & {
    preconnect?: typeof fetch.preconnect;
  };
  const fetchExtras =
    typeof baseFetchWithPreconnect.preconnect === "function"
      ? { preconnect: baseFetchWithPreconnect.preconnect.bind(baseFetchWithPreconnect) }
      : {};
  const transportFetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    // The upstream package falls through to globalThis.fetch for non-WebSocket requests.
    // Pre-filter here so Mux's existing fetch wrappers keep handling those HTTP paths.
    if (!(await isStreamingResponsesRequest(input, init))) {
      return options.baseFetch(input, init);
    }

    const activeWebSocketFetch = getWebSocketFetch();
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    captureAndStripDevToolsHeader(headers);
    const response = await activeWebSocketFetch(input, { ...(init ?? {}), headers });
    if (closeRequested) {
      try {
        activeWebSocketFetch.close();
      } catch {
        // Cleanup after a cancellation race must not mask the successful fetch response.
      }
    }
    return response;
  }, fetchExtras) as typeof fetch;

  return {
    fetch: transportFetch,
    close,
    active: true,
  };
}
