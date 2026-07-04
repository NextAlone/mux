export const LOCAL_COMPACTION_STRATEGIES = ["mux-current", "pi-local", "hybrid-local"] as const;
export type LocalCompactionStrategy = (typeof LOCAL_COMPACTION_STRATEGIES)[number];

export const REMOTE_COMPACTION_POLICIES = ["off", "openai-responses-compact"] as const;
export type RemoteCompactionPolicy = (typeof REMOTE_COMPACTION_POLICIES)[number];

export const DEFAULT_LOCAL_COMPACTION_KEEP_RECENT_TOKENS = 16_000;
export const DEFAULT_LOCAL_COMPACTION_TOOL_RESULT_MAX_CHARS = 4_000;

export interface LocalCompactionStrategyParameters {
  keepRecentTokens: number;
  toolResultMaxChars: number;
}

export interface CompactionStrategySettings {
  localStrategy: LocalCompactionStrategy;
  fallbackLocalStrategies: LocalCompactionStrategy[];
  remotePolicy: RemoteCompactionPolicy;
  piLocal: LocalCompactionStrategyParameters;
  hybridLocal: LocalCompactionStrategyParameters;
}

const DEFAULT_COMPACTION_STRATEGY_SETTINGS: CompactionStrategySettings = {
  localStrategy: "mux-current",
  fallbackLocalStrategies: [],
  remotePolicy: "off",
  piLocal: {
    keepRecentTokens: DEFAULT_LOCAL_COMPACTION_KEEP_RECENT_TOKENS,
    toolResultMaxChars: DEFAULT_LOCAL_COMPACTION_TOOL_RESULT_MAX_CHARS,
  },
  hybridLocal: {
    keepRecentTokens: DEFAULT_LOCAL_COMPACTION_KEEP_RECENT_TOKENS,
    toolResultMaxChars: DEFAULT_LOCAL_COMPACTION_TOOL_RESULT_MAX_CHARS,
  },
};

function isLocalCompactionStrategy(value: unknown): value is LocalCompactionStrategy {
  return (
    typeof value === "string" &&
    LOCAL_COMPACTION_STRATEGIES.includes(value as LocalCompactionStrategy)
  );
}

function isRemoteCompactionPolicy(value: unknown): value is RemoteCompactionPolicy {
  return (
    typeof value === "string" &&
    REMOTE_COMPACTION_POLICIES.includes(value as RemoteCompactionPolicy)
  );
}

function getObjectField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeLocalCompactionStrategyParameters(
  rawParameters: unknown,
  defaults: LocalCompactionStrategyParameters
): LocalCompactionStrategyParameters {
  return {
    keepRecentTokens: normalizePositiveInteger(
      getObjectField(rawParameters, "keepRecentTokens"),
      defaults.keepRecentTokens
    ),
    toolResultMaxChars: normalizePositiveInteger(
      getObjectField(rawParameters, "toolResultMaxChars"),
      defaults.toolResultMaxChars
    ),
  };
}

function normalizeFallbackLocalStrategies(
  rawFallbacks: unknown,
  localStrategy: LocalCompactionStrategy
): LocalCompactionStrategy[] {
  if (!Array.isArray(rawFallbacks)) {
    return [];
  }

  const fallbackLocalStrategies: LocalCompactionStrategy[] = [];
  const seen = new Set<LocalCompactionStrategy>([localStrategy]);
  for (const fallback of rawFallbacks) {
    if (!isLocalCompactionStrategy(fallback)) {
      continue;
    }
    if (seen.has(fallback)) {
      continue;
    }
    seen.add(fallback);
    fallbackLocalStrategies.push(fallback);
  }
  return fallbackLocalStrategies;
}

export function normalizeCompactionSettings(rawSettings: unknown): CompactionStrategySettings {
  const localStrategyRaw = getObjectField(rawSettings, "localStrategy");
  const localStrategy = isLocalCompactionStrategy(localStrategyRaw)
    ? localStrategyRaw
    : DEFAULT_COMPACTION_STRATEGY_SETTINGS.localStrategy;

  const remotePolicyRaw = getObjectField(rawSettings, "remotePolicy");
  const remotePolicy = isRemoteCompactionPolicy(remotePolicyRaw)
    ? remotePolicyRaw
    : DEFAULT_COMPACTION_STRATEGY_SETTINGS.remotePolicy;

  return {
    localStrategy,
    fallbackLocalStrategies: normalizeFallbackLocalStrategies(
      getObjectField(rawSettings, "fallbackLocalStrategies"),
      localStrategy
    ),
    remotePolicy,
    piLocal: normalizeLocalCompactionStrategyParameters(
      getObjectField(rawSettings, "piLocal"),
      DEFAULT_COMPACTION_STRATEGY_SETTINGS.piLocal
    ),
    hybridLocal: normalizeLocalCompactionStrategyParameters(
      getObjectField(rawSettings, "hybridLocal"),
      DEFAULT_COMPACTION_STRATEGY_SETTINGS.hybridLocal
    ),
  };
}

export function resolveLocalCompactionStrategyChain(
  rawSettings: unknown
): LocalCompactionStrategy[] {
  const settings = normalizeCompactionSettings(rawSettings);
  const chain: LocalCompactionStrategy[] = [
    settings.localStrategy,
    ...settings.fallbackLocalStrategies,
  ];

  if (!chain.includes("mux-current")) {
    chain.push("mux-current");
  }

  return chain;
}

export function canUseRemoteCompactionPolicy(params: {
  policy: RemoteCompactionPolicy;
  model: string;
}): boolean {
  if (params.policy !== "openai-responses-compact") {
    return false;
  }

  return params.model.trim().startsWith("openai:");
}
