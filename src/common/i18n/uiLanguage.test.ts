import { describe, expect, test } from "bun:test";
import { normalizeUiLanguage, translateDesktopUi, uiLanguageFromLocale } from "./uiLanguage";

describe("UI language", () => {
  test("normalizes persisted values to supported languages", () => {
    expect(normalizeUiLanguage("zh-CN")).toBe("zh-CN");
    expect(normalizeUiLanguage("unsupported")).toBe("en");
  });

  test("uses simplified Chinese for Chinese system locales", () => {
    expect(uiLanguageFromLocale("zh-CN")).toBe("zh-CN");
    expect(uiLanguageFromLocale("zh-TW")).toBe("zh-CN");
    expect(uiLanguageFromLocale("en-US")).toBe("en");
  });

  test("keeps source text as a safe fallback", () => {
    expect(translateDesktopUi("en", "Edit")).toBe("Edit");
    expect(translateDesktopUi("zh-CN", "Unknown label")).toBe("Unknown label");
    expect(translateDesktopUi("zh-CN", "Edit")).not.toBe("Edit");
  });

  test.each(["constructor", "toString", "__proto__"])(
    "does not expose Object prototype value for %s",
    (text) => {
      expect(translateDesktopUi("zh-CN", text)).toBe(text);
    }
  );
});
