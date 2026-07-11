import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getErrorMessage } from "@/common/utils/errors";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";
import { execBuffered } from "@/node/utils/runtime/helpers";
import type { InitLogger, Runtime } from "./Runtime";

const GITMODULES_PROBE_TIMEOUT_SECS = 10;
const GITMODULES_PROBE_MISSING_EXIT_CODE = 2;
const GITMODULES_PROBE_INVALID_EXIT_CODE = 3;

interface BaseSubmoduleSyncArgs {
  workspacePath: string;
  initLogger: InitLogger;
  abortSignal?: AbortSignal;
  env?: Record<string, string>;
  trusted?: boolean;
}

interface RuntimeSubmoduleSyncArgs extends BaseSubmoduleSyncArgs {
  runtime: Runtime;
}

function formatSubmoduleSyncError(error: unknown): Error {
  return new Error(`Failed to initialize submodules: ${getErrorMessage(error)}`);
}

function formatGitmodulesProbeError(error: unknown): Error {
  return new Error(`Failed to probe .gitmodules before submodule sync: ${getErrorMessage(error)}`);
}

function runSubmoduleMaterialization(args: RuntimeSubmoduleSyncArgs): never {
  args.initLogger.logStep("Submodules detected");
  throw formatSubmoduleSyncError(
    "jj-native submodule materialization is not implemented without invoking Git. Materialize submodules before creating this runtime, or use a non-submodule repository until jj-native submodule support is added."
  );
}

async function hasLocalGitmodules(workspacePath: string): Promise<boolean> {
  const gitmodulesPath = path.join(workspacePath, ".gitmodules");

  try {
    const stat = await fs.stat(gitmodulesPath);
    if (stat.isDirectory()) {
      throw new Error(`${gitmodulesPath} is a directory`);
    }
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }

    throw formatGitmodulesProbeError(error);
  }
}

async function hasRuntimeGitmodules(args: RuntimeSubmoduleSyncArgs): Promise<boolean> {
  const gitmodulesProbeCommand =
    `if [ -f .gitmodules ]; then printf present; exit 0; fi; ` +
    `if [ -e .gitmodules ]; then printf invalid; exit ${GITMODULES_PROBE_INVALID_EXIT_CODE}; fi; ` +
    `printf missing; exit ${GITMODULES_PROBE_MISSING_EXIT_CODE}`;
  const gitmodulesCheck = await execBuffered(args.runtime, gitmodulesProbeCommand, {
    cwd: args.workspacePath,
    timeout: GITMODULES_PROBE_TIMEOUT_SECS,
    abortSignal: args.abortSignal,
    env: args.env,
  });

  if (
    gitmodulesCheck.exitCode === GITMODULES_PROBE_MISSING_EXIT_CODE &&
    gitmodulesCheck.stdout.trim() === "missing"
  ) {
    return false;
  }

  if (gitmodulesCheck.exitCode !== 0 || gitmodulesCheck.stdout.trim() !== "present") {
    throw formatGitmodulesProbeError(gitmodulesCheck.stderr || gitmodulesCheck.stdout);
  }

  return true;
}

export async function syncLocalGitSubmodules(args: BaseSubmoduleSyncArgs): Promise<void> {
  if (!(await hasLocalGitmodules(args.workspacePath))) {
    return;
  }

  args.initLogger.logStep("Submodules detected");
  throw formatSubmoduleSyncError(
    "jj-native submodule materialization is not implemented without invoking Git. Materialize submodules before creating this runtime, or use a non-submodule repository until jj-native submodule support is added."
  );
}

export async function syncRuntimeGitSubmodules(args: RuntimeSubmoduleSyncArgs): Promise<void> {
  if (!(await hasRuntimeGitmodules(args))) {
    return;
  }

  runSubmoduleMaterialization(args);
}
