import React from "react";
import { ChevronDown, Gauge } from "lucide-react";

import { useCodexUsageSnapshot } from "@/browser/stores/CodexUsageStore";
import { useWorkspaceStatsSnapshot } from "@/browser/stores/WorkspaceStore";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { calculateAverageTPS } from "@/browser/utils/messages/StreamingTPSCalculator";
import { cn } from "@/common/lib/utils";
import type { CodexUsageSnapshot, CodexUsageWindow } from "@/common/orpc/types";
import { BaseBarrier } from "./BaseBarrier";

interface LastResponseStatsBarrierProps {
  workspaceId: string;
}

const STALE_USAGE_MS = 10 * 60 * 1000;
const RESPONSE_RATE_TOOLTIP =
  "Average completed-response rate. Excludes time to first token and tool execution; includes output and thinking tokens.";

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function formatResetAt(resetAt: number | null): string {
  if (resetAt == null) {
    return "--";
  }

  const date = new Date(resetAt);
  const now = new Date();
  const sameLocalDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameLocalDay) {
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function getQuotaToneClass(remainingPercent: number): string {
  if (remainingPercent <= 10) {
    return "text-danger-soft";
  }
  if (remainingPercent <= 25) {
    return "text-warning";
  }
  return "text-muted";
}

const CodexUsageWindowSummary: React.FC<{
  label: string;
  window: CodexUsageWindow | null;
}> = (props) => {
  if (!props.window) {
    return null;
  }

  return (
    <span className="hidden items-center gap-1 whitespace-nowrap sm:inline-flex">
      <span>{props.label}</span>
      <span className={cn("counter-nums-mono", getQuotaToneClass(props.window.remainingPercent))}>
        {formatPercent(props.window.remainingPercent)}
      </span>
    </span>
  );
};

const CodexUsageDetailRow: React.FC<{
  label: string;
  window: CodexUsageWindow | null;
}> = (props) => {
  if (!props.window) {
    return null;
  }

  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-baseline gap-4 text-sm">
      <span className="text-foreground font-medium">{props.label}</span>
      <span className={cn("counter-nums-mono", getQuotaToneClass(props.window.remainingPercent))}>
        {formatPercent(props.window.remainingPercent)}
      </span>
      <span className="text-muted counter-nums-mono">{formatResetAt(props.window.resetAt)}</span>
    </div>
  );
};

const CodexUsageRemaining: React.FC<{ snapshot: CodexUsageSnapshot }> = (props) => {
  const [open, setOpen] = React.useState(false);
  const remainingLabel = formatPercent(props.snapshot.remainingPercent);
  const stale = Date.now() - props.snapshot.updatedAt > STALE_USAGE_MS;

  return (
    <div className="relative ml-auto shrink-0">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Codex 剩余用量 ${remainingLabel}`}
        className="hover:bg-background-secondary/80 focus-visible:ring-focus-ring flex max-w-full items-center gap-1.5 rounded px-2 py-1 text-[11px] whitespace-nowrap transition-colors focus-visible:ring-1 focus-visible:outline-none"
        onClick={() => setOpen((value) => !value)}
      >
        <Gauge className="text-muted h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="text-muted hidden sm:inline">Codex</span>
        <span className="text-foreground font-medium">剩余用量</span>
        <span
          className={cn(
            "counter-nums-mono font-medium",
            getQuotaToneClass(props.snapshot.remainingPercent)
          )}
        >
          {remainingLabel}
        </span>
        <span className="bg-border-medium mx-0.5 hidden h-3 w-px sm:inline-block" />
        <CodexUsageWindowSummary label="5h" window={props.snapshot.windows.fiveHour} />
        <CodexUsageWindowSummary label="1w" window={props.snapshot.windows.weekly} />
        {stale && <span className="text-dim hidden sm:inline">stale</span>}
        <ChevronDown
          className={cn("text-muted h-3 w-3 shrink-0 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Codex usage details"
          className="bg-background border-border-medium absolute right-0 bottom-full z-30 mb-2 w-64 rounded-md border p-3 shadow-lg"
        >
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <span className="text-foreground text-sm font-semibold">剩余用量</span>
            <span
              className={cn(
                "counter-nums-mono text-sm font-semibold",
                getQuotaToneClass(props.snapshot.remainingPercent)
              )}
            >
              {remainingLabel}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <CodexUsageDetailRow label="5 小时" window={props.snapshot.windows.fiveHour} />
            <CodexUsageDetailRow label="1 周" window={props.snapshot.windows.weekly} />
          </div>
          <div className="text-dim mt-3 text-[10px]">
            Updated {formatResetAt(props.snapshot.updatedAt)}
            {stale ? " · stale" : ""}
          </div>
        </div>
      )}
    </div>
  );
};

export const LastResponseStatsBarrier: React.FC<LastResponseStatsBarrierProps> = (props) => {
  const snapshot = useWorkspaceStatsSnapshot(props.workspaceId);
  const codexUsageSnapshot = useCodexUsageSnapshot();
  const lastRequest = snapshot?.lastRequest;

  if (snapshot?.active) {
    return null;
  }

  const totalTokens = lastRequest ? lastRequest.outputTokens + lastRequest.reasoningTokens : 0;
  const avgTPS =
    lastRequest && !lastRequest.invalid
      ? calculateAverageTPS(lastRequest.streamingMs, lastRequest.modelTimeMs, totalTokens, null)
      : null;
  const showLastResponseStats = Boolean(avgTPS && totalTokens > 0);

  if (!showLastResponseStats && !codexUsageSnapshot) {
    return null;
  }

  return (
    <div className="flex items-center justify-between gap-3">
      {showLastResponseStats && avgTPS && (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <BaseBarrier text="Response rate" color="var(--color-assistant-border)" />
          <TooltipIfPresent tooltip={RESPONSE_RATE_TOOLTIP}>
            <span
              data-testid="last-response-stats"
              className="text-assistant-border counter-nums-mono inline-flex min-w-[14ch] items-baseline justify-end text-[11px] whitespace-nowrap select-none"
            >
              <span>~{totalTokens.toLocaleString()} tokens</span>
              <span className="text-dim ml-1 inline-flex min-w-[7ch] items-baseline justify-end gap-1">
                <span>@</span>
                <span>{Math.round(avgTPS)}</span>
                <span>t/s</span>
              </span>
            </span>
          </TooltipIfPresent>
        </div>
      )}
      {codexUsageSnapshot && <CodexUsageRemaining snapshot={codexUsageSnapshot} />}
    </div>
  );
};
