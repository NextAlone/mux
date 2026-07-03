import React from "react";

import { useWorkspaceStatsSnapshot } from "@/browser/stores/WorkspaceStore";
import { calculateAverageTPS } from "@/browser/utils/messages/StreamingTPSCalculator";
import { BaseBarrier } from "./BaseBarrier";

interface LastResponseStatsBarrierProps {
  workspaceId: string;
}

export const LastResponseStatsBarrier: React.FC<LastResponseStatsBarrierProps> = (props) => {
  const snapshot = useWorkspaceStatsSnapshot(props.workspaceId);
  const lastRequest = snapshot?.lastRequest;

  if (snapshot?.active || !lastRequest || lastRequest.invalid) {
    return null;
  }

  const totalTokens = lastRequest.outputTokens + lastRequest.reasoningTokens;
  const avgTPS = calculateAverageTPS(
    lastRequest.streamingMs,
    lastRequest.modelTimeMs,
    totalTokens,
    null
  );

  if (!avgTPS || totalTokens <= 0) {
    return null;
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-1 items-center gap-2">
        <BaseBarrier text="Last response" color="var(--color-assistant-border)" />
        <span
          data-testid="last-response-stats"
          className="text-assistant-border counter-nums-mono inline-flex min-w-[14ch] items-baseline justify-end text-[11px] whitespace-nowrap select-none"
        >
          <span>~{totalTokens.toLocaleString()} tokens</span>
          <span className="text-dim ml-1 inline-flex min-w-[7ch] items-baseline justify-end gap-1">
            <span>@</span>
            <span>{Math.round(avgTPS)}</span>
            <span>t/s</span>
          </span>
        </span>
      </div>
    </div>
  );
};
