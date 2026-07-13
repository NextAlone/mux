import { Clock3Icon } from "lucide-react";

import { JsonHighlight } from "./Shared/HighlightedCode";
import {
  DetailContent,
  DetailLabel,
  DetailSection,
  ExpandIcon,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolName,
} from "./Shared/ToolPrimitives";
import { getStatusDisplay, type ToolStatus, useToolExpansion } from "./Shared/toolUtils";
import { redactToolResultAttachmentsForDisplay } from "./Shared/toolResultDisplay";

interface CodeModeWaitArgs {
  cell_id: string;
  yield_time_ms?: number | null;
  max_tokens?: number | null;
  terminate?: boolean | null;
}

interface CodeModeWaitToolCallProps {
  args: CodeModeWaitArgs;
  result?: unknown;
  status?: ToolStatus;
}

/** Keep repeated polls compact while exposing which yielded code cell they advance. */
export function CodeModeWaitToolCall(props: CodeModeWaitToolCallProps) {
  const { expanded, toggleExpanded } = useToolExpansion();
  const cellLabel = props.args.cell_id.slice(0, 8);
  const hasDetails = props.result !== undefined;
  const status = props.status ?? "pending";

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={() => hasDetails && toggleExpanded()}>
        {hasDetails && <ExpandIcon expanded={expanded}>▶</ExpandIcon>}
        <Clock3Icon className="h-3.5 w-3.5 shrink-0" />
        <ToolName>wait</ToolName>
        <span className="text-muted min-w-0 truncate text-[10px]">cell {cellLabel}</span>
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && hasDetails && (
        <ToolDetails>
          <DetailSection>
            <DetailLabel>Arguments</DetailLabel>
            <DetailContent>
              <JsonHighlight value={props.args} />
            </DetailContent>
          </DetailSection>
          <DetailSection>
            <DetailLabel>Result</DetailLabel>
            <DetailContent>
              <JsonHighlight value={redactToolResultAttachmentsForDisplay(props.result)} />
            </DetailContent>
          </DetailSection>
        </ToolDetails>
      )}
    </ToolContainer>
  );
}
