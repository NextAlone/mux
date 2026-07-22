import "../dom";

jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));

import { fireEvent, waitFor } from "@testing-library/react";

import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";

async function getActiveTextarea(container: HTMLElement): Promise<HTMLTextAreaElement> {
  return waitFor(
    () => {
      const textareas = Array.from(
        container.querySelectorAll('textarea[aria-label="Message Claude"]')
      ) as HTMLTextAreaElement[];
      const enabled = [...textareas].reverse().find((textarea) => !textarea.disabled);
      if (!enabled) {
        throw new Error("Chat textarea not ready");
      }
      return enabled;
    },
    { timeout: 10_000 }
  );
}

describe("model selector shortcut", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("opens the model selector with Option+P while the composer is focused", async () => {
    const app = await createAppHarness({ branchPrefix: "model-selector-shortcut" });

    try {
      const textarea = await getActiveTextarea(app.view.container);
      textarea.focus();

      // macOS reports Option+P as π; the shortcut must use the physical KeyP code.
      expect(
        fireEvent.keyDown(textarea, {
          key: "π",
          code: "KeyP",
          altKey: true,
        })
      ).toBe(false);

      await waitFor(() => {
        const input = app.view.container.querySelector<HTMLInputElement>(
          'input[placeholder="Search [provider:model-name]"]'
        );
        if (!input) {
          throw new Error("Model selector input not found");
        }
      });
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
