import type { ComponentProps } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import * as ProjectContextModule from "@/browser/contexts/ProjectContext";
import * as SettingsContextModule from "@/browser/contexts/SettingsContext";
import * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type { ProjectContext } from "@/browser/contexts/ProjectContext";
import type { WorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import type { WorkspaceNameState } from "@/browser/hooks/useWorkspaceName";
import { RUNTIME_MODE } from "@/common/types/runtime";
import type { ProjectConfig } from "@/common/types/project";
import { CreationControls, buildSourceBookmarkOptions } from "./CreationControls";
import type { RuntimeAvailabilityState } from "./useCreationWorkspace";

const TEST_PROJECT_PATH = "/tmp/demo";
const TEST_PROJECT_CONFIG: ProjectConfig = { workspaces: [] };

const RUNTIME_AVAILABILITY: RuntimeAvailabilityState = {
  status: "loaded",
  data: {
    local: { available: true },
    worktree: { available: true },
    ssh: { available: true },
    docker: { available: true },
    devcontainer: { available: true },
  },
};

const NAME_STATE: WorkspaceNameState = {
  name: "demo-workspace",
  title: null,
  isGenerating: false,
  autoGenerate: true,
  error: null,
  setAutoGenerate: mock(),
  setName: mock(),
};

function createBaseProps(
  overrides: Partial<ComponentProps<typeof CreationControls>> = {}
): ComponentProps<typeof CreationControls> {
  return {
    branches: ["main", "develop"],
    branchesLoaded: true,
    trunkBranch: "main",
    onTrunkBranchChange: mock(),
    selectedRuntime: { mode: RUNTIME_MODE.WORKTREE },
    coderConfigFallback: {},
    sshHostFallback: "devbox",
    defaultRuntimeMode: RUNTIME_MODE.WORKTREE,
    onSelectedRuntimeChange: mock(),
    onSetDefaultRuntime: mock(),
    disabled: false,
    projectPath: TEST_PROJECT_PATH,
    projectName: "demo",
    nameState: NAME_STATE,
    runtimeAvailabilityState: RUNTIME_AVAILABILITY,
    ...overrides,
  };
}

function createProjectContext(): ProjectContext {
  return {
    userProjects: new Map([[TEST_PROJECT_PATH, TEST_PROJECT_CONFIG]]),
    getProjectConfig: (projectPath: string) =>
      projectPath === TEST_PROJECT_PATH ? TEST_PROJECT_CONFIG : undefined,
    loading: false,
    loaded: true,
    loadError: null,
  } as unknown as ProjectContext;
}

function renderCreationControls(props: ComponentProps<typeof CreationControls>) {
  return render(
    <TooltipProvider>
      <CreationControls {...props} />
    </TooltipProvider>
  );
}

describe("CreationControls", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalLocalStorage: typeof globalThis.localStorage;
  let originalLocation: typeof globalThis.location;
  let restoreSpies: Array<() => void>;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;
    originalLocation = globalThis.location;

    const dom = new GlobalWindow({ url: "https://mux.example.com/" });
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = dom.document as unknown as Document;
    globalThis.localStorage = dom.localStorage;
    globalThis.location = dom.location as unknown as Location;

    const projectContextSpy = spyOn(ProjectContextModule, "useProjectContext").mockImplementation(
      createProjectContext
    );
    const settingsContextSpy = spyOn(SettingsContextModule, "useSettings").mockImplementation(
      () =>
        ({
          open: mock(),
        }) as unknown as ReturnType<typeof SettingsContextModule.useSettings>
    );
    const workspaceContextSpy = spyOn(
      WorkspaceContextModule,
      "useWorkspaceContext"
    ).mockImplementation(() => ({ beginWorkspaceCreation: mock() }) as unknown as WorkspaceContext);
    restoreSpies = [
      () => projectContextSpy.mockRestore(),
      () => settingsContextSpy.mockRestore(),
      () => workspaceContextSpy.mockRestore(),
    ];
  });

  afterEach(() => {
    cleanup();
    for (const restore of restoreSpies) {
      restore();
    }
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
    globalThis.location = originalLocation;
  });

  test("hides the source bookmark selector for local runtime", () => {
    const view = renderCreationControls(
      createBaseProps({ selectedRuntime: { mode: RUNTIME_MODE.LOCAL } })
    );

    expect(view.queryByText("Source Bookmark")).toBeNull();
    expect(view.queryByLabelText("Select source bookmark")).toBeNull();
  });

  test("shows the source bookmark selector for jj workspace runtime", () => {
    const view = renderCreationControls(createBaseProps());

    expect(view.queryByText("Source Bookmark")).not.toBeNull();
    expect(view.queryByLabelText("Select source bookmark")).not.toBeNull();
  });

  test("includes the parent revision source option", () => {
    expect(buildSourceBookmarkOptions(["main", "develop"], "main")).toEqual([
      "@-",
      "main",
      "develop",
    ]);
  });
});
