import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../tests/ui/dom";
import { LanguageProvider, type Language } from "@/browser/contexts/LanguageContext";
import { UI_LANGUAGE_KEY } from "@/common/constants/storage";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";

void mock.module("@/browser/components/HoverClickPopover/HoverClickPopover", () => ({
  HoverClickPopover: (props: { children: ReactNode; content: ReactNode }) => (
    <>
      {props.children}
      <div>{props.content}</div>
    </>
  ),
}));

import { SkillIndicator } from "./SkillIndicator";

const SKILLS: AgentSkillDescriptor[] = [
  { name: "project-skill", description: "Project description", scope: "project" },
  { name: "global-skill", description: "Global description", scope: "global" },
  { name: "built-in-skill", description: "Built-in description", scope: "built-in" },
];

function renderIndicator(language: Language) {
  localStorage.setItem(UI_LANGUAGE_KEY, JSON.stringify(language));
  return render(
    <LanguageProvider>
      <SkillIndicator loadedSkills={[]} availableSkills={SKILLS} />
    </LanguageProvider>
  );
}

describe("SkillIndicator", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps scope headings grammatical in English", () => {
    const view = renderIndicator("en");

    expect(view.getByText("Project skills")).toBeTruthy();
    expect(view.getByText("Global skills")).toBeTruthy();
    expect(view.getByText("Built-in skills")).toBeTruthy();
  });

  test("renders scope headings without English spacing in Chinese", () => {
    const view = renderIndicator("zh-CN");

    expect(view.getByText("项目技能")).toBeTruthy();
    expect(view.getByText("全局技能")).toBeTruthy();
    expect(view.getByText("内置技能")).toBeTruthy();
  });
});
