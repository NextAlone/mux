import { describe, expect, test } from "bun:test";

import type { TodoItem } from "@/common/types/tools";
import { syncTodoStatuses } from "./todoList";

describe("syncTodoStatuses", () => {
  test("projects current statuses without replacing historical plan structure", () => {
    const historical: TodoItem[] = [
      { content: "Define requirements", status: "in_progress" },
      { content: "Search GitHub", status: "pending" },
      { content: "Historical-only step", status: "pending" },
    ];
    const latest: TodoItem[] = [
      { content: "Define requirements", status: "completed" },
      { content: "Search GitHub", status: "in_progress" },
      { content: "New step", status: "pending" },
    ];

    expect(syncTodoStatuses(historical, latest)).toEqual([
      { content: "Define requirements", status: "completed" },
      { content: "Search GitHub", status: "in_progress" },
      { content: "Historical-only step", status: "pending" },
    ]);
  });

  test("preserves the historical reference when no current status changes", () => {
    const historical: TodoItem[] = [{ content: "Define requirements", status: "completed" }];

    expect(syncTodoStatuses(historical, [])).toBe(historical);
    expect(syncTodoStatuses(historical, [...historical])).toBe(historical);
  });
});
