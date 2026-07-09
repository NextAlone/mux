import { getKnownModel } from "@/common/constants/knownModels";

/** Small/fast models preferred for AI-generated workspace names and titles. */
export const NAME_GEN_PREFERRED_MODELS = [getKnownModel("HAIKU").id, getKnownModel("GPT_MINI").id];

export function buildNameGenerationCandidates(
  configuredModel: string | null | undefined,
  fallbackModels: ReadonlyArray<string | null | undefined> = []
): string[] {
  const candidates: string[] = [];
  const add = (model: string | null | undefined) => {
    const trimmed = model?.trim();
    if (trimmed && !candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  };

  // User rationale: title generation should be able to use a small configured
  // model instead of inheriting a slow chat model.
  add(configuredModel);
  for (const model of NAME_GEN_PREFERRED_MODELS) add(model);
  for (const model of fallbackModels) add(model);
  return candidates;
}
