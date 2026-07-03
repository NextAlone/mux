import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { installDom } from "../../../../tests/ui/dom";
import type { LeftSidebar as LeftSidebarComponent } from "./LeftSidebar";

type LeftSidebarComponentType = typeof LeftSidebarComponent;

let LeftSidebar!: LeftSidebarComponentType;
let cleanupDom: (() => void) | null = null;

interface ProjectSidebarStubProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

function installLeftSidebarTestDoubles() {
  void mock.module("../ProjectSidebar/ProjectSidebar", () => ({
    __esModule: true,
    default: (props: ProjectSidebarStubProps) => (
      <button
        type="button"
        data-testid="project-sidebar"
        data-collapsed={String(props.collapsed)}
        onClick={props.onToggleCollapsed}
      >
        Project Sidebar
      </button>
    ),
  }));
  void mock.module("../TitleBar/TitleBar", () => ({
    TitleBar: () => <div data-testid="title-bar">Title Bar</div>,
  }));
  void mock.module("@/browser/hooks/useDesktopTitlebar", () => ({
    isDesktopMode: () => true,
  }));

  /* eslint-disable @typescript-eslint/no-require-imports */
  ({ LeftSidebar } = require("./LeftSidebar?left-sidebar-test=1") as {
    LeftSidebar: LeftSidebarComponentType;
  });
  /* eslint-enable @typescript-eslint/no-require-imports */
}

function renderLeftSidebar(collapsed: boolean) {
  return render(
    <LeftSidebar
      collapsed={collapsed}
      onToggleCollapsed={() => undefined}
      sortedWorkspacesByProject={new Map<string, FrontendWorkspaceMetadata[]>()}
      workspaceRecency={{}}
    />
  );
}

describe("LeftSidebar collapse transition", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    installLeftSidebarTestDoubles();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    mock.restore();
  });

  test("keeps expanded chrome mounted until the width transition finishes", () => {
    const view = renderLeftSidebar(false);

    expect(view.getByTestId("project-sidebar").dataset.collapsed).toBe("false");
    expect(view.getByTestId("title-bar")).toBeTruthy();

    view.rerender(
      <LeftSidebar
        collapsed={true}
        onToggleCollapsed={() => undefined}
        sortedWorkspacesByProject={new Map<string, FrontendWorkspaceMetadata[]>()}
        workspaceRecency={{}}
      />
    );

    expect(view.getByTestId("project-sidebar").dataset.collapsed).toBe("false");
    expect(view.getByTestId("title-bar")).toBeTruthy();

    const transitionEndEvent = new window.Event("transitionend", { bubbles: true });
    Object.defineProperty(transitionEndEvent, "propertyName", { value: "width" });
    fireEvent(view.getByTestId("left-sidebar"), transitionEndEvent);

    expect(view.getByTestId("project-sidebar").dataset.collapsed).toBe("true");
    expect(view.queryByTestId("title-bar")).toBeNull();
  });
});
