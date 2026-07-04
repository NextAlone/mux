import { describe, expect, test } from "bun:test";

import { DEFAULT_COMPACTION_WORD_TARGET, buildCompactionPrompt } from "@/common/constants/ui";

import {
  buildCompactionMessageText,
  buildLocalStrategyCompactionMessageText,
} from "./compactionPrompt";

describe("compaction prompts", () => {
  test("keeps mux-current prompt text unchanged", () => {
    expect(buildLocalStrategyCompactionMessageText({ localStrategy: "mux-current" })).toBe(
      buildCompactionMessageText({})
    );
    expect(buildLocalStrategyCompactionMessageText({ localStrategy: "mux-current" })).toBe(
      buildCompactionPrompt(DEFAULT_COMPACTION_WORD_TARGET)
    );
  });

  test("uses a shorter dense handoff prompt for hybrid-local", () => {
    const currentPrompt = buildLocalStrategyCompactionMessageText({
      localStrategy: "mux-current",
    });
    const hybridPrompt = buildLocalStrategyCompactionMessageText({
      localStrategy: "hybrid-local",
    });

    expect(hybridPrompt.length).toBeLessThan(currentPrompt.length);
    expect(hybridPrompt).toContain("handoff");
    expect(hybridPrompt).toContain("Recent messages are preserved verbatim");
  });
});
