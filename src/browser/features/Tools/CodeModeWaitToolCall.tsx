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
import { useLanguage } from "@/browser/contexts/LanguageContext";

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

interface CodeModeWaitGroupSummaryProps {
  cellId: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}

/** One transcript row for repeated completed polls; expanding restores their individual details. */
export function CodeModeWaitGroupSummary(props: CodeModeWaitGroupSummaryProps) {
  const { t } = useLanguage();
  return (
    <ToolContainer expanded={false}>
      <ToolHeader onClick={props.onToggle}>
        <ExpandIcon expanded={props.expanded}>▶</ExpandIcon>
        <Clock3Icon className="h-3.5 w-3.5 shrink-0" />
        <ToolName>wait ×{props.count}</ToolName>
        <span className="text-muted min-w-0 truncate text-[10px]">
          {t("cell")}
          {props.cellId.slice(0, 8)}
        </span>
        <StatusIndicator status="completed">{getStatusDisplay("completed")}</StatusIndicator>
      </ToolHeader>
    </ToolContainer>
  );
}

/** Keep repeated polls compact while exposing which yielded code cell they advance. */
export function CodeModeWaitToolCall(props: CodeModeWaitToolCallProps) {
  const { t } = useLanguage();
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
        <span className="text-muted min-w-0 truncate text-[10px]">
          {t("cell")} {cellLabel}
        </span>
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && hasDetails && (
        <ToolDetails>
          <DetailSection>
            <DetailLabel>{t("Arguments")}</DetailLabel>
            <DetailContent>
              <JsonHighlight value={props.args} />
            </DetailContent>
          </DetailSection>
          <DetailSection>
            <DetailLabel>{t("Result")}</DetailLabel>
            <DetailContent>
              <JsonHighlight value={redactToolResultAttachmentsForDisplay(props.result)} />
            </DetailContent>
          </DetailSection>
        </ToolDetails>
      )}
    </ToolContainer>
  );
}
