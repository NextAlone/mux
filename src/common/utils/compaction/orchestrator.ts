import {
  resolveLocalCompactionStrategyChain,
  type CompactionStrategySettings,
  type LocalCompactionStrategy,
} from "./strategyConfig";

export type LocalCompactionAttemptResult =
  | {
      type: "installed";
    }
  | {
      type: "failed";
      error: string;
      boundaryInstalled: boolean;
    };

export type LocalCompactionOrchestratorResult =
  | {
      type: "installed";
      strategy: LocalCompactionStrategy;
      attemptedStrategies: LocalCompactionStrategy[];
    }
  | {
      type: "failed";
      strategy: LocalCompactionStrategy;
      attemptedStrategies: LocalCompactionStrategy[];
      error: string;
      boundaryInstalled: boolean;
    };

export interface RunLocalCompactionStrategiesOptions {
  settings: CompactionStrategySettings;
  attemptStrategy: (
    strategy: LocalCompactionStrategy
  ) => Promise<LocalCompactionAttemptResult> | LocalCompactionAttemptResult;
}

export async function runLocalCompactionStrategies(
  options: RunLocalCompactionStrategiesOptions
): Promise<LocalCompactionOrchestratorResult> {
  const strategyChain = resolveLocalCompactionStrategyChain(options.settings);
  const attemptedStrategies: LocalCompactionStrategy[] = [];
  let lastFailure:
    | {
        strategy: LocalCompactionStrategy;
        error: string;
        boundaryInstalled: boolean;
      }
    | undefined;

  for (const strategy of strategyChain) {
    attemptedStrategies.push(strategy);
    const result = await options.attemptStrategy(strategy);
    if (result.type === "installed") {
      return {
        type: "installed",
        strategy,
        attemptedStrategies,
      };
    }

    lastFailure = {
      strategy,
      error: result.error,
      boundaryInstalled: result.boundaryInstalled,
    };

    if (result.boundaryInstalled) {
      break;
    }
  }

  const failure = lastFailure;
  if (!failure) {
    throw new Error("Compaction strategy chain must contain at least one strategy");
  }

  return {
    type: "failed",
    strategy: failure.strategy,
    attemptedStrategies,
    error: failure.error,
    boundaryInstalled: failure.boundaryInstalled,
  };
}
