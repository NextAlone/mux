import type { AgentSkillDescriptor, SkillName } from "@/common/types/agentSkill";
import type { AvailableWorkflow } from "@/common/types/workflow";
import { getErrorMessage } from "@/common/utils/errors";
import type { Runtime } from "@/node/runtime/Runtime";
import {
  discoverAgentSkills,
  type AgentSkillsRoots,
} from "@/node/services/agentSkills/agentSkillsService";
import { getBuiltInSkillDescriptors } from "@/node/services/agentSkills/builtInSkillDefinitions";
import { log } from "@/node/services/log";

import { buildWorkflowScriptDescriptor } from "./WorkflowService";
import { parseWorkflowMetadata, summarizeWorkflowArgs } from "./workflowMetadata";
import { resolveConventionalSkillWorkflowScript } from "./workflowScriptResolver";

export interface DiscoverWorkflowScriptsInput {
  runtime: Runtime;
  workspacePath: string;
  projectTrusted: boolean;
  roots?: AgentSkillsRoots;
}

/**
 * Enumerate the workflow scripts a workspace can run, for the Workflows tab's
 * empty-state launcher. There is no first-class workflow registry, so we probe
 * every known skill (built-in + project + global) for a conventional workflow entry by
 * attempting to resolve it — a skill that resolves is a workflow; anything that
 * throws (no entry, or project trust missing) is skipped.
 *
 * Standalone `.mux/workflows/*.{md,js}` files are intentionally not enumerated here:
 * they're an advanced, trust-gated path still launchable from chat. Skill-based
 * workflows cover the common case.
 */
export async function discoverWorkflowScripts(
  input: DiscoverWorkflowScriptsInput
): Promise<AvailableWorkflow[]> {
  const skillNames: SkillName[] = [];
  const seen = new Set<string>();
  const addSkill = (descriptor: AgentSkillDescriptor) => {
    // The Workflows tab launcher is a user-facing invocation surface, so honor
    // user-invocable: false the same way slash/palette/ACP surfaces do.
    if (descriptor.userInvocable === false) {
      return;
    }
    if (!seen.has(descriptor.name)) {
      seen.add(descriptor.name);
      skillNames.push(descriptor.name);
    }
  };

  // Built-ins aren't part of discoverAgentSkills' project/global scan, so seed them first;
  // readAgentSkill resolves by precedence (project > global > built-in) when names collide.
  getBuiltInSkillDescriptors().forEach(addSkill);
  try {
    (
      await discoverAgentSkills(input.runtime, input.workspacePath, {
        ...(input.roots != null ? { roots: input.roots } : {}),
      })
    ).forEach(addSkill);
  } catch (error) {
    log.warn(`Workflow script discovery: failed to enumerate skills: ${getErrorMessage(error)}`);
  }

  const available: AvailableWorkflow[] = [];
  for (const skillName of skillNames) {
    try {
      const resolved = await resolveConventionalSkillWorkflowScript({
        skillName,
        runtime: input.runtime,
        workspacePath: input.workspacePath,
        projectTrusted: input.projectTrusted,
        ...(input.roots != null ? { roots: input.roots } : {}),
      });
      available.push({
        descriptor: buildWorkflowScriptDescriptor(resolved),
        scriptPath: resolved.canonicalScriptPath,
        args: summarizeWorkflowArgs(parseWorkflowMetadata(resolved.source)) ?? [],
      });
    } catch {
      // A malformed definition is isolated to this skill; JavaScript remains the fallback entry.
    }
  }

  available.sort((a, b) => a.descriptor.name.localeCompare(b.descriptor.name));
  return available;
}
