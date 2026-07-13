import React, { useSyncExternalStore } from "react";
import { EmojiIcon } from "@/browser/components/icons/EmojiIcon/EmojiIcon";
import { TodoList } from "@/browser/components/TodoList/TodoList";
import type { TodoWriteToolArgs, TodoWriteToolResult } from "@/common/types/tools";
import { deriveTodoStatus, syncTodoStatuses } from "@/common/utils/todoList";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  ToolIcon,
} from "./Shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./Shared/toolUtils";

interface TodoToolCallProps {
  args: TodoWriteToolArgs;
  result?: TodoWriteToolResult;
  status?: ToolStatus;
  workspaceId?: string;
}

const EMPTY_TODOS: TodoWriteToolArgs["todos"] = [];

export const TodoToolCall: React.FC<TodoToolCallProps> = ({
  args,
  result: _result,
  status = "pending",
  workspaceId,
}) => {
  const { expanded, toggleExpanded } = useToolExpansion(false); // Collapsed by default
  const workspaceStore = useWorkspaceStoreRaw();
  const latestTodos = useSyncExternalStore(
    (callback) =>
      workspaceId ? workspaceStore.subscribeKey(workspaceId, callback) : () => undefined,
    () => (workspaceId ? workspaceStore.getTodos(workspaceId) : EMPTY_TODOS)
  );
  // The transcript keeps the original plan wording, while status follows the pinned
  // TODO panel so users do not see the same step as active and completed at once.
  const displayTodos = syncTodoStatuses(args.todos, latestTodos);
  const statusDisplay = getStatusDisplay(status);
  const todoStatusPreview = deriveTodoStatus(displayTodos);
  const fallbackPreview =
    args.todos.length === 0
      ? "Cleared todo list"
      : `${args.todos.length} item${args.todos.length === 1 ? "" : "s"}`;

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="todo_write" />
        <span className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1 italic">
          {todoStatusPreview ? (
            <>
              <EmojiIcon
                emoji={todoStatusPreview.emoji}
                className="h-3 w-3 shrink-0"
                // The preview icon reflects todo status, not the tool-call lifecycle:
                // active todos spin, completed checks stay still.
                spin={todoStatusPreview.emoji === "🔄"}
              />
              <span className="truncate">{todoStatusPreview.message}</span>
            </>
          ) : (
            <span className="truncate">{fallbackPreview}</span>
          )}
        </span>
        <StatusIndicator status={status}>{statusDisplay}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <TodoList todos={displayTodos} />
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
