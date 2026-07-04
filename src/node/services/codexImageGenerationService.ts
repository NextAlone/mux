import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CODEX_ENDPOINT } from "@/common/constants/codexOAuth";
import type { Result } from "@/common/types/result";
import type { CodexOauthAuth } from "@/node/utils/codexOauthAuth";

export interface CodexImageGenerationOauth {
  getValidAuth(): Promise<Result<CodexOauthAuth, string>>;
  recordUsageHeaders(headers: Headers): void;
}

export interface CodexImageReference {
  base64: string;
  mediaType: string;
}

export interface CodexImageGenerationInput {
  prompt: string;
  workspaceId: string;
  muxHome: string;
  size?: string | null;
  quality?: string | null;
  background?: string | null;
  referenceImage?: CodexImageReference | null;
  abortSignal?: AbortSignal;
}

export interface GeneratedCodexImage {
  base64: string;
  mediaType: "image/png";
  path: string;
  revisedPrompt?: string;
}

export type CodexImageGenerationResult =
  | { success: true; image: GeneratedCodexImage }
  | { success: false; error: string };

export interface CodexImageGenerator {
  generateImage(input: CodexImageGenerationInput): Promise<CodexImageGenerationResult>;
}

type CodexImageGenerationFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => Promise<Response>;

interface CodexImageGenerationServiceDeps {
  oauth: CodexImageGenerationOauth;
  fetchFn?: CodexImageGenerationFetch;
}

interface ImageGenerationCall {
  id?: string;
  type: "image_generation_call";
  result: string;
  revised_prompt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getResponseText(value: unknown): string {
  if (!isRecord(value)) return "";

  const error = value.error;
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }

  if (typeof value.message === "string") {
    return value.message;
  }

  return "";
}

function toImageGenerationCall(value: unknown): ImageGenerationCall | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.type !== "image_generation_call") {
    return null;
  }
  if (typeof value.result !== "string" || value.result.length === 0) {
    return null;
  }

  return {
    type: "image_generation_call",
    result: value.result,
    ...(typeof value.id === "string" && value.id.length > 0 ? { id: value.id } : {}),
    ...(typeof value.revised_prompt === "string" && value.revised_prompt.length > 0
      ? { revised_prompt: value.revised_prompt }
      : {}),
  };
}

function findImageGenerationCall(value: unknown): ImageGenerationCall | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findImageGenerationCall(item);
      if (match) return match;
    }
    return null;
  }

  const direct = toImageGenerationCall(value);
  if (direct) return direct;

  if (!isRecord(value)) {
    return null;
  }

  return (
    findImageGenerationCall(value.output) ??
    findImageGenerationCall(value.response) ??
    findImageGenerationCall(value.item)
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseSsePayloads(responseText: string): unknown[] {
  const payloads: unknown[] = [];

  for (const block of responseText.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")
      .trim();

    if (data.length === 0 || data === "[DONE]") {
      continue;
    }

    const parsed = parseJson(data);
    if (parsed != null) {
      payloads.push(parsed);
    }
  }

  return payloads;
}

function parseResponsePayload(responseText: string): unknown {
  const parsed = parseJson(responseText);
  if (parsed != null) {
    return parsed;
  }

  const payloads = parseSsePayloads(responseText);
  return payloads.length > 0 ? payloads : null;
}

function sanitizeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "image";
}

function buildRequestBody(input: CodexImageGenerationInput): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: input.prompt }];
  if (input.referenceImage != null) {
    content.push({
      type: "input_image",
      image_url: `data:${input.referenceImage.mediaType};base64,${input.referenceImage.base64}`,
    });
  }

  const imageTool: Record<string, unknown> = {
    type: "image_generation",
    model: "gpt-image-2",
    output_format: "png",
  };
  if (input.size != null) {
    imageTool.size = input.size;
  }
  if (input.quality != null) {
    imageTool.quality = input.quality;
  }
  if (input.background != null) {
    imageTool.background = input.background;
  }

  return {
    model: "gpt-5.5",
    input: [
      {
        role: "user",
        content,
      },
    ],
    tools: [imageTool],
    tool_choice: { type: "image_generation" },
    // Codex image generation rejects non-streaming Responses requests.
    stream: true,
    store: false,
  };
}

export class CodexImageGenerationService {
  private readonly oauth: CodexImageGenerationOauth;
  private readonly fetchFn: CodexImageGenerationFetch;

  constructor(deps: CodexImageGenerationServiceDeps) {
    this.oauth = deps.oauth;
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  async generateImage(input: CodexImageGenerationInput): Promise<CodexImageGenerationResult> {
    const auth = await this.oauth.getValidAuth();
    if (!auth.success) {
      return { success: false, error: auth.error };
    }

    const headers = new Headers({
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.data.access}`,
    });
    if (auth.data.accountId) {
      headers.set("ChatGPT-Account-Id", auth.data.accountId);
    }

    const response = await this.fetchFn(CODEX_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(buildRequestBody(input)),
      signal: input.abortSignal,
    });
    this.oauth.recordUsageHeaders(response.headers);

    const responseText = await response.text();
    const parsed = parseResponsePayload(responseText);

    if (!response.ok) {
      const message = getResponseText(parsed) || responseText.trim() || response.statusText;
      return {
        success: false,
        error: `Codex image generation failed (${response.status}): ${message}`,
      };
    }

    const imageCall = findImageGenerationCall(parsed);
    if (!imageCall) {
      return {
        success: false,
        error: "Codex image generation response did not include an image",
      };
    }

    const filename = `${sanitizeFilenamePart(imageCall.id ?? "image")}.png`;
    const outputDir = path.join(
      input.muxHome,
      "generated-images",
      sanitizeFilenamePart(input.workspaceId)
    );
    const outputPath = path.join(outputDir, filename);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(outputPath, Buffer.from(imageCall.result, "base64"));

    return {
      success: true,
      image: {
        base64: imageCall.result,
        mediaType: "image/png",
        path: outputPath,
        ...(imageCall.revised_prompt ? { revisedPrompt: imageCall.revised_prompt } : {}),
      },
    };
  }
}
