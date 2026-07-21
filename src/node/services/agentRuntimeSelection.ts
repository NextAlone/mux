import type { SendMessageOptions } from "@/common/orpc/types";
import type { MuxMessageMetadata } from "@/common/types/message";
import type { RuntimeMode } from "@/common/types/runtime";
import type { OpenAIResponsesCompactionRoute } from "@/common/utils/compaction/remotePolicy";

export type AgentRuntimeKind = "mux" | "pi";

export function isPiAgentRuntimeWorkspaceCompatible(options: {
  modelString: string;
  runtimeType: RuntimeMode;
  multiProject: boolean;
  remoteCompactionRoute: OpenAIResponsesCompactionRoute | null;
}): boolean {
  return (
    options.modelString.trim().startsWith("openai:") &&
    (options.runtimeType === "local" || options.runtimeType === "worktree") &&
    !options.multiProject &&
    options.remoteCompactionRoute !== "openai-api-key"
  );
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
  latestUserMuxMetadata?: { type: MuxMessageMetadata["type"] },
  agentId?: string
): boolean {
  const isOrdinaryTurn = (metadata: { type: MuxMessageMetadata["type"] } | undefined): boolean =>
    metadata == null || metadata.type === "normal";

  // Mux owns synthetic/control turns because their metadata drives orchestration,
  // correlation, and UI behavior outside the model loop. Pi is an execution
  // backend only for ordinary user turns.
  return (
    resolveAgentRuntimeKind(experiments) === "pi" &&
    (agentId == null || agentId === "exec") &&
    isOrdinaryTurn(muxMetadata) &&
    isOrdinaryTurn(latestUserMuxMetadata)
  );
}
