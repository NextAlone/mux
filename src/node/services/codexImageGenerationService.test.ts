import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Ok } from "@/common/types/result";
import { CODEX_ENDPOINT } from "@/common/constants/codexOAuth";
import { CodexImageGenerationService } from "./codexImageGenerationService";
import { TestTempDir } from "./tools/testHelpers";

describe("CodexImageGenerationService", () => {
  it("streams Codex image_generation requests and reads the completed SSE event", async () => {
    using muxHome = new TestTempDir("codex-image-service-stream");
    const imageBase64 = Buffer.from("stream png bytes").toString("base64");
    const requests: Array<{
      input: Parameters<typeof fetch>[0];
      init?: Parameters<typeof fetch>[1];
    }> = [];
    let usageHeadersRecorded = 0;
    const service = new CodexImageGenerationService({
      oauth: {
        getValidAuth: () =>
          Promise.resolve(
            Ok({
              type: "oauth",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
            })
          ),
        recordUsageHeaders: () => {
          usageHeadersRecorded += 1;
        },
      },
      fetchFn: (input, init) => {
        requests.push({ input, init });
        const completedEvent = {
          type: "response.completed",
          response: {
            output: [
              {
                id: "ig_stream",
                type: "image_generation_call",
                result: imageBase64,
                revised_prompt: "A streamed prompt",
              },
            ],
          },
        };
        return Promise.resolve(
          new Response(
            [
              'data: {"type":"response.created"}',
              "",
              `data: ${JSON.stringify(completedEvent)}`,
              "",
              "data: [DONE]",
              "",
            ].join("\n"),
            {
              headers: {
                "Content-Type": "text/event-stream",
              },
            }
          )
        );
      },
    });

    const result = await service.generateImage({
      prompt: "Draw a streamed app icon",
      workspaceId: "workspace-1",
      muxHome: muxHome.path,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(usageHeadersRecorded).toBe(1);

    const bodyText = requests[0]?.init?.body;
    if (typeof bodyText !== "string") {
      throw new Error("Expected Codex image generation request body to be a JSON string");
    }

    expect(JSON.parse(bodyText)).toMatchObject({ stream: true });
    expect(result.image).toMatchObject({
      base64: imageBase64,
      revisedPrompt: "A streamed prompt",
    });
    expect(path.basename(result.image.path)).toBe("ig_stream.png");
    expect(await fs.readFile(result.image.path, "base64")).toBe(imageBase64);
  });

  it("posts a Codex Responses image_generation request and persists the returned image", async () => {
    using muxHome = new TestTempDir("codex-image-service");
    const imageBase64 = Buffer.from("png bytes").toString("base64");
    const requests: Array<{
      input: Parameters<typeof fetch>[0];
      init?: Parameters<typeof fetch>[1];
    }> = [];
    const recordedHeaders: string[] = [];
    const service = new CodexImageGenerationService({
      oauth: {
        getValidAuth: () =>
          Promise.resolve(
            Ok({
              type: "oauth",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
              accountId: "account-id",
            })
          ),
        recordUsageHeaders: (headers) => {
          recordedHeaders.push(headers.get("x-codex-primary-used-percent") ?? "");
        },
      },
      fetchFn: (input, init) => {
        requests.push({ input, init });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "resp_123",
              output: [
                {
                  id: "ig_123",
                  type: "image_generation_call",
                  status: "completed",
                  revised_prompt: "A refined app icon prompt",
                  result: imageBase64,
                },
              ],
            }),
            {
              headers: {
                "Content-Type": "application/json",
                "x-codex-primary-used-percent": "42",
              },
            }
          )
        );
      },
    });

    const result = await service.generateImage({
      prompt: "Draw a clean app icon",
      workspaceId: "workspace-1",
      muxHome: muxHome.path,
      size: "1024x1024",
      quality: "high",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe(CODEX_ENDPOINT);
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer access-token");
    expect(headers.get("ChatGPT-Account-Id")).toBe("account-id");
    expect(recordedHeaders).toEqual(["42"]);

    const bodyText = requests[0]?.init?.body;
    if (typeof bodyText !== "string") {
      throw new Error("Expected Codex image generation request body to be a JSON string");
    }

    const body = JSON.parse(bodyText) as {
      model?: unknown;
      input?: unknown;
      tools?: unknown;
      tool_choice?: unknown;
      stream?: unknown;
      store?: unknown;
    };
    expect(body).toMatchObject({
      model: "gpt-5.5",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Draw a clean app icon" }],
        },
      ],
      tools: [
        {
          type: "image_generation",
          model: "gpt-image-2",
          size: "1024x1024",
          quality: "high",
          output_format: "png",
        },
      ],
      tool_choice: { type: "image_generation" },
      stream: true,
      store: false,
    });

    expect(result.image).toMatchObject({
      base64: imageBase64,
      mediaType: "image/png",
      revisedPrompt: "A refined app icon prompt",
    });
    expect(path.basename(result.image.path)).toBe("ig_123.png");
    expect(await fs.readFile(result.image.path, "base64")).toBe(imageBase64);
  });
});
