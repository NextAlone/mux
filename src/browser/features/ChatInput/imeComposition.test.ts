import { describe, expect, test } from "bun:test";

import {
  isEnterImmediatelyAfterCompositionEnd,
  isInputMethodCompositionKeyEvent,
} from "./imeComposition";

describe("imeComposition", () => {
  test("detects input-method composition key events", () => {
    expect(isInputMethodCompositionKeyEvent({ isComposing: true, keyCode: 13, which: 13 })).toBe(
      true
    );
    expect(isInputMethodCompositionKeyEvent({ isComposing: false, keyCode: 229, which: 13 })).toBe(
      true
    );
    expect(isInputMethodCompositionKeyEvent({ isComposing: false, keyCode: 13, which: 229 })).toBe(
      true
    );
    expect(isInputMethodCompositionKeyEvent({ isComposing: false, keyCode: 13, which: 13 })).toBe(
      false
    );
  });

  test("suppresses only Enter immediately after compositionend", () => {
    expect(isEnterImmediatelyAfterCompositionEnd({ key: "Enter", timeStamp: 1_010 }, 1_000)).toBe(
      true
    );
    expect(isEnterImmediatelyAfterCompositionEnd({ key: "Enter", timeStamp: 1_100 }, 1_000)).toBe(
      false
    );
    expect(isEnterImmediatelyAfterCompositionEnd({ key: "Tab", timeStamp: 1_010 }, 1_000)).toBe(
      false
    );
  });
});
