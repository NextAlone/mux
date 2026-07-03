import { useEffect, useRef, useState } from "react";

import { useOptionalAPI } from "@/browser/contexts/API";
import {
  DEFAULT_WORKSPACE_CHECKOUT_LOCATION,
  normalizeWorkspaceCheckoutLocationConfig,
  type WorkspaceCheckoutLocationConfig,
} from "@/common/config/workspaceCheckoutLocation";

export function useWorkspaceCheckoutLocation(): WorkspaceCheckoutLocationConfig {
  const api =
    useOptionalAPI()?.api ?? (typeof window !== "undefined" ? window.__ORPC_CLIENT__ : null);
  const fetchVersionRef = useRef(0);
  const [workspaceCheckoutLocation, setWorkspaceCheckoutLocation] =
    useState<WorkspaceCheckoutLocationConfig>(DEFAULT_WORKSPACE_CHECKOUT_LOCATION);

  useEffect(() => {
    if (!api?.config?.getConfig) {
      return;
    }

    const abortController = new AbortController();
    const { signal } = abortController;
    let iterator: AsyncIterator<unknown> | null = null;

    const refresh = () => {
      const fetchVersion = ++fetchVersionRef.current;
      api.config
        .getConfig()
        .then((config) => {
          if (signal.aborted || fetchVersion !== fetchVersionRef.current) {
            return;
          }
          setWorkspaceCheckoutLocation(
            normalizeWorkspaceCheckoutLocationConfig(config.workspaceCheckoutLocation)
          );
        })
        .catch(() => {
          // Keep the current/default value; this is display-only and creation still validates.
        });
    };

    refresh();

    const onConfigChanged = api?.config?.onConfigChanged;
    if (onConfigChanged) {
      const runSubscription = async () => {
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
            refresh();
          }
        } catch {
          // Subscription loss is non-fatal; the next mount will fetch again.
        }
      };

      void runSubscription();
    }

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api]);

  return workspaceCheckoutLocation;
}
