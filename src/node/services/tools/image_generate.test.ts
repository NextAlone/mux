import { describe, expect, it } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import * as fs from "fs/promises";
import * as path from "path";
import { createImageGenerateTool } from "./image_generate";
import type { CodexImageReference } from "@/node/services/codexImageGenerationService";
import { createTestToolConfig, TestTempDir } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions<undefined> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

describe("image_generate tool", () => {
  it("returns a media result from the Codex image generation service", async () => {
    using muxHome = new TestTempDir("image-generate-mux-home");
    const imageBase64 = Buffer.from("png bytes").toString("base64");
    const tool = createImageGenerateTool({
      ...createTestToolConfig(muxHome.path, { workspaceId: "workspace-1" }),
      codexImageGenerationService: {
        generateImage: (input) =>
          Promise.resolve({
            success: true,
            image: {
              base64: imageBase64,
              mediaType: "image/png",
              path: path.join(muxHome.path, "generated-images", "workspace-1", "image.png"),
              revisedPrompt: `refined ${input.prompt}`,
            },
          }),
      },
    });

    const result: unknown = await tool.execute!(
      {
        prompt: "Draw a clean app icon",
        size: "1024x1024",
        quality: "high",
      },
      mockToolCallOptions
    );

    expect(result).toEqual({
      type: "content",
      value: [
        {
          type: "text",
          text:
            "[Generated image: image.png (image/png). Saved to " +
            `${path.join(muxHome.path, "generated-images", "workspace-1", "image.png")}]` +
            "\nRevised prompt: refined Draw a clean app icon",
        },
        {
          type: "media",
          data: imageBase64,
          mediaType: "image/png",
          filename: "image.png",
        },
      ],
    });
  });

  it("fails clearly when Codex image generation is not configured", async () => {
    using muxHome = new TestTempDir("image-generate-mux-home");
    const tool = createImageGenerateTool(createTestToolConfig(muxHome.path));

    const result: unknown = await tool.execute!(
      {
        prompt: "Draw a clean app icon",
      },
      mockToolCallOptions
    );

    expect(result).toEqual({
      success: false,
      error: "Codex image generation service is not configured",
    });
  });

  it("passes a reference image from reference_image_path", async () => {
    using muxHome = new TestTempDir("image-generate-mux-home");
    const referencePngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l3rPjwAAAABJRU5ErkJggg==";
    await fs.writeFile(
      path.join(muxHome.path, "reference.png"),
      Buffer.from(referencePngBase64, "base64")
    );

    let capturedReferenceImage: CodexImageReference | null | undefined;
    const imageBase64 = Buffer.from("png bytes").toString("base64");
    const tool = createImageGenerateTool({
      ...createTestToolConfig(muxHome.path, { workspaceId: "workspace-1" }),
      codexImageGenerationService: {
        generateImage: (input) => {
          capturedReferenceImage = input.referenceImage;
          return Promise.resolve({
            success: true,
            image: {
              base64: imageBase64,
              mediaType: "image/png",
              path: path.join(muxHome.path, "generated-images", "workspace-1", "image.png"),
            },
          });
        },
      },
    });

    await tool.execute!(
      {
        prompt: "Edit the provided image",
        reference_image_path: "reference.png",
      },
      mockToolCallOptions
    );

    expect(capturedReferenceImage).toEqual({
      base64: referencePngBase64,
      mediaType: "image/png",
    });
  });
});
