import { useEffect, useState } from "react";
import { ArrowLeft, Menu, RefreshCw } from "lucide-react";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useRouter } from "@/browser/contexts/RouterContext";
import { useAnalyticsDashboard, useSavedQueries } from "@/browser/hooks/useAnalytics";
import { DESKTOP_TITLEBAR_HEIGHT_CLASS, isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { isEditableElement, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { Button } from "@/browser/components/Button/Button";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { cn } from "@/common/lib/utils";
import { AgentCostChart } from "./AgentCostChart";
import { DelegationChart } from "./DelegationChart";
import { SavedQueryPanel } from "./SavedQueryPanel";
import { SqlExplorer } from "./SqlExplorer";
import { ProviderCacheHitChart } from "./ProviderCacheHitChart";
import { ModelBreakdown } from "./ModelBreakdown";
import { SpendChart } from "./SpendChart";
import { SummaryCards } from "./SummaryCards";
import { TimingChart } from "./TimingChart";
import { TokensByModelChart } from "./TokensByModelChart";
import { formatProjectDisplayName } from "./analyticsUtils";
import { buildTimeFilterPredicate } from "./sqlTimeFilter";
import { useLanguage } from "@/browser/contexts/LanguageContext";

interface AnalyticsDashboardProps {
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
}

type TimeRange = "7d" | "30d" | "90d" | "all";
type TimingMetric = "ttft" | "duration" | "tps";

const VALID_TIME_RANGES = new Set<string>(["7d", "30d", "90d", "all"]);
const VALID_TIMING_METRICS = new Set<string>(["ttft", "duration", "tps"]);

const ANALYTICS_TIME_RANGE_STORAGE_KEY = "analytics:timeRange";
const ANALYTICS_TIMING_METRIC_STORAGE_KEY = "analytics:timingMetric";

/** Coerce a persisted value to a known TimeRange, falling back to "30d" if stale/corrupted. */
function normalizeTimeRange(value: unknown): TimeRange {
  return typeof value === "string" && VALID_TIME_RANGES.has(value) ? (value as TimeRange) : "30d";
}

/** Coerce a persisted value to a known TimingMetric, falling back to "duration" if stale/corrupted. */
function normalizeTimingMetric(value: unknown): TimingMetric {
  return typeof value === "string" && VALID_TIMING_METRICS.has(value)
    ? (value as TimingMetric)
    : "duration";
}

/** Build a local-midnight boundary so Today and range filters match the user's timezone. */
function localDaysAgo(days: number): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  now.setDate(now.getDate() - days);
  return now;
}

function computeDateRange(timeRange: TimeRange): {
  from: Date | null;
  to: Date | null;
  granularity: "hour" | "day" | "week";
} {
  switch (timeRange) {
    case "7d":
      return { from: localDaysAgo(6), to: null, granularity: "day" };
    case "30d":
      return { from: localDaysAgo(29), to: null, granularity: "day" };
    case "90d":
      return { from: localDaysAgo(89), to: null, granularity: "week" };
    case "all":
      return { from: null, to: null, granularity: "week" };
    default:
      // Self-heal: unknown persisted value → safe default.
      return { from: localDaysAgo(29), to: null, granularity: "day" };
  }
}

export function AnalyticsDashboard(props: AnalyticsDashboardProps) {
  const { t } = useLanguage();
  const { navigateFromAnalytics } = useRouter();
  const { userProjects } = useProjectContext();

  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [rawTimeRange, setTimeRange] = usePersistedState<TimeRange>(
    ANALYTICS_TIME_RANGE_STORAGE_KEY,
    "30d"
  );
  const [rawTimingMetric, setTimingMetric] = usePersistedState<TimingMetric>(
    ANALYTICS_TIMING_METRIC_STORAGE_KEY,
    "duration"
  );

  // Coerce persisted values to known enums — stale/corrupted localStorage
  // entries self-heal to defaults instead of crashing the dashboard.
  const timeRange = normalizeTimeRange(rawTimeRange);
  const timingMetric = normalizeTimingMetric(rawTimingMetric);

  const dateRange = computeDateRange(timeRange);
  // SQL predicate substituted for the time-filter placeholder in saved panels
  // and the SQL explorer, so user-authored queries can opt into the header's
  // date-range selection.
  const timeFilterSql = buildTimeFilterPredicate(dateRange.from, dateRange.to);

  const dashboard = useAnalyticsDashboard({
    projectPath,
    granularity: dateRange.granularity,
    timingMetric,
    from: dateRange.from,
    to: dateRange.to,
    refreshKey,
  });

  const {
    queries: savedQueries,
    save: saveQuery,
    update: updateSavedQuery,
    remove: removeSavedQuery,
  } = useSavedQueries();

  const projectRows = Array.from(userProjects.entries())
    .map(([path]) => ({
      path,
      label: formatProjectDisplayName(path),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const desktopMode = isDesktopMode();

  // Close analytics on Escape. Uses bubble phase so inner surfaces (Select dropdowns,
  // Popover) that call stopPropagation/preventDefault on Escape get first
  // right of refusal—only an unclaimed Escape navigates away from analytics.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!matchesKeybind(e, KEYBINDS.CANCEL)) return;
      if (e.defaultPrevented) return;
      if (isEditableElement(e.target)) return;

      e.preventDefault();
      e.stopPropagation();
      navigateFromAnalytics();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateFromAnalytics]);

  return (
    <div className="bg-surface-primary flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        data-testid="analytics-header"
        className={cn(
          `bg-surface-primary border-border-light titlebar-safe-right 
          titlebar-safe-right-gutter-3 flex shrink-0 items-center gap-2 border-b px-3`,
          desktopMode
            ? `${DESKTOP_TITLEBAR_HEIGHT_CLASS} titlebar-drag flex-nowrap`
            : "flex-wrap py-2 md:h-8 md:flex-nowrap md:py-0"
        )}
      >
        <div
          className={cn(
            "flex min-w-0 items-center gap-2",
            desktopMode ? "w-auto titlebar-no-drag" : "w-full md:w-auto"
          )}
        >
          {props.leftSidebarCollapsed && (
            <Button
              variant="ghost"
              size="icon"
              onClick={props.onToggleLeftSidebarCollapsed}
              title={t("Open sidebar")}
              aria-label={t("Open sidebar")}
              className="text-muted hover:text-foreground hidden h-6 w-6 md:inline-flex"
            >
              <Menu className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={navigateFromAnalytics}
            className="text-muted hover:text-foreground h-6 gap-1 px-2 text-xs"
            title={t("Back")}
            aria-label={t("Back to previous view")}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t("Back")}
          </Button>
          <h1 className="text-foreground text-sm font-semibold">{t("Analytics")}</h1>
        </div>

        <div
          className={cn(
            desktopMode
              ? "titlebar-no-drag ml-auto flex min-w-fit items-center gap-2"
              : "flex w-full min-w-0 flex-wrap items-center gap-2 md:ml-auto md:w-auto md:min-w-fit md:flex-nowrap"
          )}
        >
          {/* Keep the project control labeled on mobile for screen readers while
              keeping the compact mobile header visually uncluttered. */}
          <label
            className="text-muted sr-only text-xs md:not-sr-only md:inline"
            htmlFor="analytics-project-filter"
          >
            {t("Project")}
          </label>
          <select
            id="analytics-project-filter"
            value={projectPath ?? "__all"}
            onChange={(event) => {
              const nextValue = event.target.value;
              setProjectPath(nextValue === "__all" ? null : nextValue);
            }}
            className="border-border-medium bg-separator text-foreground h-6 min-w-0 flex-1 rounded border px-2 text-xs md:max-w-56 md:flex-none"
          >
            <option value="__all">{t("All projects")}</option>
            {projectRows.map((project) => (
              <option key={project.path} value={project.path}>
                {project.label}
              </option>
            ))}
          </select>

          <div className="border-border-medium bg-background ml-auto flex shrink-0 items-center gap-1 rounded-md border p-1">
            {(
              [
                ["7d", "7D"],
                ["30d", "30D"],
                ["90d", "90D"],
                ["all", "All"],
              ] as const
            ).map(([range, label]) => (
              <Button
                key={range}
                variant={timeRange === range ? "secondary" : "ghost"}
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setTimeRange(range)}
              >
                {label}
              </Button>
            ))}
          </div>
          <TooltipIfPresent tooltip={t("Refresh analytics")}>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              onClick={() => setRefreshKey((current) => current + 1)}
              disabled={dashboard.loading}
              aria-label={t("Refresh analytics")}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", dashboard.loading && "animate-spin")} />
            </Button>
          </TooltipIfPresent>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
          <SummaryCards
            data={dashboard.data?.summary ?? null}
            codexQuota={dashboard.data?.codexQuota ?? null}
            refreshedAt={dashboard.data?.refreshedAt ?? null}
            loading={dashboard.loading}
            error={dashboard.error}
          />
          <SpendChart
            data={dashboard.data?.spendOverTime ?? null}
            loading={dashboard.loading}
            error={dashboard.error}
            granularity={dateRange.granularity}
          />
          <ModelBreakdown
            spendByProject={{
              data: dashboard.data?.spendByProject ?? null,
              loading: dashboard.loading,
              error: dashboard.error,
            }}
            spendByModel={{
              data: dashboard.data?.spendByModel ?? null,
              loading: dashboard.loading,
              error: dashboard.error,
            }}
          />
          <TokensByModelChart
            data={dashboard.data?.tokensByModel ?? null}
            loading={dashboard.loading}
            error={dashboard.error}
          />
          <TimingChart
            data={dashboard.data?.timingDistribution ?? null}
            loading={dashboard.loading}
            error={dashboard.error}
            metric={timingMetric}
            onMetricChange={setTimingMetric}
          />
          <ProviderCacheHitChart
            data={dashboard.data?.providerCacheHitRatios ?? null}
            loading={dashboard.loading}
            error={dashboard.error}
          />
          <AgentCostChart
            data={dashboard.data?.agentCosts ?? null}
            loading={dashboard.loading}
            error={dashboard.error}
          />
          <DelegationChart
            data={dashboard.data?.delegationSummary ?? null}
            loading={dashboard.loading}
            error={dashboard.error}
          />
          {savedQueries.length > 0 && (
            <div className="flex flex-col gap-4">
              {savedQueries.map((query) => (
                <SavedQueryPanel
                  key={query.id}
                  query={query}
                  timeFilterSql={timeFilterSql}
                  onDelete={removeSavedQuery}
                  onUpdate={updateSavedQuery}
                />
              ))}
            </div>
          )}
          <SqlExplorer onSaveQuery={saveQuery} timeFilterSql={timeFilterSql} />
        </div>
      </div>
    </div>
  );
}
