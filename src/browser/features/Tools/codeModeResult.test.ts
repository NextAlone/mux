import { describe, expect, test } from "bun:test";

import { normalizeCodeModeExecResult } from "./codeModeResult";

describe("normalizeCodeModeExecResult", () => {
  test("preserves emitted text and return values from successful cells", () => {
    expect(
      normalizeCodeModeExecResult({
        cell_id: "cell-1",
        status: "completed",
        output: "inspected 3 files",
        result: { changed: 1 },
      })
    ).toMatchObject({
      success: true,
      result: {
        cell_id: "cell-1",
        status: "completed",
        output: "inspected 3 files",
        result: { changed: 1 },
      },
    });
  });

  test("turns sandbox failures into the existing error presentation", () => {
    expect(
      normalizeCodeModeExecResult({
        cell_id: "cell-2",
        status: "failed",
        error: "Tool lookup failed",
      })
    ).toMatchObject({ success: false, error: "Tool lookup failed" });
  });

  test("rejects malformed persisted results instead of inventing a display state", () => {
    expect(normalizeCodeModeExecResult({ status: "completed" })).toBeUndefined();
    expect(normalizeCodeModeExecResult("completed")).toBeUndefined();
  });
});
