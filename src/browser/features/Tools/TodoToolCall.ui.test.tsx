import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { ComponentProps } from "react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { MessageListProvider } from "@/browser/features/Messages/MessageListContext";
import { ToolNameProvider } from "@/browser/features/Messages/ToolNameContext";
import { TodoToolCall } from "./TodoToolCall";

const TEST_WORKSPACE_ID = "todo-tool-call-test";

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
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("does not spin the collapsed preview after the todo_write call completes", () => {
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

    expect(iconClass).not.toContain("animate-spin");
  });
});
