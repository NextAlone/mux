import React from "react";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../../../tests/ui/dom";
import type { APIClient } from "@/browser/contexts/API";
import type * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import type * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import type {
  AddCustomOpenAICompatibleProviderInput,
  ProviderConfigInfo,
  ProvidersConfigMap,
} from "@/common/orpc/types";

function installTestDoubles() {
  // Bun mock.module registrations are global across files, so keep this test
  // insulated from incomplete WorkspaceStore mocks registered by earlier files.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const actualWorkspaceStore =
    require("@/browser/stores/WorkspaceStore?real=1") as typeof WorkspaceStoreModule;
  /* eslint-enable @typescript-eslint/no-require-imports */

  void mock.module("@/browser/stores/WorkspaceStore", () => ({
    ...actualWorkspaceStore,
  }));
}

let repairRemovedProviderMock = mock(
  (_provider: string, _workspaceIds: Iterable<string>) => undefined
);

void mock.module("@/browser/utils/modelPreferenceRepair", () => ({
  repairLocalModelPreferencesForRemovedProvider: (
    provider: string,
    workspaceIds: Iterable<string>
  ) => repairRemovedProviderMock(provider, workspaceIds),
}));

let providersConfigMock: ProvidersConfigMap | null = null;
let apiMock: APIClient | null = null;
const providersRefreshMock = mock(() => Promise.resolve());
const updateOptimisticallyMock = mock((provider: string, updates: Partial<ProviderConfigInfo>) => {
  if (!providersConfigMock?.[provider]) {
    return;
  }
  providersConfigMock[provider] = { ...providersConfigMock[provider], ...updates };
});

void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: () => ({
    config: providersConfigMock,
    loading: false,
    refresh: providersRefreshMock,
    updateOptimistically: updateOptimisticallyMock,
  }),
}));

void mock.module("@/browser/hooks/useRouting", () => ({
  useRouting: () => ({
    routePriority: ["direct"],
    routeOverrides: {},
    resolveRoute: () => ({ route: "direct", isAuto: true, displayName: "Direct" }),
    availableRoutes: () => [],
    setRoutePreferences: () => undefined,
    setRoutePriority: () => undefined,
    setRouteOverride: () => undefined,
  }),
}));

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: apiMock }),
}));

void mock.module("@/browser/contexts/PolicyContext", () => ({
  usePolicy: () => ({
    status: { state: "disabled" as const },
    policy: null,
  }),
}));

void mock.module("@/browser/components/SelectPrimitive/SelectPrimitive", () => {
  const SelectContext = React.createContext<{
    value?: string;
    disabled?: boolean;
    open: boolean;
    options: Map<string, React.ReactNode>;
    onValueChange?: (value: string) => void;
    setOpen: (open: boolean) => void;
  } | null>(null);

  function collectOptions(children: React.ReactNode, options = new Map<string, React.ReactNode>()) {
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement<{ value?: string; children?: React.ReactNode }>(child)) {
        return;
      }

      if (typeof child.props.value === "string") {
        options.set(child.props.value, child.props.children);
      }

      if (child.props.children) {
        collectOptions(child.props.children, options);
      }
    });

    return options;
  }

  function Select(props: {
    value?: string;
    disabled?: boolean;
    onValueChange?: (value: string) => void;
    children: React.ReactNode;
  }) {
    const [open, setOpen] = React.useState(false);
    const options = collectOptions(props.children);
    return (
      <SelectContext.Provider
        value={{
          value: props.value,
          disabled: props.disabled,
          open,
          options,
          onValueChange: props.onValueChange,
          setOpen,
        }}
      >
        {props.children}
      </SelectContext.Provider>
    );
  }

  const SelectTrigger = React.forwardRef<
    HTMLButtonElement,
    React.ComponentPropsWithoutRef<"button">
  >((props, ref) => {
    const context = React.useContext(SelectContext);
    return (
      <button
        {...props}
        ref={ref}
        type="button"
        role="combobox"
        disabled={context?.disabled}
        aria-expanded={context?.open ?? false}
        onClick={(event) => {
          props.onClick?.(event);
          if (!context?.disabled) {
            context?.setOpen(true);
          }
        }}
      >
        {props.children}
      </button>
    );
  });
  SelectTrigger.displayName = "MockSelectTrigger";

  function SelectValue() {
    const context = React.useContext(SelectContext);
    return <span>{context?.options.get(context?.value ?? "") ?? context?.value ?? ""}</span>;
  }

  function SelectContent(props: { children: React.ReactNode }) {
    const context = React.useContext(SelectContext);
    return context?.open ? <div>{props.children}</div> : null;
  }

  function SelectItem(props: { value: string; children: React.ReactNode }) {
    const context = React.useContext(SelectContext);
    return (
      <button
        type="button"
        onClick={() => {
          context?.onValueChange?.(props.value);
          context?.setOpen(false);
        }}
      >
        {props.children}
      </button>
    );
  }

  return {
    Select,
    SelectTrigger,
    SelectValue,
    SelectContent,
    SelectItem,
  };
});

/* eslint-disable @typescript-eslint/no-require-imports */
const actualWorkspaceContext =
  require("@/browser/contexts/WorkspaceContext?real=1") as typeof WorkspaceContextModule;
/* eslint-enable @typescript-eslint/no-require-imports */

void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  ...actualWorkspaceContext,
  WorkspaceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWorkspaceContext: () => ({
    workspaceMetadata: new Map(),
    selectedWorkspace: null,
    refreshWorkspaceMetadata: () => Promise.resolve(),
  }),
}));

import { ProvidersSection } from "./ProvidersSection";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils";

const CUSTOM_PROVIDER_ID = "acme-openai";

function createProvidersConfig(): ProvidersConfigMap {
  return {
    openai: {
      apiKeySet: true,
      isEnabled: true,
      isConfigured: true,
    },
    [CUSTOM_PROVIDER_ID]: {
      apiKeySet: true,
      isEnabled: true,
      isConfigured: true,
      baseUrl: "https://api.acme.test/v1",
      displayName: "Acme OpenAI",
      isCustom: true,
      providerType: "openai-compatible",
      models: ["acme-chat"],
    },
  };
}

function emptyConfigChangeIterator(): AsyncIterator<void> & AsyncIterable<void> {
  const iterator: AsyncIterator<void> & AsyncIterable<void> = {
    next: () => new Promise<IteratorResult<void>>(() => undefined),
    return: () => Promise.resolve({ done: true, value: undefined }),
    [Symbol.asyncIterator]: () => iterator,
  };
  return iterator;
}

function patchProviderMethods(client: APIClient, providersConfig: ProvidersConfigMap) {
  const getConfig = mock(() => Promise.resolve({ ...providersConfig }));
  const addCustomOpenAICompatibleProvider = mock(
    (input: AddCustomOpenAICompatibleProviderInput) => {
      const providerInfo: ProviderConfigInfo = {
        apiKeySet: input.apiKey != null,
        isEnabled: true,
        isConfigured: true,
        apiKeyFile: input.apiKeyFile,
        baseUrl: input.baseUrl,
        displayName: input.displayName ?? input.provider,
        isCustom: true,
        providerType: input.providerType ?? "openai-compatible",
        models: input.models,
      };
      providersConfig[input.provider] = providerInfo;
      return Promise.resolve({ success: true as const, data: providerInfo });
    }
  );
  const removeCustomProvider = mock<APIClient["providers"]["removeCustomProvider"]>((input) => {
    delete providersConfig[input.provider];
    return Promise.resolve({ success: true as const, data: undefined });
  });
  const setProviderConfig = mock<APIClient["providers"]["setProviderConfig"]>((input) => {
    const provider = providersConfig[input.provider];
    if (provider) {
      const key = input.keyPath[0] as keyof ProviderConfigInfo | undefined;
      if (key) {
        if (input.value === "") {
          delete provider[key];
        } else {
          Object.assign(provider, { [key]: input.value });
        }
      }
    }
    return Promise.resolve({ success: true as const, data: undefined });
  });
  const onConfigChanged = mock(() => Promise.resolve(emptyConfigChangeIterator()));

  Object.assign(client.providers, {
    getConfig,
    addCustomOpenAICompatibleProvider,
    removeCustomProvider,
    setProviderConfig,
    onConfigChanged,
  });

  return {
    addCustomOpenAICompatibleProvider,
    getConfig,
    removeCustomProvider,
    setProviderConfig,
  };
}

function renderProvidersSection() {
  const providersConfig = createProvidersConfig();
  providersConfigMock = providersConfig;
  const client = setupSettingsStory({ providersConfig: {} });
  apiMock = client;
  const providerMocks = patchProviderMethods(client, providersConfig);
  const view = render(
    <SettingsSectionStory setup={() => client}>
      <ProvidersSection />
    </SettingsSectionStory>
  );

  return { ...view, ...providerMocks, providersConfig };
}

function getProviderCard(button: HTMLElement): HTMLElement {
  const card = button.parentElement;
  if (!card) {
    throw new Error("Provider button was not rendered inside a card");
  }
  return card;
}

function getProviderControlSection(card: HTMLElement, label: string): HTMLElement {
  const labelElement = within(card).getByText(label);
  const section = labelElement.parentElement?.parentElement;
  if (!section) {
    throw new Error(`Provider setting "${label}" was not rendered inside a section`);
  }
  return section;
}

describe("ProvidersSection", () => {
  let restoreDom: (() => void) | null = null;

  beforeEach(() => {
    restoreDom = installDom();
    installTestDoubles();
    repairRemovedProviderMock = mock(
      (_provider: string, _workspaceIds: Iterable<string>) => undefined
    );
    providersConfigMock = null;
    apiMock = null;
    providersRefreshMock.mockClear();
    updateOptimisticallyMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    providersConfigMock = null;
    apiMock = null;
    restoreDom?.();
    restoreDom = null;
  });

  test("renders built-in and custom providers in separate groups", async () => {
    const view = renderProvidersSection();

    const directHeading = await view.findByText("Direct Providers");
    const customHeading = await view.findByText("Custom providers");

    expect(directHeading.parentElement?.textContent).toContain("OpenAI");
    expect(customHeading.parentElement?.textContent).toContain("Acme OpenAI");
  });

  test("renders a custom provider display name with fallback icon support", async () => {
    const view = renderProvidersSection();

    expect(await view.findByRole("button", { name: /Acme OpenAI/ })).toBeTruthy();
  });

  test("shows OpenAI-compatible custom provider fields when expanded", async () => {
    const view = renderProvidersSection();
    const customButton = await view.findByRole("button", { name: /Acme OpenAI/ });

    fireEvent.click(customButton);

    const customCard = getProviderCard(customButton);
    expect(within(customCard).getByText("Display name")).toBeTruthy();
    expect(within(customCard).getByText("API key")).toBeTruthy();
    expect(within(customCard).getByText("API key file")).toBeTruthy();
    expect(within(customCard).getByText("Base URL")).toBeTruthy();
  });

  test("validates custom provider IDs in the add form", async () => {
    const view = renderProvidersSection();

    fireEvent.click(await view.findByRole("button", { name: "Add provider" }));

    expect(view.queryByText("Custom provider id is required.")).toBeNull();

    const providerIdInput = view.getByPlaceholderText("acme-openai") as HTMLInputElement;
    await userEvent.type(providerIdInput, "openai");

    await waitFor(() => {
      expect(providerIdInput.value).toBe("openai");
      expect(
        view.getByText('Custom provider id "openai" conflicts with a built-in provider.')
      ).toBeTruthy();
    });
  });

  test("submits and closes the custom provider add form", async () => {
    const view = renderProvidersSection();

    fireEvent.click(await view.findByRole("button", { name: "Add provider" }));

    await userEvent.type(view.getByPlaceholderText("acme-openai"), "team-openai");
    await userEvent.type(view.getByPlaceholderText("Acme OpenAI"), "Team OpenAI");
    await userEvent.type(
      view.getByPlaceholderText("https://api.acme.test/v1"),
      "https://team.example/v1"
    );
    await userEvent.type(view.getByPlaceholderText("gpt-4o-mini"), "qwen3-coder");
    fireEvent.click(view.getByRole("button", { name: "Add custom provider" }));

    await waitFor(() => {
      expect(view.addCustomOpenAICompatibleProvider).toHaveBeenCalledWith({
        provider: "team-openai",
        providerType: "openai-compatible",
        displayName: "Team OpenAI",
        baseUrl: "https://team.example/v1",
        apiKey: undefined,
        apiKeyFile: undefined,
        models: ["qwen3-coder"],
      });
    });
    await waitFor(() => {
      expect(view.queryByRole("button", { name: "Add custom provider" })).toBeNull();
    });
    expect(view.getByRole("button", { name: "Add provider" })).toBeTruthy();
  });

  test("submits Anthropic-compatible custom providers", async () => {
    const view = renderProvidersSection();

    fireEvent.click(await view.findByRole("button", { name: "Add provider" }));

    const typeTrigger = view.getByRole("combobox", { name: "Provider API format" });
    fireEvent.click(typeTrigger);
    fireEvent.click(view.getByRole("button", { name: "Anthropic-compatible" }));

    await userEvent.type(view.getByPlaceholderText("acme-openai"), "team-claude");
    await userEvent.type(view.getByPlaceholderText("Acme OpenAI"), "Team Claude");
    await userEvent.type(
      view.getByPlaceholderText("https://api.acme.test/v1"),
      "https://claude.example"
    );
    await userEvent.type(view.getByPlaceholderText("gpt-4o-mini"), "claude-local");
    fireEvent.click(view.getByRole("button", { name: "Add custom provider" }));

    await waitFor(() => {
      expect(view.addCustomOpenAICompatibleProvider).toHaveBeenCalledWith({
        provider: "team-claude",
        providerType: "anthropic-compatible",
        displayName: "Team Claude",
        baseUrl: "https://claude.example",
        apiKey: undefined,
        apiKeyFile: undefined,
        models: ["claude-local"],
      });
    });
  });

  test("shows OpenAI API service tier choices when API auth is active", async () => {
    const view = renderProvidersSection();
    view.providersConfig.openai.codexOauthSet = true;
    view.providersConfig.openai.codexOauthDefaultAuth = "apiKey";
    const openAiButton = await view.findByRole("button", { name: /^OpenAI\b/ });

    fireEvent.click(openAiButton);

    const serviceTierSection = getProviderControlSection(
      getProviderCard(openAiButton),
      "Service tier"
    );
    const trigger = within(serviceTierSection).getByRole("combobox");
    expect(trigger.textContent).toContain("Auto");

    fireEvent.click(trigger);

    expect(within(serviceTierSection).getByRole("button", { name: "Auto" })).toBeTruthy();
    expect(within(serviceTierSection).getByRole("button", { name: "Fast" })).toBeTruthy();
    expect(within(serviceTierSection).getByRole("button", { name: "Slow" })).toBeTruthy();
    expect(within(serviceTierSection).queryByRole("button", { name: "Normal" })).toBeNull();

    fireEvent.click(within(serviceTierSection).getByRole("button", { name: "Fast" }));

    await waitFor(() => {
      expect(view.setProviderConfig).toHaveBeenCalledWith({
        provider: "openai",
        keyPath: ["serviceTier"],
        value: "priority",
      });
    });
  });

  test("shows Codex OAuth service tier choices when OAuth auth is active", async () => {
    const view = renderProvidersSection();
    view.providersConfig.openai.codexOauthSet = true;
    view.providersConfig.openai.apiKeySet = false;
    view.providersConfig.openai.serviceTier = "fast";
    const openAiButton = await view.findByRole("button", { name: /^OpenAI\b/ });

    fireEvent.click(openAiButton);

    const serviceTierSection = getProviderControlSection(
      getProviderCard(openAiButton),
      "Service tier"
    );
    const trigger = within(serviceTierSection).getByRole("combobox");
    expect(trigger.textContent).toContain("Fast");

    fireEvent.click(trigger);

    expect(within(serviceTierSection).getByRole("button", { name: "Normal" })).toBeTruthy();
    expect(within(serviceTierSection).getByRole("button", { name: "Fast" })).toBeTruthy();
    expect(within(serviceTierSection).queryByRole("button", { name: "Auto" })).toBeNull();
    expect(within(serviceTierSection).queryByRole("button", { name: "Slow" })).toBeNull();

    fireEvent.click(within(serviceTierSection).getByRole("button", { name: "Normal" }));

    await waitFor(() => {
      expect(view.setProviderConfig).toHaveBeenCalledWith({
        provider: "openai",
        keyPath: ["serviceTier"],
        value: "",
      });
    });
  });

  test("closes the add form and shows a notice when refresh fails after add", async () => {
    providersRefreshMock.mockImplementationOnce(() => Promise.reject(new Error("refresh failed")));
    const view = renderProvidersSection();

    fireEvent.click(await view.findByRole("button", { name: "Add provider" }));

    await userEvent.type(view.getByPlaceholderText("acme-openai"), "team-openai");
    await userEvent.type(view.getByPlaceholderText("Acme OpenAI"), "Team OpenAI");
    await userEvent.type(
      view.getByPlaceholderText("https://api.acme.test/v1"),
      "https://team.example/v1"
    );
    fireEvent.click(view.getByRole("button", { name: "Add custom provider" }));

    await waitFor(() => {
      expect(view.addCustomOpenAICompatibleProvider).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(view.queryByRole("button", { name: "Add custom provider" })).toBeNull();
    });
    expect(view.queryByText("Failed to add custom provider.")).toBeNull();
    expect(
      await view.findByText(
        "Provider added, but refreshing the provider list failed. It may appear after reopening settings."
      )
    ).toBeTruthy();
  });

  test("shows and persists the OpenAI WebSocket transport toggle", async () => {
    const view = renderProvidersSection();
    const openAiButton = await view.findByRole("button", { name: /^OpenAI\b/ });

    fireEvent.click(openAiButton);

    const openAiCard = getProviderCard(openAiButton);
    const webSocketToggle = within(openAiCard).getByRole("switch", {
      name: /WebSocket transport/i,
    });
    expect(webSocketToggle).toBeTruthy();

    fireEvent.click(webSocketToggle);

    await waitFor(() => {
      expect(view.setProviderConfig).toHaveBeenCalledWith({
        provider: "openai",
        keyPath: ["webSocketTransportEnabled"],
        value: true,
      });
    });
  });

  test("clears the OpenAI WebSocket transport preference when toggled off", async () => {
    const view = renderProvidersSection();
    view.providersConfig.openai.webSocketTransportEnabled = true;
    const openAiButton = await view.findByRole("button", { name: /^OpenAI\b/ });

    fireEvent.click(openAiButton);

    const openAiCard = getProviderCard(openAiButton);
    const webSocketToggle = within(openAiCard).getByRole("switch", {
      name: /WebSocket transport/i,
    });

    fireEvent.click(webSocketToggle);

    await waitFor(() => {
      expect(view.setProviderConfig).toHaveBeenCalledWith({
        provider: "openai",
        keyPath: ["webSocketTransportEnabled"],
        value: "",
      });
    });
  });

  test("enables Codex OAuth WebSocket by default and persists an explicit opt-out", async () => {
    const view = renderProvidersSection();
    view.providersConfig.openai.codexOauthSet = true;
    view.providersConfig.openai.apiKeySet = false;
    const openAiButton = await view.findByRole("button", { name: /^OpenAI\b/ });

    fireEvent.click(openAiButton);

    const openAiCard = getProviderCard(openAiButton);
    const webSocketToggle = within(openAiCard).getByRole("switch", {
      name: /WebSocket transport/i,
    });
    expect(webSocketToggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(webSocketToggle);

    await waitFor(() => {
      expect(view.setProviderConfig).toHaveBeenCalledWith({
        provider: "openai",
        keyPath: ["webSocketTransportEnabled"],
        value: false,
      });
    });
  });

  test("shows the OpenAI WebSocket transport toggle when OpenAI uses a custom base URL", async () => {
    const view = renderProvidersSection();
    view.providersConfig.openai.baseUrl = "https://proxy.openai.test/v1";
    view.providersConfig.openai.webSocketTransportEnabled = true;
    const openAiButton = await view.findByRole("button", { name: /^OpenAI\b/ });

    fireEvent.click(openAiButton);

    const openAiCard = getProviderCard(openAiButton);
    expect(
      within(openAiCard).getByRole("switch", {
        name: /WebSocket transport/i,
      })
    ).toBeTruthy();
    expect(view.providersConfig.openai.webSocketTransportEnabled).toBe(true);
  });

  test("hides the OpenAI WebSocket transport toggle for Chat Completions without clearing it", async () => {
    const view = renderProvidersSection();
    view.providersConfig.openai.wireFormat = "chatCompletions";
    view.providersConfig.openai.webSocketTransportEnabled = true;
    const openAiButton = await view.findByRole("button", { name: /^OpenAI\b/ });

    fireEvent.click(openAiButton);

    const openAiCard = getProviderCard(openAiButton);
    expect(
      within(openAiCard).queryByRole("switch", {
        name: /WebSocket transport/i,
      })
    ).toBeNull();
    expect(within(openAiCard).queryByText("WebSocket transport")).toBeNull();
    expect(view.providersConfig.openai.webSocketTransportEnabled).toBe(true);
    expect(view.setProviderConfig).not.toHaveBeenCalledWith(
      expect.objectContaining({ keyPath: ["webSocketTransportEnabled"], value: "" })
    );
  });

  test("shows remove only for expanded custom provider cards", async () => {
    const view = renderProvidersSection();
    const customButton = await view.findByRole("button", { name: /Acme OpenAI/ });

    fireEvent.click(customButton);
    expect(
      within(getProviderCard(customButton)).getByRole("button", { name: "Remove" })
    ).toBeTruthy();

    const openAiButton = view.getByRole("button", { name: /^OpenAI\b/ });
    fireEvent.click(openAiButton);
    expect(
      within(getProviderCard(openAiButton)).queryByRole("button", { name: "Remove" })
    ).toBeNull();
  });

  test("removes the custom provider row and warns when config repair fails", async () => {
    const view = renderProvidersSection();
    const confirmMock = mock(() => true);
    window.confirm = confirmMock;
    view.removeCustomProvider.mockImplementationOnce((input: { provider: string }) => {
      delete view.providersConfig[input.provider];
      return Promise.resolve({
        success: false as const,
        error: {
          code: "config_repair_failed" as const,
          message: "Provider removed, but saved model references could not be repaired.",
        },
      });
    });

    const customButton = await view.findByRole("button", { name: /Acme OpenAI/ });
    fireEvent.click(customButton);
    fireEvent.click(within(getProviderCard(customButton)).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(view.removeCustomProvider).toHaveBeenCalledWith({ provider: CUSTOM_PROVIDER_ID });
    });
    await waitFor(() => {
      expect(view.queryByRole("button", { name: /Acme OpenAI/ })).toBeNull();
    });
    expect(
      await view.findByText(
        "Provider removed, but updating saved preferences failed. You may need to clear stale model defaults manually."
      )
    ).toBeTruthy();
  });

  test("calls the custom provider remove mutation after confirmation", async () => {
    const view = renderProvidersSection();
    const confirmMock = mock(() => true);
    window.confirm = confirmMock;

    const customButton = await view.findByRole("button", { name: /Acme OpenAI/ });
    fireEvent.click(customButton);
    fireEvent.click(within(getProviderCard(customButton)).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(view.removeCustomProvider).toHaveBeenCalledWith({ provider: CUSTOM_PROVIDER_ID });
    });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(repairRemovedProviderMock).toHaveBeenCalledWith(CUSTOM_PROVIDER_ID, expect.any(Set));
  });
});
