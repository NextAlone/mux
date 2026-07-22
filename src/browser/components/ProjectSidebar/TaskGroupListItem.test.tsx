import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { LanguageProvider, type Language } from "@/browser/contexts/LanguageContext";
import { UI_LANGUAGE_KEY } from "@/common/constants/storage";
import { TaskGroupListItem } from "./TaskGroupListItem";

function renderTaskGroup(
  overrides: Partial<React.ComponentProps<typeof TaskGroupListItem>> = {},
  language: Language = "en"
) {
  localStorage.setItem(UI_LANGUAGE_KEY, JSON.stringify(language));
  return render(
    <LanguageProvider>
      <TaskGroupListItem
        groupId="best-of-demo"
        title="Compare options"
        kind="bestOf"
        depth={1}
        totalCount={3}
        visibleCount={3}
        completedCount={0}
        runningCount={0}
        queuedCount={0}
        interruptedCount={0}
        isExpanded={false}
        isSelected={false}
        onToggle={() => undefined}
        {...overrides}
      />
    </LanguageProvider>
  );
}

describe("TaskGroupListItem", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("marks groups with running members as in progress", () => {
    const view = renderTaskGroup({ runningCount: 2, queuedCount: 1 });

    const groupRow = view.getByTestId("task-group-best-of-demo");

    expect(groupRow.dataset.running).toBe("true");
    const descriptionId = groupRow.getAttribute("aria-describedby");
    expect(descriptionId).toBe("task-group-status-best-of-demo");
    expect(document.getElementById(descriptionId ?? "")?.textContent).toContain("2 running");
    expect(view.getByTestId("task-group-status-icon").className).toContain("text-content-success");
    expect(groupRow.textContent).toContain("2 running");
  });

  test("keeps queued-only groups pending instead of active", () => {
    const view = renderTaskGroup({ queuedCount: 1 });

    const groupRow = view.getByTestId("task-group-best-of-demo");

    expect(groupRow.dataset.running).toBe("false");
    expect(view.getByTestId("task-group-status-icon").className).not.toContain(
      "text-content-success"
    );
    expect(groupRow.textContent).toContain("1 queued");
  });

  test("formats member counts in Chinese without English word order", () => {
    const active = renderTaskGroup({ runningCount: 2, queuedCount: 1 }, "zh-CN");
    const activeRow = active.getByTestId("task-group-best-of-demo");

    expect(activeRow.textContent).toContain("2 个正在运行");
    expect(activeRow.textContent).toContain("1 个排队中");
    cleanup();

    const idle = renderTaskGroup({}, "zh-CN");
    expect(idle.getByTestId("task-group-best-of-demo").textContent).toContain("3 个候选项");
  });

  test("handles menu shortcuts without toggling the group or reaching window handlers", async () => {
    const onWindowKeydown = mock(() => undefined);
    const onArchiveAll = mock(() => Promise.resolve());
    const onToggle = mock(() => undefined);
    window.addEventListener("keydown", onWindowKeydown);
    const view = renderTaskGroup({ kind: "variants", onArchiveAll, onToggle });
    fireEvent.contextMenu(view.getByTestId("task-group-best-of-demo"), {
      clientX: 120,
      clientY: 80,
    });
    const menuItem = await waitFor(() =>
      within(document.body).getByRole("button", { name: /Archive all variants/ })
    );

    fireEvent.keyDown(menuItem, { key: "Enter" });
    expect(onToggle).not.toHaveBeenCalled();
    onWindowKeydown.mockClear();

    fireEvent.keyDown(menuItem, {
      key: "Backspace",
      ctrlKey: true,
      shiftKey: true,
    });
    window.removeEventListener("keydown", onWindowKeydown);

    expect(onArchiveAll).toHaveBeenCalledTimes(1);
    expect(onWindowKeydown).not.toHaveBeenCalled();
  });

  test("handles the archive shortcut without triggering native window handlers", () => {
    const onWindowKeydown = mock(() => undefined);
    const onArchiveAll = mock(() => Promise.resolve());
    window.addEventListener("keydown", onWindowKeydown);
    const view = renderTaskGroup({ kind: "variants", onArchiveAll });

    fireEvent.keyDown(view.getByTestId("task-group-best-of-demo"), {
      key: "Backspace",
      ctrlKey: true,
      shiftKey: true,
    });
    window.removeEventListener("keydown", onWindowKeydown);

    expect(onArchiveAll).toHaveBeenCalledTimes(1);
    expect(onWindowKeydown).not.toHaveBeenCalled();
  });

  test("aggregates member state into the shared status-dot language", () => {
    // Running wins over interrupted: the group is still making progress.
    const running = renderTaskGroup({ runningCount: 1, interruptedCount: 1 });
    expect(running.getByTestId("task-group-best-of-demo").dataset.aggregateState).toBe("active");
    cleanup();

    const interrupted = renderTaskGroup({ interruptedCount: 1, completedCount: 2 });
    expect(interrupted.getByTestId("task-group-best-of-demo").dataset.aggregateState).toBe("error");
    cleanup();

    const completed = renderTaskGroup({ completedCount: 3 });
    expect(completed.getByTestId("task-group-best-of-demo").dataset.aggregateState).toBe("idle");
  });
});
