import type { CodeExecutionResult } from "./Shared/codeExecutionTypes";

type CodeModeCellStatus = "yielded" | "running" | "completed" | "failed" | "terminated";

interface CodeModeResult {
  cell_id: string;
  status: CodeModeCellStatus;
  output?: string;
  result?: unknown;
  error?: string;
}

function parseCodeModeResult(value: unknown): CodeModeResult | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const validStatuses: CodeModeCellStatus[] = [
    "yielded",
    "running",
    "completed",
    "failed",
    "terminated",
  ];
  if (
    typeof record.cell_id !== "string" ||
    typeof record.status !== "string" ||
    !validStatuses.includes(record.status as CodeModeCellStatus)
  ) {
    return undefined;
  }
  return {
    cell_id: record.cell_id,
    status: record.status as CodeModeCellStatus,
    ...(typeof record.output === "string" ? { output: record.output } : {}),
    ...(Object.hasOwn(record, "result") ? { result: record.result } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
}

/** Adapt freeform Code mode results to the existing code execution presentation. */
export function normalizeCodeModeExecResult(value: unknown): CodeExecutionResult | undefined {
  const parsed = parseCodeModeResult(value);
  if (!parsed) return undefined;
  const failed = parsed.status === "failed" || parsed.status === "terminated";
  const displayResult = {
    cell_id: parsed.cell_id,
    status: parsed.status,
    ...(parsed.output !== undefined ? { output: parsed.output } : {}),
    ...(Object.hasOwn(parsed, "result") ? { result: parsed.result } : {}),
  };
  return {
    success: !failed,
    ...(failed
      ? { error: parsed.error ?? `Code mode cell ${parsed.status}` }
      : { result: displayResult }),
    toolCalls: [],
    consoleOutput: [],
    duration_ms: 0,
  };
}
