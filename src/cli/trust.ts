#!/usr/bin/env bun
/**
 * `mux trust` - Headless project trust management.
 *
 * Trust gates all repo-controlled automation (project workflows, hooks, and
 * .mux configuration), so it lives at the top level of the CLI rather than
 * under any single feature's subcommand. The desktop app records trust in
 * ~/.mux/config.json via Settings → Security; this command writes the same
 * entry directly so headless environments (no desktop app or server running,
 * project possibly never added to mux) can grant or revoke trust. A running
 * desktop instance picks the change up through its config-file watcher.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { Command } from "commander";

import { getErrorMessage } from "@/common/utils/errors";
import { Config } from "@/node/config";
import { isProjectTrusted } from "@/node/utils/projectTrust";
import { getParseOptions } from "./argv";
import { exitAfterStdoutFlush } from "./processExit";

const execFileAsync = promisify(execFile);

export interface ResolveProjectDirInput {
  cwd: string;
  explicitDir?: string;
}

interface TrustCLIOptions {
  dir?: string;
  revoke?: boolean;
  json?: boolean;
}

/**
 * Resolve the project directory for trust and workflow discovery: an explicit
 * --dir wins; otherwise the jj workspace root of cwd (falling back to cwd itself).
 */
export async function resolveProjectDir(input: ResolveProjectDirInput): Promise<string> {
  if (input.explicitDir != null) {
    const explicitDir = path.resolve(input.cwd, input.explicitDir);
    await ensureDirectory(explicitDir);
    return explicitDir;
  }

  const cwd = path.resolve(input.cwd);
  await ensureDirectory(cwd);
  const jjRoot = await findJjRoot(cwd);
  return jjRoot ?? cwd;
}

async function ensureDirectory(dirPath: string): Promise<void> {
  const stats = await fs.stat(dirPath);
  if (!stats.isDirectory()) {
    throw new Error(`"${dirPath}" is not a directory`);
  }
}

async function runJj(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "jj",
      ["--config", "ui.paginate=never", "--config", "ui.color=never", ...args],
      { cwd }
    );
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export async function findJjRoot(cwd: string): Promise<string | null> {
  return runJj(cwd, ["root"]);
}

/**
 * For a linked jj workspace, returns the main repository working directory when
 * jj exposes a colocated Git root. Returns null for the main checkout itself,
 * non-colocated jj repos, and non-jj directories.
 */
export async function findMainRepoDir(projectDir: string): Promise<string | null> {
  const gitRoot = await runJj(projectDir, ["git", "root"]);
  if (gitRoot == null) {
    return null;
  }

  const absoluteGitRoot = path.resolve(projectDir, gitRoot);
  if (path.basename(absoluteGitRoot) !== ".git") {
    return null;
  }
  const mainRepoDir = path.dirname(absoluteGitRoot);
  return mainRepoDir === projectDir ? null : mainRepoDir;
}

/**
 * Resolve project trust for repo-controlled automation. Trust is keyed in
 * config.json by the registered project path, so linked jj workspaces (e.g. mux
 * workspaces under ~/.mux/src/<project>/<bookmark>) miss a direct lookup of their own
 * checkout path. Mirror the desktop app, which scans the workspace checkout but
 * resolves trust against the registered project path (resolveWorkflowContext in
 * src/node/orpc/router.ts), by also accepting trust granted to the main repository.
 */
export async function resolveProjectTrusted(
  realConfig: Config,
  projectDir: string
): Promise<boolean> {
  if (isProjectTrusted(realConfig, projectDir)) {
    return true;
  }
  const mainRepoDir = await findMainRepoDir(projectDir);
  return mainRepoDir != null && isProjectTrusted(realConfig, mainRepoDir);
}

async function runTrust(options: TrustCLIOptions): Promise<number> {
  const projectDir = await resolveProjectDir({
    cwd: process.cwd(),
    explicitDir: options.dir,
  });
  const realConfig = new Config();
  const trusted = options.revoke !== true;

  // Linked workspaces are ephemeral aliases of the main repository: key trust by the
  // main repo path (matching resolveProjectTrusted) instead of accumulating
  // per-workspace entries in config.json. findMainRepoDir(jjRoot) is null for a main
  // checkout, so an explicit non-workspace --dir is trusted exactly as given and
  // sub-project trust stays possible.
  const jjRoot = await findJjRoot(projectDir);
  const mainRepoDir = jjRoot == null ? null : await findMainRepoDir(jjRoot);
  const trustDir = mainRepoDir ?? projectDir;

  // Compare and verify against the checkout's *effective* trust (direct entry or
  // main-repo fallback), not just the canonical entry: that is what workflow
  // discovery and hooks actually consult.
  const wasTrusted = await resolveProjectTrusted(realConfig, projectDir);
  if (wasTrusted !== trusted) {
    await realConfig.editConfig((config) => {
      const setEntryTrusted = (dir: string, createIfMissing: boolean) => {
        let project = config.projects.get(dir);
        if (!project) {
          if (!createIfMissing) {
            return;
          }
          // Mirror the desktop setTrust handler (projects.setTrust in
          // src/node/orpc/router.ts): create a minimal project entry when the project
          // was never added to mux, so headless CLI use works without the desktop app
          // or server.
          project = { workspaces: [] };
          config.projects.set(dir, project);
        }
        project.trusted = trusted;
      };
      setEntryTrusted(trustDir, true);
      if (!trusted) {
        // Revocation must also clear direct entries for the checkout paths themselves
        // (e.g. a workspace added as its own project, or an older/manual config entry);
        // resolveProjectTrusted's direct lookup would otherwise keep this checkout
        // trusted after we report revocation. Skip entry creation: absence already
        // means untrusted.
        for (const dir of new Set([projectDir, jjRoot ?? projectDir])) {
          if (dir !== trustDir) {
            setEntryTrusted(dir, false);
          }
        }
      }
      return config;
    });
    // Config.saveConfig swallows write failures (self-healing keeps the desktop app
    // alive on bad disks), so editConfig resolves even when nothing was persisted.
    // A headless trust command must not report success in that case: re-read from
    // disk and fail loudly instead of letting automation proceed with a wrong
    // assumption about the project's trust state.
    if ((await resolveProjectTrusted(realConfig, projectDir)) !== trusted) {
      throw new Error(
        `Failed to persist trust change for ${trustDir}. Check that ${realConfig.rootDir} is a writable directory.`
      );
    }
  }

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify({ projectPath: trustDir, trusted })}\n`);
    return 0;
  }
  if (mainRepoDir != null) {
    process.stdout.write(`Resolved linked jj workspace ${projectDir} to its main repository.\n`);
  }
  if (wasTrusted === trusted) {
    process.stdout.write(`Project already ${trusted ? "trusted" : "untrusted"}: ${trustDir}\n`);
  } else if (trusted) {
    process.stdout.write(`Trusted project: ${trustDir}\n`);
    process.stdout.write(
      "Trusted projects can run repo-controlled code: project workflows, hooks, and .mux configuration.\n"
    );
  } else {
    process.stdout.write(`Revoked project trust: ${trustDir}\n`);
  }
  return 0;
}

export async function main(): Promise<number> {
  const program = new Command();
  program
    .name("mux trust")
    .description(
      "Trust the project in the current directory (or --dir) so repo-controlled automation (project workflows, hooks, .mux configuration) can run"
    )
    .option("-d, --dir <path>", "project directory")
    .option("--revoke", "revoke trust instead of granting it")
    .option("--json", "emit JSON output")
    .action(async () => {
      process.exitCode = await runTrust(program.opts<TrustCLIOptions>());
    });

  await program.parseAsync(process.argv, getParseOptions());
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

if (require.main === module) {
  main()
    .then(exitAfterStdoutFlush)
    .catch((error: unknown) => {
      console.error(`Error: ${getErrorMessage(error)}`);
      process.exit(1);
    });
}
