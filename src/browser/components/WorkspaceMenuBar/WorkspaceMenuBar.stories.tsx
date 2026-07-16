import {
  CHROMATIC_SMOKE_MODES,
  appMeta,
  AppWithMocks,
  type AppStory,
} from "@/browser/stories/meta.js";
import { createGitStatusExecutor } from "@/browser/stories/helpers/git";
import {
  collapseRightSidebar,
  collapseLeftSidebar,
  expandProjects,
  selectWorkspace,
} from "@/browser/stories/helpers/uiState";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { SCRATCH_PROJECT_CONFIG_KEY, SCRATCH_SIDEBAR_SECTION_ID } from "@/common/constants/scratch";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";

export default {
  ...appMeta,
  title: "Components/WorkspaceMenuBar",
};

// Integration: stories render full app to show devcontainer runtime indicator in WorkspaceMenuBar context.

const DEVCONTAINER_RUNTIME = {
  type: "devcontainer" as const,
  configPath: ".devcontainer/devcontainer.json",
};

/**
 * Build a mock executor that handles BookmarkSelector's jj bookmark probes plus
 * GitStatusStore's consolidated status script, using a per-workspace bookmark map.
 */
function createBookmarkAwareExecutor(
  bookmarks: Map<string, string>,
  gitStatus?: Map<string, { ahead?: number; behind?: number; dirty?: number }>
) {
  const baseExecutor = createGitStatusExecutor(gitStatus);
  return (workspaceId: string, script: string) => {
    if (script.includes("jj --no-pager --color never root")) {
      return Promise.resolve({
        success: true as const,
        output: "true",
        exitCode: 0,
        wall_duration_ms: 10,
      });
    }

    if (script.includes("latest(::@ & bookmarks())")) {
      const bookmark = bookmarks.get(workspaceId) ?? "main";
      return Promise.resolve({
        success: true as const,
        output: bookmark,
        exitCode: 0,
        wall_duration_ms: 10,
      });
    }

    if (script.includes("jj --no-pager --color never bookmark list")) {
      return Promise.resolve({
        success: true as const,
        output: Array.from(bookmarks.values()).join("\n"),
        exitCode: 0,
        wall_duration_ms: 10,
      });
    }

    if (script.includes("jj --no-pager --color never git remote list")) {
      return Promise.resolve({
        success: true as const,
        output: "",
        exitCode: 0,
        wall_duration_ms: 10,
      });
    }

    return baseExecutor(workspaceId, script);
  };
}

function createDevcontainerClient(runtimeStatus: "running" | "stopped" | "unknown") {
  const stableCreatedAt = "2023-11-14T22:13:20.000Z";

  const workspaces = [
    createWorkspace({
      id: "dc-1",
      name: "feature/lazy-start",
      projectName: "mux",
      runtimeConfig: DEVCONTAINER_RUNTIME,
      createdAt: stableCreatedAt,
    }),
    createWorkspace({
      id: "dc-2",
      name: "fix/sidebar-overflow",
      projectName: "mux",
      createdAt: stableCreatedAt,
    }),
  ];
  const projects = groupWorkspacesByProject(workspaces);

  selectWorkspace(workspaces[0]);
  expandProjects([...projects.keys()]);
  collapseRightSidebar();
  collapseLeftSidebar();

  const bookmarks = new Map([
    // dc-1 bookmark is only available when the runtime is running;
    // otherwise BookmarkSelector falls back to bookmarkCache / workspaceName.
    ...(runtimeStatus === "running" ? [["dc-1", "feature/lazy-start"] as const] : []),
    ["dc-2", "fix/sidebar-overflow"],
  ]);
  const gitStatus = new Map([
    // Passive repository status is gated behind runtime eligibility — stopped/unknown
    // devcontainers have no repository status data until the runtime starts.
    ...(runtimeStatus === "running" ? [["dc-1", { ahead: 2, dirty: 1 }] as const] : []),
    ["dc-2", { ahead: 0, behind: 3 }],
  ]);

  return createMockORPCClient({
    projects,
    workspaces,
    executeBash: createBookmarkAwareExecutor(bookmarks, gitStatus),
    runtimeStatuses: new Map([
      ["dc-1", runtimeStatus],
      ["dc-2", "unsupported"],
    ]),
  });
}

/**
 * Devcontainer workspace with a running container.
 * The top bar shows a "Container running" indicator next to the bookmark selector.
 */
export const DevcontainerRunning: AppStory = {
  parameters: {
    chromatic: { modes: CHROMATIC_SMOKE_MODES },
  },
  render: () => <AppWithMocks setup={() => createDevcontainerClient("running")} />,
};

/**
 * Devcontainer workspace with a stopped container.
 * The top bar does NOT show a container indicator — verifies absence.
 */
export const DevcontainerStopped: AppStory = {
  render: () => <AppWithMocks setup={() => createDevcontainerClient("stopped")} />,
};

/** Devcontainer with unknown runtime status — no status chip should be visible. */
export const DevcontainerUnknown: AppStory = {
  render: () => <AppWithMocks setup={() => createDevcontainerClient("unknown")} />,
};

export const ScratchWorkspace: AppStory = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    chromatic: {
      modes: {
        // ScratchWorkspace was added for the phone regression; desktop remains covered elsewhere.
        mobile: { theme: "light", viewport: "mobile1", hasTouch: true },
      },
    },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        const scratchPath = "/home/user/.mux/scratch/scratch-1";
        const workspace = {
          ...createWorkspace({
            id: "scratch-1",
            name: "scratch-scratch-1",
            projectName: "Scratch",
            projectPath: scratchPath,
            runtimeConfig: { type: "local" },
          }),
          kind: "scratch" as const,
          namedWorkspacePath: scratchPath,
        };
        selectWorkspace(workspace);
        expandProjects([SCRATCH_SIDEBAR_SECTION_ID]);
        collapseRightSidebar();

        return createMockORPCClient({
          projects: new Map([
            [
              SCRATCH_PROJECT_CONFIG_KEY,
              {
                projectKind: "system",
                trusted: true,
                workspaces: [
                  {
                    kind: "scratch",
                    path: scratchPath,
                    id: workspace.id,
                    name: workspace.name,
                    runtimeConfig: { type: "local" },
                  },
                ],
              },
            ],
          ]),
          workspaces: [workspace],
        });
      }}
    />
  ),
};
