import { Skeleton } from "@/browser/components/Skeleton/Skeleton";
import type { AnalyticsDashboardData, Summary } from "@/browser/hooks/useAnalytics";
import { formatCompactNumber, formatPercent, formatUsd } from "./analyticsUtils";
import { useLanguage } from "@/browser/contexts/LanguageContext";

interface SummaryCardsProps {
  data: Summary | null;
  loading: boolean;
  error: string | null;
  codexQuota: AnalyticsDashboardData["codexQuota"];
  refreshedAt: number | null;
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SummaryCards(props: SummaryCardsProps) {
  const { t } = useLanguage();
  if (props.error) {
    return (
      <div className="bg-background-secondary border-danger-soft text-danger rounded-lg border px-3 py-2 text-xs">
        {t("Failed to load analytics summary:")}
        {props.error}
      </div>
    );
  }

  const totalSpend = props.data ? formatUsd(props.data.totalSpendUsd) : "$0.00";
  const todaySpend = props.data ? formatUsd(props.data.todaySpendUsd) : "$0.00";
  const avgDailySpend = props.data ? formatUsd(props.data.avgDailySpendUsd) : "$0.00";
  const cacheHitRatio = props.data ? formatPercent(props.data.cacheHitRatio) : "0.0%";

  const summaryRows = [
    {
      label: "Total Spend",
      value: totalSpend,
      helper: props.data
        ? props.data.unknownCostTokens > 0
          ? t("Excludes {count} unknown-cost tokens").replace(
              "{count}",
              formatCompactNumber(props.data.unknownCostTokens)
            )
          : t("All priced usage")
        : null,
    },
    {
      label: "Today",
      value: todaySpend,
      helper: null,
    },
    {
      label: "Avg / Day",
      value: avgDailySpend,
      helper: null,
    },
    {
      label: "Total Usage",
      value: props.data ? formatCompactNumber(props.data.totalTokens) : "0",
      helper: props.data
        ? t("{count} primary responses").replace(
            "{count}",
            formatCompactNumber(props.data.totalResponses)
          )
        : null,
    },
    {
      label: "OAuth Usage",
      value: props.data ? formatCompactNumber(props.data.oauthTokens) : "0",
      helper: props.data
        ? t("{count} calls · cost included").replace(
            "{count}",
            formatCompactNumber(props.data.oauthRequests)
          )
        : null,
    },
    {
      label: "Cache Hit Ratio",
      value: cacheHitRatio,
      helper: null,
    },
  ] as const;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {summaryRows.map((row) => (
          <div
            key={row.label}
            className="bg-background-secondary border-border-medium flex min-h-20 flex-col rounded-lg border p-3"
          >
            <div className="text-muted text-xs">{t(row.label)}</div>
            {props.loading ? (
              <Skeleton variant="shimmer" className="mt-1 h-6 w-20" />
            ) : (
              <div className="text-foreground counter-nums mt-1 text-lg font-semibold">
                {row.value}
              </div>
            )}
            {row.helper && !props.loading && (
              <div className="text-muted mt-1 text-[11px]">{row.helper}</div>
            )}
          </div>
        ))}
      </div>

      <div className="bg-background-secondary border-border-medium rounded-lg border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-foreground text-sm font-medium">{t("Codex OAuth quota")}</div>
            <div className="text-muted text-[11px]">
              {props.codexQuota
                ? t("Observed {time}").replace(
                    "{time}",
                    formatTimestamp(props.codexQuota.updatedAt)
                  )
                : t("Available after the next Codex OAuth response")}
            </div>
          </div>
          {props.data?.firstEventAt != null && props.data.lastEventAt != null && (
            <div className="text-muted text-right text-[11px]">
              <div>
                {t("Data {from} – {to}")
                  .replace("{from}", formatTimestamp(props.data.firstEventAt))
                  .replace("{to}", formatTimestamp(props.data.lastEventAt))}
              </div>
              {props.refreshedAt != null && (
                <div>
                  {t("Refreshed {time}").replace("{time}", formatTimestamp(props.refreshedAt))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {([props.codexQuota?.windows.fiveHour, props.codexQuota?.windows.weekly] as const).map(
            (window, index) => (
              <div key={window?.label ?? index}>
                <div className="text-muted flex justify-between text-xs">
                  <span>{window?.label ?? (index === 0 ? "5h" : "1w")}</span>
                  <span className="counter-nums">
                    {window ? `${window.remainingPercent.toFixed(1)}% ${t("remaining")}` : "—"}
                  </span>
                </div>
                <div className="bg-separator mt-1 h-1.5 overflow-hidden rounded-full">
                  <div
                    className="bg-accent h-full rounded-full"
                    style={{ width: `${window?.remainingPercent ?? 0}%` }}
                  />
                </div>
                {window?.resetAt != null && (
                  <div className="text-muted mt-1 text-[10px]">
                    {t("Resets {time}").replace("{time}", formatTimestamp(window.resetAt))}
                  </div>
                )}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
