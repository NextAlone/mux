import { describe, expect, test } from "bun:test";

import { runLocalCompactionStrategies } from "./orchestrator";
import { normalizeCompactionSettings, type LocalCompactionStrategy } from "./strategyConfig";

describe("local compaction orchestrator", () => {
  test("falls back while no compaction boundary has been installed", async () => {
    const attempts: LocalCompactionStrategy[] = [];

    const result = await runLocalCompactionStrategies({
      settings: normalizeCompactionSettings({
        localStrategy: "hybrid-local",
        fallbackLocalStrategies: ["pi-local", "mux-current"],
        remotePolicy: "off",
      }),
      attemptStrategy: (strategy) => {
        attempts.push(strategy);
        if (strategy === "hybrid-local") {
          return {
            type: "failed",
            error: "hybrid prompt rejected",
            boundaryInstalled: false,
          };
        }
        return { type: "installed" };
      },
    });

    expect(result).toEqual({
      type: "installed",
      strategy: "pi-local",
      attemptedStrategies: ["hybrid-local", "pi-local"],
    });
    expect(attempts).toEqual(["hybrid-local", "pi-local"]);
  });

  test("does not fall back after a strategy installs a compaction boundary", async () => {
    const attempts: LocalCompactionStrategy[] = [];

    const result = await runLocalCompactionStrategies({
      settings: normalizeCompactionSettings({
        localStrategy: "hybrid-local",
        fallbackLocalStrategies: ["pi-local", "mux-current"],
        remotePolicy: "off",
      }),
      attemptStrategy: (strategy) => {
        attempts.push(strategy);
        return {
          type: "failed",
          error: "post-boundary event failed",
          boundaryInstalled: true,
        };
      },
    });

    expect(result).toEqual({
      type: "failed",
      strategy: "hybrid-local",
      attemptedStrategies: ["hybrid-local"],
      error: "post-boundary event failed",
      boundaryInstalled: true,
    });
    expect(attempts).toEqual(["hybrid-local"]);
  });
});
