import { log } from "@/node/services/log";

/**
 * Maximum size of base64 image data in bytes before we drop it.
 *
 * Rationale: providers already accept multi‑megabyte images, but a single
 * 20–30MB screenshot can still blow up request sizes or hit provider limits
 * (e.g., Anthropic ~32MB total request). We keep a generous per‑image guard to
 * pass normal screenshots while preventing pathological payloads.
 */
export const MAX_IMAGE_DATA_BYTES = 8 * 1024 * 1024; // 8MB guard per image
export const MAX_TEXT_CONTENT_CHARS = 64_000;

/**
 * MCP CallToolResult content types (from @ai-sdk/mcp)
 */
interface MCPTextContent {
  type: "text";
  text: string;
}

interface MCPImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

interface MCPResourceContent {
  type: "resource";
  resource: { uri: string; text?: string; blob?: string; mimeType?: string };
}

export interface MCPTextPersistence {
  writeTextFile: (content: string) => Promise<string>;
}

type MCPContent = MCPTextContent | MCPImageContent | MCPResourceContent;

export interface MCPCallToolResult {
  content?: MCPContent[];
  isError?: boolean;
  toolResult?: unknown;
}

/**
 * AI SDK LanguageModelV2ToolResultOutput content types
 */
type AISDKContentPart =
  | { type: "text"; text: string }
  | { type: "media"; data: string; mediaType: string };

/**
 * Format byte size as human-readable string (KB or MB).
 * Uses decimal (SI) units (1000-based) — intentionally different from the shared
 * binary-unit formatBytes in @/common/utils/formatBytes which uses 1024-based thresholds.
 */
function formatBytesSI(bytes: number): string {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1000)} KB`;
}

function createTextOverflowNotice(text: string, savedPath?: string): string {
  const saved = savedPath ? ` Full result saved to ${savedPath}.` : "";
  const suffix = `\n\n[MCP text result truncated by Mux: ${text.length.toLocaleString()} characters exceeded ${MAX_TEXT_CONTENT_CHARS.toLocaleString()}.${saved} Ask the tool for a narrower query or pagination.]`;
  return `${text.slice(0, Math.max(0, MAX_TEXT_CONTENT_CHARS - suffix.length))}${suffix}`;
}

function truncateTextContent(text: string): string {
  if (text.length <= MAX_TEXT_CONTENT_CHARS) {
    return text;
  }

  return createTextOverflowNotice(text);
}

function isMCPCallToolResult(value: unknown): value is MCPCallToolResult {
  return typeof value === "object" && value !== null;
}

async function persistTextIfOversized(
  text: string,
  persistence: MCPTextPersistence
): Promise<string> {
  if (text.length <= MAX_TEXT_CONTENT_CHARS) {
    return text;
  }

  try {
    const savedPath = await persistence.writeTextFile(text);
    return createTextOverflowNotice(text, savedPath);
  } catch (error) {
    log.warn("[MCP] Failed to persist oversized text result, falling back to truncation", {
      error: error instanceof Error ? error.message : String(error),
      textLength: text.length,
    });
    return createTextOverflowNotice(text);
  }
}

export async function persistOversizedMCPTextResult(
  result: unknown,
  persistence: MCPTextPersistence
): Promise<unknown> {
  if (!isMCPCallToolResult(result)) {
    return result;
  }

  const typed = result;
  if (typed.isError || typed.toolResult !== undefined) {
    return result;
  }

  if (!typed.content || !Array.isArray(typed.content)) {
    return result;
  }

  let changed = false;
  const content: MCPContent[] = [];
  for (const item of typed.content) {
    if (item.type === "text") {
      const text = await persistTextIfOversized(item.text, persistence);
      changed ||= text !== item.text;
      content.push(text === item.text ? item : { ...item, text });
      continue;
    }

    if (item.type === "resource" && item.resource.text !== undefined) {
      const text = await persistTextIfOversized(item.resource.text, persistence);
      changed ||= text !== item.resource.text;
      content.push(
        text === item.resource.text ? item : { ...item, resource: { ...item.resource, text } }
      );
      continue;
    }

    content.push(item);
  }

  return changed ? { ...typed, content } : result;
}

/**
 * Transform MCP tool result to AI SDK format.
 * Converts MCP's "image" content type to AI SDK's "media" type.
 * Truncates large images to prevent context overflow.
 */
export function transformMCPResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }

  const typed = result as MCPCallToolResult;

  // If it's an error or has toolResult, pass through as-is
  if (typed.isError || typed.toolResult !== undefined) {
    return result;
  }

  // If no content array, pass through
  if (!typed.content || !Array.isArray(typed.content)) {
    return result;
  }

  const hasImage = typed.content.some((c) => c.type === "image");
  const hasOversizedText = typed.content.some(
    (c) =>
      (c.type === "text" && c.text.length > MAX_TEXT_CONTENT_CHARS) ||
      (c.type === "resource" && (c.resource.text?.length ?? 0) > MAX_TEXT_CONTENT_CHARS)
  );
  if (!hasImage && !hasOversizedText) {
    return result;
  }

  // Debug: log what we received from MCP
  log.debug("[MCP] transformMCPResult input", {
    contentTypes: typed.content.map((c) => c.type),
    textItems: typed.content
      .filter((c): c is MCPTextContent => c.type === "text")
      .map((c) => ({ type: c.type, textLen: c.text.length })),
    imageItems: typed.content
      .filter((c): c is MCPImageContent => c.type === "image")
      .map((c) => ({ type: c.type, mimeType: c.mimeType, dataLen: c.data?.length })),
  });

  // Transform to AI SDK content format
  const transformedContent: AISDKContentPart[] = typed.content.map((item) => {
    if (item.type === "text") {
      return { type: "text" as const, text: truncateTextContent(item.text) };
    }
    if (item.type === "image") {
      const imageItem = item;
      // Check if image data exceeds the limit
      const dataLength = imageItem.data?.length ?? 0;
      if (dataLength > MAX_IMAGE_DATA_BYTES) {
        log.warn("[MCP] Image data too large, omitting from context", {
          mimeType: imageItem.mimeType,
          dataLength,
          maxAllowed: MAX_IMAGE_DATA_BYTES,
        });
        return {
          type: "text" as const,
          text: `[Image omitted: ${formatBytesSI(dataLength)} exceeds per-image guard of ${formatBytesSI(MAX_IMAGE_DATA_BYTES)}. Reduce resolution or quality and retry.]`,
        };
      }
      // Ensure mediaType is present - default to image/png if missing
      const mediaType = imageItem.mimeType || "image/png";
      log.debug("[MCP] Transforming image content", { mimeType: imageItem.mimeType, mediaType });
      return { type: "media" as const, data: imageItem.data, mediaType };
    }
    // For resource type, convert to text representation
    if (item.type === "resource") {
      const text = item.resource.text ?? item.resource.uri;
      return { type: "text" as const, text: truncateTextContent(text) };
    }
    // Fallback: stringify unknown content
    return { type: "text" as const, text: JSON.stringify(item) };
  });

  return { type: "content", value: transformedContent };
}
