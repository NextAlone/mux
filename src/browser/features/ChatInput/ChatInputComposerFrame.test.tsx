import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { ChatInputComposerFrame } from "./ChatInputComposerFrame";

let cleanupDom: (() => void) | null = null;

describe("ChatInputComposerFrame", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("anchors toast overlay to the centered workspace input column", () => {
    const view = render(
      <ChatInputComposerFrame variant="workspace" toastLayer={<div data-testid="toast">Saved</div>}>
        <div data-testid="composer">Composer</div>
      </ChatInputComposerFrame>
    );

    const frame = view.container.querySelector('[data-component="ChatInputComposerFrame"]');
    expect(frame).toBeInstanceOf(HTMLElement);
    if (!(frame instanceof HTMLElement)) {
      throw new Error("Expected the chat input composer frame to render");
    }

    expect(frame.className).toContain("relative");
    expect(frame.className).toContain("mx-auto");
    expect(frame.className).toContain("max-w-4xl");

    const overlay = view.container.querySelector('[data-component="ChatInputToastOverlay"]');
    expect(overlay).toBeInstanceOf(HTMLElement);
    if (!(overlay instanceof HTMLElement)) {
      throw new Error("Expected the chat input toast overlay to render");
    }

    expect(overlay.className).toContain("absolute");
    expect(overlay.parentElement).toBe(frame);
  });
});
