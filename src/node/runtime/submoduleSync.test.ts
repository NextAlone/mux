import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "bun:test";

import type { InitLogger, Runtime } from "./Runtime";
import { syncLocalGitSubmodules, syncRuntimeGitSubmodules } from "./submoduleSync";

function createInitLogger() {
  const steps: string[] = [];
  const logger: InitLogger = {
    logStep: (message) => steps.push(message),
    logStdout: (_line) => undefined,
    logStderr: (_line) => undefined,
    logComplete: (_exitCode) => undefined,
  };

  return { logger, steps };
}

function createExecStream(result: { stdout?: string; stderr?: string; exitCode: number }) {
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        if (result.stdout) {
          controller.enqueue(new TextEncoder().encode(result.stdout));
        }
        controller.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        if (result.stderr) {
          controller.enqueue(new TextEncoder().encode(result.stderr));
        }
        controller.close();
      },
    }),
    stdin: new WritableStream<Uint8Array>({
      write: () => undefined,
      close: () => undefined,
      abort: () => undefined,
    }),
    exitCode: Promise.resolve(result.exitCode),
    duration: Promise.resolve(0),
  };
}

class RecordingRuntime {
  readonly calls: Array<{
    command: string;
    cwd: string | undefined;
    env: Record<string, string> | undefined;
  }> = [];

  constructor(
    private readonly results: Array<{ stdout?: string; stderr?: string; exitCode: number }>
  ) {}

  exec(
    command: string,
    options: { cwd?: string; env?: Record<string, string> }
  ): Promise<ReturnType<typeof createExecStream>> {
    this.calls.push({ command, cwd: options.cwd, env: options.env });
    return Promise.resolve(createExecStream(this.results.shift() ?? { exitCode: 0 }));
  }
}

describe("syncLocalGitSubmodules", () => {
  it("rejects local submodules until jj-native materialization exists", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mux-submodule-sync-"));

    try {
      const workspacePath = path.join(tempRoot, "worktrees", "feature-submodule");
      await fs.mkdir(workspacePath, { recursive: true });
      await fs.writeFile(path.join(workspacePath, ".gitmodules"), '[submodule "docs"]\n', "utf-8");

      const { logger, steps } = createInitLogger();
      let errorMessage = "";
      try {
        await syncLocalGitSubmodules({ workspacePath, initLogger: logger });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toContain("jj-native submodule materialization is not implemented");
      expect(steps).toEqual(["Submodules detected"]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("throws when probing local .gitmodules fails for reasons other than absence", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mux-submodule-probe-"));

    try {
      await fs.mkdir(path.join(tempRoot, ".gitmodules"), { recursive: true });
      const { logger } = createInitLogger();

      let errorMessage = "";
      try {
        await syncLocalGitSubmodules({
          workspacePath: tempRoot,
          initLogger: logger,
          trusted: true,
        });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toContain("Failed to probe .gitmodules before submodule sync");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("syncRuntimeGitSubmodules", () => {
  it("rejects remote submodules until jj-native materialization exists", async () => {
    const runtime = new RecordingRuntime([
      { stdout: "present", exitCode: 0 },
    ]) as unknown as Runtime & RecordingRuntime;
    const { logger, steps } = createInitLogger();

    let errorMessage = "";
    try {
      await syncRuntimeGitSubmodules({
        runtime,
        workspacePath: "/remote/workspace",
        initLogger: logger,
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain("jj-native submodule materialization is not implemented");
    expect(runtime.calls[0]?.command).toContain("if [ -f .gitmodules ]");
    expect(runtime.calls).toHaveLength(1);
    expect(steps).toEqual(["Submodules detected"]);
  });

  it("skips runtime sync when .gitmodules is absent", async () => {
    const runtime = new RecordingRuntime([
      { stdout: "missing", exitCode: 2 },
    ]) as unknown as Runtime & RecordingRuntime;
    const { logger, steps } = createInitLogger();

    await syncRuntimeGitSubmodules({
      runtime,
      workspacePath: "/remote/workspace",
      initLogger: logger,
      trusted: true,
    });

    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]?.command).toContain("if [ -f .gitmodules ]");
    expect(steps).toEqual([]);
  });

  it("throws when probing .gitmodules on the runtime fails for reasons other than absence", async () => {
    const runtime = new RecordingRuntime([
      { stderr: "cd: /remote/workspace: No such file or directory", exitCode: 1 },
    ]) as unknown as Runtime & RecordingRuntime;
    const { logger } = createInitLogger();

    let errorMessage = "";
    try {
      await syncRuntimeGitSubmodules({
        runtime,
        workspacePath: "/remote/workspace",
        initLogger: logger,
        trusted: true,
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain("Failed to probe .gitmodules before submodule sync");
  });
});
