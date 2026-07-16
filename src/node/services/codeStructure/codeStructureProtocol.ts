import type { CodeModuleReport, ReadCodeResult, ReadSymbolSelector } from "./codeStructureAnalysis";

export type CodeStructureOperation =
  | { type: "analyze"; path: string; source: string }
  | { type: "readSymbol"; path: string; source: string; selector: ReadSymbolSelector }
  | { type: "readEnclosing"; path: string; source: string; line: number };

export interface CodeStructureWorkerRequest {
  type: "request";
  messageId: number;
  deadlineMs: number;
  operation: CodeStructureOperation;
}

export interface CodeStructureWorkerCancel {
  type: "cancel";
  messageId: number;
}

export type CodeStructureWorkerInput = CodeStructureWorkerRequest | CodeStructureWorkerCancel;

export type CodeStructureWorkerResult = CodeModuleReport | ReadCodeResult;

export type CodeStructureWorkerResponse =
  | { messageId: number; result: CodeStructureWorkerResult }
  | { messageId: number; error: string };
