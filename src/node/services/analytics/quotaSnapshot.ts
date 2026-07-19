const RESET_AT_COALESCE_TOLERANCE_MS = 60_000;

interface QuotaObservationValue {
  usedPercent: number;
  remainingPercent: number;
  resetAt: number | null;
}

/**
 * `reset-after-seconds` is converted to an absolute timestamp at response time,
 * so equivalent headers naturally drift by a few milliseconds. Coalescing that
 * noise keeps quota history sparse while preserving real reset-cycle changes.
 */
export function shouldCoalesceQuotaObservation(
  previous: QuotaObservationValue,
  next: QuotaObservationValue
): boolean {
  if (
    previous.usedPercent !== next.usedPercent ||
    previous.remainingPercent !== next.remainingPercent
  ) {
    return false;
  }

  if (previous.resetAt == null || next.resetAt == null) {
    return previous.resetAt === next.resetAt;
  }

  return Math.abs(previous.resetAt - next.resetAt) <= RESET_AT_COALESCE_TOLERANCE_MS;
}
