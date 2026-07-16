import React from "react";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  ToolIcon,
  TOOL_NAME_TO_ICON,
  ToolName,
  StatusIndicator,
  ToolDetails,
  DetailSection,
  DetailLabel,
  DetailContent,
  LoadingDots,
  ErrorBox,
} from "./Shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./Shared/toolUtils";
import { JsonHighlight } from "./Shared/HighlightedCode";
import { redactToolResultAttachmentsForDisplay } from "./Shared/toolResultDisplay";
import { ToolResultImages, extractImagesFromToolResult } from "./Shared/ToolResultImages";
import { useLanguage } from "@/browser/contexts/LanguageContext";

interface GenericToolCallProps {
  toolName: string;
  args?: unknown;
  result?: unknown;
  status?: ToolStatus;
}

export const GenericToolCall: React.FC<GenericToolCallProps> = ({
  toolName,
  args,
  result,
  status = "pending",
}) => {
  const { t } = useLanguage();
  const { expanded, toggleExpanded } = useToolExpansion();

  const hasDetails = args !== undefined || result !== undefined;
  const images = extractImagesFromToolResult(result);
  const hasImages = images.length > 0;
  const errorMessage =
    status === "failed" &&
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    typeof result.error === "string"
      ? result.error
      : undefined;

  // Auto-expand if there are images to show
  const shouldShowDetails = expanded || hasImages;

  return (
    <ToolContainer expanded={shouldShowDetails}>
      <ToolHeader onClick={() => hasDetails && toggleExpanded()}>
        {hasDetails && <ExpandIcon expanded={shouldShowDetails}>▶</ExpandIcon>}
        {TOOL_NAME_TO_ICON[toolName] && <ToolIcon toolName={toolName} />}
        <ToolName>{toolName}</ToolName>
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {/* Always show images if present */}
      {hasImages && <ToolResultImages result={result} />}
      {errorMessage && <ErrorBox className="mt-2">{errorMessage}</ErrorBox>}

      {expanded && hasDetails && (
        <ToolDetails>
          {args !== undefined && (
            <DetailSection>
              <DetailLabel>{t("Arguments")}</DetailLabel>
              <DetailContent>
                <JsonHighlight value={args} />
              </DetailContent>
            </DetailSection>
          )}

          {result !== undefined && (
            <DetailSection>
              <DetailLabel>{t("Result")}</DetailLabel>
              <DetailContent>
                <JsonHighlight value={redactToolResultAttachmentsForDisplay(result)} />
              </DetailContent>
            </DetailSection>
          )}

          {status === "executing" && result === undefined && (
            <DetailSection>
              <DetailContent>
                {t("Waiting for result")}
                <LoadingDots />
              </DetailContent>
            </DetailSection>
          )}
          {status === "redacted" && (
            <DetailSection>
              <DetailContent className="text-muted italic">
                {t("Output excluded from shared transcript")}
              </DetailContent>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
