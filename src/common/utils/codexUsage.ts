import type { CodexUsageSnapshot, CodexUsageWindow } from "@/common/orpc/schemas/api";

type CodexUsageWindowKey = "primary" | "secondary";

const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

function parseFiniteNumber(value: string | null): number | null {
  if (value == null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function parseResetAt(headers: Headers, key: CodexUsageWindowKey, nowMs: number): number | null {
  const resetAfterSeconds = parseFiniteNumber(headers.get(`x-codex-${key}-reset-after-seconds`));
  if (resetAfterSeconds != null) {
    return nowMs + Math.max(0, resetAfterSeconds) * 1000;
  }

  const resetAt = headers.get(`x-codex-${key}-reset-at`);
  if (!resetAt) {
    return null;
  }

  const numericResetAt = Number(resetAt);
  if (Number.isFinite(numericResetAt)) {
    return numericResetAt > 1_000_000_000_000 ? numericResetAt : numericResetAt * 1000;
  }

  const parsedDate = Date.parse(resetAt);
  return Number.isFinite(parsedDate) ? parsedDate : null;
}

function parseWindow(
  headers: Headers,
  key: CodexUsageWindowKey,
  nowMs: number
): { window: Omit<CodexUsageWindow, "label">; windowMinutes: number | null } | null {
  const usedPercent = parseFiniteNumber(headers.get(`x-codex-${key}-used-percent`));
  if (usedPercent == null) {
    return null;
  }

  const clampedUsedPercent = clampPercent(usedPercent);
  return {
    window: {
      usedPercent: clampedUsedPercent,
      remainingPercent: clampPercent(100 - clampedUsedPercent),
      resetAt: parseResetAt(headers, key, nowMs),
    },
    windowMinutes: parseFiniteNumber(headers.get(`x-codex-${key}-window-minutes`)),
  };
}

export function parseCodexUsageSnapshotFromHeaders(
  headers: Headers,
  nowMs = Date.now()
): CodexUsageSnapshot | null {
  const primary = parseWindow(headers, "primary", nowMs);
  const secondary = parseWindow(headers, "secondary", nowMs);
  if (!primary && !secondary) {
    return null;
  }

  let fiveHour = primary?.windowMinutes === FIVE_HOUR_WINDOW_MINUTES ? primary.window : null;
  let weekly = primary?.windowMinutes === WEEKLY_WINDOW_MINUTES ? primary.window : null;

  if (secondary?.windowMinutes === FIVE_HOUR_WINDOW_MINUTES) {
    fiveHour = secondary.window;
  } else if (secondary?.windowMinutes === WEEKLY_WINDOW_MINUTES) {
    weekly = secondary.window;
  }

  // The observed Codex headers use primary for the short quota and secondary for
  // the weekly quota. Only use that fallback when the response omits window size
  // metadata entirely; otherwise explicit window-minutes wins.
  if (primary?.windowMinutes == null && secondary?.windowMinutes == null) {
    fiveHour ??= primary?.window ?? null;
    weekly ??= secondary?.window ?? null;
  }

  const windows = {
    fiveHour: fiveHour ? { ...fiveHour, label: "5h" as const } : null,
    weekly: weekly ? { ...weekly, label: "1w" as const } : null,
  };
  const remainingPercents = [windows.fiveHour, windows.weekly]
    .map((window) => window?.remainingPercent)
    .filter((value): value is number => typeof value === "number");

  return {
    source: "headers",
    updatedAt: nowMs,
    remainingPercent: Math.min(...remainingPercents),
    windows,
  };
}
