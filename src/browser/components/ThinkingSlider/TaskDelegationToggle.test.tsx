import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { APIProvider } from "@/browser/contexts/API";
import { AgentProvider, type AgentContextValue } from "@/browser/contexts/AgentContext";
import {
  CommandRegistryProvider,
  useCommandRegistry,
  type CommandAction,
} from "@/browser/contexts/CommandRegistryContext";
import { ThinkingProvider } from "@/browser/contexts/ThinkingContext";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import { installDom } from "../../../../tests/ui/dom";
import { TaskDelegationToggle } from "./TaskDelegationToggle";

let cleanupDom: (() => void) | null = null;
let getActions: () => CommandAction[] = () => [];

function CaptureActions() {
  const registry = useCommandRegistry();
  getActions = registry.getActions;
  return null;
}

function descriptor(
  id: string,
  overrides: Partial<AgentDefinitionDescriptor> = {}
): AgentDefinitionDescriptor {
  return {
    id,
    scope: "built-in",
    name: id,
    uiSelectable: true,
    subagentRunnable: false,
    ...overrides,
  };
}

function renderToggle(options: {
  busy?: boolean;
  topLevel?: boolean;
  agentId?: string;
  agents?: readonly AgentDefinitionDescriptor[];
}) {
  const agents = [
    ...(options.agents ?? [descriptor("exec", { tools: { add: ["file_edit_insert"] } })]),
  ];
  const agentId = options.agentId ?? "exec";
  const agentValue: AgentContextValue = {
    agentId,
    setAgentId: () => undefined,
    currentAgent: agents.find((agent) => agent.id === agentId),
    agents,
    loaded: true,
    loadFailed: false,
    refresh: () => Promise.resolve(),
    refreshing: false,
    disableWorkspaceAgents: false,
    setDisableWorkspaceAgents: () => undefined,
  };

  return render(
    <APIProvider client={createMockORPCClient()}>
      <AgentProvider value={agentValue}>
        <ThinkingProvider workspaceId="delegation-toggle-workspace">
          <TooltipProvider delayDuration={0}>
            <CommandRegistryProvider>
              <TaskDelegationToggle
                busy={options.busy ?? false}
                topLevel={options.topLevel ?? true}
              />
              <CaptureActions />
            </CommandRegistryProvider>
          </TooltipProvider>
        </ThinkingProvider>
      </AgentProvider>
    </APIProvider>
  );
}

describe("TaskDelegationToggle", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    getActions = () => [];
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("toggles the preference for an eligible top-level exec agent", async () => {
    const view = renderToggle({});
    const button = view.getByRole("button", { name: /preference: off/i });

    fireEvent.click(button);

    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
  });

  test.each([
    { name: "child workspace", options: { topLevel: false } },
    {
      name: "plan agent",
      options: {
        agentId: "plan",
        agents: [descriptor("plan", { tools: { add: ["propose_plan"] } })],
      },
    },
    {
      name: "broken inheritance chain",
      options: {
        agentId: "custom",
        agents: [descriptor("custom", { base: "missing" })],
      },
    },
  ])("fails closed for $name", async ({ options }) => {
    const view = renderToggle(options);
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.queryByRole("button")).toBeNull();
  });

  test("removes the Palette action while busy and exposes an accessible disabled state", async () => {
    const view = renderToggle({ busy: true });
    const button = view.getByRole("button", { name: /preference: off.*current turn finishes/i });

    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(getActions()).toEqual([]));
  });

  test("keeps the idle Palette action wired to the same preference", async () => {
    const view = renderToggle({});
    const button = view.getByRole("button", { name: /preference: off/i });

    await waitFor(() => expect(getActions()).toHaveLength(1));
    await act(async () => {
      await getActions()[0]?.run();
    });

    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
  });
});
