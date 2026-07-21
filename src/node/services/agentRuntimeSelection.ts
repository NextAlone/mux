import type { SendMessageOptions } from "@/common/orpc/types";
import type { MuxMessageMetadata } from "@/common/types/message";

export type AgentRuntimeKind = "mux" | "pi";

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
  // Codex remote compaction remains a Mux-owned control turn. Its opaque output
  // is replayed into the next ordinary Pi request instead of teaching Pi a
  // second, incompatible compaction protocol.
  return (
    resolveAgentRuntimeKind(experiments) === "pi" &&
    muxMetadata?.type !== "compaction-request" &&
    latestUserMuxMetadata?.type !== "compaction-request"
  );
}
