import { tool } from "ai";

import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

export const createSendFollowUpTool: ToolFactory = (config) =>
  tool({
    description: TOOL_DEFINITIONS.send_follow_up.description,
    inputSchema: TOOL_DEFINITIONS.send_follow_up.schema,
    execute: ({ message }) => {
      const runtime = config.sendFollowUpRuntime;
      if (runtime == null) {
        return {
          success: false,
          queued: false,
          status: "unavailable" as const,
          note: "Automatic follow-up is unavailable for this stream.",
        };
      }
      if (runtime.used) {
        return {
          success: false,
          queued: false,
          status: "already-used" as const,
          note: "This turn already attempted to queue an automatic follow-up.",
        };
      }

      runtime.used = true;
      const result = runtime.enqueue(message);
      if (result.status === "queued") {
        return {
          success: true,
          queued: true,
          status: result.status,
          note: "Queued for the next turn in this running session.",
        };
      }
      return {
        success: false,
        queued: false,
        status: result.status,
        note:
          result.status === "user-message-pending"
            ? "A pending user message takes priority; no automatic follow-up was queued."
            : "An automatic follow-up is already pending for this workspace.",
      };
    },
  });
