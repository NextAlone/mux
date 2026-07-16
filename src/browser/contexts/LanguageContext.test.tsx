import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";
import { UI_LANGUAGE_KEY } from "@/common/constants/storage";
import { LanguageProvider, useLanguage } from "./LanguageContext";

installDom();

function LanguageProbe() {
  const { language, setLanguage, t } = useLanguage();
  return (
    <div>
      <span>{language}</span>
      <span>{t("Settings")}</span>
      <span>{t("Untranslated")}</span>
      <span data-testid="prototype-translation">{t("constructor")}</span>
      <button type="button" onClick={() => setLanguage("zh-CN")}>
        Switch
      </button>
    </div>
  );
}

describe("LanguageContext", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("switches immediately, persists the preference, and falls back to English source text", () => {
    const view = render(
      <LanguageProvider>
        <LanguageProbe />
      </LanguageProvider>
    );

    expect(view.getByText("en")).toBeTruthy();
    expect(view.getByText("Settings")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Switch" }));

    expect(view.getByText("zh-CN")).toBeTruthy();
    expect(view.getByText("设置")).toBeTruthy();
    expect(view.getByText("Untranslated")).toBeTruthy();
    expect(view.getByTestId("prototype-translation").textContent).toBe("constructor");
    expect(localStorage.getItem(UI_LANGUAGE_KEY)).toBe(JSON.stringify("zh-CN"));
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  test("normalizes unsupported persisted values to English", () => {
    localStorage.setItem(UI_LANGUAGE_KEY, JSON.stringify("unsupported"));

    const view = render(
      <LanguageProvider>
        <LanguageProbe />
      </LanguageProvider>
    );

    expect(view.getByText("en")).toBeTruthy();
    expect(view.getByText("Settings")).toBeTruthy();
  });
});
