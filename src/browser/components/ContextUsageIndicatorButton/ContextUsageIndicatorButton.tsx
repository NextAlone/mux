import React from "react";
import { Cloud, Hourglass } from "lucide-react";
import { TokenMeter } from "@/browser/features/RightSidebar/TokenMeter";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../Dialog/Dialog";
import {
  HorizontalThresholdSlider,
  type AutoCompactionConfig,
} from "@/browser/features/RightSidebar/ThresholdSlider";
import { Switch } from "../Switch/Switch";
import { formatTokens, type TokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";
import { cn } from "@/common/lib/utils";
import { Toggle1MContext } from "../Toggle1MContext/Toggle1MContext";
import { Tooltip, TooltipContent, TooltipTrigger } from "../Tooltip/Tooltip";

const CONTEXT_RING_SIZE = 16;
const CONTEXT_RING_RADIUS = 6.25;
const CONTEXT_RING_STROKE = 2;
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_RING_RADIUS;

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

const ContextUsageRing: React.FC<{
  data: TokenMeterData;
}> = ({ data }) => {
  let consumedPercent = 0;
  const ringSegments = data.segments
    .map((segment) => {
      const percentage = Math.max(
        0,
        Math.min(clampPercent(segment.percentage), 100 - consumedPercent)
      );
      const start = consumedPercent;
      consumedPercent += percentage;
      return { ...segment, percentage, start };
    })
    .filter((segment) => segment.percentage > 0);

  return (
    <svg
      data-context-usage-meter
      className="h-4 w-4 overflow-visible"
      width={CONTEXT_RING_SIZE}
      height={CONTEXT_RING_SIZE}
      viewBox={`0 0 ${CONTEXT_RING_SIZE} ${CONTEXT_RING_SIZE}`}
      aria-hidden="true"
    >
      <circle
        cx={CONTEXT_RING_SIZE / 2}
        cy={CONTEXT_RING_SIZE / 2}
        r={CONTEXT_RING_RADIUS}
        fill="none"
        stroke="var(--color-border-medium)"
        strokeWidth={CONTEXT_RING_STROKE}
        opacity={0.55}
      />
      <g transform={`rotate(-90 ${CONTEXT_RING_SIZE / 2} ${CONTEXT_RING_SIZE / 2})`}>
        {ringSegments.map((segment) => {
          const dash = (segment.percentage / 100) * CONTEXT_RING_CIRCUMFERENCE;
          const gap = CONTEXT_RING_CIRCUMFERENCE - dash;
          const offset = -(segment.start / 100) * CONTEXT_RING_CIRCUMFERENCE;

          return (
            <circle
              key={`${segment.type}-${segment.start}`}
              cx={CONTEXT_RING_SIZE / 2}
              cy={CONTEXT_RING_SIZE / 2}
              r={CONTEXT_RING_RADIUS}
              fill="none"
              stroke={segment.color}
              strokeWidth={CONTEXT_RING_STROKE}
              strokeLinecap="round"
              strokeDasharray={`${dash} ${gap}`}
              strokeDashoffset={offset}
            />
          );
        })}
      </g>
    </svg>
  );
};

export interface IdleCompactionConfig {
  /** Hours of inactivity before idle compaction triggers, or null if disabled */
  hours: number | null;
  /** Update the idle compaction hours setting */
  setHours: (hours: number | null) => void;
}

export interface RemoteCompactionConfig {
  /** Whether OpenAI Responses remote compaction is enabled globally. */
  enabled: boolean;
  /** Update the global remote compaction policy. */
  setEnabled: (enabled: boolean) => void;
}

interface ContextUsageIndicatorButtonProps {
  data: TokenMeterData;
  autoCompaction?: AutoCompactionConfig;
  idleCompaction?: IdleCompactionConfig;
  remoteCompaction?: RemoteCompactionConfig;
  /** Current model ID — used to show 1M context toggle for supported models */
  model?: string;
}

/** Tick marks with vertical lines attached to the meter */
const PercentTickMarks: React.FC = () => {
  const ticks = [0, 25, 50, 75, 100];
  return (
    <div className="relative -mt-1 h-5 w-full">
      {ticks.map((pct) => {
        const transform =
          pct === 0 ? "translateX(0%)" : pct === 100 ? "translateX(-100%)" : "translateX(-50%)";
        return (
          <div
            key={pct}
            className="absolute flex flex-col items-center"
            style={{ left: `${pct}%`, transform }}
          >
            <div className="bg-border-medium h-[3px] w-px" />
            <span className="text-muted text-[8px] leading-tight">{pct}</span>
          </div>
        );
      })}
    </div>
  );
};

/** Unified auto-compact settings panel */
const AutoCompactSettings: React.FC<{
  data: TokenMeterData;
  usageConfig?: AutoCompactionConfig;
  idleConfig?: IdleCompactionConfig;
  remoteConfig?: RemoteCompactionConfig;
  model?: string;
}> = ({ data, usageConfig, idleConfig, remoteConfig, model }) => {
  const [idleInputValue, setIdleInputValue] = React.useState(idleConfig?.hours?.toString() ?? "24");

  // Sync idle input when external hours change
  React.useEffect(() => {
    setIdleInputValue(idleConfig?.hours?.toString() ?? "24");
  }, [idleConfig?.hours]);

  const totalDisplay = formatTokens(data.totalTokens);
  const maxDisplay = data.maxTokens ? ` / ${formatTokens(data.maxTokens)}` : "";
  const percentageDisplay = data.maxTokens ? ` (${data.totalPercentage.toFixed(1)}%)` : "";

  const showUsageSlider = Boolean(usageConfig && data.maxTokens);
  const isIdleEnabled = idleConfig?.hours !== null && idleConfig?.hours !== undefined;

  const handleIdleToggle = (enabled: boolean) => {
    if (!idleConfig) return;
    const parsed = parseInt(idleInputValue, 10);
    idleConfig.setHours(enabled ? (Number.isNaN(parsed) || parsed < 1 ? 24 : parsed) : null);
  };

  const handleIdleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    if (!idleConfig) return;
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val) && val >= 1 && val !== idleConfig.hours && idleConfig.hours !== null) {
      idleConfig.setHours(val);
    } else if (e.target.value === "" || isNaN(val) || val < 1) {
      setIdleInputValue(idleConfig.hours?.toString() ?? "24");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Context Usage header with instruction */}
      <div>
        <div className="flex items-baseline justify-between">
          <span className="text-foreground font-medium">Context Usage</span>
          <span className="text-muted text-xs">
            {totalDisplay}
            {maxDisplay}
            {percentageDisplay}
          </span>
        </div>
        {showUsageSlider && (
          <div className="text-muted mt-1 text-[10px]">
            Drag blue slider to adjust usage-based auto-compaction
          </div>
        )}
      </div>

      {/* Token meter with threshold slider + tick marks */}
      <div>
        <div className="relative w-full py-1.5">
          <TokenMeter segments={data.segments} orientation="horizontal" />
          {showUsageSlider && usageConfig && <HorizontalThresholdSlider config={usageConfig} />}
        </div>
        {showUsageSlider && <PercentTickMarks />}
      </div>

      {/* 1M context toggle for supported Anthropic models */}
      {model && <Toggle1MContext model={model} />}

      {/* Idle-based auto-compact */}
      {idleConfig && (
        <div className="border-separator-light border-t pt-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Hourglass className="text-muted h-2.5 w-2.5" />
              <span className="text-foreground text-[11px] font-medium">Idle compaction</span>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                value={idleInputValue}
                onChange={(e) => setIdleInputValue(e.target.value)}
                onBlur={handleIdleBlur}
                disabled={!isIdleEnabled}
                className={cn(
                  "border-border-medium bg-background-secondary focus:border-accent h-5 w-10 rounded border px-1 text-center text-[11px] focus:outline-none",
                  !isIdleEnabled && "opacity-50"
                )}
              />
              <span className={cn("text-[10px]", isIdleEnabled ? "text-muted" : "text-muted/50")}>
                hrs
              </span>
              <Switch
                checked={isIdleEnabled}
                onCheckedChange={handleIdleToggle}
                className="scale-75"
              />
            </div>
          </div>
          <div className="text-muted mt-0.5 text-[10px]">
            Auto-compact after workspace inactivity
          </div>
        </div>
      )}

      {/* OpenAI Responses remote compaction */}
      {remoteConfig && (
        <div className="border-separator-light border-t pt-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Cloud className="text-muted h-2.5 w-2.5" />
              <span className="text-foreground text-[11px] font-medium">OpenAI remote compact</span>
            </div>
            <Switch
              checked={remoteConfig.enabled}
              onCheckedChange={remoteConfig.setEnabled}
              className="scale-75"
            />
          </div>
          <div className="text-muted mt-0.5 text-[10px]">
            Use OpenAI Responses compact for OpenAI compaction models
          </div>
        </div>
      )}

      {/* Warning for unknown model limits */}
      {!data.maxTokens && (
        <div className="text-subtle text-[10px] italic">
          Unknown model limits - showing relative usage only
        </div>
      )}

      {/* Persistence note */}
      <div className="text-muted border-separator-light border-t pt-2 text-[10px]">
        Usage threshold saved per model{idleConfig && "; idle timer saved per project"}
        {remoteConfig && "; remote compact saved globally"}
      </div>
    </div>
  );
};

export const ContextUsageIndicatorButton: React.FC<ContextUsageIndicatorButtonProps> = ({
  data,
  autoCompaction,
  idleCompaction,
  remoteCompaction,
  model,
}) => {
  const idleHours = idleCompaction?.hours;
  const isIdleCompactionEnabled = idleHours !== null && idleHours !== undefined;

  // Show nothing only if no tokens AND no idle compaction config to display
  // (idle compaction settings should always be accessible when the prop is passed)
  if (data.totalTokens === 0 && !idleCompaction) return null;

  const ariaLabel = data.maxTokens
    ? `Context usage: ${formatTokens(data.totalTokens)} / ${formatTokens(data.maxTokens)} (${data.totalPercentage.toFixed(
        1
      )}%)`
    : `Context usage: ${formatTokens(data.totalTokens)} (unknown limit)`;

  const compactLabel = data.maxTokens
    ? `${Math.round(data.totalPercentage)}%`
    : formatTokens(data.totalTokens);

  const hoverUsageSummary = data.maxTokens
    ? `Context ${formatTokens(data.totalTokens)} / ${formatTokens(data.maxTokens)} (${data.totalPercentage.toFixed(1)}%)`
    : `Context ${formatTokens(data.totalTokens)} (unknown limit)`;
  const hoverAutoSummary = autoCompaction
    ? autoCompaction.threshold < 100
      ? `Auto ${autoCompaction.threshold}%`
      : "Auto off"
    : null;
  const hoverIdleSummary = idleCompaction
    ? isIdleCompactionEnabled
      ? `Idle ${idleHours}h`
      : "Idle off"
    : null;
  const hoverRemoteSummary = remoteCompaction
    ? remoteCompaction.enabled
      ? "Remote compact on"
      : "Remote compact off"
    : null;
  const hoverSummary = [hoverUsageSummary, hoverAutoSummary, hoverIdleSummary, hoverRemoteSummary]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <Dialog>
      {/*
        Keep a hover-only one-line summary so users can quickly see compaction stats
        without reopening the full click-based settings dialog.
      */}
      <Tooltip delayDuration={200} disableHoverableContent>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <button
              aria-label={ariaLabel}
              aria-haspopup="dialog"
              className="text-muted hover:bg-hover hover:text-foreground hover:border-border-light relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-sm border border-transparent transition-colors duration-150"
              type="button"
            >
              {/* The chat footer uses a low-chrome toolbar; a ring keeps context state visible without adding another wide pill. */}
              <ContextUsageRing data={data} />
              {isIdleCompactionEnabled && (
                <span className="bg-background border-border-light absolute -right-0.5 -bottom-0.5 flex h-3 w-3 items-center justify-center rounded-full border">
                  <Hourglass className="text-muted h-2 w-2" />
                </span>
              )}
              <span data-context-usage-percent className="sr-only">
                {compactLabel}
              </span>
            </button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          showArrow={false}
          className="max-w-[calc(100vw-2rem)] text-center leading-snug break-words whitespace-normal sm:max-w-sm"
        >
          {hoverSummary}
        </TooltipContent>
      </Tooltip>

      {/*
        Keep compaction controls in a dialog so auto + idle settings stay open
        while users adjust sliders/toggles, instead of depending on hover timing.
      */}
      <DialogContent maxWidth="380px" className="gap-3 p-3">
        <DialogHeader className="space-y-0">
          <DialogTitle className="text-sm">Compaction Settings</DialogTitle>
        </DialogHeader>
        {/* Keep manual /compact discoverability in the settings modal so the inline auto-compact hint stays minimal. */}
        <div className="text-muted text-[10px]">
          <div>
            Run <span className="font-mono">/compact</span> to compact manually
          </div>
          <div className="mt-1">
            • <span className="font-mono">-m model</span>
          </div>
          <div>
            • <span className="font-mono">-t max output tokens</span>
          </div>
          <div>• Add a followup message on the next line</div>
        </div>
        <AutoCompactSettings
          data={data}
          usageConfig={autoCompaction}
          idleConfig={idleCompaction}
          remoteConfig={remoteCompaction}
          model={model}
        />
      </DialogContent>
    </Dialog>
  );
};
