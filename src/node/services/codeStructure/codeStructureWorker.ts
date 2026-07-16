import { parentPort } from "node:worker_threads";
import { CodeStructureAnalyzer } from "./codeStructureAnalysis";
import type {
  CodeStructureWorkerInput,
  CodeStructureWorkerRequest,
  CodeStructureWorkerResponse,
} from "./codeStructureProtocol";

if (!parentPort) throw new Error("Code structure worker requires a parent port");

const port = parentPort;
const cancelled = new Set<number>();
let analyzerPromise: Promise<CodeStructureAnalyzer> | undefined;
let queue = Promise.resolve();

function getAnalyzer(): Promise<CodeStructureAnalyzer> {
  analyzerPromise ??= CodeStructureAnalyzer.create();
  return analyzerPromise;
}

async function execute(request: CodeStructureWorkerRequest): Promise<void> {
  if (cancelled.delete(request.messageId)) return;

  const response: CodeStructureWorkerResponse = await (async () => {
    try {
      const analyzer = await getAnalyzer();
      const options = { deadlineMs: request.deadlineMs };
      switch (request.operation.type) {
        case "analyze":
          return {
            messageId: request.messageId,
            result: await analyzer.analyze(
              request.operation.path,
              request.operation.source,
              options
            ),
          };
        case "readSymbol":
          return {
            messageId: request.messageId,
            result: await analyzer.readSymbol(
              request.operation.path,
              request.operation.source,
              request.operation.selector,
              options
            ),
          };
        case "readEnclosing":
          return {
            messageId: request.messageId,
            result: await analyzer.readEnclosing(
              request.operation.path,
              request.operation.source,
              request.operation.line,
              options
            ),
          };
      }
    } catch (error) {
      return {
        messageId: request.messageId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  })();

  if (!cancelled.delete(request.messageId)) port.postMessage(response);
}

port.on("message", (input: CodeStructureWorkerInput) => {
  if (input.type === "cancel") {
    cancelled.add(input.messageId);
    return;
  }

  queue = queue.then(() => execute(input));
});

process.once("exit", () => {
  void analyzerPromise?.then((analyzer) => analyzer.dispose());
});
