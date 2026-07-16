import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type { CodeModuleReport, ReadCodeResult, ReadSymbolSelector } from "./codeStructureAnalysis";
import type {
  CodeStructureOperation,
  CodeStructureWorkerInput,
  CodeStructureWorkerResponse,
  CodeStructureWorkerResult,
} from "./codeStructureProtocol";

const CODE_STRUCTURE_TIMEOUT_MS = 5_000;

interface PendingRequest {
  resolve: (result: CodeStructureWorkerResult) => void;
  reject: (error: Error) => void;
  removeAbortListener?: () => void;
}

function resolveWorkerPath(): string {
  const isBun = Boolean((process as unknown as { isBun?: boolean }).isBun);
  const extension = isBun && path.extname(__filename) === ".ts" ? ".ts" : ".js";
  return path.join(__dirname, `codeStructureWorker${extension}`);
}

export class CodeStructureService {
  private worker: Worker | undefined;
  private nextMessageId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private workerError: Error | undefined;
  private disposed = false;

  analyze(path: string, source: string, abortSignal?: AbortSignal): Promise<CodeModuleReport> {
    return this.dispatch({ type: "analyze", path, source }, abortSignal).then(
      (result) => result as CodeModuleReport
    );
  }

  readSymbol(
    path: string,
    source: string,
    selector: ReadSymbolSelector,
    abortSignal?: AbortSignal
  ): Promise<ReadCodeResult> {
    return this.dispatch({ type: "readSymbol", path, source, selector }, abortSignal).then(
      (result) => result as ReadCodeResult
    );
  }

  readEnclosing(
    path: string,
    source: string,
    line: number,
    abortSignal?: AbortSignal
  ): Promise<ReadCodeResult> {
    return this.dispatch({ type: "readEnclosing", path, source, line }, abortSignal).then(
      (result) => result as ReadCodeResult
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error("CodeStructureService has been disposed");
    this.rejectPending(error);
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
  }

  private ensureWorker(): Worker {
    if (this.disposed) throw new Error("CodeStructureService has been disposed");
    if (this.workerError) throw this.workerError;
    if (this.worker) return this.worker;

    const worker = new Worker(resolveWorkerPath());
    worker.unref();
    worker.on("message", (response: CodeStructureWorkerResponse) => {
      const pending = this.pending.get(response.messageId);
      if (!pending) return;
      this.pending.delete(response.messageId);
      pending.removeAbortListener?.();
      if ("error" in response) pending.reject(new Error(response.error));
      else pending.resolve(response.result);
    });
    worker.on("error", (error) => {
      this.workerError = error;
      this.rejectPending(error);
    });
    worker.on("exit", (code) => {
      this.worker = undefined;
      if (this.disposed || code === 0) return;
      const error = new Error(`Code structure worker exited with code ${code}`);
      this.workerError = error;
      this.rejectPending(error);
    });
    this.worker = worker;
    return worker;
  }

  private dispatch(
    operation: CodeStructureOperation,
    abortSignal?: AbortSignal
  ): Promise<CodeStructureWorkerResult> {
    if (this.disposed) return Promise.reject(new Error("CodeStructureService has been disposed"));
    if (abortSignal?.aborted) return Promise.reject(new Error("Code structure request aborted"));

    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }

    const messageId = this.nextMessageId++;
    const input: CodeStructureWorkerInput = {
      type: "request",
      messageId,
      deadlineMs: Date.now() + CODE_STRUCTURE_TIMEOUT_MS,
      operation,
    };

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (abortSignal) {
        const onAbort = () => {
          if (!this.pending.delete(messageId)) return;
          worker.postMessage({ type: "cancel", messageId } satisfies CodeStructureWorkerInput);
          reject(new Error("Code structure request aborted"));
        };
        abortSignal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
      }
      this.pending.set(messageId, pending);
      worker.postMessage(input);
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.removeAbortListener?.();
      pending.reject(error);
    }
    this.pending.clear();
  }
}

let sharedService: CodeStructureService | undefined;

export function getCodeStructureService(): CodeStructureService {
  sharedService ??= new CodeStructureService();
  return sharedService;
}

export async function disposeCodeStructureService(): Promise<void> {
  const service = sharedService;
  sharedService = undefined;
  await service?.dispose();
}
