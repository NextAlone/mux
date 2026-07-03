import * as path from "node:path";
import { tool } from "ai";
import { getErrorMessage } from "@/common/utils/errors";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { CodexImageReference } from "@/node/services/codexImageGenerationService";
import { readAttachFileFromPath } from "@/node/utils/attachments/readAttachmentFromPath";

function resolveMuxHome(config: ToolConfiguration): string {
  return config.muxScope?.muxHome ?? config.workspaceSessionDir ?? config.cwd;
}

async function readReferenceImage(
  config: ToolConfiguration,
  referenceImagePath: string,
  abortSignal?: AbortSignal
): Promise<CodexImageReference> {
  const result = await readAttachFileFromPath({
    path: referenceImagePath,
    cwd: config.cwd,
    runtime: config.runtime,
    abortSignal,
  });

  if (result.type !== "attachment" || !result.attachment.mediaType.startsWith("image/")) {
    throw new Error("reference_image_path must point to a supported image file");
  }

  return {
    base64: result.attachment.data,
    mediaType: result.attachment.mediaType,
  };
}

export const createImageGenerateTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.image_generate.description,
    inputSchema: TOOL_DEFINITIONS.image_generate.schema,
    execute: async (
      { prompt, size, quality, background, reference_image_path },
      { abortSignal }
    ) => {
      if (!config.codexImageGenerationService) {
        return {
          success: false as const,
          error: "Codex image generation service is not configured",
        };
      }

      try {
        const referenceImage =
          reference_image_path != null
            ? await readReferenceImage(config, reference_image_path, abortSignal)
            : null;
        const result = await config.codexImageGenerationService.generateImage({
          prompt,
          workspaceId: config.workspaceId ?? "global",
          muxHome: resolveMuxHome(config),
          size,
          quality,
          background,
          referenceImage,
          abortSignal,
        });

        if (!result.success) {
          return result;
        }

        const filename = path.basename(result.image.path);
        const revisedPrompt =
          result.image.revisedPrompt != null
            ? `\nRevised prompt: ${result.image.revisedPrompt}`
            : "";
        return {
          type: "content" as const,
          value: [
            {
              type: "text" as const,
              text:
                `[Generated image: ${filename} (${result.image.mediaType}). ` +
                `Saved to ${result.image.path}]${revisedPrompt}`,
            },
            {
              type: "media" as const,
              data: result.image.base64,
              mediaType: result.image.mediaType,
              filename,
            },
          ],
        };
      } catch (error) {
        return {
          success: false as const,
          error: getErrorMessage(error),
        };
      }
    },
  });
};
