import { z } from "zod";

export const TASK_DELEGATION_MODES = ["explicit", "proactive"] as const;
export type TaskDelegationMode = (typeof TASK_DELEGATION_MODES)[number];
export const TaskDelegationModeSchema = z.enum(TASK_DELEGATION_MODES);
export type TaskDelegationCallSurface = "direct" | "code_mode" | "code_execution";

export function coerceTaskDelegationMode(value: unknown): TaskDelegationMode | undefined {
  return TASK_DELEGATION_MODES.includes(value as TaskDelegationMode)
    ? (value as TaskDelegationMode)
    : undefined;
}
