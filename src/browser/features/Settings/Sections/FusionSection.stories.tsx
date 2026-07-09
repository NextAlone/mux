import { lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { within } from "@storybook/test";
import { FusionSection } from "./FusionSection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/FusionSection",
  component: FusionSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const ConfiguredMobile: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    chromatic: {
      modes: {
        "dark-mobile": { theme: "dark", viewport: 375 },
        "light-mobile": { theme: "light", viewport: 375 },
      },
    },
  },
  render: () => (
    <div className="w-[343px] p-3">
      <SettingsSectionStory
        setup={() =>
          setupSettingsStory({
            providersConfig: {
              mimo: {
                apiKeySet: true,
                isEnabled: true,
                isConfigured: true,
                models: ["mimo-v2.5-pro"],
              },
            },
            fusion: {
              panel: [
                { modelString: "mimo:mimo-v2.5-pro" },
                { modelString: "google:gemini-3.1-pro-preview" },
              ],
              judge: { modelString: "openai:gpt-5.4" },
            },
          })
        }
      >
        <FusionSection />
      </SettingsSectionStory>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Fusion defaults");
    await canvas.findByText("Panel models");
    await canvas.findByText("Judge model");
    await canvas.findByRole("button", { name: "Save Fusion defaults" });
  },
};
