import { describe, expect, test } from "bun:test";

import { buildNameGenerationCandidates, NAME_GEN_PREFERRED_MODELS } from "./nameGeneration";

describe("buildNameGenerationCandidates", () => {
  test("tries configured title model before fast defaults and fallbacks", () => {
    const configured = "google:gemini-3.5-flash";
    const candidates = buildNameGenerationCandidates(configured, [
      NAME_GEN_PREFERRED_MODELS[0],
      "anthropic:claude-sonnet-5",
    ]);

    expect(candidates[0]).toBe(configured);
    expect(candidates).toContain(NAME_GEN_PREFERRED_MODELS[0]);
    expect(candidates).toContain("anthropic:claude-sonnet-5");
    expect(candidates.filter((model) => model === NAME_GEN_PREFERRED_MODELS[0])).toHaveLength(1);
  });
});
