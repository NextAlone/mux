import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { ComponentProps } from "react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { MessageListProvider } from "@/browser/features/Messages/MessageListContext";
import { ToolNameProvider } from "@/browser/features/Messages/ToolNameContext";
import { TodoToolCall } from "./TodoToolCall";
import { useWorkspaceStoreRaw as getWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import type { TodoItem } from "@/common/types/tools";

const TEST_WORKSPACE_ID = "todo-tool-call-test";
const workspaceStore = getWorkspaceStoreRaw();
const originalGetTodos = workspaceStore.getTodos.bind(workspaceStore);
const originalSubscribeKey = workspaceStore.subscribeKey.bind(workspaceStore);

function renderTodoToolCall(props: ComponentProps<typeof TodoToolCall>) {
  return render(
    <ThemeProvider forcedTheme="dark">
      <MessageListProvider value={{ workspaceId: TEST_WORKSPACE_ID, latestMessageId: null }}>
        <ToolNameProvider toolName="todo_write">
          <TooltipProvider>
            <TodoToolCall {...props} />
          </TooltipProvider>
        </ToolNameProvider>
      </MessageListProvider>
    </ThemeProvider>
  );
}

describe("TodoToolCall", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    workspaceStore.getTodos = originalGetTodos;
    workspaceStore.subscribeKey = originalSubscribeKey;
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("spins the in-progress preview even after the todo_write call completes", () => {
    const view = renderTodoToolCall({
      args: {
        todos: [
          { content: "Confirm current revision and default location", status: "in_progress" },
        ],
      },
      result: { success: true, count: 1 },
      status: "completed",
    });

    const preview = view.getByText("Confirm current revision and default location").parentElement;
    const iconClass = preview?.querySelector("svg")?.getAttribute("class") ?? "";

    expect(iconClass).toContain("animate-spin");
  });

  test("does not spin the completed preview check while the todo_write call is still executing", () => {
    const view = renderTodoToolCall({
      args: {
        todos: [{ content: "Submit fix revision", status: "completed" }],
      },
      status: "executing",
    });

    const preview = view.getByText("Submit fix revision").parentElement;
    const iconClass = preview?.querySelector("svg")?.getAttribute("class") ?? "";

    expect(iconClass).not.toContain("animate-spin");
  });

  test("updates the historical preview when the pinned TODO state advances", () => {
    let latestTodos: TodoItem[] = [
      { content: "Define requirements", status: "in_progress" },
      { content: "Search GitHub", status: "pending" },
    ];
    let notifyWorkspace: (() => void) | undefined;
    workspaceStore.getTodos = () => latestTodos;
    workspaceStore.subscribeKey = (_workspaceId, callback) => {
      notifyWorkspace = callback;
      return () => undefined;
    };

    const view = renderTodoToolCall({
      workspaceId: TEST_WORKSPACE_ID,
      args: { todos: latestTodos },
      result: { success: true, count: 2 },
      status: "completed",
    });
    expect(view.getByText("Define requirements")).toBeTruthy();

    act(() => {
      latestTodos = [
        { content: "Define requirements", status: "completed" },
        { content: "Search GitHub", status: "in_progress" },
      ];
      notifyWorkspace?.();
    });

    expect(view.getByText("Search GitHub")).toBeTruthy();
    expect(view.queryByText("Define requirements")).toBeNull();
  });
});
