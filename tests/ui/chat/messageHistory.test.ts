import "../dom";

jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));

import { fireEvent, waitFor } from "@testing-library/react";

import { preloadTestModules, type TestEnvironment } from "../../ipc/setup";
import { createAppHarness } from "../harness";

type WorkspaceServiceSendMessageFn = TestEnvironment["services"]["workspaceService"]["sendMessage"];

async function getActiveTextarea(container: HTMLElement): Promise<HTMLTextAreaElement> {
  return waitFor(
    () => {
      const textareas = Array.from(container.querySelectorAll("textarea")) as HTMLTextAreaElement[];
      const enabled = [...textareas].reverse().find((textarea) => !textarea.disabled);
      if (!enabled) {
        throw new Error("Chat textarea not ready");
      }
      return enabled;
    },
    { timeout: 10_000 }
  );
}

describe("chat input message history", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("restores the sent draft when a successful send appends no transcript message", async () => {
    let sendCallCount = 0;
    const app = await createAppHarness({
      branchPrefix: "history-restore",
      beforeRender: (env) => {
        env.services.workspaceService.sendMessage = (async () => {
          sendCallCount += 1;
          return {
            success: true as const,
            data: undefined,
          };
        }) as WorkspaceServiceSendMessageFn;
      },
    });

    try {
      const message = "restore me when nothing appears";
      await app.chat.send(message);

      await waitFor(() => expect(sendCallCount).toBe(1));
      await app.chat.expectInputValue(message);
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("uses Up and Down to navigate sent message history in the composer", async () => {
    const app = await createAppHarness({ branchPrefix: "history-arrows" });

    try {
      const first = "first history item";
      const second = "second history item";

      await app.chat.send(first);
      await app.chat.expectTranscriptContains(`Mock response: ${first}`);
      await app.chat.expectStreamComplete();

      await app.chat.send(second);
      await app.chat.expectTranscriptContains(`Mock response: ${second}`);
      await app.chat.expectStreamComplete();

      const textarea = await getActiveTextarea(app.view.container);
      textarea.focus();

      expect(fireEvent.keyDown(textarea, { key: "ArrowUp" })).toBe(false);
      await app.chat.expectInputValue(second);
      expect(textarea.getAttribute("aria-label")).toBe("Message Claude");

      expect(fireEvent.keyDown(textarea, { key: "ArrowUp" })).toBe(false);
      await app.chat.expectInputValue(first);

      expect(fireEvent.keyDown(textarea, { key: "ArrowDown" })).toBe(false);
      await app.chat.expectInputValue(second);

      expect(fireEvent.keyDown(textarea, { key: "ArrowDown" })).toBe(false);
      await app.chat.expectInputValue("");
      expect(textarea.getAttribute("aria-label")).toBe("Message Claude");
    } finally {
      await app.dispose();
    }
  }, 90_000);
});
