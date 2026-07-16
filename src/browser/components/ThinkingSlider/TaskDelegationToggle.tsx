import { useEffect, useRef } from "react";
import { GitFork } from "lucide-react";

import { useAgent } from "@/browser/contexts/AgentContext";
import { useOptionalCommandRegistry } from "@/browser/contexts/CommandRegistryContext";
import { useTaskDelegationMode } from "@/browser/hooks/useTaskDelegationMode";
import { isAgentDescriptorExecLikeEditingCapable } from "@/common/utils/agentTools";
import { CommandIds } from "@/browser/utils/commandIds";
import { Tooltip, TooltipContent, TooltipTrigger } from "../Tooltip/Tooltip";
import { useLanguage } from "@/browser/contexts/LanguageContext";

interface TaskDelegationToggleProps {
  busy: boolean;
  topLevel: boolean;
}

export function TaskDelegationToggle(props: TaskDelegationToggleProps) {
  const { t } = useLanguage();
  const { agentId, agents, loaded } = useAgent();
  const [mode, setMode] = useTaskDelegationMode();
  const registerSource = useOptionalCommandRegistry()?.registerSource;
  const available =
    props.topLevel && loaded && isAgentDescriptorExecLikeEditingCapable(agentId, agents);
  const stateRef = useRef({ busy: props.busy, mode, setMode });
  stateRef.current = { busy: props.busy, mode, setMode };

  useEffect(() => {
    if (!registerSource || !available || props.busy) {
      return;
    }

    return registerSource(() => {
      const state = stateRef.current;
      return [
        {
          id: CommandIds.toggleTaskDelegation(),
          title: t("Toggle Proactive Task Delegation"),
          subtitle: t(state.mode === "proactive" ? "Current: Proactive" : "Current: Explicit only"),
          section: t("Mode"),
          keywords: ["task", "delegate", "delegation", "subagent", "proactive"],
          run: () => {
            const latest = stateRef.current;
            if (!latest.busy) {
              latest.setMode(latest.mode === "proactive" ? "explicit" : "proactive");
            }
          },
        },
      ];
    });
  }, [available, props.busy, registerSource, t]);

  if (!available) {
    return null;
  }

  const active = mode === "proactive";
  const label = active
    ? t("Proactive task delegation preference: on.")
    : t("Proactive task delegation preference: off.");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-component="TaskDelegationToggle"
          data-task-delegation-toggle
          aria-pressed={active}
          aria-disabled={props.busy}
          aria-label={
            props.busy
              ? `${label} ${t("It can be changed after the current turn finishes.")}`
              : `${label} ${t("Click to toggle.")}`
          }
          onClick={() => {
            if (!props.busy) {
              setMode(active ? "explicit" : "proactive");
            }
          }}
          className="hover:bg-hover aria-disabled:text-muted flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-transparent aria-disabled:cursor-not-allowed"
          style={{ color: active ? "var(--color-task-mode)" : "var(--color-text-secondary)" }}
        >
          <GitFork className="h-3.5 w-3.5" strokeWidth={active ? 2.4 : 1.8} />
        </button>
      </TooltipTrigger>
      <TooltipContent align="center">
        {props.busy
          ? t("Task delegation mode can be changed after the current turn finishes.")
          : t("Prefer proactive delegation on the next eligible user turn when useful.")}
      </TooltipContent>
    </Tooltip>
  );
}
