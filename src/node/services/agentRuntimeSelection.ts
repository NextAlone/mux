import type { SendMessageOptions } from "@/common/orpc/types";
import type { MuxMessageMetadata } from "@/common/types/message";
import type { RuntimeMode } from "@/common/types/runtime";
import type { OpenAIResponsesCompactionRoute } from "@/common/utils/compaction/remotePolicy";

export type AgentRuntimeKind = "mux" | "pi";

interface PiAgentRuntimeWorkspaceOptions {
  modelString: string;
  runtimeType: RuntimeMode;
  multiProject: boolean;
  remoteCompactionRoute: OpenAIResponsesCompactionRoute | null;
}

export function getPiAgentRuntimeIncompatibility(
  options: PiAgentRuntimeWorkspaceOptions
): string | null {
  if (!options.modelString.trim().startsWith("openai:")) {
    return "Pi agent runtime requires an openai:* Codex OAuth model. Select a direct OpenAI Codex OAuth model or disable the Pi runtime experiment.";
  }
  if (options.runtimeType !== "local" && options.runtimeType !== "worktree") {
    return "Pi agent runtime supports only local and worktree workspaces. Move this task to a local/worktree workspace or disable the Pi runtime experiment.";
  }
  if (options.multiProject) {
    return "Pi agent runtime does not support multi-project workspaces. Use a single-project workspace or disable the Pi runtime experiment.";
  }
  if (options.remoteCompactionRoute === "openai-api-key") {
    return "This workspace context was compacted with direct OpenAI API-key routing. Reset context before using the Pi Codex OAuth runtime.";
  }
  return null;
}

export function isPiAgentRuntimeWorkspaceCompatible(
  options: PiAgentRuntimeWorkspaceOptions
): boolean {
  return getPiAgentRuntimeIncompatibility(options) === null;
}

/**
 * Runtime selection is captured with the accepted user turn. Reading the live
 * experiment again mid-stream would let a Settings toggle change ownership of
 * an already-running tool loop.
 */
export function resolveAgentRuntimeKind(
  experiments: SendMessageOptions["experiments"]
): AgentRuntimeKind {
  return experiments?.piAgentRuntime === true ? "pi" : "mux";
}

export function shouldUsePiAgentRuntime(
  experiments: SendMessageOptions["experiments"],
  muxMetadata: { type: MuxMessageMetadata["type"] } | undefined,
  latestUserMuxMetadata?: { type: MuxMessageMetadata["type"] }
): boolean {
  const isOrdinaryTurn = (metadata: { type: MuxMessageMetadata["type"] } | undefined): boolean =>
    metadata == null || metadata.type === "normal";

  // Mux owns synthetic/control turns because their metadata drives orchestration,
  // correlation, and UI behavior outside the model loop. Pi is an execution
  // backend only for ordinary user turns.
  return (
    resolveAgentRuntimeKind(experiments) === "pi" &&
    isOrdinaryTurn(muxMetadata) &&
    isOrdinaryTurn(latestUserMuxMetadata)
  );
}
