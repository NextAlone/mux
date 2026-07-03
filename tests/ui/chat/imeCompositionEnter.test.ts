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

function dispatchEnter(
  textarea: HTMLTextAreaElement,
  props: { isComposing?: boolean; keyCode?: number; which?: number } = {}
): boolean {
  const event = new window.KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true,
  });

  if (props.isComposing != null) {
    Object.defineProperty(event, "isComposing", { value: props.isComposing });
  }
  if (props.keyCode != null) {
    Object.defineProperty(event, "keyCode", { value: props.keyCode });
  }
  if (props.which != null) {
    Object.defineProperty(event, "which", { value: props.which });
  }

  return fireEvent(textarea, event);
}

describe("chat input IME composition", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("does not send when Enter confirms an input-method composition", async () => {
    const app = await createAppHarness({ branchPrefix: "ime-enter" });

    try {
      const draftText = "输入法确认不应该发送";
      await app.chat.typeWithoutSending(draftText);
      const textarea = await getActiveTextarea(app.view.container);

      expect(dispatchEnter(textarea, { isComposing: true })).toBe(true);
      expect(textarea.value).toBe(draftText);

      expect(dispatchEnter(textarea, { keyCode: 229, which: 229 })).toBe(true);
      expect(textarea.value).toBe(draftText);

      expect(dispatchEnter(textarea)).toBe(false);
      await app.chat.expectTranscriptContains(`Mock response: ${draftText}`);
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
