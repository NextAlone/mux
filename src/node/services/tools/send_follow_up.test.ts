import { describe, expect, it, mock } from "bun:test";

import { createTestToolConfig, mockToolCallOptions } from "./testHelpers";
import { createSendFollowUpTool } from "./send_follow_up";

async function executeSendFollowUp(
  tool: ReturnType<typeof createSendFollowUpTool>,
  message: string
): Promise<unknown> {
  if (!tool.execute) {
    throw new Error("send_follow_up test tool is missing execute");
  }
  return await tool.execute({ message }, mockToolCallOptions);
}

describe("send_follow_up", () => {
  it("queues at most once across tool reconstruction in the same stream", async () => {
    const enqueue = mock(() => ({ status: "queued" as const }));
    const config = createTestToolConfig("/tmp");
    config.sendFollowUpRuntime = { used: false, enqueue };

    const first = await executeSendFollowUp(createSendFollowUpTool(config), "continue");
    const second = await executeSendFollowUp(createSendFollowUpTool(config), "again");

    expect(first).toMatchObject({ success: true, queued: true, status: "queued" });
    expect(second).toMatchObject({ success: false, queued: false, status: "already-used" });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith("continue");
  });

  it("does not retry after pending user input rejects the stream's attempt", async () => {
    const enqueue = mock(() => ({ status: "user-message-pending" as const }));
    const config = createTestToolConfig("/tmp");
    config.sendFollowUpRuntime = { used: false, enqueue };

    const first = await executeSendFollowUp(createSendFollowUpTool(config), "continue");
    const second = await executeSendFollowUp(createSendFollowUpTool(config), "try again");

    expect(first).toMatchObject({
      success: false,
      queued: false,
      status: "user-message-pending",
    });
    expect(second).toMatchObject({ success: false, queued: false, status: "already-used" });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
