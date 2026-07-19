#!/usr/bin/env bun

/**
 * Downloads model prices from a pinned LiteLLM commit. Pass
 * `--revision <40-char sha>` only when intentionally advancing the snapshot.
 */

const OUTPUT_PATH = "src/common/utils/tokens/models.json";
const SOURCE_PATH = "src/common/utils/tokens/models-source.json";

interface PricingSource {
  provider: "LiteLLM";
  repository: string;
  revision: string;
  path: string;
}

async function resolvePricingSource(): Promise<PricingSource> {
  const source = (await Bun.file(SOURCE_PATH).json()) as PricingSource;
  const revisionFlagIndex = process.argv.indexOf("--revision");
  const revision =
    revisionFlagIndex < 0 ? source.revision : process.argv[revisionFlagIndex + 1]?.trim();
  if (!revision || !/^[0-9a-f]{40}$/i.test(revision)) {
    throw new Error("LiteLLM revision must be a full 40-character commit SHA");
  }
  return { ...source, revision };
}

const RETAINED_FIELDS = [
  "max_input_tokens",
  "max_output_tokens",
  "input_cost_per_token",
  "output_cost_per_token",
  "output_cost_per_image_token",
  "input_cost_per_token_above_200k_tokens",
  "output_cost_per_token_above_200k_tokens",
  "cache_creation_input_token_cost",
  "cache_creation_input_token_cost_above_200k_tokens",
  "cache_read_input_token_cost",
  "cache_read_input_token_cost_above_200k_tokens",
  "tiered_pricing_threshold_tokens",
  "mode",
  "litellm_provider",
  "supports_pdf_input",
  "supports_vision",
  "supports_audio_input",
  "supports_video_input",
  "max_pdf_size_mb",
] as const;

function pruneModelData(data: unknown): Record<string, Record<string, unknown>> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Expected LiteLLM model metadata object");
  }

  const pruned: Record<string, Record<string, unknown>> = {};
  for (const [modelId, rawMetadata] of Object.entries(data)) {
    if (!rawMetadata || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
      continue;
    }

    const metadata = rawMetadata as Record<string, unknown>;
    const retained: Record<string, unknown> = {};
    // Keep models.json small: Mux only reads pricing, token limits, provider, mode, and media
    // capability fields, while upstream LiteLLM ships many provider-specific fields we never use.
    for (const field of RETAINED_FIELDS) {
      if (metadata[field] !== undefined) {
        retained[field] = metadata[field];
      }
    }
    pruned[modelId] = retained;
  }

  return pruned;
}

async function updateModels() {
  const source = await resolvePricingSource();
  const url = `${source.repository.replace("github.com", "raw.githubusercontent.com")}/${source.revision}/${source.path}`;
  console.log(`Fetching model data from ${source.repository}@${source.revision}...`);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch model data: ${response.status} ${response.statusText}`);
  }

  const data = pruneModelData(await response.json());

  console.log(`Writing model data to ${OUTPUT_PATH}...`);
  await Bun.write(OUTPUT_PATH, `${JSON.stringify(data, null, 2)}\n`);
  await Bun.write(SOURCE_PATH, `${JSON.stringify(source, null, 2)}\n`);

  console.log("Model data updated successfully");
}

updateModels().catch((error) => {
  console.error("Error updating models:", error);
  process.exit(1);
});
