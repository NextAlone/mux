import React, {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import * as APIModule from "@/browser/contexts/API";
import type { APIClient } from "@/browser/contexts/API";
import * as GitStatusStoreModule from "@/browser/stores/GitStatusStore";
import type { GitStatus } from "@/common/types/workspace";
import * as CopyToClipboardModule from "@/browser/hooks/useCopyToClipboard";
import * as PopoverModule from "../Popover/Popover";
import * as TooltipModule from "../Tooltip/Tooltip";

import { BookmarkSelector } from "./BookmarkSelector";

interface ExecuteBashInput {
  workspaceId: string;
  script: string;
  command?: string;
  args?: string[];
  options?: {
    timeout_secs?: number;
    cwdMode?: "default" | "repo-root";
  };
}

type ExecuteBashResult =
  | {
      success: true;
      data: {
        success: boolean;
        output?: string;
        exitCode: number;
        wall_duration_ms: number;
        error?: string;
      };
    }
  | { success: false; error: string };

interface MockApiClient {
  workspace: {
    executeBash: (input: ExecuteBashInput) => Promise<ExecuteBashResult>;
  };
}

let mockApi: MockApiClient;
let mockGitStatus: GitStatus | null = null;
const invalidateGitStatusMock = mock(() => undefined);
const clearGitStatusMock = mock(() => undefined);
const copyToClipboardMock = mock(() => Promise.resolve());
let restoreSpies: Array<() => void> = [];

const PopoverContext = createContext<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>({
  open: false,
  onOpenChange: () => undefined,
});

function bashSuccess(output: string): ExecuteBashResult {
  return {
    success: true,
    data: {
      success: true,
      output,
      exitCode: 0,
      wall_duration_ms: 0,
    },
  };
}

function trackSpy<T extends { mockRestore: () => void }>(spy: T): T {
  restoreSpies.push(() => spy.mockRestore());
  return spy;
}

describe("BookmarkSelector", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalLocalStorage: typeof globalThis.localStorage;
  let originalLocation: typeof globalThis.location;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;
    originalLocation = globalThis.location;

    const dom = new GlobalWindow({ url: "https://mux.example.com/" });
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = dom.document as unknown as Document;
    globalThis.localStorage = dom.localStorage;
    globalThis.location = dom.location as unknown as Location;

    mockGitStatus = null;
    restoreSpies = [];
    invalidateGitStatusMock.mockClear();
    clearGitStatusMock.mockClear();
    copyToClipboardMock.mockClear();
    mockApi = {
      workspace: {
        executeBash: mock(() => Promise.resolve(bashSuccess(""))),
      },
    };

    trackSpy(spyOn(APIModule, "useAPI")).mockImplementation(() => ({
      api: mockApi as unknown as APIClient,
      status: "connected" as const,
      error: null,
      authenticate: () => undefined,
      retry: () => undefined,
    }));

    trackSpy(spyOn(GitStatusStoreModule, "useGitStatus")).mockImplementation(() => mockGitStatus);
    trackSpy(spyOn(GitStatusStoreModule, "invalidateGitStatus")).mockImplementation(
      invalidateGitStatusMock
    );
    trackSpy(spyOn(GitStatusStoreModule, "clearGitStatus")).mockImplementation(clearGitStatusMock);
    trackSpy(spyOn(CopyToClipboardModule, "useCopyToClipboard")).mockImplementation(() => ({
      copied: false,
      copyToClipboard: copyToClipboardMock,
    }));

    trackSpy(spyOn(PopoverModule, "Popover")).mockImplementation(((props: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) => (
      <PopoverContext.Provider value={{ open: props.open, onOpenChange: props.onOpenChange }}>
        {props.children}
      </PopoverContext.Provider>
    )) as unknown as typeof PopoverModule.Popover);
    trackSpy(spyOn(PopoverModule, "PopoverTrigger")).mockImplementation(((props: {
      asChild?: boolean;
      children: ReactNode;
    }) => {
      const popover = useContext(PopoverContext);
      if (
        props.asChild &&
        isValidElement<{ onClick?: (event: React.MouseEvent) => void }>(props.children)
      ) {
        const child = props.children;
        return cloneElement(child, {
          onClick: (event: React.MouseEvent) => {
            child.props.onClick?.(event);
            popover.onOpenChange(!popover.open);
          },
        });
      }
      return <button onClick={() => popover.onOpenChange(!popover.open)}>{props.children}</button>;
    }) as unknown as typeof PopoverModule.PopoverTrigger);
    trackSpy(spyOn(PopoverModule, "PopoverContent")).mockImplementation(((props: {
      children: ReactNode;
    }) => {
      const popover = useContext(PopoverContext);
      return popover.open ? <div>{props.children}</div> : null;
    }) as unknown as typeof PopoverModule.PopoverContent);

    trackSpy(spyOn(TooltipModule, "Tooltip")).mockImplementation(((props: {
      children: ReactNode;
    }) => <>{props.children}</>) as unknown as typeof TooltipModule.Tooltip);
    trackSpy(spyOn(TooltipModule, "TooltipTrigger")).mockImplementation(((props: {
      children: ReactNode;
      asChild?: boolean;
    }) => <>{props.children}</>) as unknown as typeof TooltipModule.TooltipTrigger);
    trackSpy(spyOn(TooltipModule, "TooltipContent")).mockImplementation(((props: {
      children: ReactNode;
      side?: string;
    }) => <>{props.children}</>) as unknown as typeof TooltipModule.TooltipContent);
  });

  afterEach(() => {
    cleanup();
    for (const restore of [...restoreSpies].reverse()) {
      restore();
    }
    restoreSpies = [];
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
    globalThis.location = originalLocation;
  });

  test("resolves and shows the active bookmark even when the recent bookmark list does not include it", async () => {
    const executeBash = mock((input: ExecuteBashInput) => {
      if (input.script.includes("jj --no-pager --color never root")) {
        return Promise.resolve(bashSuccess("true"));
      }
      if (input.script.includes("latest(::@ & bookmarks())")) {
        return Promise.resolve(bashSuccess("feature/lazy-start"));
      }
      if (input.script.includes("bookmark list --sort")) {
        return Promise.resolve(
          bashSuccess(
            Array.from({ length: 101 }, (_, index) => `recent-bookmark-${index + 1}`).join("\n")
          )
        );
      }
      if (input.script.includes("jj --no-pager --color never git remote list")) {
        return Promise.resolve(bashSuccess("origin"));
      }
      throw new Error(`Unexpected script: ${input.script}`);
    });
    mockApi = {
      workspace: {
        executeBash,
      },
    };

    const view = render(<BookmarkSelector workspaceId="ws-1" workspaceName="scratch-workspace" />);

    expect(view.getByRole("button", { name: "scratch-workspace" })).toBeDefined();
    expect(view.queryByLabelText("Copy bookmark name")).toBeNull();
    expect(view.container.querySelector(".lucide-bookmark")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "scratch-workspace" }));

    await waitFor(() => {
      expect(view.getByLabelText("Copy bookmark name")).toBeDefined();
    });
    expect(view.getAllByText("feature/lazy-start").length).toBeGreaterThan(0);
    const executedScripts = executeBash.mock.calls.map(([input]) => input.script);
    expect(
      executedScripts.some((script) => script.includes("jj --no-pager --color never root"))
    ).toBe(true);
    expect(executedScripts.some((script) => script.includes("latest(::@ & bookmarks())"))).toBe(
      true
    );
    expect(executedScripts.some((script) => script.includes("bookmark list --sort"))).toBe(true);
    expect(
      executedScripts.some((script) => script.includes("jj --no-pager --color never git remote"))
    ).toBe(true);
  });

  test("resets stale bookmark state when the component remounts for a different workspace", async () => {
    mockGitStatus = {
      branch: "feature/lazy-start",
      ahead: 1,
      behind: 0,
      dirty: false,
      outgoingAdditions: 0,
      outgoingDeletions: 0,
      incomingAdditions: 0,
      incomingDeletions: 0,
    };

    const view = render(
      <BookmarkSelector key="ws-1" workspaceId="ws-1" workspaceName="first-workspace" />
    );

    await waitFor(() => {
      expect(view.getByRole("button", { name: "feature/lazy-start" })).toBeDefined();
    });

    mockGitStatus = null;
    view.rerender(
      <BookmarkSelector key="ws-2" workspaceId="ws-2" workspaceName="second-workspace" />
    );

    expect(view.getByRole("button", { name: "second-workspace" })).toBeDefined();
    expect(view.queryByRole("button", { name: "feature/lazy-start" })).toBeNull();
    expect(view.queryByLabelText("Copy bookmark name")).toBeNull();
  });

  test("switches to the non-jj fallback after an explicit open confirms the workspace is not a repo", async () => {
    const executeBash = mock((input: ExecuteBashInput) => {
      if (input.script.includes("jj --no-pager --color never root")) {
        return Promise.resolve({
          success: true,
          data: {
            success: false,
            error: "Error: No jj repo found",
            exitCode: 128,
            wall_duration_ms: 0,
          },
        } satisfies ExecuteBashResult);
      }
      throw new Error(`Unexpected script: ${input.script}`);
    });
    mockApi = {
      workspace: {
        executeBash,
      },
    };
    mockGitStatus = {
      branch: "stale-bookmark",
      ahead: 1,
      behind: 0,
      dirty: false,
      outgoingAdditions: 0,
      outgoingDeletions: 0,
      incomingAdditions: 0,
      incomingDeletions: 0,
    };
    localStorage.setItem(
      "bookmark:ws-2",
      JSON.stringify({ data: "stale-bookmark", cachedAt: Date.now() })
    );
    localStorage.setItem("bookmarkIndex", JSON.stringify(["bookmark:ws-2"]));

    const view = render(<BookmarkSelector workspaceId="ws-2" workspaceName="plain-workspace" />);

    expect(view.getByRole("button", { name: "stale-bookmark" })).toBeDefined();

    fireEvent.click(view.getByRole("button", { name: "stale-bookmark" }));

    await waitFor(() => {
      expect(executeBash.mock.calls).toHaveLength(1);
    });
    await waitFor(() => {
      expect(view.queryByRole("button", { name: "plain-workspace" })).toBeNull();
    });
    expect(view.getByText("plain-workspace")).toBeDefined();
    expect(localStorage.getItem("bookmark:ws-2")).toBeNull();
    expect(localStorage.getItem("bookmarkIndex")).toBe(JSON.stringify([]));
    expect(clearGitStatusMock).toHaveBeenCalledWith("ws-2");
    expect(executeBash.mock.calls[0]?.[0].script).toContain("jj --no-pager --color never root");
  });

  test("keeps the selector interactive when the repo probe fails inconclusively", async () => {
    const executeBash = mock((input: ExecuteBashInput) => {
      if (input.script.includes("jj --no-pager --color never root")) {
        return Promise.resolve({
          success: false,
          error: "runtime not ready",
        } satisfies ExecuteBashResult);
      }
      throw new Error(`Unexpected script: ${input.script}`);
    });
    mockApi = {
      workspace: {
        executeBash,
      },
    };
    mockGitStatus = {
      branch: "stale-bookmark",
      ahead: 1,
      behind: 0,
      dirty: false,
      outgoingAdditions: 0,
      outgoingDeletions: 0,
      incomingAdditions: 0,
      incomingDeletions: 0,
    };
    localStorage.setItem(
      "bookmark:ws-3",
      JSON.stringify({ data: "stale-bookmark", cachedAt: Date.now() })
    );
    localStorage.setItem("bookmarkIndex", JSON.stringify(["bookmark:ws-3"]));

    const view = render(<BookmarkSelector workspaceId="ws-3" workspaceName="plain-workspace" />);

    fireEvent.click(view.getByRole("button", { name: "stale-bookmark" }));

    await waitFor(() => {
      expect(executeBash.mock.calls).toHaveLength(1);
    });
    expect(view.getByRole("button", { name: "stale-bookmark" })).toBeDefined();
    expect(localStorage.getItem("bookmark:ws-3")).not.toBeNull();
    expect(clearGitStatusMock).not.toHaveBeenCalled();
  });
});
