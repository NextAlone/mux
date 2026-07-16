import React from "react";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  ToolIcon,
  ErrorBox,
} from "./Shared/ToolPrimitives";
import {
  useToolExpansion,
  getStatusDisplay,
  isToolErrorResult,
  type ToolStatus,
} from "./Shared/toolUtils";
import {
  GoalStatusBadge,
  GoalToolStat,
  extractGoalFromResult,
  formatGoalBudgetSummary,
  formatGoalCents,
  formatGoalElapsed,
  formatGoalTurns,
} from "./Goal/goalToolUtils";
import { useLanguage } from "@/browser/contexts/LanguageContext";

interface GetGoalToolCallProps {
  args: Record<string, never>;
  result?: unknown;
  status?: ToolStatus;
}

export const GetGoalToolCall: React.FC<GetGoalToolCallProps> = ({ result, status = "pending" }) => {
  const { t } = useLanguage();
  const { expanded, toggleExpanded } = useToolExpansion();
  const errorResult = isToolErrorResult(result) ? result : null;
  const goal = extractGoalFromResult(result);

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="get_goal" />
        <span className="text-secondary font-medium whitespace-nowrap">{t("Read goal")}</span>
        {goal && <GoalStatusBadge status={goal.status} />}
        {goal && (
          <span className="text-foreground hidden truncate italic @sm:inline">
            “{goal.objective}”
          </span>
        )}
        {!goal && status === "completed" && (
          <span className="text-muted truncate italic">{t("No current goal")}</span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {errorResult && <ErrorBox>{errorResult.error}</ErrorBox>}

          {goal && (
            <div className="bg-code-bg space-y-2 rounded px-3 py-2 text-[11px] leading-relaxed">
              <div>
                <div className="text-secondary text-[10px] tracking-wide uppercase">
                  {t("Objective")}
                </div>
                <div className="text-foreground">{goal.objective}</div>
              </div>

              <dl className="grid grid-cols-1 gap-x-4 gap-y-1 @sm:grid-cols-2">
                <GoalToolStat
                  label={t("Status")}
                  value={<GoalStatusBadge status={goal.status} />}
                />
                <GoalToolStat
                  label={t("Cost")}
                  value={
                    <span className="counter-nums">
                      {formatGoalBudgetSummary(goal.costCents, goal.budgetCents)}
                    </span>
                  }
                />
                <GoalToolStat
                  label={t("Turns")}
                  value={
                    <span className="counter-nums">
                      {formatGoalTurns(goal.turnsUsed, goal.turnCap)}
                    </span>
                  }
                />
                <GoalToolStat
                  label={t("Elapsed")}
                  value={
                    <span className="counter-nums">{formatGoalElapsed(goal.createdAtMs)}</span>
                  }
                />
                {goal.budgetCents != null && (
                  <GoalToolStat
                    label={t("Remaining")}
                    value={
                      <span className="counter-nums">
                        {formatGoalCents(Math.max(0, goal.budgetCents - goal.costCents))}
                      </span>
                    }
                  />
                )}
              </dl>

              {goal.completionSummary && (
                <div>
                  <div className="text-secondary text-[10px] tracking-wide uppercase">
                    {t("Summary")}
                  </div>
                  <div className="text-foreground">{goal.completionSummary}</div>
                </div>
              )}
            </div>
          )}

          {!goal && !errorResult && (
            <div className="text-muted px-3 py-2 text-[11px] italic">
              {t("No goal is set for this workspace.")}
            </div>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
