import type { ComponentProps } from "react";

import type { FusionToolArgs } from "@/common/types/tools";
import { WorkflowRunToolCall } from "./WorkflowRunToolCall";

type WorkflowRunProps = ComponentProps<typeof WorkflowRunToolCall>;

interface FusionToolCallProps extends Omit<WorkflowRunProps, "args" | "toolName"> {
  args: FusionToolArgs;
}

function getRunArgs(result: unknown): unknown {
  if (result == null || typeof result !== "object") return undefined;
  const run = (result as { run?: unknown }).run;
  if (run == null || typeof run !== "object") return undefined;
  return (run as { args?: unknown }).args;
}

export function FusionToolCall(props: FusionToolCallProps) {
  const workflowArgs = getRunArgs(props.result) ??
    props.workflowRunHint?.run?.args ?? {
      prompt: props.args.prompt,
    };

  return (
    <WorkflowRunToolCall
      {...props}
      args={{
        script_path: "skill://fusion/workflow.js",
        args: workflowArgs,
        run_in_background: props.args.run_in_background,
      }}
      toolName="workflow_run"
    />
  );
}
