import { useSyncExternalStore } from "react";

import type { APIClient } from "@/browser/contexts/API";
import type { CodexUsageSnapshot } from "@/common/orpc/types";

export class CodexUsageStore {
  private client: APIClient | null = null;
  private snapshot: CodexUsageSnapshot | null = null;
  private readonly listeners = new Set<() => void>();
  private subscriptionController: AbortController | null = null;
  private subscriptionIterator: AsyncIterator<CodexUsageSnapshot | null> | null = null;

  setClient(client: APIClient | null): void {
    this.client = client;
    this.subscriptionController?.abort();
    this.subscriptionController = null;
    void this.subscriptionIterator?.return?.();
    this.subscriptionIterator = null;

    if (!client) {
      this.setSnapshot(null);
      return;
    }

    void this.refresh();
    this.runSubscription(client);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): CodexUsageSnapshot | null => this.snapshot;

  refresh = async (): Promise<void> => {
    const client = this.client;
    if (!client) return;
    try {
      this.setSnapshot(await client.codexOauth.getUsageSnapshot());
    } catch {
      // Best-effort UI chrome: failures should not affect chat rendering.
    }
  };

  private setSnapshot(snapshot: CodexUsageSnapshot | null): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private runSubscription(client: APIClient): void {
    const controller = new AbortController();
    const { signal } = controller;
    this.subscriptionController = controller;

    let iterator: AsyncIterator<CodexUsageSnapshot | null> | null = null;

    void (async () => {
      try {
        const subscribedIterator = await client.codexOauth.subscribeUsageSnapshot(undefined, {
          signal,
        });

        if (signal.aborted || this.subscriptionController !== controller) {
          void subscribedIterator.return?.();
          return;
        }

        iterator = subscribedIterator;
        this.subscriptionIterator = subscribedIterator;
        for await (const snapshot of subscribedIterator) {
          if (signal.aborted) break;
          this.setSnapshot(snapshot);
        }
      } catch {
        // Subscription cancellation or backend restart: APIProvider will re-arm us.
      } finally {
        void iterator?.return?.();
        if (this.subscriptionIterator === iterator) {
          this.subscriptionIterator = null;
        }
      }
    })();
  }
}

let storeInstance: CodexUsageStore | null = null;

export function getCodexUsageStore(): CodexUsageStore {
  storeInstance ??= new CodexUsageStore();
  return storeInstance;
}

export function useCodexUsageSnapshot(): CodexUsageSnapshot | null {
  const store = getCodexUsageStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
