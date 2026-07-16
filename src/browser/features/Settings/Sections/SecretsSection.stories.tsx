import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";
import { selectWorkspace } from "@/browser/stories/helpers/uiState";
import type { Secret } from "@/common/types/secrets";
import { SecretsSection } from "./SecretsSection.js";
import { SettingsSectionStory } from "./settingsStoryUtils.js";

interface SecretsStoryOptions {
  globalSecrets?: Secret[];
  projectSecrets?: Map<string, Secret[]>;
}

function setupSecretsStory(options: SecretsStoryOptions = {}) {
  const projectPathA = "/Users/test/my-app";
  const projectPathB = "/Users/test/other-app";

  const workspaces = [
    createWorkspace({
      id: "ws-secrets-a",
      name: "main",
      projectName: "my-app",
      projectPath: projectPathA,
    }),
    createWorkspace({
      id: "ws-secrets-b",
      name: "main",
      projectName: "other-app",
      projectPath: projectPathB,
    }),
  ];

  selectWorkspace(workspaces[0]);

  return createMockORPCClient({
    workspaces,
    projects: groupWorkspacesByProject(workspaces),
    globalSecrets: options.globalSecrets ?? [{ key: "GLOBAL_TOKEN", value: "global-secret" }],
    projectSecrets:
      options.projectSecrets ??
      new Map<string, Secret[]>([
        [projectPathA, [{ key: "PROJECT_TOKEN", value: "project-secret" }]],
        [projectPathB, [{ key: "OTHER_TOKEN", value: "other-secret" }]],
      ]),
  });
}

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/SecretsSection",
  component: SecretsSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

function renderSecretsSection(setup: () => ReturnType<typeof createMockORPCClient>) {
  return (
    <SettingsSectionStory setup={setup}>
      <div className="bg-background p-6">
        <SecretsSection />
      </div>
    </SettingsSectionStory>
  );
}

export const GlobalSecretsView: Story = {
  render: () => renderSecretsSection(() => setupSecretsStory()),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText(/Secrets are stored in/i);
    await canvas.findByDisplayValue("GLOBAL_TOKEN");
  },
};

export const PopulatedGlobalSecrets: Story = {
  render: () =>
    renderSecretsSection(() =>
      setupSecretsStory({
        globalSecrets: [
          { key: "OPENAI_API_KEY", value: "sk-openai" },
          { key: "ANTHROPIC_API_KEY", value: "sk-anthropic" },
          { key: "GITHUB_TOKEN", value: "ghp_123" },
          { key: "SENTRY_AUTH_TOKEN", value: "sentry" },
        ],
      })
    ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByDisplayValue("OPENAI_API_KEY");
    await canvas.findByDisplayValue("ANTHROPIC_API_KEY");
    await canvas.findByDisplayValue("GITHUB_TOKEN");
    await canvas.findByDisplayValue("SENTRY_AUTH_TOKEN");
  },
};

export const ProjectSecrets: Story = {
  render: () => renderSecretsSection(() => setupSecretsStory()),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const projectScopeToggle = await canvas.findByRole("radio", { name: /^Project$/i });
    await userEvent.click(projectScopeToggle);

    await canvas.findByText(/Select a project to configure/i);
    await canvas.findByDisplayValue("PROJECT_TOKEN");
  },
};

/**
 * Fixed-width wrapper keeps the responsive contract active in the Storybook test runner,
 * while the matching viewport mode makes Chromatic capture the same narrow Settings layout.
 */
export const NarrowProjectSecrets: Story = {
  tags: ["secrets-responsive"],
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    chromatic: {
      modes: {
        "dark-mobile": { theme: "dark", viewport: 375 },
      },
    },
  },
  render: () => (
    <div data-testid="secrets-mobile-container" className="bg-background w-[375px] max-w-full p-4">
      <SettingsSectionStory setup={() => setupSecretsStory()}>
        <SecretsSection />
      </SettingsSectionStory>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const accountInput = await canvas.findByPlaceholderText("my-team.1password.com");
    const projectScopeToggle = await canvas.findByRole("radio", {
      name: /^(Project|项目)$/i,
    });

    await userEvent.click(projectScopeToggle);

    const keyInput = await canvas.findByDisplayValue("PROJECT_TOKEN");
    const valueInput = await canvas.findByDisplayValue("project-secret");
    const sourceSelect = await canvas.findByRole("combobox", {
      name: /(Secret source|密钥来源)/i,
    });

    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );

    const container = canvas.getByTestId("secrets-mobile-container");
    if (container.scrollWidth > container.clientWidth + 1) {
      throw new Error(
        `Secrets settings overflowed its ${container.clientWidth}px container by ` +
          `${container.scrollWidth - container.clientWidth}px`
      );
    }

    const accountRect = accountInput.getBoundingClientRect();
    if (accountRect.width < container.clientWidth * 0.75) {
      throw new Error("1Password account input did not expand across the narrow settings row");
    }

    const keyRect = keyInput.getBoundingClientRect();
    const valueRect = valueInput.getBoundingClientRect();
    if (keyRect.bottom > valueRect.top + 1) {
      throw new Error("Secret key and value controls did not stack in the narrow layout");
    }

    if (sourceSelect.getBoundingClientRect().width < container.clientWidth * 0.5) {
      throw new Error("Secret source selector remained fixed-width in the narrow layout");
    }
  },
};
