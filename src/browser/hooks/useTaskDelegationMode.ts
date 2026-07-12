import { useThinking } from "@/browser/contexts/ThinkingContext";

export function useTaskDelegationMode() {
  const { taskDelegationMode, setTaskDelegationMode } = useThinking();
  return [taskDelegationMode, setTaskDelegationMode] as const;
}
