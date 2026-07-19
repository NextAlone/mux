import { describe, expect, test } from "bun:test";
import { shouldCoalesceQuotaObservation } from "./quotaSnapshot";

describe("shouldCoalesceQuotaObservation", () => {
  test("coalesces reset-after timestamp drift for unchanged quota", () => {
    expect(
      shouldCoalesceQuotaObservation(
        { usedPercent: 25, remainingPercent: 75, resetAt: 1_000_000 },
        { usedPercent: 25, remainingPercent: 75, resetAt: 1_059_000 }
      )
    ).toBe(true);
  });

  test("preserves percentage and reset-cycle changes", () => {
    const previous = { usedPercent: 25, remainingPercent: 75, resetAt: 1_000_000 };
    expect(
      shouldCoalesceQuotaObservation(previous, {
        usedPercent: 26,
        remainingPercent: 74,
        resetAt: 1_001_000,
      })
    ).toBe(false);
    expect(
      shouldCoalesceQuotaObservation(previous, {
        usedPercent: 25,
        remainingPercent: 75,
        resetAt: 1_061_000,
      })
    ).toBe(false);
  });
});
