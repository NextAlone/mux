import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../tests/ui/dom";
import * as ExperimentsModule from "@/browser/hooks/useExperiments";
import { LanguageProvider, type Language } from "@/browser/contexts/LanguageContext";
import { UI_LANGUAGE_KEY } from "@/common/constants/storage";

void mock.module("@/browser/components/Dialog/Dialog", () => ({
  Dialog: (props: { open: boolean; children: ReactNode }) =>
    props.open ? <div>{props.children}</div> : null,
  DialogContent: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogHeader: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogTitle: (props: { children: ReactNode }) => <h2>{props.children}</h2>,
  DialogDescription: (props: { children: ReactNode }) => <p>{props.children}</p>,
  DialogFooter: (props: { children: ReactNode }) => <div>{props.children}</div>,
}));

import { MultiProjectWorkspaceCreateModal } from "./MultiProjectWorkspaceCreateModal";

let cleanupDom: (() => void) | null = null;

function renderModal(language: Language = "en") {
  localStorage.setItem(UI_LANGUAGE_KEY, JSON.stringify(language));
  return render(
    <LanguageProvider>
      <MultiProjectWorkspaceCreateModal
        isOpen={true}
        onClose={() => undefined}
        onConfirm={() => Promise.resolve()}
        projectOptions={[
          { projectPath: "/projects/a", projectName: "a" },
          { projectPath: "/projects/b", projectName: "b" },
        ]}
      />
    </LanguageProvider>
  );
}

describe("MultiProjectWorkspaceCreateModal", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    localStorage.clear();
    spyOn(ExperimentsModule, "useExperimentValue").mockImplementation(() => true);
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    mock.restore();
  });

  test("renders when the experiment is enabled", () => {
    const view = renderModal();

    expect(view.getByText("New Multi-Project Workspace")).toBeTruthy();
    expect(view.getByText("Selected 0 of 2 projects")).toBeTruthy();
  });

  test("renders the project count in Chinese word order", () => {
    const view = renderModal("zh-CN");

    expect(view.getByText("已选择 0/2 个项目")).toBeTruthy();
  });

  test("returns null when the experiment is disabled even if a caller tries to open it", () => {
    spyOn(ExperimentsModule, "useExperimentValue").mockImplementation(() => false);

    const view = renderModal();

    expect(view.queryByText("New Multi-Project Workspace")).toBeNull();
  });
});
