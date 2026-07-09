import { tool } from "ai";

import type { FusionConfig, FusionModelConfig } from "@/common/config/schemas/appConfigOnDisk";
import type { FusionToolArgs } from "@/common/types/tools";
import type { ThinkingLevel } from "@/common/types/thinking";
import { normalizeModelInput } from "@/common/utils/ai/normalizeModelInput";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { createWorkflowRunTool } from "./workflow_run";

interface ResolvedFusionModel {
  model: string;
  thinking?: ThinkingLevel;
}

interface ResolvedFusionArgs {
  prompt: string;
  panel: ResolvedFusionModel[];
  judge: ResolvedFusionModel;
}

function modelKey(model: string): string {
  return model.trim().toLowerCase();
}

function configuredCandidates(config: FusionConfig): string[] {
  return [...config.panel.map((entry) => entry.modelString), config.judge.modelString];
}

function resolveModelShorthand(
  rawModel: string,
  config: FusionConfig,
  availableModels: readonly string[]
): string {
  const normalized = normalizeModelInput(rawModel);
  if (normalized.model != null) {
    return normalized.model;
  }

  const rawKey = modelKey(rawModel);
  const candidates = [...new Set([...configuredCandidates(config), ...availableModels])];
  const matches = candidates.filter((candidate) => {
    const candidateKey = modelKey(candidate);
    const separator = candidateKey.indexOf(":");
    const provider = separator < 0 ? "" : candidateKey.slice(0, separator);
    const modelId = separator < 0 ? candidateKey : candidateKey.slice(separator + 1);
    return candidateKey === rawKey || provider === rawKey || modelId === rawKey;
  });

  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`Fusion model "${rawModel}" is ambiguous. Use one of: ${matches.join(", ")}`);
  }
  throw new Error(
    `Fusion model "${rawModel}" must be a known alias, a unique configured model/provider name, or provider:model.`
  );
}

function findConfiguredModel(config: FusionConfig, model: string): FusionModelConfig | undefined {
  return [...config.panel, config.judge].find(
    (entry) => modelKey(entry.modelString) === modelKey(model)
  );
}

function resolveOverrideModel(params: {
  rawModel: string;
  thinking?: ThinkingLevel | null;
  config: FusionConfig;
  availableModels: readonly string[];
}): ResolvedFusionModel {
  const model = resolveModelShorthand(params.rawModel, params.config, params.availableModels);
  const inheritedThinking = findConfiguredModel(params.config, model)?.thinkingLevel;
  const thinking = params.thinking ?? inheritedThinking;
  return { model, ...(thinking != null ? { thinking } : {}) };
}

function dedupePanel(panel: readonly ResolvedFusionModel[]): ResolvedFusionModel[] {
  const seen = new Set<string>();
  return panel.filter((entry) => {
    const key = modelKey(entry.model);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Resolve saved defaults plus explicit one-shot overrides without mutating persisted config. */
export function resolveFusionArgs(
  config: FusionConfig | undefined,
  args: FusionToolArgs,
  availableModels: readonly string[] = []
): ResolvedFusionArgs {
  if (config == null) {
    throw new Error(
      "Fusion is not configured. Configure at least two panel models and one judge in Settings > Fusion before running it."
    );
  }

  const savedPanel = config.panel.map((entry) => ({
    model: entry.modelString,
    ...(entry.thinkingLevel != null ? { thinking: entry.thinkingLevel } : {}),
  }));
  const overridePanel = (args.panelOverride?.models ?? []).map((rawModel) =>
    resolveOverrideModel({
      rawModel,
      thinking: args.panelOverride?.thinking,
      config,
      availableModels,
    })
  );
  const panel = dedupePanel(
    args.panelOverride?.mode === "replace"
      ? overridePanel
      : args.panelOverride?.mode === "append"
        ? [...savedPanel, ...overridePanel]
        : savedPanel
  );

  if (panel.length < 2 || panel.length > 8) {
    throw new Error(
      `Fusion needs 2-8 distinct effective panel models after overrides; received ${panel.length}.`
    );
  }

  const judge = args.judgeOverride
    ? resolveOverrideModel({
        rawModel: args.judgeOverride.model,
        thinking: args.judgeOverride.thinking,
        config,
        availableModels,
      })
    : {
        model: config.judge.modelString,
        ...(config.judge.thinkingLevel != null ? { thinking: config.judge.thinkingLevel } : {}),
      };

  return { prompt: args.prompt, panel, judge };
}

function buildDescription(config: ToolConfiguration): string {
  const saved = config.fusionConfig;
  if (saved == null) {
    return `${TOOL_DEFINITIONS.fusion.description} Fusion is currently not configured.`;
  }
  return (
    `${TOOL_DEFINITIONS.fusion.description} ` +
    `Saved panel: ${saved.panel.map((entry) => entry.modelString).join(", ")}. ` +
    `Saved judge: ${saved.judge.modelString}.`
  );
}

export const createFusionTool: ToolFactory = (config: ToolConfiguration) => {
  const workflowRunTool = createWorkflowRunTool(config);
  return tool({
    description: buildDescription(config),
    inputSchema: TOOL_DEFINITIONS.fusion.schema,
    execute: (args, options) => {
      const effectiveArgs = resolveFusionArgs(
        config.fusionConfig,
        args,
        config.fusionAvailableModels
      );
      if (workflowRunTool.execute == null) {
        throw new Error("Fusion requires the workflow_run executor");
      }
      const result: unknown = workflowRunTool.execute(
        {
          script_path: "skill://fusion/workflow.js",
          args: effectiveArgs,
          run_in_background: args.run_in_background,
        },
        options
      );
      return result;
    },
  });
};
