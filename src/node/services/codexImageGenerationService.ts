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

function findImageGenerationCall(value: unknown): ImageGenerationCall | null {
  if (!isRecord(value) || !Array.isArray(value.output)) {
    return null;
  }

  for (const item of value.output) {
    if (!isRecord(item)) continue;
    if (item.type !== "image_generation_call") continue;
    if (typeof item.result !== "string" || item.result.length === 0) continue;

    return {
      type: "image_generation_call",
      result: item.result,
      ...(typeof item.id === "string" && item.id.length > 0 ? { id: item.id } : {}),
      ...(typeof item.revised_prompt === "string" && item.revised_prompt.length > 0
        ? { revised_prompt: item.revised_prompt }
        : {}),
    };
  }

  return null;
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
    stream: false,
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText) as unknown;
    } catch {
      parsed = null;
    }

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
