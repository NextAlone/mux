import { describe, expect, test } from "bun:test";

import { parseCodexUsageSnapshotFromHeaders } from "./codexUsage";

describe("parseCodexUsageSnapshotFromHeaders", () => {
  test("maps Codex used-percent headers into remaining 5h and weekly usage", () => {
    const nowMs = Date.UTC(2026, 6, 4, 1, 0, 0);
    const snapshot = parseCodexUsageSnapshotFromHeaders(
      new Headers({
        "x-codex-primary-used-percent": "75",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-after-seconds": "5160",
        "x-codex-secondary-used-percent": "92",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-at": "2026-07-07T00:00:00.000Z",
      }),
      nowMs
    );

    expect(snapshot?.remainingPercent).toBe(8);
    expect(snapshot?.windows.fiveHour).toEqual({
      label: "5h",
      usedPercent: 75,
      remainingPercent: 25,
      resetAt: nowMs + 5160 * 1000,
    });
    expect(snapshot?.windows.weekly).toEqual({
      label: "1w",
      usedPercent: 92,
      remainingPercent: 8,
      resetAt: Date.UTC(2026, 6, 7, 0, 0, 0),
    });
    expect(snapshot?.updatedAt).toBe(nowMs);
    expect(snapshot?.source).toBe("headers");
  });

  test("returns null when quota headers are absent", () => {
    expect(parseCodexUsageSnapshotFromHeaders(new Headers(), 1000)).toBeNull();
  });

  test("clamps malformed percentages to the valid remaining range", () => {
    const snapshot = parseCodexUsageSnapshotFromHeaders(
      new Headers({
        "x-codex-primary-used-percent": "130",
        "x-codex-primary-window-minutes": "300",
      }),
      1000
    );

    expect(snapshot?.windows.fiveHour?.usedPercent).toBe(100);
    expect(snapshot?.windows.fiveHour?.remainingPercent).toBe(0);
    expect(snapshot?.remainingPercent).toBe(0);
  });

  test("does not duplicate a recognized weekly window into the five-hour slot", () => {
    const snapshot = parseCodexUsageSnapshotFromHeaders(
      new Headers({
        "x-codex-primary-used-percent": "90",
        "x-codex-primary-window-minutes": "10080",
      }),
      1000
    );

    expect(snapshot?.windows.fiveHour).toBeNull();
    expect(snapshot?.windows.weekly?.remainingPercent).toBe(10);
    expect(snapshot?.remainingPercent).toBe(10);
  });
});
