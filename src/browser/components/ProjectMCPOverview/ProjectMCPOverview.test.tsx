import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import * as APIModule from "@/browser/contexts/API";
import * as SettingsModule from "@/browser/contexts/SettingsContext";
import { LanguageProvider, type Language } from "@/browser/contexts/LanguageContext";
import { getMCPServersKey, UI_LANGUAGE_KEY } from "@/common/constants/storage";
import type { MCPServerInfo } from "@/common/types/mcp";
import { ProjectMCPOverview } from "./ProjectMCPOverview";

const PROJECT_PATH = "/projects/demo";
const SERVERS: Record<string, MCPServerInfo> = Object.fromEntries(
  ["alpha", "beta", "delta", "gamma"].map((name) => [
    name,
    { transport: "stdio", command: name, disabled: false },
  ])
);

function renderOverview(language: Language) {
  localStorage.setItem(UI_LANGUAGE_KEY, JSON.stringify(language));
  localStorage.setItem(getMCPServersKey(PROJECT_PATH), JSON.stringify(SERVERS));
  return render(
    <LanguageProvider>
      <ProjectMCPOverview projectPath={PROJECT_PATH} />
    </LanguageProvider>
  );
}

describe("ProjectMCPOverview", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    localStorage.clear();
    // Keep the test on the cached rendering path; API refresh behavior is covered separately.
    spyOn(APIModule, "useAPI").mockImplementation(() => ({
      api: null,
      status: "connecting",
      error: null,
      authenticate: () => undefined,
      retry: () => undefined,
    }));
    spyOn(SettingsModule, "useSettings").mockImplementation(
      () =>
        ({
          isOpen: true,
          open: () => undefined,
        }) as unknown as ReturnType<typeof SettingsModule.useSettings>
    );
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps enabled and overflow counts grammatical in English", () => {
    const view = renderOverview("en");

    expect(view.container.textContent).toContain("MCP Servers (4 enabled)");
    expect(view.container.textContent).toContain("alpha, beta, delta +1 more");
  });

  test("places enabled and overflow counts naturally in Chinese", () => {
    const view = renderOverview("zh-CN");

    expect(view.container.textContent).toContain("MCP 服务器（已启用 4 个）");
    expect(view.container.textContent).toContain("alpha, beta, delta 另有 1 个");
  });
});
