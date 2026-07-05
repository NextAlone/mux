import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalAPI } from "@/browser/contexts/API";
import type { CompactionSettings } from "@/common/config/schemas/appConfigOnDisk";

const REMOTE_OPENAI_RESPONSES_COMPACT = "openai-responses-compact" as const;

export interface RemoteCompactionSettings {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

export function useRemoteCompactionSettings(): RemoteCompactionSettings {
  const api = useOptionalAPI()?.api ?? null;
  const [settings, setSettings] = useState<CompactionSettings>({});
  const fetchVersionRef = useRef(0);

  const fetchConfig = useCallback(async () => {
    const getConfig = api?.config?.getConfig;
    if (!getConfig) {
      return;
    }

    const fetchVersion = ++fetchVersionRef.current;

    try {
      const config = await getConfig();
      if (fetchVersion !== fetchVersionRef.current) {
        return;
      }
      setSettings(config.compaction ?? {});
    } catch {
      // Best-effort only; keep the current toggle state on transient IPC failures.
    }
  }, [api]);

  useEffect(() => {
    const abortController = new AbortController();
    const { signal } = abortController;
    let iterator: AsyncIterator<unknown> | null = null;

    void fetchConfig();

    const onConfigChanged = api?.config?.onConfigChanged;
    if (!onConfigChanged) {
      return () => {
        abortController.abort();
      };
    }

    void (async () => {
      try {
        const subscribedIterator = await onConfigChanged(undefined, { signal });
        if (signal.aborted) {
          void subscribedIterator.return?.();
          return;
        }

        iterator = subscribedIterator;
        for await (const _ of subscribedIterator) {
          if (signal.aborted) {
            break;
          }
          void fetchConfig();
        }
      } catch {
        // Subscription errors are non-fatal; direct saves still update local state.
      }
    })();

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api, fetchConfig]);

  const setEnabled = useCallback(
    (enabled: boolean) => {
      const nextSettings: CompactionSettings = {
        ...settings,
        remotePolicy: enabled ? REMOTE_OPENAI_RESPONSES_COMPACT : "off",
      };

      fetchVersionRef.current++;
      setSettings(nextSettings);

      api?.config?.saveConfig({ compaction: nextSettings }).catch(() => {
        void fetchConfig();
      });
    },
    [api, fetchConfig, settings]
  );

  return {
    enabled: settings.remotePolicy === REMOTE_OPENAI_RESPONSES_COMPACT,
    setEnabled,
  };
}
